import type Database from 'better-sqlite3';
import type { RemnaReader } from '../remnawave/types.js';
import type { ScoringEngine } from '../scoring/engine.js';
import type { ScoringConfig } from '../scoring/rules.js';
import type { Actions } from '../actions.js';
import { bus } from '../events.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Коллектор: строго read-only по отношению к панели.
 * Ноды опрашиваются ПОСЛЕДОВАТЕЛЬНО с паузой — так же, как это делает
 * штатный «Обозреватель сессий», чтобы не грузить бэкенд панели.
 */
export class Collector {
  private stopped = false;
  private lastUserSync = 0;

  constructor(
    private db: Database.Database,
    private remna: RemnaReader,
    private engine: ScoringEngine,
    // интервалы и ретеншн правятся в панели на лету — читаем конфиг каждый цикл
    private getConfig: () => ScoringConfig,
    // только для автобана по HWID-блэклисту
    private actions: Actions,
  ) {}

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const startedAt = Date.now();
      try {
        await this.tick();
      } catch (err) {
        console.error('[collector] cycle failed:', err);
      }
      const elapsed = Date.now() - startedAt;
      await sleep(Math.max(5_000, this.getConfig().collector.pollIntervalSec * 1000 - elapsed));
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const t0 = now;
    const cc = this.getConfig().collector;

    if (now - this.lastUserSync > cc.userSyncIntervalSec * 1000) {
      await this.syncUsers(now);
      try {
        await this.syncHwidDevices(now);
      } catch (err) {
        console.error('[collector] hwid sync:', err instanceof Error ? err.message : err);
      }
      this.lastUserSync = now;
    }

    const nodes = (await this.remna.getNodes()).filter((n) => !n.isDisabled);
    let nodesOk = 0;
    let usersSeen = 0;
    let ipsSeen = 0;

    const upsertObs = this.db.prepare(
      `INSERT INTO ip_observations (user_id, node_uuid, ip, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, node_uuid, ip) DO UPDATE SET
         last_seen = MAX(last_seen, excluded.last_seen)`,
    );
    const upsertNodeStatus = this.db.prepare(
      `INSERT INTO node_status (node_uuid, name, country, last_ok_at, last_err, users_seen, ips_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_uuid) DO UPDATE SET
         name = excluded.name, country = excluded.country, last_ok_at = excluded.last_ok_at,
         last_err = excluded.last_err, users_seen = excluded.users_seen, ips_seen = excluded.ips_seen`,
    );

