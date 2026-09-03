import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { secretKey } from './servers.js';

// Инфраструктура → конфигурации: импорт подписок, как в Happ.
// Панель скачивает подписку по URL (представляясь Happ) и разбирает список серверов:
//   · тело из ссылок vless:// vmess:// trojan:// ss:// (возможно целиком в base64)
//   · JSON-подписка: массив конфигов xray с remarks — каждый конфиг становится строкой,
//     несколько прокси-выходов внутри показываются раскрываемым пулом (балансировщик)
// Запрос несёт HWID-заголовки, как настоящий Happ: панели с лимитом устройств без них
// отдают заглушку «приложение не поддерживается». HWID либо задаётся в настройках раздела
// (свой, общий для всех подписок — например, от реального устройства), либо выводится
// из локального секрета + URL, так что у провайдера панель занимает максимум один слот.

export interface SubServer {
  /** протокол: VLESS/VMESS/TROJAN/SS; у пула — общий протокол серверов или MIXED */
  protocol: string;
  name: string;
  /** эмодзи-флаг, вытащенный из имени сервера (как рисует Happ) */
  flag: string | null;
  address: string;
  port: number | null;
  transport: string | null;
  security: string | null;
  /** запись пришла из JSON-конфига xray, а не из ссылки */
  fromJson?: boolean;
  /** исходная ссылка vless://… — из неё собирается outbound для URL-теста */
  link?: string;
  /** исходный outbound из JSON-конфига — готовый outbound для URL-теста */
  outbound?: unknown;
  /** балансировщик: раскрываемый пул серверов */
  pool?: SubServer[];
}

export interface RedSubscriptionRow {
  id: number;
  name: string;
  url: string;
  servers: string; // JSON SubServer[]
  server_count: number;
  last_error: string | null;
  traffic_used: number | null; // байт потрачено (из subscription-userinfo)
  traffic_total: number | null; // лимит в байтах; 0 = безлимит
  expire_at: number | null; // срок подписки, мс
  updated_at: number | null;
  created_at: number;
}

/** трафик и срок из заголовка subscription-userinfo: `upload=…; download=…; total=…; expire=…` */
export interface SubUserinfo {
  used: number | null;
  total: number | null;
  expireAt: number | null;
}

export function parseUserinfo(h: string | null): SubUserinfo {
  if (!h) return { used: null, total: null, expireAt: null };
  const kv: Record<string, number> = {};
  for (const part of h.split(';')) {
    const m = /^\s*(\w+)\s*=\s*(-?\d+)\s*$/.exec(part);
    if (m?.[1] && m[2] != null) kv[m[1].toLowerCase()] = Number(m[2]);
  }
  const hasUsage = kv.upload != null || kv.download != null;
  return {
    used: hasUsage ? (kv.upload ?? 0) + (kv.download ?? 0) : null,
    total: kv.total != null && kv.total >= 0 ? kv.total : null,
    expireAt: kv.expire != null && kv.expire > 0 ? kv.expire * 1000 : null,
  };
}

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 3_000_000;

// пара региональных индикаторов = эмодзи-флаг страны
const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u;

/** вытащить флаг из имени: Happ показывает его отдельным квадратом слева */
function splitFlag(raw: string): { flag: string | null; name: string } {
  const s = raw.trim();
  const m = FLAG_RE.exec(s);
  if (!m) return { flag: null, name: s };
  const rest = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/\s{2,}/g, ' ').trim();
  return { flag: m[0], name: rest || s };
}

/** аккуратный base64-декод (обычный и url-safe); null, если это не base64-текст */
export function tryBase64(s: string): string | null {
  const cleaned = s.replace(/\s+/g, '');
  if (cleaned.length < 8 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(cleaned)) return null;
  try {
    const norm = cleaned.replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(norm + '='.repeat((4 - (norm.length % 4)) % 4), 'base64');
    const text = buf.toString('utf8');
    // обратная перекодировка не сходится → внутри был не текст, а бинарь
    if (Buffer.byteLength(text, 'utf8') !== buf.length) return null;
    return text;
  } catch {
    return null;
  }
}

