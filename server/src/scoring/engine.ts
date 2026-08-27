import type Database from 'better-sqlite3';
import type { GeoProvider } from '../geo/index.js';
import { bus } from '../events.js';
import {
  computeSignals,
  levelFor,
  type ActiveIp,
  type Level,
  type ScoringConfig,
  type Signal,
} from './rules.js';

const LEVEL_ORDER: Record<Level, number> = { green: 0, yellow: 1, orange: 2, red: 3 };

interface ObsRow {
  user_id: number;
  ip: string;
  last_seen: number;
  nodes: string;
}

export class ScoringEngine {
  private lastAlertAt = new Map<number, { at: number; level: Level }>();

  constructor(
    private db: Database.Database,
    private geo: GeoProvider,
    private getConfig: () => ScoringConfig,
  ) {}

  /** Прогон скоринга по всем юзерам с активными IP. Вызывается после каждого цикла опроса нод. */
  run(now = Date.now()): void {
    const cfg = this.getConfig();
    const windowStart = now - cfg.activeWindowMin * 60_000;

    const rows = this.db
      .prepare<[number], ObsRow>(
        `SELECT user_id, ip, MAX(last_seen) AS last_seen, GROUP_CONCAT(DISTINCT node_uuid) AS nodes
         FROM ip_observations
         WHERE last_seen >= ?
         GROUP BY user_id, ip`,
      )
      .all(windowStart);

    const byUser = new Map<number, ActiveIp[]>();
    for (const r of rows) {
      const meta = this.resolveMeta(r.ip, now);
      const list = byUser.get(r.user_id) ?? [];
      list.push({ ...meta, lastSeen: r.last_seen, nodes: r.nodes.split(',') });
      byUser.set(r.user_id, list);
    }

    const decayPerMs = Math.LN2 / (cfg.decayHalfLifeHours * 3600_000);
    const prevStates = this.db
      .prepare<[], { user_id: number; score: number; level: Level; updated_at: number; signals_seen: string }>(
        'SELECT user_id, score, level, updated_at, signals_seen FROM score_state',
      )
      .all();
    const prevByUser = new Map(prevStates.map((s) => [s.user_id, s]));
    const whitelisted = new Set(
      this.db.prepare<[], { user_id: number }>('SELECT user_id FROM whitelist').all().map((w) => w.user_id),
    );
    // HWID-лимиты для персонального порога числа IP
    const hwidLimits = new Map(
      this.db
        .prepare<[], { id: number; hwid_limit: number | null }>('SELECT id, hwid_limit FROM users')
        .all()
        .map((u) => [u.id, u.hwid_limit]),
    );

    const upsert = this.db.prepare(
      `INSERT INTO score_state (user_id, score, level, signals, active_ips, updated_at, signals_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         score = excluded.score, level = excluded.level, signals = excluded.signals,
         active_ips = excluded.active_ips, updated_at = excluded.updated_at,
         signals_seen = excluded.signals_seen`,
    );

    // память о сработавших проверках: живёт, пока их очки не затухли до нуля —
    // из неё в отчёте видно, ПОЧЕМУ уровень ещё держится, когда текущие проверки чистые
    type SeenEntry = { at: number; points: number; evidence: string; ipsCount?: number };
    type SeenMap = Record<string, SeenEntry>;
    const parseSeen = (prevJson: string | undefined): SeenMap => {
      try {
        return JSON.parse(prevJson || '{}') as SeenMap;
      } catch {
        return {};
      }
    };
    // старые записи без ipsCount: число IP достаётся из текста улики («14 активных IP …»)
    const ipsOf = (e: SeenEntry): number | undefined => {
      if (e.ipsCount !== undefined) return e.ipsCount;
      const m = /^(\d+) активных IP/.exec(e.evidence);
      return m ? Number(m[1]) : undefined;
    };
    /**
     * Самоисцеление: если HWID-лимит юзера досинкался ПОСЛЕ срабатывания и с ним
     * персональный порог выше числа IP на тот момент — срабатывание было ложным
     * (шло по запасному порогу «без лимита»). Снимаем память и зависимый multi_asn
     * того же цикла — хвост очков пересчитается без них.
     */
    const heal = (seen: SeenMap, hwidLimit: number | null): void => {
      if (hwidLimit === null || hwidLimit <= 0 || !cfg.signals.ipCount.enabled) return;
      const threshold = hwidLimit * cfg.signals.ipCount.perDeviceIps;
      const entry = seen['ip_count'];
      if (!entry) return;
      const ips = ipsOf(entry);
      if (ips === undefined || ips > threshold) return;
      delete seen['ip_count'];
      if (seen['multi_asn'] && seen['multi_asn'].at === entry.at) delete seen['multi_asn'];
    };
    const mergeSeen = (seen: SeenMap, signals: Signal[], nowTs: number): SeenMap => {
      for (const s of signals) {
        seen[s.key] = { at: nowTs, points: s.points, evidence: s.evidence, ...(s.ipsCount !== undefined && { ipsCount: s.ipsCount }) };
      }
      for (const [key, v] of Object.entries(seen)) {
        if (v.points * Math.exp(-decayPerMs * Math.max(0, nowTs - v.at)) < 1) delete seen[key];
      }
      return seen;
    };
    // хвост очков = сумма затухающих очков по каждой живой сработке:
    // так снятая исцелением сработка честно исчезает и из скора
    const tailScore = (seen: SeenMap, nowTs: number): number =>
      Object.values(seen).reduce((sum, e) => sum + e.points * Math.exp(-decayPerMs * Math.max(0, nowTs - e.at)), 0);

    const touched = new Set<number>();
    const tx = this.db.transaction(() => {
      for (const [userId, ips] of byUser) {
        touched.add(userId);
        const prev = prevByUser.get(userId);
        const hwidLimit = hwidLimits.get(userId) ?? null;

        const rate = this.trafficRate(userId, now);
        const torrentBlocks = this.torrentBlocks24h(userId, now);
        const signals = computeSignals(ips, rate, torrentBlocks, hwidLimit, cfg);

        const seen = parseSeen(prev?.signals_seen);
        heal(seen, hwidLimit);
        mergeSeen(seen, signals, now);
        const score = tailScore(seen, now);
        const level = levelFor(score, cfg);

        upsert.run(userId, score, level, JSON.stringify(signals), ips.length, now, JSON.stringify(seen));
        this.maybeRaiseIncident(userId, level, (prev?.level ?? 'green') as Level, score, signals, ips.length, whitelisted, cfg, now);
      }

      // юзеры без активных IP: только затухание (и то же самоисцеление)
      for (const prev of prevStates) {
        if (touched.has(prev.user_id)) continue;
        const seen = parseSeen(prev.signals_seen);
        heal(seen, hwidLimits.get(prev.user_id) ?? null);
        mergeSeen(seen, [], now);
        const score = tailScore(seen, now);
        if (score < 1) {
          this.db.prepare('DELETE FROM score_state WHERE user_id = ?').run(prev.user_id);
        } else {
          upsert.run(prev.user_id, score, levelFor(score, cfg), '[]', 0, now, JSON.stringify(seen));
        }
      }
    });
    tx();
  }

