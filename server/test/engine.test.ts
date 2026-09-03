import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { MockGeoProvider } from '../src/geo/index.js';
import { ScoringEngine } from '../src/scoring/engine.js';
import { DEFAULT_CONFIG } from '../src/scoring/rules.js';

// один юзер с одним IP: из всех проверок может сработать только всплеск трафика
function setup() {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO users (id, uuid, short_uuid, username, status, used_traffic, synced_at) VALUES (1, 'u1', 's1', 'alice', 'ACTIVE', 0, ?)`,
  ).run(Date.now());
  const engine = new ScoringEngine(db, new MockGeoProvider(), () => DEFAULT_CONFIG);
  const snapshot = db.prepare('INSERT INTO traffic_snapshots (user_id, ts, used) VALUES (1, ?, ?)');
  const observe = (ts: number) =>
    db.prepare('INSERT INTO ip_observations (user_id, node_uuid, ip, first_seen, last_seen) VALUES (1, ?, ?, ?, ?)').run('n', '10.0.0.1', ts, ts);
  const signalKeys = (): string[] => {
    const row = db.prepare<[], { signals: string }>('SELECT signals FROM score_state WHERE user_id = 1').get();
    return row ? (JSON.parse(row.signals) as { key: string }[]).map((s) => s.key) : [];
  };
  return { db, engine, snapshot, observe, signalKeys };
}

const MB = 1024 * 1024;

describe('ScoringEngine.trafficRate', () => {
  it('сброс счётчика панелью не превращается в ложный всплеск трафика', () => {
    const { engine, snapshot, observe, signalKeys } = setup();
    const now = Date.now();
    observe(now);
    // 50 минут назад — 10 ГБ, 40 минут назад — обнулили, 30 минут назад — 1 МБ
    snapshot.run(now - 50 * 60_000, 10 * 1024 * MB);
    snapshot.run(now - 40 * 60_000, 0);
    snapshot.run(now - 30 * 60_000, 1 * MB);
    engine.run(now);
    expect(signalKeys()).not.toContain('traffic_rate');
  });

  it('настоящий поток выше порога даёт сигнал', () => {
    const { engine, snapshot, observe, signalKeys } = setup();
    const now = Date.now();
    observe(now);
    const bps = DEFAULT_CONFIG.trafficRateBps * 1.5;
    snapshot.run(now - 20 * 60_000, 0);
    snapshot.run(now - 10 * 60_000, bps * 600);
    snapshot.run(now, bps * 1200);
    engine.run(now);
    expect(signalKeys()).toContain('traffic_rate');
  });
});

describe('ScoringEngine.run', () => {
  it('состояние без активных IP затухает и удаляется, когда очки кончились', () => {
    const { db, engine, observe } = setup();
    const start = Date.now() - 48 * 3600_000;
    // 12 IP у юзера без лимита → ip_count, уровень как минимум жёлтый
    for (let i = 0; i < 12; i++) {
      db.prepare('INSERT INTO ip_observations (user_id, node_uuid, ip, first_seen, last_seen) VALUES (1, ?, ?, ?, ?)').run('n', `10.1.0.${i + 1}`, start, start);
    }
    engine.run(start);
    const level = db.prepare<[], { level: string }>('SELECT level FROM score_state WHERE user_id = 1').get()?.level;
    expect(level).not.toBe('green');
    // двое суток спустя (8 периодов полураспада) очки < 1 — записи нет
    observe(Date.now() - 10 * 3600_000); // неактивное наблюдение, чтобы юзер не попал в «активные»
    engine.run(Date.now());
    expect(db.prepare('SELECT 1 FROM score_state WHERE user_id = 1').get()).toBeUndefined();
  });
});