function safeDecodeUri(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---- разбор ссылок ----

/** vless://uuid@host:port?type=…&security=…#имя и trojan://pass@host:port?…#имя */
function parseVlessTrojan(line: string): SubServer | null {
  let u: URL;
  try {
    u = new URL(line);
  } catch {
    return null;
  }
  const proto = u.protocol.replace(':', '').toLowerCase();
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return null;
  const { flag, name } = splitFlag(safeDecodeUri(u.hash.slice(1)) || host);
  return {
    protocol: proto.toUpperCase(),
    name,
    flag,
    address: host,
    port: u.port ? Number(u.port) : proto === 'trojan' ? 443 : null,
    transport: (u.searchParams.get('type') || 'tcp').toLowerCase(),
    security: (u.searchParams.get('security') || (proto === 'trojan' ? 'tls' : 'none')).toLowerCase(),
  };
}

/** vmess://base64({ps, add, port, net, tls, …}) */
function parseVmess(line: string): SubServer | null {
  const decoded = tryBase64(line.slice('vmess://'.length));
  if (!decoded) return null;
  try {
    const j = JSON.parse(decoded) as { ps?: unknown; add?: unknown; port?: unknown; net?: unknown; tls?: unknown };
    const address = String(j.add ?? '').trim();
    if (!address) return null;
    const { flag, name } = splitFlag(String(j.ps ?? '') || address);
    return {
      protocol: 'VMESS',
      name,
      flag,
      address,
      port: Number(j.port) || null,
      transport: String(j.net ?? 'tcp').toLowerCase(),
      security: j.tls ? String(j.tls).toLowerCase() : 'none',
    };
  } catch {
    return null;
  }
}

/** ss://base64(method:pass@host:port)#имя или SIP002 ss://userinfo@host:port#имя */
function parseSs(line: string): SubServer | null {
  const rest = line.slice('ss://'.length);
  const hashIdx = rest.indexOf('#');
  const main = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  const label = hashIdx >= 0 ? safeDecodeUri(rest.slice(hashIdx + 1)) : '';
  let hostPort: string;
  if (main.includes('@')) {
    hostPort = main.slice(main.lastIndexOf('@') + 1);
  } else {
    const dec = tryBase64(main);
    if (!dec || !dec.includes('@')) return null;
    hostPort = dec.slice(dec.lastIndexOf('@') + 1);
  }
  const m = /^(.+?):(\d+)$/.exec(hostPort.split(/[/?]/)[0] ?? '');
  if (!m?.[1] || !m[2]) return null;
  const address = m[1].replace(/^\[|\]$/g, '');
  const { flag, name } = splitFlag(label || address);
  return { protocol: 'SS', name, flag, address, port: Number(m[2]), transport: 'tcp', security: null };
}

// ---- разбор JSON-подписки (конфиги xray, формат Happ/Streisand) ----

interface XrayOutbound {
  protocol?: unknown;
  tag?: unknown;
  settings?: {
    vnext?: { address?: unknown; port?: unknown }[];
    servers?: { address?: unknown; port?: unknown }[];
  };
  streamSettings?: { network?: unknown; security?: unknown };
}

const PROXY_PROTOS = new Set(['vless', 'vmess', 'trojan', 'shadowsocks']);

function outboundToServer(o: XrayOutbound): SubServer | null {
  const proto = String(o?.protocol ?? '').toLowerCase();
  if (!PROXY_PROTOS.has(proto)) return null;
  const vnext = o.settings?.vnext?.[0];
  const srv = o.settings?.servers?.[0];
  const address = String(vnext?.address ?? srv?.address ?? '').trim();
  if (!address) return null;
  const { flag, name } = splitFlag(String(o.tag ?? '') || proto);
  return {
    protocol: proto === 'shadowsocks' ? 'SS' : proto.toUpperCase(),
    name,
    flag,
    address,
    port: Number(vnext?.port ?? srv?.port) || null,
    transport: String(o.streamSettings?.network ?? 'tcp').toLowerCase(),
    security: String(o.streamSettings?.security ?? 'none').toLowerCase(),
    fromJson: true,
    outbound: o,
  };
}

/** один конфиг xray → одна строка списка; несколько прокси-выходов → пул (балансировщик) */
function entriesFromJsonConfig(cfg: { remarks?: unknown; outbounds?: unknown }, idx: number): SubServer[] {
  const outs = Array.isArray(cfg?.outbounds) ? (cfg.outbounds as XrayOutbound[]) : [];
  const proxies = outs.map(outboundToServer).filter((s): s is SubServer => s != null);
  const first = proxies[0];
  if (!first) return [];
  const { flag, name } = splitFlag(String(cfg.remarks ?? '') || `JSON-конфиг ${idx + 1}`);
  if (proxies.length === 1) {
    return [{ ...first, name: name || first.name, flag: flag ?? first.flag }];
  }
  const protos = new Set(proxies.map((p) => p.protocol));
  return [
    {
      protocol: protos.size === 1 ? first.protocol : 'MIXED',
      name,
      flag,
      address: '',
      port: null,
      transport: null,
      security: null,
      fromJson: true,
      pool: proxies,
    },
  ];
}

/** Разбор тела подписки в список серверов. Неизвестные строки молча пропускаются. */
export function parseSubscriptionBody(body: string): SubServer[] {
  const text = body.trim();

  // JSON-подписка: массив конфигов xray либо один конфиг
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const j = JSON.parse(text) as unknown;
      const cfgs = Array.isArray(j) ? j : [j];
      const entries = cfgs.flatMap((c, i) => entriesFromJsonConfig(c as { remarks?: unknown; outbounds?: unknown }, i));
      if (entries.length > 0) return entries;
    } catch {
      /* не JSON — пробуем как список ссылок */
    }
  }

  // тело нередко целиком закодировано в base64
  let list = text;
  if (!text.includes('://')) {
    const dec = tryBase64(text);
    if (dec?.includes('://')) list = dec;
  }

  const out: SubServer[] = [];
  for (const rawLine of list.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const lower = line.toLowerCase();
    let s: SubServer | null = null;
    if (lower.startsWith('vless://') || lower.startsWith('trojan://')) s = parseVlessTrojan(line);
    else if (lower.startsWith('vmess://')) s = parseVmess(line);
    else if (lower.startsWith('ss://')) s = parseSs(line);
    // ссылку храним целиком: в разборе выше теряются креды, а URL-тесту нужен полный outbound
    if (s) out.push({ ...s, link: line });
  }
  return out;
}

