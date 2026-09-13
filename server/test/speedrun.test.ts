import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAddr, AgentSpeedStatus } from '../src/red/agent.js';
import { SpeedRunError, SpeedRunner, type PersistedRun, type SpeedNodeTarget, type SpeedRunClient } from '../src/red/speedrun.js';

const addr = (n: number): AgentAddr => ({ host: `10.0.0.${n}`, port: 8760, token: 't', fp: 'F' });
const target = (id: number, agent = true): SpeedNodeTarget => ({
  serverId: id,
  name: `node${id}`,
  agent: agent ? addr(id) : null,
  error: agent ? undefined : 'На ноде не установлен агент',
});

/** агент-заглушка: статус задаётся функцией от адреса, стоп возвращает тот же снимок с running=false */
function fakeClient(status: (a: AgentAddr) => AgentSpeedStatus | null) {
  const calls = { start: 0, stop: 0, status: 0 };
  const client: SpeedRunClient = {
    start: async () => {
      calls.start++;
      return { ok: true };
    },
    status: async (a) => {
      calls.status++;
      return status(a);
    },
    stop: async (a) => {
      calls.stop++;
      const st = status(a);
      return st ? { ...st, running: false } : null;
    },
  };
  return { client, calls };
}

function runner(client: SpeedRunClient, persisted: (PersistedRun | null)[] = []) {
  return new SpeedRunner({ client, persist: (p) => persisted.push(p), pollMs: 1000 });
}

