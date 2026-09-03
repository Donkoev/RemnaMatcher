import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Client, type ConnectConfig } from 'ssh2';
import type Database from 'better-sqlite3';
import { agentHealth, agentSelfUpdate, type AgentAddr } from './agent.js';

// Шифрование сохранённого SSH-пароля: ключ в отдельном файле data/red-secret.key (не в БД).
// Пароль вводится один раз, панель хранит его зашифрованным и подставляет при переустановке.
// Экспортируется: из него же выводится стабильный HWID панели для импорта подписок.
export function secretKey(): Buffer {
  const p = path.resolve('./data/red-secret.key');
  try {
    const b = fs.readFileSync(p);
    if (b.length === 32) return b;
  } catch {
    /* нет ключа — создадим */
  }
  const key = randomBytes(32);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, key, { mode: 0o600 });
  return key;
}

export function encryptSecret(text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decryptSecret(blob: string): string | null {
  try {
    const b = Buffer.from(blob, 'base64');
    const iv = b.subarray(0, 12);
    const tag = b.subarray(12, 28);
    const d = createDecipheriv('aes-256-gcm', secretKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

const AGENT_PORT = 8760;
const AGENT_DIR = '/opt/remnamatcher-agent';

/** агент старой установки без сертификата: по открытому HTTP панель к нему не ходит */
export const NO_TLS_ERROR =
  'агент старой установки без TLS — панель к нему не ходит; переустанови его из меню сервера';
/** префикс ошибки о смене ключа хоста SSH — фронт по нему предлагает подтвердить новый ключ */
export const HOST_KEY_CHANGED = 'Ключ хоста SSH изменился';
// содержимое агента читаем из репозитория один раз
const AGENT_PY = fs.readFileSync(new URL('../../agent/agent.py', import.meta.url), 'utf8');

// URL бинарника xray-core под ОС ноды (Linux) из последнего релиза XTLS
async function xrayLinuxUrl(arch: string): Promise<string> {
  const asset = /aarch64|arm64/i.test(arch) ? 'Xray-linux-arm64-v8a.zip' : 'Xray-linux-64.zip';
  const res = await fetch('https://api.github.com/repos/XTLS/Xray-core/releases/latest', {
    headers: { 'User-Agent': 'RemnaMatcher', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const rel = (await res.json()) as { assets: { name: string; browser_download_url: string }[] };
  const dl = rel.assets.find((a) => a.name === asset);
  if (!dl) throw new Error(`нет ассета ${asset}`);
  return dl.browser_download_url;
}

// Инфраструктура → серверы: панель сама ставит ноду по SSH.
// Пайплайн установки: подключение → факты о сервере → xray → agent.py + TLS-сертификат +
// systemd → проверка. Отпечаток сертификата снимается по SSH (доверенный канал) и прикалывается
// в БД: дальше панель ходит к агенту только по TLS и только на этот сертификат.
// SSH-пароль в БД хранится только шифрованным (см. encryptSecret выше).

export interface RedServerRow {
  id: number;
  name: string;
  address: string;
  port: number;
  ssh_user: string;
  token: string;
  status: 'never' | 'online' | 'offline';
  agent_status: 'none' | 'installing' | 'connected' | 'error';
  last_error: string | null;
  os: string | null;
  kernel: string | null;
  cpu: string | null;
  cores: number | null;
  mem_mb: number | null;
  disk_free: string | null;
  agent_port: number | null;
  /** SHA-256 отпечаток TLS-сертификата агента (пин); null — старый агент без TLS, только переустановка */
  agent_fp: string | null;
  ssh_pass: string | null;
  /** SHA-256 отпечаток ключа хоста SSH (TOFU: запомнен при первом подключении); null — ещё не подключались */
  ssh_host_fp: string | null;
  latency_ms: number | null;
  last_check_at: number | null;
  last_ok_at: number | null;
  created_at: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// креды для SSH: пароль передаётся при первой установке; при переустановке берётся сохранённый
export interface SshCreds {
  username: string;
  password?: string;
  /** сервер переустанавливали — принять новый ключ хоста вместо запомненного (явное решение человека) */
  acceptNewHostKey?: boolean;
}

/** есть ли у сервера сохранённый пароль (тогда переустановка — без ввода) */
export function hasStoredPass(db: Database.Database, id: number): boolean {
  const r = db.prepare<[number], { ssh_pass: string | null }>('SELECT ssh_pass FROM red_servers WHERE id = ?').get(id);
  return !!r?.ssh_pass;
}

export interface InstallJob {
  lines: string[];
  done: boolean;
  ok: boolean;
}

const CHECK_TIMEOUT_MS = 3000;
const SSH_TIMEOUT_MS = 30_000; // слабые/далёкие серверы медленно делают SSH-рукопожатие
const POLL_INTERVAL_MS = 5000;

// связь панель → агент может флапать: новые TCP-потоки до 8760 иногда молча теряются
// (VPN/NAT раскидывает их по разным путям), при живом агенте. Поэтому «ошибка» — только
// после 2 минут полной тишины, обратно в «подключён» — с первого успеха.
const AGENT_SILENCE_MS = 120_000;
// id → время последнего успешного ответа агента; при старте сидируется текущим временем (грейс)
const agentLastOk = new Map<number, number>();

// живые логи установок: id сервера → строки (в памяти, переживать рестарт не обязаны)
const jobs = new Map<number, InstallJob>();

export function getInstallJob(id: number): InstallJob | null {
  return jobs.get(id) ?? null;
}

/** TCP-проверка: SSH-порт отвечает → сервер жив; меряем задержку коннекта */
export function checkTcp(host: string, port: number): Promise<{ ok: boolean; latencyMs: number | null }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.createConnection({ host, port, timeout: CHECK_TIMEOUT_MS });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve({ ok, latencyMs: ok ? Date.now() - started : null });
    };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/**
 * Проверить один сервер и записать результат: TCP до SSH-порта (жив ли сервер)
 * и, если агент ставился, его /health — чтобы agent_status не застывал снимком установки.
 * Задержка — RTT HTTP-запроса к агенту: ответ физически приходит с ноды. TCP-коннект — лишь
 * фолбэк: локальный VPN/прокси в TUN-режиме принимает коннект у себя и рисует вечную «1 мс».
 */
export async function checkRedServer(db: Database.Database, id: number): Promise<RedServerRow | null> {
  const row = db.prepare<[number], RedServerRow>('SELECT * FROM red_servers WHERE id = ?').get(id);
  if (!row) return null;
  const res = await checkTcp(row.address, row.port);
  const now = Date.now();
  // TCP-задержку пишем только пока агента нет: иначе она на миг затирала бы честный RTT
  // в начале каждого тика, и фронт выхватывал бы «1 мс»
  db.prepare(
    'UPDATE red_servers SET status = ?, latency_ms = COALESCE(?, latency_ms), last_check_at = ?, last_ok_at = COALESCE(?, last_ok_at) WHERE id = ?',
  ).run(res.ok ? 'online' : 'offline', row.agent_port == null ? res.latencyMs : null, now, res.ok ? now : null, id);

  // во время установки агента не трогаем — итог выставит сам пайплайн установки
  if (row.agent_port != null && row.agent_status !== 'installing') {
    if (row.agent_fp == null) {
      // агент старой установки без сертификата: по открытому HTTP не ходим — токен даёт
      // /self-update (выполнение кода на ноде), в открытом виде его показывать нельзя никому
      db.prepare("UPDATE red_servers SET agent_status = 'error', latency_ms = NULL, last_error = ? WHERE id = ?").run(
        NO_TLS_ERROR,
        id,
      );
      return db.prepare<[number], RedServerRow>('SELECT * FROM red_servers WHERE id = ?').get(id) ?? null;
    }
    const t0 = Date.now();
    const health = await agentHealth({ host: row.address, port: row.agent_port, token: row.token, fp: row.agent_fp });
    if (health?.ok) {
      agentLastOk.set(id, Date.now());
      db.prepare(
        "UPDATE red_servers SET agent_status = 'connected', last_error = NULL, latency_ms = ? WHERE id = ?",
      ).run(Date.now() - t0, id);
    } else {
      const lastOk = agentLastOk.get(id);
      if (lastOk == null) {
        agentLastOk.set(id, Date.now()); // первый взгляд после старта панели — даём грейс
      } else if (Date.now() - lastOk > AGENT_SILENCE_MS) {
        // подробную причину из установки не затираем — общий текст пишем только поверх пустой;
        // задержку сбрасываем: старый RTT при мёртвом агенте — враньё
        db.prepare(
          "UPDATE red_servers SET agent_status = 'error', latency_ms = NULL, last_error = COALESCE(last_error, ?) WHERE id = ?",
        ).run(`агент молчит дольше 2 минут (порт ${row.agent_port}) — проверь сервис на ноде и фаервол`, id);
      }
    }
  }
  return db.prepare<[number], RedServerRow>('SELECT * FROM red_servers WHERE id = ?').get(id) ?? null;
}

/** Фоновый поллер доступности всех серверов контура */
export function startRedServerPoller(db: Database.Database): () => void {
  // рестарт панели мог прервать установку: её job живёт в памяти, и без этого
  // карточка навсегда осталась бы в «установка…»
  db.prepare(
    "UPDATE red_servers SET agent_status = 'error', last_error = 'установка прервана перезапуском панели — запусти переустановку' WHERE agent_status = 'installing'",
  ).run();
  let stopped = false;
  // при 5-секундном интервале медленный тик (лежащая нода ест таймауты) не должен наслаиваться
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const rows = db.prepare<[], { id: number }>('SELECT id FROM red_servers').all();
      for (const { id } of rows) {
        if (stopped) return;
        await checkRedServer(db, id).catch(() => {});
      }
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function sshConnect(cfg: ConnectConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.once('ready', () => resolve(conn));
    conn.once('error', (err) => reject(err));
    // keepalive держит канал живым во время долгой установки (скачивание xray на ноду и т.п.)
    conn.connect({ readyTimeout: SSH_TIMEOUT_MS, keepaliveInterval: 15_000, keepaliveCountMax: 8, ...cfg });
  });
}

// одна повторная попытка при таймауте рукопожатия — слабый sshd часто отвечает со второго раза
async function sshConnectRetry(cfg: ConnectConfig): Promise<Client> {
  try {
    return await sshConnect(cfg);
  } catch (e) {
    if (/handshake|timed out|timeout/i.test(e instanceof Error ? e.message : '')) {
      await sleep(1500);
      return sshConnect(cfg);
    }
    throw e;
  }
}

// заливка файла на ноду через SFTP — надёжнее echo/base64 (нет лимитов длины команды)
function sftpWrite(conn: Client, remotePath: string, content: string, mode?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.writeFile(remotePath, content, mode === undefined ? {} : { mode }, (e) => {
        sftp.end();
        if (e) reject(e);
        else resolve();
      });
    });
  });
}

function sshExec(conn: Client, cmd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('data', (d: Buffer) => (out += d.toString()));
      stream.stderr.on('data', (d: Buffer) => (out += d.toString()));
      stream.on('close', (code: number | null) => resolve({ code: code ?? 0, out: out.trim() }));
    });
  });
}