/** ключ настройки с пользовательским HWID для импорта подписок (пусто/нет — авто) */
export const SUB_HWID_SETTING = 'red_sub_hwid';
/** допустимый вид HWID: то, что клиенты шлют в x-hwid — hex/uuid-подобные строки */
export const HWID_RE = /^[A-Za-z0-9-]{4,64}$/;

/** Стабильный HWID «устройства»-панели для этого URL: секрет установки + адрес подписки (16 hex, как у Happ) */
export function stableHwid(url: string): string {
  return createHash('sha256').update(secretKey()).update('|sub-hwid|').update(url).digest('hex').slice(0, 16);
}

/** HWID для запроса подписки: заданный в настройках раздела либо авто-выведенный из URL */
export function subscriptionHwid(db: Database.Database, url: string): string {
  const row = db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?').get(SUB_HWID_SETTING);
  const custom = row?.value.trim();
  return custom && HWID_RE.test(custom) ? custom : stableHwid(url);
}

/** имя профиля из заголовка profile-title: бывает голым текстом или base64 с префиксом */
function decodeProfileTitle(h: string | null): string | null {
  if (!h) return null;
  const v = h.trim();
  if (/^base64:/i.test(v)) return tryBase64(v.slice('base64:'.length))?.trim() || null;
  return v || null;
}

