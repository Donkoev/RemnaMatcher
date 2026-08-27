export interface Signal {
  key: string;
  label: string;
  points: number;
  evidence: string;
}

export type Level = 'green' | 'yellow' | 'orange' | 'red';

export interface Overview {
  mode: 'mock' | 'live';
  totals: {
    activeIps: number;
    uniqueIps: number;
    activeUsers: number;
    totalUsers: number;
    openIncidents: number;
  };
  levels: Partial<Record<Level, number>>;
  nodes: NodeStatus[];
}

export interface NodeStatus {
  node_uuid: string;
  name: string;
  country: string;
  last_ok_at: number | null;
  last_err: string | null;
  users_seen: number;
  ips_seen: number;
}

export interface SuspectIp {
  nodeUuid: string;
  nodeName: string | null;
  nodeCountry: string | null;
  ip: string;
  lastSeen: number;
  asn: number | null;
  asnOrg: string | null;
  country: string | null;
  city: string | null;
  isDc: 0 | 1 | null;
}

export interface SuspectNode {
  nodeName: string;
  nodeCountry: string;
  ips: SuspectIp[];
}

export interface Suspect {
  userId: number;
  score: number;
  level: Level;
  signals: Signal[];
  activeIps: number;
  uniqueIps: number;
  updatedAt: number;
  username: string | null;
  status: string | null;
  telegramId: number | null;
  whitelisted: 1 | null;
  nodes: SuspectNode[];
}

export interface ActionLogEntry {
  id: number;
  ts: number;
  userId: number | null;
  action: string;
  source: string;
  ok: 0 | 1;
  error: string | null;
  username: string | null;
}

export interface UserIp {
  ip: string;
  lastSeen: number;
  firstSeen: number;
  nodes: string | null;
  asn: number | null;
  asnOrg: string | null;
  country: string | null;
  city: string | null;
  isDc: 0 | 1 | null;
  isActive: 0 | 1;
}

export interface UserDetail {
  user: {
    id: number;
    uuid: string;
    username: string;
    status: string;
    telegram_id: number | null;
    used_traffic: number;
    traffic_limit: number;
    sub_url: string | null;
    online_at: number | null;
    expire_at: number | null;
  };
  whitelisted: boolean;
  score: {
    score: number;
    level: Level;
    signals: Signal[];
    // проверки, которые срабатывали раньше и чьи очки ещё не затухли
    signalsSeen?: Record<string, { at: number; points: number; evidence: string }>;
    active_ips: number;
    updated_at: number;
  } | null;
  ips: UserIp[];
  // имя ноды → страна, для флагов в колонке «Нода»
  nodeCatalog: { name: string; country: string | null }[];
  // активные пары «нода × IP» (Σ с карточки)
  activePerNode: number;
  // сколько часов хранятся наблюдения («вся история»)
  retentionHours: number;
  incidents: Incident[];
  traffic: { ts: number; used: number }[];
  log: { ts: number; action: string; source: string; ok: 0 | 1; error: string | null }[];
  torrents: { ip: string; node: string; createdAt: number }[];
  hwid: { count: number | null; limit: number | null };
}

export interface Incident {
  id: number;
  userId: number;
  createdAt: number;
  level: Level;
  score: number;
  signals: Signal[];
  status: 'open' | 'actioned' | 'ignored';
  username?: string | null;
}

export interface ScoringConfig {
  activeWindowMin: number;
  thresholds: { yellow: number; orange: number; red: number };
  decayHalfLifeHours: number;
  trafficRateBps: number;
  alertCooldownHours: number;
  telegramAlertsEnabled: boolean;
  uniqueWindowMin: number;
  collector: {
    pollIntervalSec: number;
    nodePollGapMs: number;
    userSyncIntervalSec: number;
    retentionHours: number;
  };
  signals: {
    multiAsn: { enabled: boolean; minAsns: number };
    multiCountry: { enabled: boolean };
    datacenter: { enabled: boolean };
    ipCount: { enabled: boolean; minIps: number; perDeviceIps: number };
    trafficRate: { enabled: boolean };
    torrent: { enabled: boolean };
  };
}

/** Русские склонения: plural(5, ['очко', 'очка', 'очков']) → 'очков' */
export function plural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (d === 1) return forms[0];
  if (d >= 2 && d <= 4) return forms[1];
  return forms[2];
}

export interface PunishedUser {
  userId: number;
  username: string | null;
  status: string | null;
  actionCount: number;
  actions: string;
  lastTs: number;
}

export interface WhitelistedUser {
  userId: number;
  username: string | null;
  status: string | null;
  addedAt: number;
}

export type ActionName = 'revoke' | 'disable' | 'enable' | 'drop' | 'whitelist' | 'unwhitelist';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    // сессия умерла — показываем экран входа (401 от самих auth-ручек не считается)
    if (res.status === 401 && !url.startsWith('/api/auth/')) {
      window.dispatchEvent(new Event('rm-unauthorized'));
    }
    const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

const post = <T,>(url: string, body: unknown): Promise<T> =>
  json<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const authApi = {
  status: () => json<{ setup: boolean; authorized: boolean }>('/api/auth/status'),
  setup: (password: string) => post<{ ok: boolean }>('/api/auth/setup', { password }),
  login: (password: string) => post<{ ok: boolean }>('/api/auth/login', { password }),
  logout: () => post<{ ok: boolean }>('/api/auth/logout', {}),
  changePassword: (current: string, next: string) => post<{ ok: boolean }>('/api/auth/password', { current, next }),
};

export const api = {
  overview: () => json<Overview>('/api/overview'),
  suspects: (level?: string, search?: string) => {
    const p = new URLSearchParams();
    if (level) p.set('level', level);
    if (search) p.set('search', search);
    return json<Suspect[]>(`/api/suspects?${p}`);
  },
  user: (id: number) => json<UserDetail>(`/api/users/${id}`),
  incidents: (status?: string) =>
    json<Incident[]>(`/api/incidents${status ? `?status=${status}` : ''}`),
  actionsLog: () => json<ActionLogEntry[]>('/api/actions-log'),
  lists: () => json<{ punished: PunishedUser[]; whitelist: WhitelistedUser[] }>('/api/lists'),
  settings: () => json<ScoringConfig>('/api/settings'),
  saveSettings: (cfg: ScoringConfig) =>
    json<{ ok: boolean }>('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    }),
  action: (action: ActionName, userId: number) =>
    json<{ ok: boolean; message: string }>(`/api/actions/${action}/${userId}`, { method: 'POST' }),
};

export function flagEmoji(iso: string | null): string {
  if (!iso || iso.length !== 2) return '🌐';
  const base = 0x1f1e6;
  const a = iso.toUpperCase().charCodeAt(0) - 65;
  const b = iso.toUpperCase().charCodeAt(1) - 65;
  if (a < 0 || a > 25 || b < 0 || b > 25) return '🌐';
  return String.fromCodePoint(base + a, base + b);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

/** Подчистка городов из DB-IP Lite: убираем уточнения в скобках и апострофы транслита */
export function cleanCity(city: string | null): string | null {
  if (!city) return city;
  return city.replace(/\s*\(.+?\)\s*/g, ' ').replace(/'/g, '').trim() || city;
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)} с назад`;
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return `${Math.floor(s / 86400)} дн назад`;
}