/**
 * Обновление агента БЕЗ пароля: толкаем текущий код агента по HTTP работающему агенту,
 * он перезаписывает себя и перезапускается. Нужен живой агент (иначе — полная переустановка).
 */
export async function updateAgent(db: Database.Database, id: number): Promise<{ ok: boolean; error?: string }> {
  const row = db.prepare<[number], RedServerRow>('SELECT * FROM red_servers WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Сервер не найден' };
  if (!row.agent_port) return { ok: false, error: 'Агент ещё не установлен — нужна полная установка по SSH' };
  if (!row.agent_fp) return { ok: false, error: 'Агент старой установки без TLS — по сети не обновить, нужна переустановка по SSH' };

  const addr: AgentAddr = { host: row.address, port: row.agent_port, token: row.token, fp: row.agent_fp };
  const push = await agentSelfUpdate(addr, AGENT_PY);
  if (!push.ok) return { ok: false, error: push.error ?? 'агент не принял обновление' };

  // ждём перезапуск и проверяем здоровье
  let health = null;
  for (let i = 0; i < 8 && !health?.ok; i++) {
    await sleep(1000);
    health = await agentHealth(addr);
  }
  if (health?.ok) {
    agentLastOk.set(id, Date.now());
    db.prepare("UPDATE red_servers SET agent_status = 'connected', last_error = NULL WHERE id = ?").run(id);
    return { ok: true };
  }
  db.prepare("UPDATE red_servers SET agent_status = 'error', last_error = ? WHERE id = ?").run(
    'агент не поднялся после обновления',
    id,
  );
  return { ok: false, error: 'агент не поднялся после обновления' };
}

