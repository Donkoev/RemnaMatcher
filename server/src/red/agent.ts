import type { TLSSocket } from 'node:tls';
import { Agent, buildConnector, request } from 'undici';

// HTTP-клиент к агенту на ноде. Все запросы несут X-Agent-Token.
// Панель проверяет присутствие агента и толкает ему обновления кода.
//
// Транспорт: агент, поставленный панелью, слушает TLS на самоподписанном сертификате,
// а панель ПРИКАЛЫВАЕТ его SHA-256 отпечаток (снят по SSH при установке — доверенный канал).
// Так токен и код агента не ходят открытым текстом, а подмену сервера панель отвергает.
// Агенты старых установок (без сертификата, fp = null) опрашиваются по HTTP — до переустановки.

// Держим соединение к агенту живым между тиками поллера: новые TCP-потоки до ноды
// на флапающем канале иногда молча теряются, а уже установленное соединение работает.
// Агент отвечает по HTTP/1.1 и рвёт простой у себя через 65с — держим меньше.
const KEEP_ALIVE_MS = 60_000;

const TIMEOUT_MS = 12_000;
// health лёгкий: долгий таймаут лишь растягивал бы циклы опроса при недоступной ноде
const HEALTH_TIMEOUT_MS = 5000;

/** коннектор, который принимает только сертификат с закреплённым отпечатком */
function pinnedConnector(fp: string): buildConnector.connector {
  // цепочку не проверяем (сертификат самоподписанный) — проверяем сам сертификат
  const tlsConnect = buildConnector({ rejectUnauthorized: false });
  return (opts, cb) => {
    tlsConnect(opts, (err, socket) => {
      if (err || !socket) return cb(err ?? new Error('нет сокета'), null);
      const actual = (socket as TLSSocket).getPeerCertificate?.()?.fingerprint256 ?? '';
      if (actual.toUpperCase() !== fp.toUpperCase()) {
        socket.destroy();
        return cb(new Error(`сертификат агента ${opts.hostname} не совпадает с закреплённым при установке`), null);
      }
      cb(null, socket);
    });
  };
}

// диспетчер на каждый отпечаток (у каждой ноды свой сертификат) + один общий для HTTP
const plainDispatcher = new Agent({ keepAliveTimeout: KEEP_ALIVE_MS, connections: 2 });
const pinnedDispatchers = new Map<string, Agent>();

function dispatcherFor(fp: string | null): Agent {
  if (!fp) return plainDispatcher;
  let d = pinnedDispatchers.get(fp);
  if (!d) {
    d = new Agent({ keepAliveTimeout: KEEP_ALIVE_MS, connections: 2, connect: pinnedConnector(fp) });
    pinnedDispatchers.set(fp, d);
  }
  return d;
}

/** адрес агента: сертификат есть — TLS, нет — старый агент по открытому HTTP */
export interface AgentAddr {
  host: string;
  port: number;
  token: string;
  fp: string | null;
}

async function call(
  a: AgentAddr,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await request(`${a.fp ? 'https' : 'http'}://${a.host}:${a.port}${path}`, {
    method,
    dispatcher: dispatcherFor(a.fp),
    headers: { 'X-Agent-Token': a.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.body.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* не json */
  }
  return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data };
}

export interface AgentHealth {
  ok: boolean;
  version?: string;
  xray?: boolean;
  tls?: boolean;
}

export async function agentHealth(a: AgentAddr): Promise<AgentHealth | null> {
  try {
    const r = await call(a, 'GET', '/health', undefined, HEALTH_TIMEOUT_MS);
    return r.ok ? (r.data as AgentHealth) : null;
  } catch {
    return null;
  }
}

// Непрерывный спидтест силами ноды: start запускает на ней постоянную загрузку+отдачу
// через присланный outbound, status отдаёт живые скорости, stop глушит и возвращает итог.
export interface AgentSpeedStatus {
  running: boolean;
  pingMs?: number | null;
  elapsedS?: number;
  downBytes?: number;
  upBytes?: number;
  downCurrentMbps?: number | null;
  upCurrentMbps?: number | null;
  downPeakMbps?: number | null;
  upPeakMbps?: number | null;
  downAvgMbps?: number | null;
  upAvgMbps?: number | null;
  /** последняя ошибка направления — почему поток не даёт данных (напр. HTTP 429) */
  downError?: string | null;
  upError?: string | null;
  error?: string;
}

export async function agentSpeedStart(
  a: AgentAddr,
  outbound: Record<string, unknown>,
): Promise<{ ok: boolean; pingMs?: number | null; error?: string }> {
  try {
    const r = await call(a, 'POST', '/speedtest-start', { outbound }, 30_000);
    if (r.status === 404) return { ok: false, error: 'на ноде старый агент — обнови его в «Серверах»' };
    const d = (r.data ?? {}) as { ok?: boolean; pingMs?: number; error?: string };
    if (d.error || !d.ok) return { ok: false, error: d.error ?? `агент ответил HTTP ${r.status}` };
    return { ok: true, pingMs: d.pingMs ?? null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'нет связи с агентом' };
  }
}

export async function agentSpeedStatus(a: AgentAddr): Promise<AgentSpeedStatus | null> {
  try {
    const r = await call(a, 'GET', '/speedtest-status', undefined, 8000);
    return r.ok ? (r.data as AgentSpeedStatus) : null;
  } catch {
    return null;
  }
}

export async function agentSpeedStop(a: AgentAddr): Promise<AgentSpeedStatus | null> {
  try {
    const r = await call(a, 'POST', '/speedtest-stop', {}, 20_000);
    return r.ok ? (r.data as AgentSpeedStatus) : null;
  } catch {
    return null;
  }
}

export async function agentSelfUpdate(a: AgentAddr, code: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await call(a, 'POST', '/self-update', { code });
    const d = (r.data ?? {}) as { ok?: boolean; error?: string };
    return { ok: !!d.ok, error: d.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'нет связи с агентом' };
  }
}