describe('SpeedRunner', () => {
  afterEach(() => vi.useRealTimers());

  it('старт → панель сама поллит статусы → стоп: итог остаётся, запись о запуске очищается', async () => {
    vi.useFakeTimers();
    let elapsed = 0;
    const { client, calls } = fakeClient(() => ({ running: true, elapsedS: elapsed, downCurrentMbps: 100 }));
    const persisted: (PersistedRun | null)[] = [];
    const r = runner(client, persisted);
    const st = await r.start(1, 'h:443', { protocol: 'freedom' }, [target(1), target(2)]);
    expect(st.active).toBe(true);
    expect(st.run?.nodes.map((n) => n.running)).toEqual([true, true]);
    expect(calls.start).toBe(2);
    expect(persisted.at(-1)).toMatchObject({ subId: 1, key: 'h:443', serverIds: [1, 2] });

    elapsed = 5;
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.state().run?.nodes[0]?.status?.elapsedS).toBe(5);
    expect(calls.status).toBeGreaterThanOrEqual(2);

    const fin = await r.stop();
    expect(fin.active).toBe(false);
    expect(fin.run?.stoppedAt).not.toBeNull();
    expect(fin.run?.nodes.every((n) => !n.running && n.status?.running === false)).toBe(true);
    expect(calls.stop).toBe(2);
    expect(persisted.at(-1)).toBeNull();
    // после стопа опросов больше нет
    const before = calls.status;
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.status).toBe(before);
    r.dispose();
  });

  it('нода остановила замер сама (вотчдог) — причина из заметок агента, запуск завершается', async () => {
    vi.useFakeTimers();
    let running = true;
    const note = 'панель перестала опрашивать статус — замер остановлен';
    const { client } = fakeClient(() =>
      running ? { running: true, elapsedS: 3 } : { running: false, elapsedS: 40, downAvgMbps: 500, notes: [note] },
    );
    const persisted: (PersistedRun | null)[] = [];
    const r = runner(client, persisted);
    await r.start(1, 'h:443', {}, [target(1)]);
    await vi.advanceTimersByTimeAsync(1000);
    running = false;
    await vi.advanceTimersByTimeAsync(1000);
    const st = r.state();
    expect(st.active).toBe(false);
    expect(st.run?.nodes[0]).toMatchObject({ running: false, error: note });
    expect(st.run?.nodes[0]?.status).toMatchObject({ running: false, downAvgMbps: 500 });
    expect(persisted.at(-1)).toBeNull();
    r.dispose();
  });

  it('агент перезапустился (статуса без данных) — замер на ноде прерван, прошлый статус сохранён', async () => {
    vi.useFakeTimers();
    let alive = true;
    const { client } = fakeClient(() => (alive ? { running: true, elapsedS: 7, downAvgMbps: 200 } : { running: false }));
    const r = runner(client);
    await r.start(1, 'h:443', {}, [target(1)]);
    await vi.advanceTimersByTimeAsync(1000);
    alive = false;
    await vi.advanceTimersByTimeAsync(1000);
    const n = r.state().run?.nodes[0];
    expect(n?.running).toBe(false);
    expect(n?.error).toMatch(/перезапустился/);
    expect(n?.status?.downAvgMbps).toBe(200);
    r.dispose();
  });

  it('агент молчит дольше 45 с — нода выбывает; короткая потеря связи замер не гасит', async () => {
    vi.useFakeTimers();
    let reachable = true;
    const { client } = fakeClient(() => (reachable ? { running: true, elapsedS: 1 } : null));
    const r = runner(client);
    await r.start(1, 'h:443', {}, [target(1)]);
    reachable = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.state().active).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.state().active).toBe(false);
    expect(r.state().run?.nodes[0]?.error).toMatch(/нет связи/);
    r.dispose();
  });

  it('повторный старт при живом замере отклоняется, после стопа — новый запуск', async () => {
    vi.useFakeTimers();
    const { client } = fakeClient(() => ({ running: true, elapsedS: 1 }));
    const r = runner(client);
    await r.start(1, 'h:443', {}, [target(1)]);
    await expect(r.start(2, 'x:1', {}, [target(1)])).rejects.toBeInstanceOf(SpeedRunError);
    await r.stop();
    const st = await r.start(2, 'x:1', {}, [target(1)]);
    expect(st.run).toMatchObject({ subId: 2, key: 'x:1' });
    expect(st.active).toBe(true);
    r.dispose();
  });

  it('нода без агента получает причину, остальные стартуют; без единой стартовавшей запуск сразу завершён', async () => {
    vi.useFakeTimers();
    const { client, calls } = fakeClient(() => ({ running: true, elapsedS: 1 }));
    const r = runner(client);
    const st = await r.start(1, 'h:443', {}, [target(1, false), target(2)]);
    expect(st.active).toBe(true);
    expect(st.run?.nodes[0]).toMatchObject({ running: false, error: 'На ноде не установлен агент' });
    expect(st.run?.nodes[1]?.running).toBe(true);
    expect(calls.start).toBe(1);
    await r.stop();
    const none = await r.start(1, 'h:443', {}, [target(3, false)]);
    expect(none.active).toBe(false);
    expect(none.run?.stoppedAt).not.toBeNull();
    r.dispose();
  });

  it('adopt после рестарта панели: бегущие на агентах замеры подхватываются, остальные помечаются', async () => {
    vi.useFakeTimers();
    const { client } = fakeClient((a) => (a.host.endsWith('.1') ? { running: true, elapsedS: 12 } : { running: false }));
    const persisted: (PersistedRun | null)[] = [];
    const r = runner(client, persisted);
    r.adopt({ subId: 5, key: 'h:443', startedAt: 123, serverIds: [1, 2] }, [target(1), target(2)]);
    await vi.advanceTimersByTimeAsync(10);
    const st = r.state();
    expect(st.active).toBe(true);
    expect(st.run).toMatchObject({ subId: 5, key: 'h:443', startedAt: 123 });
    expect(st.run?.nodes[0]?.status?.elapsedS).toBe(12);
    expect(st.run?.nodes[1]).toMatchObject({ running: false, error: expect.stringMatching(/перезапустился/) });
    await r.stop();
    expect(persisted.at(-1)).toBeNull();
    r.dispose();
  });
});
