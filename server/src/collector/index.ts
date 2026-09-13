import type Database from 'better-sqlite3';
import type { HwidDevice, RemnaReader, RemnaUser } from '../remnawave/types.js';
import type { ScoringEngine } from '../scoring/engine.js';
import type { ScoringConfig } from '../scoring/rules.js';
import type { Actions } from '../actions.js';
import { bus } from '../events.js';
import { SNAPSHOT_TIERS, ticksToDrop } from './thin.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Коллектор: строго read-only по отношению к панели.
 * Ноды опрашиваются тем же job, что и штатный «Обозреватель сессий», но не по одной,
 * как в панели, а параллельно — в пределах того, сколько job панель держит в работе
 * (5 в 2.7.x, 10 в 3.x). Ноды без онлайн-юзеров пропускаются, справочник юзеров
 * синхронизируется параллельно с опросом: на сотнях нод круг занимает десятки секунд.
 */
export class Collector {
  private stopped = false;
  private lastUserSync = 0;
  private lastMetaPrune = 0;
  /** идущий синк справочника — следующий не стартует, пока не кончится этот */
  private userSync: Promise<void> | null = null;
  private thinning = false;

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
    const t0 = Date.now();
    const cc = this.getConfig().collector;

    // синк справочника — отдельно от круга: он не должен ни задерживать опрос нод, ни держать
    // завершение круга, если панель отдаёт список юзеров медленно. Круг обязан заканчиваться
    // сам по себе — от этого зависит окно «нода онлайн» и свежесть наблюдений
    if (t0 - this.lastUserSync > cc.userSyncIntervalSec * 1000 && !this.userSync) {
      this.userSync = this.syncUsersAndDevices(t0).finally(() => {
        this.userSync = null;
      });
    }

    const allNodes = await this.remna.getNodes();
    const nodes = allNodes.filter((n) => !n.isDisabled);
    // ноды, удалённые из панели, уходят и из статуса — иначе «0/231» при 150 живых.
    // Пустой список считаем сбоем панели, а не «все ноды удалены»
    if (allNodes.length > 0) {
      const alive = new Set(allNodes.map((n) => n.uuid));
      const stale = this.db
        .prepare<[], { node_uuid: string }>('SELECT node_uuid FROM node_status')
        .all()
        .filter((r) => !alive.has(r.node_uuid));
      if (stale.length > 0) {
        const del = this.db.prepare('DELETE FROM node_status WHERE node_uuid = ?');
        const tx = this.db.transaction(() => {
          for (const r of stale) del.run(r.node_uuid);
        });
        tx();
        console.log(`[collector] убрано нод, которых нет в панели: ${stale.length}`);
      }
    }
    let nodesOk = 0;
    let nodesIdle = 0;
    let nodesFailed = 0;
    const failReasons = new Map<string, number>();
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
    // сбой одного круга не гасит ноду: last_ok_at остаётся от последнего успеха, «онлайн» решает
    // окно на дашборде — ноду, которая не отвечает дольше окна, оно выключит само; причина — в last_err
    const markNodeError = this.db.prepare(
      `INSERT INTO node_status (node_uuid, name, country, last_ok_at, last_err, users_seen, ips_seen)
       VALUES (?, ?, ?, NULL, ?, 0, 0)
       ON CONFLICT(node_uuid) DO UPDATE SET
         name = excluded.name, country = excluded.country, last_err = excluded.last_err,
         users_seen = 0, ips_seen = 0`,
    );

    // Опрос параллельным пулом: job выполняется агентом на самой ноде, панель лишь
    // брокерит — параллельность размазывает нагрузку по нодам, а не бьёт в панель.
    // Стаггер стартов (nodePollGapMs) не даёт выстрелить все запросы одномоментно.
    const pollNode = async (node: (typeof nodes)[number]): Promise<void> => {
      try {
        const sessions = await this.remna.fetchNodeSessions(node.uuid);
        if (!sessions.success) throw new Error(sessions.error ?? 'панель вернула job без результата');

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
        nodesFailed++;
        const msg = err instanceof Error ? err.message : String(err);
        failReasons.set(msg, (failReasons.get(msg) ?? 0) + 1);
        console.error(`[collector] node ${node.name}: ${msg}`);
        markNodeError.run(node.uuid, node.name, node.countryCode, msg);
      }
    };

