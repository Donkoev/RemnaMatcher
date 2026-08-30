import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { env } from '../config.js';
import type { RemnaReader } from '../remnawave/types.js';
import type { Actions, ActionName } from '../actions.js';
import { bus } from '../events.js';
import { DEFAULT_CONFIG, type ScoringConfig } from '../scoring/rules.js';
import { Auth, hashPassword, verifyPassword } from './auth.js';

const GITHUB_REPO = 'Donkoev/RemnaMatcher';
const VERSION: string = (
  JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

/** сравнение версий x.y.z: положительное — a новее b */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function loadScoringConfig(db: Database.Database): ScoringConfig {
  const row = db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?').get('scoring');
  if (!row) return DEFAULT_CONFIG;
  try {
    const parsed = JSON.parse(row.value) as Partial<ScoringConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      collector: { ...DEFAULT_CONFIG.collector, ...parsed.collector },
      signals: {
        multiAsn: { ...DEFAULT_CONFIG.signals.multiAsn, ...parsed.signals?.multiAsn },
        multiCountry: { ...DEFAULT_CONFIG.signals.multiCountry, ...parsed.signals?.multiCountry },
        datacenter: { ...DEFAULT_CONFIG.signals.datacenter, ...parsed.signals?.datacenter },
        ipCount: { ...DEFAULT_CONFIG.signals.ipCount, ...parsed.signals?.ipCount },
        trafficRate: { ...DEFAULT_CONFIG.signals.trafficRate, ...parsed.signals?.trafficRate },
        torrent: { ...DEFAULT_CONFIG.signals.torrent, ...parsed.signals?.torrent },
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

const ScoringConfigSchema = z.object({
  activeWindowMin: z.number().min(1).max(60),
  uniqueWindowMin: z.number().min(1).max(120),
  collector: z.object({
    pollIntervalSec: z.number().min(15).max(3600),
    nodePollGapMs: z.number().min(0).max(60_000),
    nodeConcurrency: z.number().min(1).max(20),
    userSyncIntervalSec: z.number().min(60).max(86_400),
    retentionHours: z.number().min(6).max(720),
  }),
  thresholds: z.object({
    yellow: z.number().min(1),
    orange: z.number().min(1),
    red: z.number().min(1),
  }),
  decayHalfLifeHours: z.number().min(0.5).max(168),
  trafficRateBps: z.number().min(0),
  alertCooldownHours: z.number().min(0).max(168),
  hwidAutobanEnabled: z.boolean(),
  telegramAlertsEnabled: z.boolean(),
  signals: z.object({
    multiAsn: z.object({ enabled: z.boolean(), minAsns: z.number().min(2).max(20) }),
    multiCountry: z.object({ enabled: z.boolean() }),
    datacenter: z.object({ enabled: z.boolean() }),
    ipCount: z.object({
      enabled: z.boolean(),
      minIps: z.number().min(2).max(100),
      perDeviceIps: z.number().min(1).max(10),
    }),
    trafficRate: z.object({ enabled: z.boolean() }),
    torrent: z.object({ enabled: z.boolean() }),
  }),
});

export async function startApi(opts: {
  db: Database.Database;
  actions: Actions;
  port: number;
  mode: string;
  remna: RemnaReader;
  refineIps: (ips: string[]) => void;
}): Promise<void> {
  const { db, actions, port, remna, refineIps } = opts;
  // trustProxy: за reverse-proxy рейт-лимит логина считается по реальному IP из X-Forwarded-For
  const app = Fastify({ logger: false, trustProxy: true });
  await app.register(cors, { origin: true });
  await app.register(cookie);

  const webDist = path.resolve('../web/dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  // --- Авторизация: весь /api/* закрыт сессией, кроме самих auth-ручек ---
  const auth = new Auth(db);
  const SESSION_COOKIE = 'rm_session';
  const cookieOpts = { httpOnly: true, sameSite: 'lax' as const, path: '/', maxAge: 7 * 24 * 3600 };

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/auth/')) return;
    if (!auth.validate(req.cookies[SESSION_COOKIE])) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/api/auth/status', (req) => ({
    setup: !auth.hasPassword(),
    authorized: auth.validate(req.cookies[SESSION_COOKIE]),
  }));

  const PasswordBody = z.object({ password: z.string().min(8).max(200) });

  // первый запуск: пароля ещё нет — задаём и сразу логиним
  app.post('/api/auth/setup', async (req, reply) => {
    if (auth.hasPassword()) return reply.code(409).send({ error: 'пароль уже задан' });
    const parsed = PasswordBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'пароль — минимум 8 символов' });
    auth.setHash(await hashPassword(parsed.data.password));
    const token = auth.createSession(req.ip, req.headers['user-agent']);
    return reply.setCookie(SESSION_COOKIE, token, cookieOpts).send({ ok: true });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const lockedMs = auth.lockedFor(req.ip);
    if (lockedMs > 0) {
      return reply.code(429).send({ error: `слишком много попыток — подожди ${Math.ceil(lockedMs / 1000)} с` });
    }
    const parsed = PasswordBody.safeParse(req.body);
    const hash = auth.getHash();
    if (!parsed.success || !hash) return reply.code(400).send({ error: 'неверный пароль' });
    // лёгкое замедление против онлайн-перебора
    await new Promise((r) => setTimeout(r, 250));
    if (!(await verifyPassword(parsed.data.password, hash))) {
      auth.registerFail(req.ip);
      return reply.code(401).send({ error: 'неверный пароль' });
    }
    auth.clearFails(req.ip);
    const token = auth.createSession(req.ip, req.headers['user-agent']);
    return reply.setCookie(SESSION_COOKIE, token, cookieOpts).send({ ok: true });
  });

  app.post('/api/auth/logout', (req, reply) => {
    auth.destroySession(req.cookies[SESSION_COOKIE]);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true });
  });

  // смена пароля: требует текущий; все сессии сбрасываются, текущему выдаётся новая
  app.post('/api/auth/password', async (req, reply) => {
    if (!auth.validate(req.cookies[SESSION_COOKIE])) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = z
      .object({ current: z.string(), next: z.string().min(8).max(200) })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'новый пароль — минимум 8 символов' });
    const hash = auth.getHash();
    if (!hash || !(await verifyPassword(parsed.data.current, hash))) {
      return reply.code(401).send({ error: 'текущий пароль неверный' });
    }
    auth.setHash(await hashPassword(parsed.data.next));
    auth.destroyAllSessions();
    const token = auth.createSession(req.ip, req.headers['user-agent']);
    return reply.setCookie(SESSION_COOKIE, token, cookieOpts).send({ ok: true });
  });

  // последний цикл коллектора: длительность нужна и для окна «нода онлайн»
  // (на сотнях нод круг дольше 5 минут), и для показа реального времени опроса в UI
  let lastCycle = { at: 0, durationMs: 60_000 };
  bus.on('cycle', (ev) => {
    lastCycle = { at: ev.at, durationMs: ev.durationMs };
  });

  app.get('/api/overview', () => {
    const cfg = loadScoringConfig(db);
    const windowStart = Date.now() - cfg.activeWindowMin * 60_000;
    const totals = db
      .prepare<[number], { activeIps: number; uniqueIps: number; activeUsers: number }>(
        `SELECT COUNT(*) AS activeIps, COUNT(DISTINCT ip) AS uniqueIps, COUNT(DISTINCT user_id) AS activeUsers
         FROM ip_observations WHERE last_seen >= ?`,
      )
      .get(windowStart)!;
    const levels = db
      .prepare<[], { level: string; n: number }>('SELECT level, COUNT(*) AS n FROM score_state GROUP BY level')
      .all();
    const totalUsers = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM users').get()!.n;
    const nodes = db
      .prepare<[], { node_uuid: string; name: string; country: string; last_ok_at: number | null; last_err: string | null; users_seen: number; ips_seen: number }>(
        'SELECT * FROM node_status ORDER BY name',
      )
      .all();
    const openIncidents = db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM incidents WHERE status = 'open'")
      .get()!.n;
    // бейдж у «Журнала» показывает только НОВЫЕ инциденты — с момента последнего открытия журнала
    const seenTs = Number(
      db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?').get('incidents_seen_ts')
        ?.value ?? 0,
    );
    const newIncidents = db
      .prepare<[number], { n: number }>("SELECT COUNT(*) AS n FROM incidents WHERE status = 'open' AND created_at > ?")
      .get(seenTs)!.n;
    return {
      mode: opts.mode,
      totals: { ...totals, totalUsers, openIncidents, newIncidents },
      levels: Object.fromEntries(levels.map((l) => [l.level, l.n])),
      nodes,
      // нода «онлайн», если опрошена в пределах двух циклов (минимум 5 минут)
      nodeOnlineWindowMs: Math.max(300_000, lastCycle.durationMs * 2 + 60_000),
      lastCycle: lastCycle.at > 0 ? lastCycle : null,
    };
  });

  app.get('/api/suspects', (req) => {
    const q = req.query as { level?: string; search?: string; limit?: string };
    const limit = Math.min(Number(q.limit) || 100, 500);
    const cfg = loadScoringConfig(db);
    // IP, ушедший в офлайн дольше окна уникальных, выпадает из счётчика;
    // вернётся онлайн — last_seen обновится и он снова в счёте
    const params: unknown[] = [Date.now() - cfg.uniqueWindowMin * 60_000];
    // на главный экран не попадают юзеры из белого списка и отключённые —
    // они живут на своих страницах («Белый список» и «Наказанные»)
    let where =
      "NOT EXISTS (SELECT 1 FROM whitelist wl WHERE wl.user_id = s.user_id) AND (u.status IS NULL OR u.status != 'DISABLED')";
    if (q.level && ['yellow', 'orange', 'red'].includes(q.level)) {
      where += ' AND s.level = ?';
      params.push(q.level);
    } else {
      where += " AND s.level != 'green'";
    }
    if (q.search) {
      where +=
        ' AND (u.username LIKE ? OR CAST(u.id AS TEXT) LIKE ?' +
        ' OR EXISTS (SELECT 1 FROM ip_observations o WHERE o.user_id = s.user_id AND o.ip LIKE ?))';
      params.push(`%${q.search}%`, `%${q.search}%`, `%${q.search}%`);
    }
    params.push(limit);
    const rows = db
      .prepare(
        `SELECT s.user_id AS userId, s.score, s.level, s.signals, s.active_ips AS activeIps, s.updated_at AS updatedAt,
                u.username, u.status, u.telegram_id AS telegramId,
                (SELECT 1 FROM whitelist w WHERE w.user_id = s.user_id) AS whitelisted,
                (SELECT COUNT(DISTINCT o.ip) FROM ip_observations o WHERE o.user_id = s.user_id AND o.last_seen >= ?) AS uniqueIps,
                (SELECT COUNT(*) FROM actions_log al WHERE al.user_id = s.user_id AND al.ok = 1
                   AND al.action IN ('revoke', 'disable', 'drop', 'hwid_ban')) AS punishedCount
         FROM score_state s LEFT JOIN users u ON u.id = s.user_id
         WHERE ${where}
         ORDER BY s.score DESC
         LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown> & { signals: string; userId: number }>;

    // активные IP юзера, сгруппированные по нодам — для карточки в стиле «Обозревателя сессий»
    const windowStart = Date.now() - cfg.activeWindowMin * 60_000;
    const ipStmt = db.prepare(
      `SELECT o.node_uuid AS nodeUuid, ns.name AS nodeName, ns.country AS nodeCountry,
              o.ip, MAX(o.last_seen) AS lastSeen,
              m.asn, m.asn_org AS asnOrg, m.country, m.city, m.is_dc AS isDc
       FROM ip_observations o
       LEFT JOIN node_status ns ON ns.node_uuid = o.node_uuid
       LEFT JOIN ip_meta m ON m.ip = o.ip
       WHERE o.user_id = ? AND o.last_seen >= ?
       GROUP BY o.node_uuid, o.ip
       ORDER BY ns.name, lastSeen DESC
       LIMIT 120`,
    );

    return rows.map((r) => {
      const ipRows = ipStmt.all(r.userId, windowStart) as Array<{
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
      }>;
      const byNode = new Map<string, { nodeName: string; nodeCountry: string; ips: typeof ipRows }>();
      for (const ip of ipRows) {
        const key = ip.nodeUuid;
        const entry = byNode.get(key) ?? {
          nodeName: ip.nodeName ?? key,
          nodeCountry: ip.nodeCountry ?? 'XX',
          ips: [] as typeof ipRows,
        };
        entry.ips.push(ip);
        byNode.set(key, entry);
      }
      return {
        ...r,
        signals: JSON.parse(r.signals) as unknown,
        nodes: [...byNode.values()],
      };
    });
  });

  // Списки: наказанные (по журналу успешных карательных действий) и белый список
  app.get('/api/lists', () => {
    const punished = db
      .prepare(
        `SELECT a.user_id AS userId, u.username, u.status,
                COUNT(*) AS actionCount, GROUP_CONCAT(DISTINCT a.action) AS actions, MAX(a.ts) AS lastTs
         FROM actions_log a LEFT JOIN users u ON u.id = a.user_id
         WHERE a.ok = 1 AND a.action IN ('revoke', 'disable', 'drop')
         GROUP BY a.user_id
         ORDER BY lastTs DESC
         LIMIT 300`,
      )
      .all();
    const whitelist = db
      .prepare(
        `SELECT w.user_id AS userId, w.added_at AS addedAt, u.username, u.status
         FROM whitelist w LEFT JOIN users u ON u.id = w.user_id
         ORDER BY w.added_at DESC`,
      )
      .all();
    return { punished, whitelist };
  });

  app.get('/api/actions-log', () => {
    return db
      .prepare(
        `SELECT a.id, a.ts, a.user_id AS userId, a.action, a.source, a.ok, a.error, u.username
         FROM actions_log a LEFT JOIN users u ON u.id = a.user_id
         ORDER BY a.ts DESC LIMIT 200`,
      )
      .all();
  });

  app.get('/api/users/:id', async (req, reply) => {
    const userId = Number((req.params as { id: string }).id);
    if (!Number.isFinite(userId)) return reply.code(400).send({ error: 'bad id' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as
      | (Record<string, unknown> & { uuid: string; hwid_limit: number | null })
      | undefined;
    if (!user) return reply.code(404).send({ error: 'user not found' });

    // устройства — из локального зеркала (быстро); пока зеркало пустое — живой счётчик с панели
    const devices = db
      .prepare<[number], { hwid: string; platform: string | null; osVersion: string | null; deviceModel: string | null; firstSeen: number; lastSeen: number }>(
        `SELECT hwid, platform, os_version AS osVersion, device_model AS deviceModel,
                first_seen AS firstSeen, last_seen AS lastSeen
         FROM hwid_devices WHERE user_id = ? AND deleted_at IS NULL
         ORDER BY last_seen DESC`,
      )
      .all(userId);
    const sharedStmt = db.prepare<[string, number], { n: number }>(
      'SELECT COUNT(DISTINCT user_id) AS n FROM hwid_devices WHERE hwid = ? AND user_id != ?',
    );
    const blStmt = db.prepare<[string], { hwid: string }>('SELECT hwid FROM hwid_blacklist WHERE hwid = ?');
    const deviceList = devices.map((d) => ({
      ...d,
      sharedWith: sharedStmt.get(d.hwid, userId)?.n ?? 0,
      blacklisted: !!blStmt.get(d.hwid),
    }));
    const hwidCount =
      deviceList.length > 0 ? deviceList.length : await remna.getHwidDeviceCount({ id: userId, uuid: user.uuid });

    const cfg = loadScoringConfig(db);
    const windowStart = Date.now() - cfg.activeWindowMin * 60_000;

    const ips = db
      .prepare(
        `SELECT o.ip, MAX(o.last_seen) AS lastSeen, MIN(o.first_seen) AS firstSeen,
                GROUP_CONCAT(DISTINCT ns.name) AS nodes,
                m.asn, m.asn_org AS asnOrg, m.country, m.city, m.is_dc AS isDc,
                MAX(o.last_seen) >= ${windowStart} AS isActive
         FROM ip_observations o
         LEFT JOIN ip_meta m ON m.ip = o.ip
         LEFT JOIN node_status ns ON ns.node_uuid = o.node_uuid
         WHERE o.user_id = ?
         GROUP BY o.ip
         ORDER BY lastSeen DESC
         LIMIT 300`,
      )
      .all(userId);

    const score = db.prepare('SELECT * FROM score_state WHERE user_id = ?').get(userId) as
      | (Record<string, unknown> & { signals: string })
      | undefined;
    const incidents = db
      .prepare(
        `SELECT id, user_id AS userId, created_at AS createdAt, level, score, signals, status
         FROM incidents WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      )
      .all(userId) as Array<Record<string, unknown> & { signals: string }>;
    const whitelisted = !!db.prepare('SELECT 1 FROM whitelist WHERE user_id = ?').get(userId);
    const traffic = db
      .prepare('SELECT ts, used FROM traffic_snapshots WHERE user_id = ? ORDER BY ts')
      .all(userId);
    const log = db
      .prepare('SELECT ts, action, source, ok, error FROM actions_log WHERE user_id = ? ORDER BY ts DESC LIMIT 30')
      .all(userId);
    const torrents = db
      .prepare(
        'SELECT ip, node, created_at AS createdAt FROM torrent_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
      )
      .all(userId);

    // фоновое уточнение городов этого юзера через ipinfo (кэшируется навсегда)
    refineIps((ips as Array<{ ip: string }>).map((r) => r.ip));

    // каталог нод для флагов в колонке «Нода»
    const nodeCatalog = db.prepare('SELECT name, country FROM node_status').all();

    // Σ с карточки: активные пары «нода × IP» — адрес на двух нодах считается дважды
    const activePerNode =
      (
        db
          .prepare<[number, number], { n: number }>(
            `SELECT COUNT(*) AS n FROM (
               SELECT DISTINCT node_uuid, ip FROM ip_observations WHERE user_id = ? AND last_seen >= ?
             )`,
          )
          .get(userId, windowStart) ?? { n: 0 }
      ).n;

    return {
      user,
      whitelisted,
      score: score
        ? {
            ...score,
            signals: JSON.parse(score.signals) as unknown,
            signalsSeen: JSON.parse(String(score.signals_seen ?? '{}')) as unknown,
          }
        : null,
      ips,
      nodeCatalog,
      activePerNode,
      retentionHours: cfg.collector.retentionHours,
      incidents: incidents.map((i) => ({ ...i, signals: JSON.parse(i.signals) as unknown })),
      traffic,
      log,
      torrents,
      hwid: { count: hwidCount, limit: user.hwid_limit ?? null, devices: deviceList },
      // метка «уже наказывали»: успешные карательные действия из нашего журнала
      punished: db
        .prepare<[number], { count: number; lastTs: number | null; actions: string | null }>(
          `SELECT COUNT(*) AS count, MAX(ts) AS lastTs, GROUP_CONCAT(DISTINCT action) AS actions
           FROM actions_log WHERE user_id = ? AND ok = 1 AND action IN ('revoke', 'disable', 'drop', 'hwid_ban')`,
        )
        .get(userId) ?? { count: 0, lastTs: null, actions: null },
    };
  });

  // --- HWID: чёрный список и история устройства по подпискам ---
  app.get('/api/hwid/blacklist', () => {
    return db
      .prepare(
        `SELECT b.hwid, b.reason, b.added_at AS addedAt, b.source_user_id AS sourceUserId, u.username AS sourceUsername,
                (SELECT COUNT(DISTINCT d.user_id) FROM hwid_devices d WHERE d.hwid = b.hwid) AS seenIn
         FROM hwid_blacklist b LEFT JOIN users u ON u.id = b.source_user_id
         ORDER BY b.added_at DESC`,
      )
      .all();
  });

  app.post('/api/hwid/blacklist', (req, reply) => {
    const parsed = z.object({ hwid: z.string().min(3).max(200), reason: z.string().max(200).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad hwid' });
    db.prepare('INSERT OR REPLACE INTO hwid_blacklist (hwid, reason, source_user_id, added_at) VALUES (?, ?, NULL, ?)').run(
      parsed.data.hwid.trim(),
      parsed.data.reason ?? 'добавлен вручную',
      Date.now(),
    );
    return { ok: true };
  });

  app.post('/api/hwid/blacklist/remove', (req, reply) => {
    const parsed = z.object({ hwid: z.string() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad hwid' });
    db.prepare('DELETE FROM hwid_blacklist WHERE hwid = ?').run(parsed.data.hwid);
    return { ok: true };
  });

  // история: в каких подписках светился hwid (включая уже удалённые из панели устройства)
  app.get('/api/hwid/lookup', (req, reply) => {
    const q = (req.query as { hwid?: string }).hwid?.trim();
    if (!q) return reply.code(400).send({ error: 'нужен hwid' });
    const entries = db
      .prepare(
        `SELECT d.user_id AS userId, u.username, u.status, d.platform, d.device_model AS deviceModel,
                d.first_seen AS firstSeen, d.last_seen AS lastSeen, d.deleted_at AS deletedAt
         FROM hwid_devices d LEFT JOIN users u ON u.id = d.user_id
         WHERE d.hwid = ? ORDER BY d.last_seen DESC`,
      )
      .all(q);
    return { hwid: q, blacklisted: !!db.prepare('SELECT 1 FROM hwid_blacklist WHERE hwid = ?').get(q), entries };
  });

  // открытие «Журнала» сбрасывает бейдж новых инцидентов (статусы инцидентов не трогаются)
  app.post('/api/incidents/seen', () => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('incidents_seen_ts', String(Date.now()));
    return { ok: true };
  });

  app.get('/api/incidents', (req) => {
    const q = req.query as { status?: string; limit?: string };
    const limit = Math.min(Number(q.limit) || 100, 500);
    const params: unknown[] = [];
    let where = '1=1';
    if (q.status && ['open', 'actioned', 'ignored'].includes(q.status)) {
      where = 'i.status = ?';
      params.push(q.status);
    }
    params.push(limit);
    const rows = db
      .prepare(
        `SELECT i.id, i.user_id AS userId, i.created_at AS createdAt, i.level, i.score, i.signals, i.status,
                u.username
         FROM incidents i LEFT JOIN users u ON u.id = i.user_id
         WHERE ${where}
         ORDER BY i.created_at DESC LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown> & { signals: string }>;
    return rows.map((r) => ({ ...r, signals: JSON.parse(r.signals) as unknown }));
  });

  const ActionParams = z.object({
    action: z.enum(['revoke', 'disable', 'enable', 'drop', 'whitelist', 'unwhitelist', 'hwid_ban']),
    userId: z.coerce.number().int(),
  });

  app.post('/api/actions/:action/:userId', async (req, reply) => {
    const parsed = ActionParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'bad params' });
    const res = await actions.run(parsed.data.action as ActionName, parsed.data.userId, 'web');
    return reply.code(res.ok ? 200 : 500).send(res);
  });

  // Кэширующий прокси логотипов провайдеров: первый запрос тянет фавиконку
  // у Google и сохраняет на диск, дальше — только локальный файл.
  const iconsDir = path.resolve('data/icons');
  app.get('/api/asn-icon/:domain', async (req, reply) => {
    const { domain } = req.params as { domain: string };
    if (!/^[a-z0-9][a-z0-9.-]{1,60}$/i.test(domain)) return reply.code(400).send({ error: 'bad domain' });

    const file = path.join(iconsDir, `${domain.toLowerCase()}.png`);
    if (!fs.existsSync(file)) {
      // gstatic — основной источник (www.google.com на некоторых маршрутах виснет), DDG — запасной,
      // Яндекс знает региональные RU-сайты (на неизвестный домен отдаёт 1×1 PNG — режется фильтром <100 байт),
      // последний шанс — favicon.ico прямо с сайта провайдера
      const sources = [
        `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${encodeURIComponent(domain)}&size=64`,
        `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
        `https://favicon.yandex.net/favicon/${encodeURIComponent(domain)}`,
        `https://${domain}/favicon.ico`,
      ];
      let saved = false;
      for (const url of sources) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 100) continue;
          fs.mkdirSync(iconsDir, { recursive: true });
          fs.writeFileSync(file, buf);
          saved = true;
          break;
        } catch {
          // пробуем следующий источник
        }
      }
      if (!saved) return reply.code(404).send({ error: 'icon not found' });
    }
    return reply
      .header('Cache-Control', 'public, max-age=604800')
      .type('image/png')
      .send(fs.readFileSync(file));
  });

  // --- Самообновление ---
  // Панель сама себя не пересобирает: POST /api/update/run пишет файл-флаг в data,
  // а хост-хелпер (update.sh по systemd-таймеру) его подбирает и делает pull + up.
  const updateFlagPath = path.resolve('data/update-request');
  let releaseCache: { at: number; latest: string | null; notes: string | null; url: string | null } | null = null;

  app.get('/api/update/status', async (req) => {
    // кнопка «Проверить» шлёт force=1 и пробивает получасовой кэш
    const force = (req.query as { force?: string }).force === '1';
    if (force || !releaseCache || Date.now() - releaseCache.at > 30 * 60_000) {
      try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'remnamatcher' },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const j = (await res.json()) as { tag_name?: string; body?: string; html_url?: string };
          releaseCache = {
            at: Date.now(),
            latest: (j.tag_name ?? '').replace(/^v/, '') || null,
            notes: j.body ?? null,
            url: j.html_url ?? null,
          };
        } else {
          releaseCache = { at: Date.now(), latest: null, notes: null, url: null };
        }
      } catch {
        releaseCache = { at: Date.now(), latest: null, notes: null, url: null };
      }
    }
    return {
      current: VERSION,
      latest: releaseCache.latest,
      updateAvailable: releaseCache.latest !== null && compareVersions(releaseCache.latest, VERSION) > 0,
      notes: releaseCache.notes,
      url: releaseCache.url,
      pending: fs.existsSync(updateFlagPath),
    };
  });

  app.post('/api/update/run', (req, reply) => {
    if (fs.existsSync(updateFlagPath)) return reply.code(409).send({ error: 'обновление уже запрошено' });
    fs.writeFileSync(updateFlagPath, JSON.stringify({ requestedAt: Date.now(), from: VERSION }));
    releaseCache = null;
    return { ok: true };
  });

  app.get('/api/settings', () => loadScoringConfig(db));

  app.put('/api/settings', (req, reply) => {
    const parsed = ScoringConfigSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'scoring',
      JSON.stringify(parsed.data),
    );
    return { ok: true };
  });

  // SSE: живые обновления для веба
  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const send = (type: string, data: unknown) => {
      reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onCycle = (ev: unknown) => send('cycle', ev);
    const onIncident = (ev: unknown) => send('incident', ev);
    bus.on('cycle', onCycle);
    bus.on('incident', onIncident);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off('cycle', onCycle);
      bus.off('incident', onIncident);
    });
  });

  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[api] listening on http://localhost:${port}`);
}
