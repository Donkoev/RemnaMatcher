import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { ProxyAgent, request } from 'undici';
import { tryBase64, type SubServer } from './subscriptions.js';

// URL-тест серверов подписки — как burstObservatory у балансировщика xray:
// запрос на generate_204 идёт ЧЕРЕЗ сам прокси-сервер, задержка — полный путь до интернета
// (TCP + TLS/Reality + протокол + HTTP), а не голый коннект до адреса. Отличия от observatory:
// метод GET (по просьбе — не HEAD) и замер по клику, а не фоновыми интервалами.
// Механика: панель поднимает локальный xray с http-inbound'ом на каждый сервер,
// роутинг жёстко связывает inbound → outbound, и меряется RTT запроса через каждый inbound.

const DESTINATION = 'http://connectivitycheck.gstatic.com/generate_204';
const REQUEST_TIMEOUT_MS = 5000; // timeout: 5s — как в конфиге burstObservatory
const SAMPLES = 2; // observatory делает 5 фоновых замеров; по клику хватит двух, берём лучший
const CONCURRENCY = 16;
const XRAY_START_TIMEOUT_MS = 6000;

export interface UrlTestResult {
  ok: boolean;
  latencyMs: number | null;
}

// ---- локальный xray для панели (скачивается один раз в data/xray) ----

const XRAY_DIR = path.resolve('./data/xray');
const XRAY_BIN = path.join(XRAY_DIR, process.platform === 'win32' ? 'xray.exe' : 'xray');

let xrayPromise: Promise<string> | null = null;

/** Путь к xray под ОС панели; при первом вызове бинарник скачивается из релизов XTLS */
export function ensureLocalXray(): Promise<string> {
  if (!xrayPromise) {
    xrayPromise = downloadXray().catch((e: unknown) => {
      xrayPromise = null; // не кэшируем неудачу — следующая попытка скачает заново
      throw e;
    });
  }
  return xrayPromise;
}

function xrayAssetName(): string {
  const arm = /arm64|aarch64/i.test(process.arch);
  if (process.platform === 'win32') return arm ? 'Xray-windows-arm64-v8a.zip' : 'Xray-windows-64.zip';
  if (process.platform === 'darwin') return arm ? 'Xray-macos-arm64-v8a.zip' : 'Xray-macos-64.zip';
  return arm ? 'Xray-linux-arm64-v8a.zip' : 'Xray-linux-64.zip';
}