    for (const node of nodes) {
      if (this.stopped) return;
      try {
        const sessions = await this.remna.fetchNodeSessions(node.uuid);
        if (!sessions.success) throw new Error('node job failed');

        let nodeIps = 0;
        const tx = this.db.transaction(() => {
          for (const u of sessions.users) {
            const userId = Number(u.userId);
            if (!Number.isFinite(userId)) continue;
            for (const entry of u.ips) {
              const seen = Date.parse(entry.lastSeen) || Date.now();
              upsertObs.run(userId, node.uuid, entry.ip, seen, seen);
              nodeIps++;
            }
          }
        });
        tx();

        nodesOk++;
        usersSeen += sessions.users.length;
        ipsSeen += nodeIps;
        upsertNodeStatus.run(node.uuid, node.name, node.countryCode, Date.now(), null, sessions.users.length, nodeIps);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[collector] node ${node.name}: ${msg}`);
        upsertNodeStatus.run(node.uuid, node.name, node.countryCode, null, msg, 0, 0);
      }
      await sleep(cc.nodePollGapMs);
    }

    // репорты торрент-блокера (панель хранит последние — дедуп по id)
    try {
      const reports = await this.remna.getTorrentReports();
      const insertReport = this.db.prepare(
        'INSERT OR IGNORE INTO torrent_reports (id, user_id, ip, node, created_at) VALUES (?, ?, ?, ?, ?)',
      );
      const tx = this.db.transaction(() => {
        for (const r of reports) insertReport.run(r.id, r.userId, r.ip, r.nodeName, r.createdAt);
      });
      tx();
    } catch (err) {
      console.error('[collector] torrent reports:', err instanceof Error ? err.message : err);
    }

    this.retention(cc.retentionHours);
    this.engine.run();

    bus.emit('cycle', {
      at: Date.now(),
      durationMs: Date.now() - t0,
      nodesOk,
      nodesTotal: nodes.length,
      usersSeen,
      ipsSeen,
    });
  }

  private async syncUsers(now: number): Promise<void> {
    const users = await this.remna.getAllUsers();
    const upsertUser = this.db.prepare(
      `INSERT INTO users (id, uuid, short_uuid, username, status, telegram_id, email, tag, used_traffic, traffic_limit, hwid_limit, sub_url, online_at, expire_at, description, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         uuid = excluded.uuid, short_uuid = excluded.short_uuid, username = excluded.username,
         status = excluded.status, telegram_id = excluded.telegram_id, email = excluded.email,
         tag = excluded.tag, used_traffic = excluded.used_traffic, traffic_limit = excluded.traffic_limit,
         hwid_limit = excluded.hwid_limit, sub_url = excluded.sub_url, online_at = excluded.online_at,
         expire_at = excluded.expire_at, description = excluded.description, synced_at = excluded.synced_at`,
    );
    const insertSnapshot = this.db.prepare(
      'INSERT OR IGNORE INTO traffic_snapshots (user_id, ts, used) VALUES (?, ?, ?)',
    );
    const tx = this.db.transaction(() => {
      for (const u of users) {
        upsertUser.run(
          u.id,
          u.uuid,
          u.shortUuid,
          u.username,
          u.status,
          u.telegramId,
          u.email,
          u.tag,
          u.usedTrafficBytes,
          u.trafficLimitBytes,
          u.hwidDeviceLimit,
          u.subscriptionUrl,
          u.onlineAt ? Date.parse(u.onlineAt) : null,
          u.expireAt ? Date.parse(u.expireAt) : null,
          u.description,
          now,
        );
        insertSnapshot.run(u.id, now, u.usedTrafficBytes);
      }
    });
    tx();
    console.log(`[collector] user sync: ${users.length} users`);
  }

  /**
   * Зеркало устройств панели с историей: живые обновляются, пропавшие помечаются
   * deleted_at (но не удаляются — по ним видно, где hwid светился раньше).
   * После синка — автобан: устройство из чёрного списка в активной подписке.
   */
  private async syncHwidDevices(now: number): Promise<void> {
    const pageSize = 500;
    const seen = new Set<string>();
    // панель отдаёт uuid юзера — маппим на наш числовой id
    const uuidToId = new Map(
      this.db.prepare<[], { id: number; uuid: string }>('SELECT id, uuid FROM users').all().map((u) => [u.uuid, u.id]),
    );
    const upsert = this.db.prepare(
      `INSERT INTO hwid_devices (hwid, user_id, platform, os_version, device_model, user_agent, first_seen, last_seen, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(hwid, user_id) DO UPDATE SET
         platform = excluded.platform, os_version = excluded.os_version,
         device_model = excluded.device_model, user_agent = excluded.user_agent,
         last_seen = excluded.last_seen, deleted_at = NULL`,
    );

    let fetched = 0;
    for (let start = 0; ; start += pageSize) {
      const page = await this.remna.getAllHwidDevices(start, pageSize);
      const tx = this.db.transaction(() => {
        for (const d of page.devices) {
          const userId = uuidToId.get(d.userUuid);
          if (userId === undefined) continue; // юзер ещё не в справочнике — доедет со следующим синком
          upsert.run(d.hwid, userId, d.platform, d.osVersion, d.deviceModel, d.userAgent, now, now);
          seen.add(`${d.hwid} ${userId}`);
        }
      });
      tx();
      fetched += page.devices.length;
      if (fetched >= page.total || page.devices.length === 0) break;
    }

    // пропавшие из панели устройства — в историю
    const active = this.db
      .prepare<[], { hwid: string; user_id: number }>('SELECT hwid, user_id FROM hwid_devices WHERE deleted_at IS NULL')
      .all();
    const markDeleted = this.db.prepare('UPDATE hwid_devices SET deleted_at = ? WHERE hwid = ? AND user_id = ?');
    const tx = this.db.transaction(() => {
      for (const row of active) {
        if (!seen.has(`${row.hwid} ${row.user_id}`)) markDeleted.run(now, row.hwid, row.user_id);
      }
    });
    tx();

    await this.enforceHwidBlacklist();
  }

  /** Автобан: блэклистнутый hwid всплыл в живой подписке — отключаем её (если включено в настройках) */
  private async enforceHwidBlacklist(): Promise<void> {
    if (!this.getConfig().hwidAutobanEnabled) return;
    const hits = this.db
      .prepare<[], { user_id: number; username: string; hwid: string; source_user_id: number | null }>(
        `SELECT DISTINCT d.user_id, u.username, d.hwid, b.source_user_id
         FROM hwid_devices d
         JOIN hwid_blacklist b ON b.hwid = d.hwid
         JOIN users u ON u.id = d.user_id
         WHERE d.deleted_at IS NULL
           AND u.status != 'DISABLED'
           AND NOT EXISTS (SELECT 1 FROM whitelist w WHERE w.user_id = d.user_id)`,
      )
      .all();
    for (const hit of hits) {
      const res = await this.actions.run('disable', hit.user_id, 'hwid-autoban');
      console.log(`[hwid] автобан ${hit.username} (hwid ${hit.hwid.slice(0, 16)}…): ${res.ok ? 'ok' : res.message}`);
      const src = hit.source_user_id
        ? (this.db.prepare<[number], { username: string }>('SELECT username FROM users WHERE id = ?').get(hit.source_user_id)?.username ?? null)
        : null;
      bus.emit('hwid_autoban', {
        userId: hit.user_id,
        username: hit.username,
        hwid: hit.hwid,
        sourceUsername: src,
        ok: res.ok,
      });
    }
  }

  private retention(retentionHours: number): void {
    const cutoff = Date.now() - retentionHours * 3600_000;
    this.db.prepare('DELETE FROM ip_observations WHERE last_seen < ?').run(cutoff);
    this.db.prepare('DELETE FROM traffic_snapshots WHERE ts < ?').run(cutoff);
    this.db.prepare('DELETE FROM torrent_reports WHERE created_at < ?').run(cutoff);
    const incidentCutoff = Date.now() - 30 * 864e5;
    this.db.prepare('DELETE FROM incidents WHERE created_at < ?').run(incidentCutoff);
  }
}