/** Скачать тело подписки. Представляемся Happ — панели отдают этому UA клиентский формат. */
export async function fetchSubscription(
  url: string,
  hwid: string,
): Promise<{ body: string; profileTitle: string | null; userinfo: SubUserinfo }> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Happ/1.6.5',
      Accept: '*/*',
      // как настоящий клиент: панели с HWID-лимитом требуют эти заголовки
      'x-hwid': hwid,
      'x-device-os': 'Windows',
      'x-ver-os': '11',
      'x-device-model': 'RemnaMatcher',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`подписка ответила HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BODY_BYTES) throw new Error('подписка слишком большая (>3 МБ)');
  return {
    body: buf.toString('utf8'),
    profileTitle: decodeProfileTitle(res.headers.get('profile-title')),
    userinfo: parseUserinfo(res.headers.get('subscription-userinfo')),
  };
}

// заглушка-«сервер», которой панели отвечают вместо списка (не поддерживаемое приложение,
// превышен лимит устройств и т.п.) — адрес 0.0.0.0, а текст сообщения лежит в имени
const isStub = (s: SubServer) => s.address === '0.0.0.0' || s.address === '127.0.0.1' || (s.port != null && s.port <= 1);

/** запасное имя подписки — хост из её URL */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 60);
  }
}

/**
 * Перечитать подписку: скачать, разобрать, записать в базу.
 * Название необязательно: пустое заполняется из заголовка profile-title (так делает Happ),
 * а если панель его не шлёт — хостом из URL. Введённое руками имя не перезаписывается.
 * При ошибке старый разбор не трогаем — подписка могла быть временно недоступна.
 */
export async function refreshSubscription(db: Database.Database, id: number): Promise<RedSubscriptionRow | null> {
  const row = db.prepare<[number], RedSubscriptionRow>('SELECT * FROM red_subscriptions WHERE id = ?').get(id);
  if (!row) return null;
  try {
    const { body, profileTitle, userinfo } = await fetchSubscription(row.url, subscriptionHwid(db, row.url));
    const servers = parseSubscriptionBody(body);
    if (servers.length === 0) throw new Error('в ответе не нашлось ни одного сервера');
    // одни заглушки — показываем сообщение панели провайдера как ошибку импорта
    if (servers.every(isStub)) {
      throw new Error(`панель провайдера не отдала серверы: «${servers[0]?.name ?? 'без описания'}»`);
    }
    const count = servers.reduce((n, s) => n + (s.pool ? s.pool.length : 1), 0);
    const name = row.name || (profileTitle ?? '').slice(0, 60) || hostOf(row.url);
    db.prepare(
      `UPDATE red_subscriptions SET name = ?, servers = ?, server_count = ?, last_error = NULL,
       traffic_used = ?, traffic_total = ?, expire_at = ?, updated_at = ? WHERE id = ?`,
    ).run(name, JSON.stringify(servers), count, userinfo.used, userinfo.total, userinfo.expireAt, Date.now(), id);
  } catch (e) {
    // безымянной подписке даём хотя бы хост — карточка не должна остаться без подписи
    if (!row.name) db.prepare('UPDATE red_subscriptions SET name = ? WHERE id = ?').run(hostOf(row.url), id);
    db.prepare('UPDATE red_subscriptions SET last_error = ? WHERE id = ?').run(
      e instanceof Error ? e.message : String(e),
      id,
    );
  }
  return db.prepare<[number], RedSubscriptionRow>('SELECT * FROM red_subscriptions WHERE id = ?').get(id) ?? null;
}