    // Нода, отвалившаяся от панели, job не выполнит — не ждём её, а сразу помечаем причину.
    // Ноду без единого онлайн-юзера (по счётчику панели) не спрашиваем вовсе: на сотнях нод
    // это заметная часть круга. Остальные — сначала самые нагруженные: их данные к моменту
    // скоринга получаются самыми свежими
    // Пропускаем только по ЯВНОМУ значению поля: если панель его не отдала (другая версия,
    // другое имя) — ноду опрашиваем, а не списываем молча
    const queue: typeof nodes = [];
    for (const node of nodes) {
      if (node.isConnected === false) {
        nodesFailed++;
        failReasons.set('нода не подключена к панели', (failReasons.get('нода не подключена к панели') ?? 0) + 1);
        markNodeError.run(node.uuid, node.name, node.countryCode, 'нода не подключена к панели');
      } else if (typeof node.usersOnline === 'number' && node.usersOnline <= 0) {
        nodesIdle++;
        upsertNodeStatus.run(node.uuid, node.name, node.countryCode, Date.now(), null, 0, 0);
      } else {
        queue.push(node);
      }
    }
    queue.sort((a, b) => (b.usersOnline ?? 0) - (a.usersOnline ?? 0));
    const workers = Array.from({ length: Math.max(1, cc.nodeConcurrency) }, async (_, wi) => {
      await sleep(wi * cc.nodePollGapMs);
      while (!this.stopped) {
        const node = queue.shift();
        if (!node) return;
        await pollNode(node);
        await sleep(cc.nodePollGapMs);
      }
    });
    await Promise.all(workers);
    if (this.stopped) return;

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
    const durationMs = Date.now() - t0;
    this.engine.run(Date.now(), durationMs);