async function downloadXray(): Promise<string> {
  if (fs.existsSync(XRAY_BIN)) return XRAY_BIN;
  const asset = xrayAssetName();
  const rel = await fetch('https://api.github.com/repos/XTLS/Xray-core/releases/latest', {
    headers: { 'User-Agent': 'RemnaMatcher', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!rel.ok) throw new Error(`GitHub API ${rel.status}`);
  const json = (await rel.json()) as { assets: { name: string; browser_download_url: string }[] };
  const url = json.assets.find((a) => a.name === asset)?.browser_download_url;
  if (!url) throw new Error(`в релизе xray нет ассета ${asset}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`скачивание xray: HTTP ${res.status}`);
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  const entry = zip.getEntry(process.platform === 'win32' ? 'xray.exe' : 'xray');
  if (!entry) throw new Error('в архиве xray нет бинарника');
  fs.mkdirSync(XRAY_DIR, { recursive: true });
  fs.writeFileSync(XRAY_BIN, entry.getData(), { mode: 0o755 });
  return XRAY_BIN;
}

// ---- ссылка → outbound xray ----

/** выкинуть undefined-поля, чтобы конфиг xray не захламлялся null-ами */
function clean<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

/** streamSettings из query-параметров ссылки vless/trojan (type, security, sni, pbk, …) */
function streamFromParams(q: URLSearchParams): Record<string, unknown> {
  let network = (q.get('type') || 'tcp').toLowerCase();
  if (network === 'splithttp') network = 'xhttp';
  if (network === 'h2') network = 'http';
  if (network === 'mkcp') network = 'kcp';
  const security = (q.get('security') || 'none').toLowerCase();
  const host = q.get('host') || undefined;
  const p = q.get('path') || undefined;
  const ss: Record<string, unknown> = { network, security };
  if (network === 'ws') ss.wsSettings = clean({ path: p ?? '/', host });
  else if (network === 'grpc') ss.grpcSettings = { serviceName: q.get('serviceName') ?? '' };
  else if (network === 'httpupgrade') ss.httpupgradeSettings = clean({ path: p ?? '/', host });
  else if (network === 'xhttp') ss.xhttpSettings = clean({ path: p ?? '/', host, mode: q.get('mode') || undefined });
  else if (network === 'http') ss.httpSettings = clean({ path: p ?? '/', host: host?.split(',') });
  else if (network === 'kcp') ss.kcpSettings = clean({ header: { type: q.get('headerType') || 'none' }, seed: q.get('seed') || undefined });
  else if (network === 'tcp' && q.get('headerType') === 'http') {
    ss.tcpSettings = { header: { type: 'http', request: { path: [p ?? '/'], headers: host ? { Host: host.split(',') } : {} } } };
  }
  if (security === 'tls') {
    ss.tlsSettings = clean({
      serverName: q.get('sni') || host,
      fingerprint: q.get('fp') || undefined,
      alpn: q.get('alpn') ? q.get('alpn')!.split(',').filter(Boolean) : undefined,
      allowInsecure: ['1', 'true'].includes(q.get('allowInsecure') ?? q.get('insecure') ?? '') || undefined,
    });
  } else if (security === 'reality') {
    ss.realitySettings = clean({
      serverName: q.get('sni') || undefined,
      fingerprint: q.get('fp') || 'chrome',
      publicKey: q.get('pbk') || undefined,
      shortId: q.get('sid') || undefined,
      spiderX: q.get('spx') || undefined,
    });
  }
  return ss;
}

/** vless://uuid@host:port?… и trojan://pass@host:port?… → outbound */
function uriOutbound(link: string): Record<string, unknown> | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  const proto = u.protocol.replace(':', '').toLowerCase();
  const address = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port) || (proto === 'trojan' ? 443 : 0);
  const user = decodeURIComponent(u.username);
  if (!address || !port || !user) return null;
  const stream = streamFromParams(u.searchParams);
  if (proto === 'vless') {
    return {
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address,
            port,
            users: [clean({ id: user, encryption: u.searchParams.get('encryption') || 'none', flow: u.searchParams.get('flow') || undefined })],
          },
        ],
      },
      streamSettings: stream,
    };
  }
  return { protocol: 'trojan', settings: { servers: [{ address, port, password: user }] }, streamSettings: stream };
}

/** vmess://base64(JSON) → outbound */
function vmessOutbound(link: string): Record<string, unknown> | null {
  const decoded = tryBase64(link.slice('vmess://'.length));
  if (!decoded) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
  const address = String(j.add ?? '').trim();
  const port = Number(j.port) || 0;
  const uid = String(j.id ?? '');
  if (!address || !port || !uid) return null;
  let network = String(j.net ?? 'tcp').toLowerCase();
  if (network === 'h2') network = 'http';
  if (network === 'splithttp') network = 'xhttp';
  const security = j.tls && String(j.tls) !== 'none' ? 'tls' : 'none';
  const host = String(j.host ?? '') || undefined;
  const p = String(j.path ?? '') || undefined;
  const stream: Record<string, unknown> = { network, security };
  if (network === 'ws') stream.wsSettings = clean({ path: p ?? '/', host });
  else if (network === 'grpc') stream.grpcSettings = { serviceName: p ?? '' };
  else if (network === 'http') stream.httpSettings = clean({ path: p ?? '/', host: host?.split(',') });
  else if (network === 'httpupgrade') stream.httpupgradeSettings = clean({ path: p ?? '/', host });
  else if (network === 'xhttp') stream.xhttpSettings = clean({ path: p ?? '/', host });
  else if (network === 'kcp') stream.kcpSettings = clean({ header: { type: String(j.type ?? 'none') }, seed: p });
  else if (network === 'tcp' && String(j.type ?? '') === 'http') {
    stream.tcpSettings = { header: { type: 'http', request: { path: [p ?? '/'], headers: host ? { Host: host.split(',') } : {} } } };
  }
  if (security === 'tls') {
    stream.tlsSettings = clean({
      serverName: String(j.sni ?? '') || host,
      fingerprint: String(j.fp ?? '') || undefined,
      alpn: String(j.alpn ?? '') ? String(j.alpn).split(',') : undefined,
    });
  }
  return {
    protocol: 'vmess',
    settings: { vnext: [{ address, port, users: [{ id: uid, alterId: Number(j.aid) || 0, security: String(j.scy ?? '') || 'auto' }] }] },
    streamSettings: stream,
  };
}

/** ss://base64(method:pass@host:port) или SIP002 ss://userinfo@host:port → outbound */
function ssOutbound(link: string): Record<string, unknown> | null {
  const main = (link.slice('ss://'.length).split('#')[0] ?? '').split(/[/?]/)[0] ?? '';
  let method: string;
  let password: string;
  let hostPort: string;
  if (main.includes('@')) {
    const at = main.lastIndexOf('@');
    const userinfo = main.slice(0, at);
    hostPort = main.slice(at + 1);
    // userinfo — либо base64(method:pass), либо plain method:pass (2022-шифры, percent-encoded)
    const dec = tryBase64(userinfo);
    let creds: string;
    if (dec?.includes(':')) creds = dec;
    else {
      try {
        creds = decodeURIComponent(userinfo);
      } catch {
        creds = userinfo;
      }
    }
    const c = creds.indexOf(':');
    if (c < 0) return null;
    method = creds.slice(0, c);
    password = creds.slice(c + 1);
  } else {
    const dec = tryBase64(main);
    if (!dec) return null;
    const at = dec.lastIndexOf('@');
    if (at < 0) return null;
    hostPort = dec.slice(at + 1);
    const creds = dec.slice(0, at);
    const c = creds.indexOf(':');
    if (c < 0) return null;
    method = creds.slice(0, c);
    password = creds.slice(c + 1);
  }
  const m = /^(.+?):(\d+)$/.exec(hostPort);
  if (!m?.[1] || !m[2]) return null;
  return {
    protocol: 'shadowsocks',
    settings: { servers: [{ address: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]), method, password }] },
  };
}

/** Полный outbound для сервера подписки: из сохранённого JSON-конфига либо из ссылки */
export function serverOutbound(s: SubServer): Record<string, unknown> | null {
  if (s.outbound && typeof s.outbound === 'object') return { ...(s.outbound as Record<string, unknown>) };
  if (!s.link) return null;
  const lower = s.link.toLowerCase();
  try {
    if (lower.startsWith('vless://') || lower.startsWith('trojan://')) return uriOutbound(s.link);
    if (lower.startsWith('vmess://')) return vmessOutbound(s.link);
    if (lower.startsWith('ss://')) return ssOutbound(s.link);
  } catch {
    /* кривая ссылка — этому серверу останется TCP-фолбэк */
  }
  return null;
}

// ---- сам URL-тест ----

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** ждать, пока xray откроет первый inbound-порт (или упасть с его stderr) */
function waitStart(port: number, child: ChildProcess, stderr: { text: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let exited = false;
    child.once('exit', () => {
      exited = true;
    });
    const attempt = () => {
      if (exited) {
        const last = stderr.text.trim().split('\n').pop() ?? '';
        return reject(new Error(`xray не запустился${last ? `: ${last.slice(0, 200)}` : ''}`));
      }
      if (Date.now() - started > XRAY_START_TIMEOUT_MS) return reject(new Error('xray не открыл порт вовремя'));
      const sock = net.createConnection({ host: '127.0.0.1', port, timeout: 300 });
      const retry = () => {
        sock.destroy();
        setTimeout(attempt, 150);
      };
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', retry);
      sock.once('timeout', retry);
    };
    attempt();
  });
}

/** один сервер: SAMPLES запросов через его локальный http-прокси, в зачёт — лучший */
async function probe(port: number): Promise<UrlTestResult> {
  let best: number | null = null;
  for (let i = 0; i < SAMPLES; i++) {
    // каждый замер на свежем соединении — как у observatory, честно с рукопожатием
    const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
    const t0 = Date.now();
    try {
      const res = await request(DESTINATION, {
        method: 'GET',
        dispatcher: agent,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await res.body.dump();
      if (res.statusCode >= 200 && res.statusCode < 400) {
        const dt = Date.now() - t0;
        best = best == null ? dt : Math.min(best, dt);
      }
    } catch {
      /* замер не удался — возможно, следующий пройдёт */
    } finally {
      await agent.close().catch(() => {});
    }
  }
  return { ok: best != null, latencyMs: best };
}

/**
 * Прогнать URL-тест по списку outbound'ов. Поднимает один временный процесс xray
 * со всеми серверами сразу и возвращает результат по каждому ключу.
 * Бросает, если xray не удалось скачать/запустить (тогда зовущий падает на TCP-фолбэк).
 */
export async function urlTestOutbounds(
  items: { key: string; outbound: Record<string, unknown> }[],
): Promise<Record<string, UrlTestResult>> {
  if (items.length === 0) return {};
  const bin = await ensureLocalXray();
  const ports: number[] = [];
  for (let i = 0; i < items.length; i++) ports.push(await freePort());

  const cfg = {
    log: { loglevel: 'none' },
    inbounds: items.map((_, i) => ({ tag: `in-${i}`, listen: '127.0.0.1', port: ports[i], protocol: 'http' })),
    outbounds: items.map((it, i) => ({ ...it.outbound, tag: `out-${i}` })),
    routing: {
      rules: items.map((_, i) => ({ type: 'field', inboundTag: [`in-${i}`], outboundTag: `out-${i}` })),
    },
  };
  const cfgPath = path.join(XRAY_DIR, `urltest-${process.pid}-${Date.now()}.json`);
  fs.mkdirSync(XRAY_DIR, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  const stderr = { text: '' };
  const child = spawn(bin, ['run', '-c', cfgPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', (d: Buffer) => (stderr.text += d.toString()));
  try {
    await waitStart(ports[0]!, child, stderr);
    const results: Record<string, UrlTestResult> = {};
    // пачками, чтобы большая подписка не жгла сотню одновременных соединений
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      await Promise.all(
        items.slice(i, i + CONCURRENCY).map(async (it, k) => {
          results[it.key] = await probe(ports[i + k]!);
        }),
      );
    }
    return results;
  } finally {
    child.kill();
    fs.rmSync(cfgPath, { force: true });
  }
}
