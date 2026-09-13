import type Database from 'better-sqlite3';
import type { AgentAddr, AgentSpeedStatus } from './agent.js';

// ===== Спидтест: владелец замера — панель, а не вкладка браузера =====
// Запуск живёт здесь: панель сама опрашивает агентов нод по таймеру (это же кормит их
// вотчдог), копит последние статусы и отдаёт странице одно состояние. Страницу можно
// обновлять, переключать и закрывать — замер идёт, пока его не остановят.
// Активный запуск запоминается в settings: после рестарта панели он подхватывается,
// если агенты ещё не заглушили его сами (без опросов они ждут ~30 с).

const POLL_MS = 1000;
// агент не отвечает дольше — считаем ноду выбывшей (сама она заглохнет по вотчдогу)
const LOST_AFTER_MS = 45_000;
const PERSIST_KEY = 'red_speedrun';

export interface SpeedRunClient {
  start: (a: AgentAddr, outbound: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  status: (a: AgentAddr) => Promise<AgentSpeedStatus | null>;
  stop: (a: AgentAddr) => Promise<AgentSpeedStatus | null>;
}

/** нода-участник: без агента — сразу с причиной, почему мерить не будет */
export interface SpeedNodeTarget {
  serverId: number;
  name: string;
  agent: AgentAddr | null;
  error?: string;
}

export interface PersistedRun {
  subId: number;
  key: string;
  startedAt: number;
  serverIds: number[];
}

export interface SpeedRunNodeDto {
  serverId: number;
  name: string;
  running: boolean;
  error: string | null;
  status: AgentSpeedStatus | null;
}

export interface SpeedRunDto {
  subId: number;
  /** сервер подписки «address:port» */
  key: string;
  startedAt: number;
  stoppedAt: number | null;
  nodes: SpeedRunNodeDto[];
}

export interface SpeedStateDto {
  active: boolean;
  /** живой или последний завершённый запуск — страница показывает его итог до следующего */
  run: SpeedRunDto | null;
}

export class SpeedRunError extends Error {}

interface RunNode {
  serverId: number;
  name: string;
  agent: AgentAddr | null;
  running: boolean;
  error: string | null;
  status: AgentSpeedStatus | null;
  lastOkAt: number;
  inFlight: boolean;
}

interface Run {
  subId: number;
  key: string;
  startedAt: number;
  stoppedAt: number | null;
  starting: boolean;
  nodes: RunNode[];
}

export class SpeedRunner {
  private run: Run | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly client: SpeedRunClient;
  private readonly persist: (r: PersistedRun | null) => void;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(opts: {
    client: SpeedRunClient;
    persist: (r: PersistedRun | null) => void;
    pollMs?: number;
    now?: () => number;
  }) {
    this.client = opts.client;
    this.persist = opts.persist;
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  state(): SpeedStateDto {
    const run = this.run;
    if (!run) return { active: false, run: null };
    const active = run.stoppedAt == null && (run.starting || run.nodes.some((n) => n.running));
    return {
      active,
      run: {
        subId: run.subId,
        key: run.key,
        startedAt: run.startedAt,
        stoppedAt: run.stoppedAt,
        nodes: run.nodes.map((n) => ({
          serverId: n.serverId,
          name: n.name,
          running: n.running,
          error: n.error,
          status: n.status,
        })),
      },
    };
  }

  /** запустить замер на нодах; ноды независимы — стартуют параллельно */
  async start(
    subId: number,
    key: string,
    outbound: Record<string, unknown>,
    targets: SpeedNodeTarget[],
  ): Promise<SpeedStateDto> {
    if (this.run && this.state().active) throw new SpeedRunError('Замер уже идёт — сначала останови его');
    this.stopTimer();
    const now = this.now();
    const run: Run = {
      subId,
      key,
      startedAt: now,
      stoppedAt: null,
      starting: true,
      nodes: targets.map((t) => ({
        serverId: t.serverId,
        name: t.name,
        agent: t.agent,
        running: false,
        error: t.agent ? null : (t.error ?? 'агент недоступен'),
        status: null,
        lastOkAt: now,
        inFlight: false,
      })),
    };
    this.run = run;
    await Promise.all(
      run.nodes.map(async (n) => {
        if (!n.agent) return;
        const r = await this.client.start(n.agent, outbound);
        if (this.run !== run) return;
        if (!r.ok) {
          n.error = r.error ?? 'не удалось запустить';
          return;
        }
        if (run.stoppedAt != null) {
          // остановили, пока нода ещё стартовала — глушим сразу
          await this.client.stop(n.agent);
          return;
        }
        n.running = true;
        n.lastOkAt = this.now();
      }),
    );
    run.starting = false;
    if (this.run !== run) return this.state();
    if (run.stoppedAt == null && run.nodes.some((n) => n.running)) {
      this.persist({ subId, key, startedAt: run.startedAt, serverIds: run.nodes.map((n) => n.serverId) });
      this.startTimer();
    } else if (run.stoppedAt == null) {
      run.stoppedAt = this.now(); // ни одна нода не стартовала — запуск сразу завершён
    }
    return this.state();
  }

  /** остановить замер на всех нодах; итог остаётся в состоянии до следующего запуска */
  async stop(): Promise<SpeedStateDto> {
    const run = this.run;
    if (!run || run.stoppedAt != null) return this.state();
    run.stoppedAt = this.now();
    this.stopTimer();
    this.persist(null);
    await Promise.all(
      run.nodes
        .filter((n) => n.running && n.agent)
        .map(async (n) => {
          const st = n.agent ? await this.client.stop(n.agent) : null;
          n.running = false;
          if (st) n.status = { ...st, running: false };
          else n.error ??= 'агент не ответил на стоп — без опросов он заглушит замер сам';
        }),
    );
    return this.state();
  }

  /** после рестарта панели: подхватить запуск, который агенты ещё держат */
  adopt(p: PersistedRun, targets: SpeedNodeTarget[]): void {
    if (this.run && this.state().active) return;
    this.stopTimer();
    const now = this.now();
    this.run = {
      subId: p.subId,
      key: p.key,
      startedAt: p.startedAt,
      stoppedAt: null,
      starting: false,
      nodes: targets.map((t) => ({
        serverId: t.serverId,
        name: t.name,
        agent: t.agent,
        running: t.agent != null,
        error: t.agent ? null : (t.error ?? 'агент недоступен'),
        status: null,
        lastOkAt: now,
        inFlight: false,
      })),
    };
    if (this.run.nodes.some((n) => n.running)) this.startTimer();
    else this.finish(this.run);
  }

  dispose(): void {
    this.stopTimer();
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref?.();
    this.tick();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const run = this.run;
    if (!run || run.stoppedAt != null) return;
    for (const n of run.nodes) {
      if (n.running && n.agent && !n.inFlight) void this.poll(run, n, n.agent);
    }
  }

  // медленная нода (таймауты) не должна наслаивать опросы — по одному в полёте на ноду
  private async poll(run: Run, n: RunNode, agent: AgentAddr): Promise<void> {
    n.inFlight = true;
    let st: AgentSpeedStatus | null;
    try {
      st = await this.client.status(agent);
    } finally {
      n.inFlight = false;
    }
    // за время запроса замер остановили или начался новый — ответ уже не наш
    if (this.run !== run || run.stoppedAt != null || !n.running) return;
    const now = this.now();
    if (!st) {
      if (now - n.lastOkAt > LOST_AFTER_MS) {
        n.running = false;
        n.error = 'нет связи с агентом — без опросов он заглушит замер сам';
      }
    } else {
      n.lastOkAt = now;
      if (st.running) {
        n.status = st;
      } else {
        n.running = false;
        if (st.elapsedS != null) {
          // агент остановил замер сам (вотчдог, чужой стоп) и ещё помнит итог
          n.status = { ...st, running: false };
          n.error = st.notes?.at(-1) ?? 'замер на ноде остановлен';
        } else {
          n.error = 'агент перезапустился — замер на ноде прерван';
        }
      }
    }
    if (!run.nodes.some((x) => x.running)) this.finish(run);
  }

  private finish(run: Run): void {
    if (run.stoppedAt == null) run.stoppedAt = this.now();
    this.stopTimer();
    this.persist(null);
  }
}

// ---- запоминание активного запуска в settings ----

export function readPersistedRun(db: Database.Database): PersistedRun | null {
  const row = db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?').get(PERSIST_KEY);
  if (!row) return null;
  try {
    const p = JSON.parse(row.value) as Partial<PersistedRun>;
    if (
      typeof p.subId === 'number' &&
      typeof p.key === 'string' &&
      typeof p.startedAt === 'number' &&
      Array.isArray(p.serverIds)
    ) {
      return { subId: p.subId, key: p.key, startedAt: p.startedAt, serverIds: p.serverIds.filter((x) => typeof x === 'number') };
    }
  } catch {
    /* битая запись — считаем, что запуска не было */
  }
  return null;
}

export function persistRun(db: Database.Database, r: PersistedRun | null): void {
  if (r) db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(PERSIST_KEY, JSON.stringify(r));
  else db.prepare('DELETE FROM settings WHERE key = ?').run(PERSIST_KEY);
}