/**
 * Установка ноды по SSH (асинхронно): подключение → факты о сервере → проверка площадки.
 * Пишет прогресс в живой лог, факты и статус — в БД. Пароль наружу не выходит.
 */
export function installRedServer(db: Database.Database, id: number, creds: SshCreds): void {
  const job: InstallJob = { lines: [], done: false, ok: false };
  jobs.set(id, job);
  const log = (line: string) => job.lines.push(line);
  const fail = (msg: string) => {
    log(`✗ ${msg}`);
    db.prepare("UPDATE red_servers SET agent_status = 'error', last_error = ? WHERE id = ?").run(msg, id);
    job.done = true;
  };

  void (async () => {
    const row = db.prepare<[number], RedServerRow>('SELECT * FROM red_servers WHERE id = ?').get(id);
    if (!row) return fail('Сервер пропал из базы');

    // пароль: из формы (первый раз) ИЛИ сохранённый (переустановка без ввода)
    const stored = row.ssh_pass ? decryptSecret(row.ssh_pass) : null;
    if (row.ssh_pass && stored == null) {
      // ключ шифрования сменился/утерян — сохранёнка бесполезна, пусть UI снова спросит пароль
      db.prepare('UPDATE red_servers SET ssh_pass = NULL WHERE id = ?').run(id);
    }
    const password = creds.password ?? stored ?? undefined;
    if (!password) return fail('Нужен SSH-пароль — введи его в форме');

    db.prepare("UPDATE red_servers SET agent_status = 'installing', last_error = NULL WHERE id = ?").run(id);

    // Ключ хоста SSH: при первом подключении запоминаем (TOFU), дальше сверяем ДО отправки
    // пароля — подменённому серверу пароль не достанется. Ключ меняется при переустановке ОС;
    // тогда человек явно подтверждает новый галочкой в форме переустановки
    const expectedHostFp = creds.acceptNewHostKey ? null : row.ssh_host_fp;
    const seen = { hostFp: null as string | null };
    const hostVerifier = (fp: string): boolean => {
      seen.hostFp = fp;
      return expectedHostFp == null || fp === expectedHostFp;
    };

    let conn: Client | null = null;
    try {
      log(`Подключаюсь по SSH к ${row.address}:${row.port}…`);
      conn = await sshConnectRetry({
        host: row.address,
        port: row.port,
        username: creds.username,
        password,
        hostHash: 'sha256',
        hostVerifier,
      });
      log('✓ SSH-доступ есть');
      if (seen.hostFp && seen.hostFp !== row.ssh_host_fp) {
        db.prepare('UPDATE red_servers SET ssh_host_fp = ? WHERE id = ?').run(seen.hostFp, id);
        log(
          row.ssh_host_fp
            ? `⚠ Принят новый ключ хоста по твоему подтверждению (…${seen.hostFp.slice(-12)})`
            : `✓ Ключ хоста SSH запомнен (…${seen.hostFp.slice(-12)}) — дальше сверяется при каждом подключении`,
        );
      }
      // запоминаем пароль (шифрованным) — чтобы дальше переустанавливать без ввода
      db.prepare('UPDATE red_servers SET ssh_pass = ? WHERE id = ?').run(encryptSecret(password), id);

      log('Собираю информацию о сервере…');
      const os = (await sshExec(conn, '. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"')).out || null;
      const kernel = (await sshExec(conn, 'uname -sr')).out || null;
      const cpu =
        (await sshExec(conn, "grep -m1 'model name' /proc/cpuinfo | cut -d: -f2")).out.trim() || null;
      const cores = Number((await sshExec(conn, 'nproc')).out) || null;
      const memMb = Number((await sshExec(conn, "free -m | awk '/^Mem:/{print $2}'")).out) || null;
      const diskFree = (await sshExec(conn, "df -h / | awk 'NR==2{print $4}'")).out || null;
      db.prepare('UPDATE red_servers SET os = ?, kernel = ?, cpu = ?, cores = ?, mem_mb = ?, disk_free = ? WHERE id = ?').run(
        os,
        kernel,
        cpu,
        cores,
        memMb,
        diskFree,
        id,
      );
      log(`✓ ${os ?? 'ОС не определена'} · ${cores ?? '?'} CPU · ${memMb ? Math.round(memMb / 1024) + ' ГБ RAM' : 'RAM ?'}`);

      // ---- раскатка агента: xray + agent.py + systemd ----
      log('Проверяю зависимости (python3, curl)…');
      const py = (await sshExec(conn, 'command -v python3 || true')).out;
      if (!py) return fail('на ноде нет python3 — агент не поставить');
      if (!(await sshExec(conn, 'command -v curl || true')).out) {
        log('· curl не найден, ставлю…');
        await sshExec(conn, 'apt-get update -y && apt-get install -y curl || yum install -y curl || true');
      }

      await sshExec(conn, `mkdir -p ${AGENT_DIR}`);
      // xray уже стоит? тогда не качаем заново — переустановка агента идёт быстро
      const existingXray = (await sshExec(conn, `${AGENT_DIR}/xray version 2>/dev/null | head -1`)).out;
      if (/Xray/i.test(existingXray)) {
        log(`✓ xray уже на ноде: ${existingXray.split('\n').pop()}`);
      } else {
        const arch = (await sshExec(conn, 'uname -m')).out || 'x86_64';
        log('Ставлю xray на ноду…');
        const xrayUrl = await xrayLinuxUrl(arch);
        const xrayCmd =
          `curl -fsSL -o /tmp/rmxray.zip '${xrayUrl}' && ` +
          `( command -v unzip >/dev/null && unzip -o /tmp/rmxray.zip xray -d ${AGENT_DIR} || ` +
          `python3 -c "import zipfile;zipfile.ZipFile('/tmp/rmxray.zip').extract('xray','${AGENT_DIR}')" ) && ` +
          `chmod +x ${AGENT_DIR}/xray && rm -f /tmp/rmxray.zip && ${AGENT_DIR}/xray version | head -1`;
        const xrayRes = await sshExec(conn, xrayCmd);
        if (!/Xray/i.test(xrayRes.out)) return fail(`xray не установился: ${xrayRes.out.slice(0, 120)}`);
        log(`✓ ${xrayRes.out.split('\n').pop()}`);
      }

      log('Разворачиваю агента начисто…');
      // чистая переустановка: гасим старый сервис и сносим прежний код с юнитом
      await sshExec(conn, 'systemctl stop remnamatcher-agent 2>/dev/null || true');
      await sshExec(conn, `rm -f ${AGENT_DIR}/agent.py /etc/systemd/system/remnamatcher-agent.service`);
      // файлы заливаем по SFTP — надёжно для любого размера, без шелл-экранирования
      await sftpWrite(conn, `${AGENT_DIR}/agent.py`, AGENT_PY);

      // ---- TLS: самоподписанный сертификат на ноде; отпечаток забираем по SSH и прикалываем ----
      log('Готовлю TLS-сертификат агента…');
      if (!(await sshExec(conn, 'command -v openssl || true')).out) {
        log('· openssl не найден, ставлю…');
        await sshExec(conn, 'apt-get update -y && apt-get install -y openssl || yum install -y openssl || true');
        if (!(await sshExec(conn, 'command -v openssl || true')).out) {
          return fail('на ноде нет openssl — без него агент не поднять по TLS');
        }
      }
      // сертификат переживает переустановки: есть — используем, нет — выпускаем на 10 лет
      const certRes = await sshExec(
        conn,
        `( [ -s ${AGENT_DIR}/agent.key ] && [ -s ${AGENT_DIR}/agent.crt ] ) || ` +
          `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${AGENT_DIR}/agent.key -out ${AGENT_DIR}/agent.crt ` +
          `-days 3650 -subj /CN=remnamatcher-agent >/dev/null 2>&1; ` +
          `chmod 600 ${AGENT_DIR}/agent.key; openssl x509 -in ${AGENT_DIR}/agent.crt -noout -fingerprint -sha256`,
      );
      const fpMatch = /Fingerprint=([0-9A-Fa-f:]{95})/.exec(certRes.out);
      if (!fpMatch) return fail(`не удалось выпустить сертификат агента: ${certRes.out.slice(0, 160)}`);
      const fp = fpMatch[1]!.toUpperCase();
      log(`✓ Сертификат готов, отпечаток …${fp.slice(-11)}`);

      // секреты — в отдельный файл с правами 0600, а не в мир-читаемый юнит systemd
      await sftpWrite(
        conn,
        `${AGENT_DIR}/agent.env`,
        `AGENT_TOKEN=${row.token}\nAGENT_PORT=${AGENT_PORT}\nXRAY_BIN=${AGENT_DIR}/xray\n` +
          `AGENT_TLS_CERT=${AGENT_DIR}/agent.crt\nAGENT_TLS_KEY=${AGENT_DIR}/agent.key\n`,
        0o600,
      );
      // ExecStart через явный поиск python3 (на некоторых образах он не в /usr/bin)
      const pyBin = (await sshExec(conn, 'command -v python3')).out.trim() || '/usr/bin/python3';
      const unit =
        `[Unit]\nDescription=RemnaMatcher agent\nAfter=network.target\n\n` +
        `[Service]\nEnvironmentFile=${AGENT_DIR}/agent.env\n` +
        `ExecStart=${pyBin} ${AGENT_DIR}/agent.py\nRestart=always\nRestartSec=3\n\n` +
        `[Install]\nWantedBy=multi-user.target\n`;
      await sftpWrite(conn, '/etc/systemd/system/remnamatcher-agent.service', unit);
      // проверим, что python вообще запускает агента (синтаксис/импорты) — до systemd
      const dry = await sshExec(conn, `${pyBin} -c "import ast; ast.parse(open('${AGENT_DIR}/agent.py').read()); print('PYOK')"`);
      if (!/PYOK/.test(dry.out)) return fail(`агент не парсится python: ${dry.out.slice(0, 160)}`);
      // restart (не enable --now): если агент уже крутится, enable --now НЕ перезапустит его,
      // и в памяти останется старый код при обновлённом файле. restart гарантирует новый код.
      await sshExec(conn, 'systemctl daemon-reload && systemctl enable remnamatcher-agent && systemctl restart remnamatcher-agent');
      // лучшая попытка открыть порт: ufw И прямое правило iptables (на многих облаках ufw неактивен)
      await sshExec(
        conn,
        `command -v ufw >/dev/null && ufw allow ${AGENT_PORT}/tcp || true; ` +
          `command -v iptables >/dev/null && (iptables -C INPUT -p tcp --dport ${AGENT_PORT} -j ACCEPT 2>/dev/null || ` +
          `iptables -I INPUT -p tcp --dport ${AGENT_PORT} -j ACCEPT) || true`,
      );
      db.prepare('UPDATE red_servers SET agent_port = ?, agent_fp = ? WHERE id = ?').run(AGENT_PORT, fp, id);
      log(`✓ Агент установлен, порт ${AGENT_PORT} (TLS)`);

      // 1) проверяем агента ЛОКАЛЬНО на ноде — отделяет «сервис не поднялся» от «фаервол»
      log('Проверяю агента на ноде…');
      await sleep(2500);
      const localHealth = await sshExec(
        conn,
        `curl -sk --max-time 5 -H 'X-Agent-Token: ${row.token}' https://127.0.0.1:${AGENT_PORT}/health || echo FAIL`,
      );
      if (!/"ok"\s*:\s*true/.test(localHealth.out)) {
        // сервис не отвечает даже локально — вытащим причину из systemd в лог установки
        const active = (await sshExec(conn, 'systemctl is-active remnamatcher-agent 2>/dev/null')).out;
        const jlog = await sshExec(
          conn,
          'journalctl -u remnamatcher-agent --no-pager -n 15 2>/dev/null || systemctl status remnamatcher-agent --no-pager 2>&1 | tail -15',
        );
        log(`✗ Агент не отвечает локально (сервис: ${active || '?'}). Логи:`);
        jlog.out
          .split('\n')
          .filter((l) => l.trim())
          .slice(-12)
          .forEach((l) => log('   ' + l.slice(0, 160)));
        db.prepare("UPDATE red_servers SET agent_status = 'error', last_error = ? WHERE id = ?").run(
          `агент не поднялся на ноде (сервис ${active || '?'}) — смотри логи в установке`,
          id,
        );
        await checkRedServer(db, id);
        job.done = true;
        return;
      }
      log('✓ Агент отвечает локально на ноде');

      // 2) проверяем связь панель → агент (много попыток: связь до ноды может флапать)
      log('Проверяю связь панель → агент…');
      let health = null;
      for (let i = 0; i < 15 && !health?.ok; i++) {
        health = await agentHealth({ host: row.address, port: AGENT_PORT, token: row.token, fp });
        if (!health?.ok) await sleep(1000);
      }
      await checkRedServer(db, id);
      if (health?.ok) {
        agentLastOk.set(id, Date.now());
        db.prepare("UPDATE red_servers SET agent_status = 'connected' WHERE id = ?").run(id);
        log(`✓ Агент на связи${health.xray ? ' · xray готов' : ''} — сервер готов к работе`);
        job.ok = true;
      } else {
        db.prepare("UPDATE red_servers SET agent_status = 'error', last_error = ? WHERE id = ?").run(
          `агент работает на ноде, но панель не достучалась до порта ${AGENT_PORT} — открой его в облачном фаерволе`,
          id,
        );
        log(`✗ Агент жив на ноде, но панель не достучалась до ${AGENT_PORT} — открой порт в ОБЛАЧНОМ фаерволе`);
      }
      job.done = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/host denied/i.test(msg)) {
        fail(
          `${HOST_KEY_CHANGED}: был …${(row.ssh_host_fp ?? '').slice(-12)}, стал …${(seen.hostFp ?? '').slice(-12)}. ` +
            'Пароль серверу НЕ отправлен. Если сервер переустанавливали — запусти переустановку с галочкой ' +
            '«принять новый ключ хоста»; иначе кто-то подменяет сервер',
        );
      } else {
        fail(/authentication/i.test(msg) ? 'SSH не пустил: неверный логин или пароль' : `SSH: ${msg}`);
      }
    } finally {
      conn?.end();
    }
  })();
}