    // в лог — и топ причин отказов: по нему видно, панель это, ноды или сеть
    const topReasons = [...failReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, n]) => `${n}× ${reason}`)
      .join('; ');
    // память — в каждой строке: рост от круга к кругу виден в docker logs раньше, чем OOM
    const rssMb = Math.round(process.memoryUsage().rss / 1048576);
    console.log(
      `[collector] круг ${(durationMs / 1000).toFixed(1)} с: опрошено ${nodesOk} нод, пустых ${nodesIdle}, ` +
        `с ошибкой ${nodesFailed}; юзеров ${usersSeen}, IP ${ipsSeen}; rss ${rssMb} МБ${topReasons ? ` | ${topReasons}` : ''}`,
    );

    bus.emit('cycle', {
      at: Date.now(),
      durationMs,
      nodesOk: nodesOk + nodesIdle,
      nodesTotal: nodes.length,
      nodesIdle,
      nodesFailed,
      usersSeen,
      ipsSeen,
    });
  }

  /** справочник юзеров и зеркало устройств; ошибки не роняют круг — ноды опрашиваются независимо */
  private async syncUsersAndDevices(now: number): Promise<void> {
    try {
      await this.syncUsers(now);
      // интервал считаем от конца синка: долгий синк не должен стартовать заново сразу по окончании
      this.lastUserSync = Date.now();
    } catch (err) {
      console.error('[collector] user sync:', err instanceof Error ? err.message : err);
      return;
    }
    try {
      await this.syncHwidDevices(now);
    } catch (err) {
      console.error('[collector] hwid sync:', err instanceof Error ? err.message : err);
    }
  }

  private async syncUsers(now: number): Promise<void> {
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
    // страница за страницей, каждая своей транзакцией с передышкой: список юзеров целиком
    // в памяти не держим (на сотнях тысяч это сотни мегабайт), а event loop между страницами
    // отдаём запросам за результатами job по нодам — их таймауты не должны страдать
    const upsertPage = this.db.transaction((page: RemnaUser[]) => {
      for (const u of page) {
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
    const total = await this.remna.streamUsers(async (page) => {
      if (this.stopped) return;
      upsertPage(page);
      await sleep(0);
    });
    // юзеры, которых панель больше не отдаёт, удалены из неё — сносим их вместе с текущим
    // состоянием, иначе призраки копятся вечно. История (инциденты, журнал, hwid) остаётся.
    // Пустой ответ панели считаем сбоем, а не «всех удалили»
    let pruned = 0;
    if (total > 0 && !this.stopped) {
      const prune = this.db.transaction(() => {
        pruned = this.db.prepare('DELETE FROM users WHERE synced_at < ?').run(now).changes;
        if (pruned > 0) {
          for (const table of ['score_state', 'ip_observations', 'traffic_snapshots', 'whitelist']) {
            this.db.prepare(`DELETE FROM ${table} WHERE user_id NOT IN (SELECT id FROM users)`).run();
          }
        }
      });
      prune();
    }
    console.log(`[collector] user sync: ${total} users${pruned > 0 ? `, удалено из панели: ${pruned}` : ''}`);
  }

  /**
   * Зеркало устройств панели с историей: живые обновляются, пропавшие помечаются
   * deleted_at (но не удаляются — по ним видно, где hwid светился раньше).
   * После синка — автобан: устройство из чёрного списка в активной подписке.
   */
  private async syncHwidDevices(now: number): Promise<void> {
    const pageSize = 500;
    const seen = new Set<string>();
    // панель 2.7.x отдаёт uuid юзера вместо id — карту uuid→id по всему справочнику
    // строим только когда она реально понадобилась (на 3.x — никогда)
    let uuidToId: Map<string, number> | null = null;
    const idOf = (d: HwidDevice): number | undefined => {
      if (d.userId !== undefined) return d.userId;
      if (d.userUuid === undefined) return undefined;
      uuidToId ??= new Map(
        this.db.prepare<[], { id: number; uuid: string }>('SELECT id, uuid FROM users').all().map((u) => [u.uuid, u.id]),
      );
      return uuidToId.get(d.userUuid);
    };
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
          // панель 3.x отдаёт числовой userId, 2.7.x — uuid юзера
          const userId = idOf(d);
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

    // кэш гео по IP: строка на каждый адрес за всё время иначе растёт бесконечно.
    // Чистим раз в час адреса, которых давно нет в наблюдениях (активные не трогаем —
    // у них кэш и уточнённые города остаются)
    if (Date.now() - this.lastMetaPrune > 3600_000) {
      this.lastMetaPrune = Date.now();
      const metaCutoff = Date.now() - 30 * 864e5;
      this.db
        .prepare('DELETE FROM ip_meta WHERE resolved_at < ? AND ip NOT IN (SELECT ip FROM ip_observations)')
        .run(metaCutoff);
      this.thinSnapshots();
    }
  }

  /**
   * Снапшоты трафика: строка на каждого юзера каждый синк — на десятках тысяч юзеров это
   * миллионы строк в сутки. Последний час держим как есть (движок считает скорость по нему),
   * старше часа — тик на 10 минут (график в отчёте рисует сутки по 15 минут), старше суток —
   * тик в час. Тик общий для всех юзеров, поэтому чистим целыми тиками по индексу ts.
   */
  private thinSnapshots(): void {
    if (this.thinning) return;
    this.thinning = true;
    void (async () => {
      try {
        const now = Date.now();
        const ticks = this.db
          .prepare<[number], { ts: number }>('SELECT DISTINCT ts FROM traffic_snapshots WHERE ts < ? ORDER BY ts')
          .all(now - SNAPSHOT_TIERS[0]!.olderThanMs)
          .map((r) => r.ts);
        const drop = ticksToDrop(ticks, now);
        const del = this.db.prepare('DELETE FROM traffic_snapshots WHERE ts = ?');
        // тик за тиком и с передышкой между ними: первое прореживание после обновления снимает
        // миллионы строк, одной транзакцией это заморозило бы API и опрос нод на минуты
        for (const ts of drop) {
          if (this.stopped) return;
          del.run(ts);
          await sleep(0);
        }
      } catch (err) {
        console.error('[collector] прореживание снапшотов:', err instanceof Error ? err.message : err);
      } finally {
        this.thinning = false;
      }
    })();
  }
}
