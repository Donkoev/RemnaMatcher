import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// параметры scrypt по рекомендациям OWASP (N=2^15, r=8, p=1)
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const KEYLEN = 64;
const SESSION_TTL_MS = 7 * 24 * 3600_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64!, 'base64');
  const expected = Buffer.from(hashB64!, 'base64');
  const key = await scrypt(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Авторизация панели: один админ-пароль (scrypt-хэш в settings) + сессии
 * в httpOnly-куке. В БД хранится только SHA-256 токена — утечка базы не даёт сессий.
 * Перебор пароля душится прогрессирующей блокировкой по IP.
 */
export class Auth {
  private fails = new Map<string, { count: number; lockedUntil: number }>();

  constructor(private db: Database.Database) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT
    )`);
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  }

  hasPassword(): boolean {
    return this.getHash() !== null;
  }

  getHash(): string | null {
    const row = this.db
      .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
      .get('admin_password');
    return row?.value ?? null;
  }

  setHash(hash: string): void {
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('admin_password', hash);
  }

  createSession(ip: string | undefined, userAgent: string | undefined): string {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (token_hash, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), now, now + SESSION_TTL_MS, ip ?? null, (userAgent ?? '').slice(0, 200) || null);
    return token;
  }

  /** true, если сессия жива; заодно скользяще продлевает её */
  validate(token: string | undefined): boolean {
    if (!token) return false;
    const hash = sha256(token);
    const row = this.db
      .prepare<[string], { expires_at: number }>('SELECT expires_at FROM sessions WHERE token_hash = ?')
      .get(hash);
    const now = Date.now();
    if (!row || row.expires_at < now) {
      if (row) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
      return false;
    }
    if (row.expires_at - now < SESSION_TTL_MS / 2) {
      this.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(now + SESSION_TTL_MS, hash);
    }
    return true;
  }

  destroySession(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  /** после смены пароля убиваем все сессии — везде попросит войти заново */
  destroyAllSessions(): void {
    this.db.prepare('DELETE FROM sessions').run();
  }

  /** сколько мс осталось до снятия блокировки логина для этого IP (0 = не заблокирован) */
  lockedFor(ip: string): number {
    const f = this.fails.get(ip);
    if (!f) return 0;
    return Math.max(0, f.lockedUntil - Date.now());
  }

  registerFail(ip: string): void {
    const f = this.fails.get(ip) ?? { count: 0, lockedUntil: 0 };
    f.count += 1;
    // с 5-й неудачи — блокировка 30с, каждая следующая удваивает (потолок 1 час)
    if (f.count >= 5) {
      const lockMs = Math.min(30_000 * 2 ** (f.count - 5), 3600_000);
      f.lockedUntil = Date.now() + lockMs;
    }
    this.fails.set(ip, f);
  }

  clearFails(ip: string): void {
    this.fails.delete(ip);
  }
}
