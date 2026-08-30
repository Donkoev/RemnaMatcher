import { env, assertLiveConfig } from './config.js';
import { openDb } from './db/index.js';
import { MockGeoProvider, MmdbGeoProvider, type GeoProvider } from './geo/index.js';
import { HttpRemnaEnforcer, HttpRemnaReader, PanelVersionState } from './remnawave/http.js';
import { MockRemna } from './remnawave/mock.js';
import type { RemnaEnforcer, RemnaReader } from './remnawave/types.js';
import { Collector } from './collector/index.js';
import { ScoringEngine } from './scoring/engine.js';
import { Actions } from './actions.js';
import { startTelegram } from './alerts/telegram.js';
import { startApi, loadScoringConfig } from './api/server.js';
import { createIpinfoRefiner } from './geo/refine.js';
import { bus } from './events.js';

async function main(): Promise<void> {
  console.log(`RemnaMatcher server, MODE=${env.MODE}`);
  // у мока своя база — переключение режимов не трогает боевые данные
  const dbPath = env.MODE === 'mock' ? env.DB_PATH.replace(/\.db$/, '-mock.db') : env.DB_PATH;
  const db = openDb(dbPath);

  let reader: RemnaReader;
  let enforcer: RemnaEnforcer;
  let geo: GeoProvider;

  if (env.MODE === 'live') {
    assertLiveConfig(env);
    const httpOpts = { baseUrl: env.REMNAWAVE_URL, token: env.REMNAWAVE_TOKEN, secret: env.REMNAWAVE_SECRET };
    // общий детект версии панели (2.7.x/3.x): что узнал reader — знает и enforcer
    const panelVersion = new PanelVersionState();
    reader = new HttpRemnaReader(httpOpts, panelVersion);
    enforcer = new HttpRemnaEnforcer(httpOpts, panelVersion);
    const mmdb = new MmdbGeoProvider(env.GEOIP_CITY_MMDB, env.GEOIP_ASN_MMDB);
    if (!mmdb.ready.city || !mmdb.ready.asn) {
      console.warn(
        `[geo] mmdb-базы не найдены (${env.GEOIP_CITY_MMDB}, ${env.GEOIP_ASN_MMDB}). ` +
          'Гео/ASN-сигналы будут пустыми. Скачай базы: npm run -w server geoip',
      );
    }
    geo = mmdb;
  } else {
    // мок генерит новые случайные id при каждом старте — чистим базу,
    // иначе копятся юзеры-призраки прошлых запусков
    for (const table of [
      'users',
      'ip_observations',
      'ip_meta',
      'traffic_snapshots',
      'score_state',
      'incidents',
      'actions_log',
      'whitelist',
      'node_status',
      'torrent_reports',
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    const mock = new MockRemna();
    reader = mock;
    enforcer = mock;
    geo = new MockGeoProvider();
  }

  const engine = new ScoringEngine(db, geo, () => loadScoringConfig(db));
  const actions = new Actions(db, enforcer);
  const collector = new Collector(db, reader, engine, () => loadScoringConfig(db), actions);

  startTelegram({
    token: env.TELEGRAM_BOT_TOKEN,
    adminChatId: env.TELEGRAM_ADMIN_CHAT_ID,
    db,
    actions,
  });

  const refiner = createIpinfoRefiner(db);
  await startApi({ db, actions, port: env.PORT, mode: env.MODE, remna: reader, refineIps: refiner.refineIps });
  collector.start();

  // после каждого цикла фоном дочищаем города по IP подозрительных (до 60 за цикл)
  bus.on('cycle', () => {
    try {
      const rows = db
        .prepare<[], { ip: string }>(
          `SELECT DISTINCT o.ip FROM ip_observations o
           JOIN score_state s ON s.user_id = o.user_id AND s.level != 'green'
           JOIN ip_meta m ON m.ip = o.ip AND m.refined = 0
           LIMIT 60`,
        )
        .all();
      if (rows.length > 0) refiner.refineIps(rows.map((r) => r.ip));
    } catch (err) {
      console.error('[ipinfo] выборка для фонового уточнения:', err instanceof Error ? err.message : err);
    }
  });

  const shutdown = () => {
    collector.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// сетевые сбои (VPN, недоступность панели) не должны убивать процесс
process.on('unhandledRejection', (err) => {
  console.error('[fatal-guard] unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal-guard] uncaught exception:', err);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
