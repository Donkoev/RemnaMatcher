import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function openDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  // мини-миграции для существующих баз
  for (const stmt of [
    "ALTER TABLE users ADD COLUMN traffic_limit REAL NOT NULL DEFAULT 0",
    'ALTER TABLE users ADD COLUMN sub_url TEXT',
    'ALTER TABLE users ADD COLUMN hwid_limit INTEGER',
    'ALTER TABLE ip_meta ADD COLUMN refined INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE score_state ADD COLUMN signals_seen TEXT NOT NULL DEFAULT '{}'",
  ]) {
    try {
      db.exec(stmt);
    } catch {
      // колонка уже есть
    }
  }
  return db;
}

const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,          -- числовой id панели
  uuid          TEXT NOT NULL,
  short_uuid    TEXT NOT NULL DEFAULT '',
  username      TEXT NOT NULL,
  status        TEXT NOT NULL,
  telegram_id   INTEGER,
  email         TEXT,
  tag           TEXT,
  used_traffic  REAL NOT NULL DEFAULT 0,
  online_at     INTEGER,
  expire_at     INTEGER,
  synced_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_uuid ON users(uuid);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- наблюдения IP: upsert по (user_id, node_uuid, ip)
CREATE TABLE IF NOT EXISTS ip_observations (
  user_id    INTEGER NOT NULL,
  node_uuid  TEXT NOT NULL,
  ip         TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (user_id, node_uuid, ip)
);
CREATE INDEX IF NOT EXISTS idx_obs_last_seen ON ip_observations(last_seen);
CREATE INDEX IF NOT EXISTS idx_obs_user ON ip_observations(user_id, last_seen);

-- кэш гео/ASN по IP
CREATE TABLE IF NOT EXISTS ip_meta (
  ip           TEXT PRIMARY KEY,
  asn          INTEGER,
  asn_org      TEXT,
  country      TEXT,
  city         TEXT,
  lat          REAL,
  lon          REAL,
  is_dc        INTEGER NOT NULL DEFAULT 0,
  resolved_at  INTEGER NOT NULL
);

-- снапшоты трафика для дельт
CREATE TABLE IF NOT EXISTS traffic_snapshots (
  user_id  INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  used     REAL NOT NULL,
  PRIMARY KEY (user_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_traffic_ts ON traffic_snapshots(ts);

-- текущее состояние скоринга юзера
CREATE TABLE IF NOT EXISTS score_state (
  user_id     INTEGER PRIMARY KEY,
  score       REAL NOT NULL DEFAULT 0,
  level       TEXT NOT NULL DEFAULT 'green',   -- green|yellow|orange|red
  signals     TEXT NOT NULL DEFAULT '[]',      -- json-массив улик последнего расчёта
  active_ips  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- инциденты (переходы на orange/red и выше)
CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  level       TEXT NOT NULL,
  score       REAL NOT NULL,
  signals     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open'     -- open|actioned|ignored
);
CREATE INDEX IF NOT EXISTS idx_incidents_user ON incidents(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status, created_at);

-- журнал действий (кто/что/когда нажал)
CREATE TABLE IF NOT EXISTS actions_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  user_id  INTEGER,
  action   TEXT NOT NULL,
  source   TEXT NOT NULL,                      -- telegram|web
  payload  TEXT,
  ok       INTEGER NOT NULL,
  error    TEXT
);

CREATE TABLE IF NOT EXISTS whitelist (
  user_id  INTEGER PRIMARY KEY,
  reason   TEXT,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- репорты торрент-блокера панели (id из панели — дедупликация)
CREATE TABLE IF NOT EXISTS torrent_reports (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  ip         TEXT NOT NULL,
  node       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_torrent_user ON torrent_reports(user_id, created_at);

-- статус коллектора по нодам
CREATE TABLE IF NOT EXISTS node_status (
  node_uuid   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  country     TEXT NOT NULL DEFAULT '',
  last_ok_at  INTEGER,
  last_err    TEXT,
  users_seen  INTEGER NOT NULL DEFAULT 0,
  ips_seen    INTEGER NOT NULL DEFAULT 0
);
`;
