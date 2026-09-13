import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  HOST_KEY_CHANGED,
  checkTcp,
  getInstallJob,
  installRedServer,
  startRedServerPoller,
  updateAgent,
  type RedServerRow,
} from '../red/servers.js';
import {
  HWID_RE,
  SUB_HWID_SETTING,
  refreshSubscription,
  type RedSubscriptionRow,
  type SubServer,
} from '../red/subscriptions.js';
import { serverOutbound, urlTestOutbounds } from '../red/urltest.js';
import { agentSpeedStart, agentSpeedStatus, agentSpeedStop, type AgentAddr } from '../red/agent.js';
import { SpeedRunError, SpeedRunner, persistRun, readPersistedRun, type SpeedNodeTarget } from '../red/speedrun.js';

// ===== Инфраструктура: подключённые узлы, конфигурации, спидтест =====
// Регистрируется только при NODE_PANEL в .env; все ручки живут под /api/red/*
// и закрыты той же сессией, что и остальной API.

export function registerRedRoutes(app: FastifyInstance, db: Database.Database): void {
  // токен агента и SSH-данные наружу не отдаём
  const toDto = (r: RedServerRow) => ({
    id: r.id,
    name: r.name,
    address: r.address,
    port: r.port,
    sshUser: r.ssh_user,
    status: r.status,
    agentStatus: r.agent_status,
    // агент ставился → «Обновить агента» доступно и из «ошибки» (это путь восстановления без SSH)
    agentReady: r.agent_port != null,
    // сертификат закреплён — панель ходит к агенту по TLS; иначе старый агент по HTTP до переустановки
    tls: r.agent_fp != null,
    hasPass: r.ssh_pass != null, // пароль сохранён (шифрованно) — переустановка без ввода
    // ключ хоста SSH не совпал с запомненным — переустановка требует явно принять новый
    hostKeyChanged: r.last_error?.startsWith(HOST_KEY_CHANGED) ?? false,
    lastError: r.last_error,
    os: r.os,
    kernel: r.kernel,
    cpu: r.cpu,
    cores: r.cores,
    memMb: r.mem_mb,
    diskFree: r.disk_free,
    latencyMs: r.latency_ms,
    lastCheckAt: r.last_check_at,
    lastOkAt: r.last_ok_at,
    createdAt: r.created_at,
  });

  // агент готов к командам: порт есть и сертификат приколот. Старый агент без TLS — только переустановка
  const agentOf = (r: RedServerRow): AgentAddr | null =>
    r.agent_port == null || r.agent_fp == null
      ? null
      : { host: r.address, port: r.agent_port, token: r.token, fp: r.agent_fp };
  const noAgentError = (r: RedServerRow): string =>
    r.agent_port == null ? 'На ноде не установлен агент' : 'Агент без TLS — переустанови его в «Серверах»';

  app.get('/api/red/servers', () => {
    const rows = db.prepare<[], RedServerRow>('SELECT * FROM red_servers ORDER BY created_at').all();
    return rows.map(toDto);
  });

  const SshBody = z.object({
    name: z.string().trim().min(1).max(60),
    address: z.string().trim().min(3).max(253),
    port: z.coerce.number().int().min(1).max(65535).default(22),
    username: z.string().trim().min(1).max(64).default('root'),
    password: z.string().min(1).max(200),
  });

  // добавить сервер: панель сама заходит по SSH и ставит ноду; пароль сохраняется шифрованным
  app.post('/api/red/servers', (req, reply) => {
    const parsed = SshBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Проверь поля: имя, адрес, порт, логин и пароль' });
    const { name, address, port, username, password } = parsed.data;
    if (db.prepare('SELECT 1 FROM red_servers WHERE address = ?').get(address)) {
      return reply.code(409).send({ error: 'Сервер с таким адресом уже добавлен' });
    }
    const token = randomBytes(24).toString('hex');
    const info = db
      .prepare('INSERT INTO red_servers (name, address, port, ssh_user, token, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, address, port, username, token, Date.now());
    const id = Number(info.lastInsertRowid);
    installRedServer(db, id, { username, password });
    return { ok: true, id };
  });

  // переустановка: адрес уже в базе, нужны только свежие SSH-креды
  app.post('/api/red/servers/:id/install', (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const srv = db.prepare<[number], RedServerRow>('SELECT * FROM red_servers WHERE id = ?').get(id);
    if (!srv) return reply.code(404).send({ error: 'Сервер не найден' });
    // две параллельные установки на один сервер дерутся за лог и БД — не допускаем
    if (getInstallJob(id)?.done === false) {
      return reply.code(409).send({ error: 'Установка уже идёт — дождись её окончания' });
    }
    // пароль обязателен, только если сохранённого ещё нет
    const parsed = z
      .object({
        username: z.string().trim().min(1).max(64).optional(),
        password: z.string().min(1).max(200).optional(),
        acceptNewHostKey: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Проверь логин/пароль' });
    if (!parsed.data.password && !srv.ssh_pass) {
      return reply.code(400).send({ error: 'Нужен SSH-пароль (первый раз)' });
    }
    const username = parsed.data.username || srv.ssh_user;
    db.prepare('UPDATE red_servers SET ssh_user = ? WHERE id = ?').run(username, id);
    installRedServer(db, id, {
      username,
      password: parsed.data.password,
      acceptNewHostKey: parsed.data.acceptNewHostKey,
    });
    return { ok: true, id };
  });

  // живой лог установки — фронт поллит его, пока done не станет true
  app.get('/api/red/servers/:id/install-log', (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const job = getInstallJob(id);
    if (!job) return reply.code(404).send({ error: 'Установка не запускалась' });
    return job;
  });

  // обновление агента без пароля (по HTTP работающему агенту)
  app.post('/api/red/servers/:id/update-agent', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const res = await updateAgent(db, id);
    if (!res.ok) return reply.code(502).send({ error: res.error ?? 'Не удалось обновить агента' });
    return { ok: true };
  });

  app.delete('/api/red/servers/:id', (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const info = db.prepare('DELETE FROM red_servers WHERE id = ?').run(id);
    if (info.changes === 0) return reply.code(404).send({ error: 'Сервер не найден' });
    return { ok: true };
  });

  // ===== Настройки раздела: HWID для импорта подписок =====
  // пусто — панель выводит стабильный HWID сама (из секрета установки и URL подписки)
  app.get('/api/red/settings', () => {
    const row = db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?').get(SUB_HWID_SETTING);
    return { hwid: row?.value ?? '' };
  });

  app.put('/api/red/settings', (req, reply) => {
    const parsed = z.object({ hwid: z.string().trim().max(64) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'HWID — строка до 64 символов' });
    const hwid = parsed.data.hwid;
    if (hwid && !HWID_RE.test(hwid)) {
      return reply.code(400).send({ error: 'HWID: только латиница, цифры и дефис, от 4 до 64 символов' });
    }
    if (hwid) db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(SUB_HWID_SETTING, hwid);
    else db.prepare('DELETE FROM settings WHERE key = ?').run(SUB_HWID_SETTING);
    return { ok: true, hwid };
  });

  // ===== Конфигурации: импортированные подписки (как в Happ) =====
  // ссылки и outbound'ы несут креды (uuid/пароли) — в браузер их не отдаём
  const stripSecrets = (s: SubServer): SubServer => ({
    ...s,
    link: undefined,
    outbound: undefined,
    pool: s.pool?.map(stripSecrets),
  });
  const subToDto = (r: RedSubscriptionRow) => {
    let servers: SubServer[] = [];
    try {
      servers = (JSON.parse(r.servers) as SubServer[]).map(stripSecrets);
    } catch {
      /* битый JSON в базе — покажем пустой список */
    }
    return {
      id: r.id,
      name: r.name,
      url: r.url,
      servers,
      serverCount: r.server_count,
      lastError: r.last_error,
      trafficUsed: r.traffic_used,
      trafficTotal: r.traffic_total,
      expireAt: r.expire_at,
      updatedAt: r.updated_at,
      createdAt: r.created_at,
    };
  };

  app.get('/api/red/subscriptions', () => {
    const rows = db.prepare<[], RedSubscriptionRow>('SELECT * FROM red_subscriptions ORDER BY created_at').all();
    return rows.map(subToDto);
  });

  const SubBody = z.object({
    // название необязательно: пустое заполнится из profile-title подписки или хоста URL
    name: z.string().trim().max(60).optional().default(''),
    url: z.string().trim().url().max(2000),
  });

  // добавить подписку: панель сразу качает её и разбирает список серверов
  app.post('/api/red/subscriptions', async (req, reply) => {
    const parsed = SubBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Нужен корректный URL подписки' });
    const { name, url } = parsed.data;
    if (!/^https?:$/.test(new URL(url).protocol)) return reply.code(400).send({ error: 'URL должен быть http(s)' });
    if (db.prepare('SELECT 1 FROM red_subscriptions WHERE url = ?').get(url)) {
      return reply.code(409).send({ error: 'Такая подписка уже добавлена' });
    }
    const info = db
      .prepare('INSERT INTO red_subscriptions (name, url, created_at) VALUES (?, ?, ?)')
      .run(name, url, Date.now());
    const id = Number(info.lastInsertRowid);
    // первый импорт сразу: если не выйдет — карточка появится с ошибкой и кнопкой «Обновить»
    await refreshSubscription(db, id);
    const row = db.prepare<[number], RedSubscriptionRow>('SELECT * FROM red_subscriptions WHERE id = ?').get(id);
    return row ? subToDto(row) : reply.code(500).send({ error: 'Подписка пропала из базы' });
  });

  // повторный импорт: перечитать подписку по её URL
  app.post('/api/red/subscriptions/:id/refresh', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = await refreshSubscription(db, id);
    if (!row) return reply.code(404).send({ error: 'Подписка не найдена' });
    return subToDto(row);
  });

  app.delete('/api/red/subscriptions/:id', (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const info = db.prepare('DELETE FROM red_subscriptions WHERE id = ?').run(id);
    if (info.changes === 0) return reply.code(404).send({ error: 'Подписка не найдена' });
    return { ok: true };
  });

  // пинг серверов подписки — URL-тест, как burstObservatory у балансировщика xray:
  // GET http://connectivitycheck.gstatic.com/generate_204 ЧЕРЕЗ каждый сервер (временный
  // локальный xray), задержка — весь путь до интернета. Серверы без данных для outbound
  // проверяются TCP-коннектом (via: 'tcp'). Ключ результата — «address:port»,
  // пулы балансировщиков пингуются посерверно
  app.post('/api/red/subscriptions/:id/ping', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db.prepare<[number], RedSubscriptionRow>('SELECT * FROM red_subscriptions WHERE id = ?').get(id);
    if (!row) return reply.code(404).send({ error: 'Подписка не найдена' });
    let servers: SubServer[] = [];
    try {
      servers = JSON.parse(row.servers) as SubServer[];
    } catch {
      /* битый JSON — пинговать нечего */
    }
    // подписка разобрана старой версией панели (без ссылок/outbound'ов) —
    // перечитаем её, чтобы URL-тесту было из чего собирать конфиг
    const hasCreds = (list: SubServer[]): boolean =>
      list.some((s) => s.link != null || s.outbound != null || (s.pool != null && hasCreds(s.pool)));
    if (servers.length > 0 && !hasCreds(servers)) {
      const fresh = await refreshSubscription(db, id);
      if (fresh) {
        try {
          servers = JSON.parse(fresh.servers) as SubServer[];
        } catch {
          /* оставим старый список */
        }
      }
    }
    const targets = new Map<string, SubServer>();
    const collect = (s: SubServer) => {
      const key = `${s.address}:${s.port}`;
      if (s.address && s.port != null && s.port > 1 && !targets.has(key)) targets.set(key, s);
      s.pool?.forEach(collect);
    };
    servers.forEach(collect);

    const urlItems: { key: string; host: string; port: number; outbound: Record<string, unknown> }[] = [];
    const tcpItems: { key: string; host: string; port: number }[] = [];
    for (const [key, s] of targets) {
      const outbound = serverOutbound(s);
      if (outbound) urlItems.push({ key, host: s.address, port: s.port!, outbound });
      else tcpItems.push({ key, host: s.address, port: s.port! });
    }

    const results: Record<string, { ok: boolean; latencyMs: number | null; via: 'url' | 'tcp' }> = {};
    if (urlItems.length > 0) {
      try {
        const tested = await urlTestOutbounds(urlItems);
        for (const [key, r] of Object.entries(tested)) results[key] = { ...r, via: 'url' };
      } catch {
        // xray не скачался/не запустился — честный фолбэк на TCP-коннект
        tcpItems.push(...urlItems.map(({ key, host, port }) => ({ key, host, port })));
      }
    }
    // пачками, чтобы большая подписка не открывала сотню коннектов разом
    const CONCURRENCY = 10;
    for (let i = 0; i < tcpItems.length; i += CONCURRENCY) {
      await Promise.all(
        tcpItems.slice(i, i + CONCURRENCY).map(async (t) => {
          results[t.key] = { ...(await checkTcp(t.host, t.port)), via: 'tcp' };
        }),
      );
    }
    return { results };
  });

  // Непрерывный спидтест силами нод: владелец замера — панель (см. red/speedrun.ts).
  // start запускает на выбранных нодах параллельные потоки через outbound сервера подписки,
  // дальше панель сама опрашивает агентов и отдаёт странице одно состояние; stop глушит
  // все ноды и оставляет итог. Страница может обновляться и закрываться — замер идёт.
  const nodeById = (serverId: number) =>
    db.prepare<[number], RedServerRow>('SELECT * FROM red_servers WHERE id = ?').get(serverId);
  const speedTarget = (serverId: number): SpeedNodeTarget => {
    const node = nodeById(serverId);
    if (!node) return { serverId, name: `#${serverId}`, agent: null, error: 'Нода не найдена' };
    const agent = agentOf(node);
    return { serverId, name: node.name, agent, error: agent ? undefined : noAgentError(node) };
  };
  const runner = new SpeedRunner({
    client: { start: agentSpeedStart, status: agentSpeedStatus, stop: agentSpeedStop },
    persist: (r) => persistRun(db, r),
  });
  // рестарт панели: подхватываем запуск, который агенты ещё держат (без опросов они ждут ~30 с)
  const persisted = readPersistedRun(db);
  if (persisted) runner.adopt(persisted, persisted.serverIds.map(speedTarget));

  app.get('/api/red/speedtest', () => runner.state());

  const SpeedStartBody = z.object({
    subId: z.number().int().positive(),
    key: z.string().min(3).max(300),
    serverIds: z.array(z.number().int().positive()).min(1).max(50),
  });
  app.post('/api/red/speedtest/start', async (req, reply) => {
    const parsed = SpeedStartBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Нужны подписка, ключ сервера (address:port) и ноды' });
    const { subId, key, serverIds } = parsed.data;
    if (runner.state().active) return reply.code(409).send({ error: 'Замер уже идёт — сначала останови его' });
    const row = db.prepare<[number], RedSubscriptionRow>('SELECT * FROM red_subscriptions WHERE id = ?').get(subId);
    if (!row) return reply.code(404).send({ error: 'Подписка не найдена' });
    let servers: SubServer[] = [];
    try {
      servers = JSON.parse(row.servers) as SubServer[];
    } catch {
      /* битый JSON — сервер не найдём */
    }
    let target: SubServer | null = null;
    const find = (s: SubServer) => {
      if (!target && s.address && s.port != null && `${s.address}:${s.port}` === key) target = s;
      s.pool?.forEach(find);
    };
    servers.forEach(find);
    if (!target) return reply.code(404).send({ error: 'Сервер не найден в подписке' });
    const outbound = serverOutbound(target);
    if (!outbound) return reply.code(400).send({ error: 'Для сервера нет данных подключения — обнови подписку' });
    try {
      return await runner.start(subId, key, outbound, [...new Set(serverIds)].map(speedTarget));
    } catch (e) {
      if (e instanceof SpeedRunError) return reply.code(409).send({ error: e.message });
      throw e;
    }
  });

  // агент не ответил на стоп — не страшно: без опросов статуса он заглушит замер сам
  app.post('/api/red/speedtest/stop', () => runner.stop());

  startRedServerPoller(db);
}