  private resolveMeta(ip: string, now: number) {
    const cached = this.db
      .prepare<[string], { ip: string; asn: number | null; asn_org: string | null; country: string | null; city: string | null; lat: number | null; lon: number | null; is_dc: number }>(
        'SELECT * FROM ip_meta WHERE ip = ?',
      )
      .get(ip);
    if (cached) {
      return {
        ip,
        asn: cached.asn,
        asnOrg: cached.asn_org,
        country: cached.country,
        city: cached.city,
        lat: cached.lat,
        lon: cached.lon,
        isDatacenter: cached.is_dc === 1,
      };
    }
    const meta = this.geo.lookup(ip);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ip_meta (ip, asn, asn_org, country, city, lat, lon, is_dc, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ip, meta.asn, meta.asnOrg, meta.country, meta.city, meta.lat, meta.lon, meta.isDatacenter ? 1 : 0, now);
    return meta;
  }

  private torrentBlocks24h(userId: number, now: number): number {
    return (
      this.db
        .prepare<[number, number], { n: number }>(
          'SELECT COUNT(*) AS n FROM torrent_reports WHERE user_id = ? AND created_at >= ?',
        )
        .get(userId, now - 24 * 3600_000)?.n ?? 0
    );
  }

  /** Средняя скорость трафика юзера за последний час, байт/сек */
  private trafficRate(userId: number, now: number): number | null {
    const hourAgo = now - 3600_000;
    const row = this.db
      .prepare<[number, number], { minUsed: number; maxUsed: number; minTs: number; maxTs: number; n: number }>(
        `SELECT MIN(used) AS minUsed, MAX(used) AS maxUsed, MIN(ts) AS minTs, MAX(ts) AS maxTs, COUNT(*) AS n
         FROM traffic_snapshots WHERE user_id = ? AND ts >= ?`,
      )
      .get(userId, hourAgo);
    if (!row || row.n < 2 || row.maxTs === row.minTs) return null;
    const delta = row.maxUsed - row.minUsed;
    if (delta <= 0) return 0;
    return delta / ((row.maxTs - row.minTs) / 1000);
  }

  private maybeRaiseIncident(
    userId: number,
    level: Level,
    prevLevel: Level,
    score: number,
    signals: Signal[],
    activeIps: number,
    whitelisted: Set<number>,
    cfg: ScoringConfig,
    now: number,
  ): void {
    if (whitelisted.has(userId)) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER.orange) return;

    const cooldownMs = cfg.alertCooldownHours * 3600_000;
    // кэш в памяти + fallback на БД, чтобы рестарт не приводил к повторной волне алертов
    let last = this.lastAlertAt.get(userId);
    if (!last) {
      const row = this.db
        .prepare<[number], { created_at: number; level: Level }>(
          'SELECT created_at, level FROM incidents WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
        )
        .get(userId);
      if (row) {
        last = { at: row.created_at, level: row.level };
        this.lastAlertAt.set(userId, last);
      }
    }
    const levelRose = !last || LEVEL_ORDER[level] > LEVEL_ORDER[last.level];
    if (last && !levelRose && now - last.at < cooldownMs) return;

    const username =
      this.db.prepare<[number], { username: string }>('SELECT username FROM users WHERE id = ?').get(userId)
        ?.username ?? `id ${userId}`;

    const res = this.db
      .prepare(
        `INSERT INTO incidents (user_id, created_at, level, score, signals) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(userId, now, level, score, JSON.stringify(signals));

    this.lastAlertAt.set(userId, { at: now, level });
    bus.emit('incident', {
      incidentId: Number(res.lastInsertRowid),
      userId,
      username,
      level,
      prevLevel,
      score,
      signals,
      activeIps,
    });
  }
}
