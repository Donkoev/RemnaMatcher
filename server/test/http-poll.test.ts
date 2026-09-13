import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRemnaReader, PanelVersionState } from '../src/remnawave/http.js';

type Step = { status: number; body?: unknown; headers?: Record<string, string> };

/** fetch-заглушка: отдаёт ответы по очереди, запоминает вызовы */
function stubFetch(steps: Step[]): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      const step = steps.shift() ?? { status: 500 };
      return new Response(JSON.stringify(step.body ?? { statusCode: step.status }), {
        status: step.status,
        headers: { 'content-type': 'application/json', ...step.headers },
      });
    }),
  );
  return { calls };
}

const done = (success: boolean) => ({
  response: {
    isCompleted: true,
    isFailed: false,
    result: { nodeUuid: 'n1', success, users: success ? [{ userId: 7, ips: [{ ip: '1.2.3.4', lastSeen: '2026-09-13T10:00:00Z' }] }] : [] },
  },
});
const pending = { response: { isCompleted: false, isFailed: false, result: null } };

describe('опрос сессий ноды — устойчивость к сбоям отдельных запросов', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('429 и 5xx на запросе результата не списывают ноду: опрос продолжается до готовности', async () => {
    const ver = new PanelVersionState();
    ver.set('3');
    const { calls } = stubFetch([
      { status: 201, body: { response: { jobId: 'j1' } } },
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 502 },
      { status: 200, body: pending },
      { status: 200, body: done(true) },
    ]);
    const reader = new HttpRemnaReader({ baseUrl: 'https://panel.test', token: 't' }, ver);
    const res = await reader.fetchNodeSessions('n1');
    expect(res.success).toBe(true);
    expect(res.users).toEqual([{ userId: '7', ips: [{ ip: '1.2.3.4', lastSeen: '2026-09-13T10:00:00Z' }] }]);
    expect(calls[0]).toBe('POST /api/connections/by-node/n1');
    expect(calls.filter((c) => c.startsWith('GET /api/connections/by-node/j1'))).toHaveLength(4);
  }, 20_000);

  it('панель вернула job без результата — понятная причина', async () => {
    const ver = new PanelVersionState();
    ver.set('3');
    stubFetch([{ status: 201, body: { response: { jobId: 'j2' } } }, { status: 200, body: done(false) }]);
    const reader = new HttpRemnaReader({ baseUrl: 'https://panel.test', token: 't' }, ver);
    const res = await reader.fetchNodeSessions('n1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/нода не ответила панели/);
  });

  it('временный сбой на запуске job повторяется, 404 — нет (это смена версии API)', async () => {
    const ver = new PanelVersionState();
    ver.set('3');
    stubFetch([
      { status: 503 },
      { status: 201, body: { response: { jobId: 'j3' } } },
      { status: 200, body: done(true) },
    ]);
    const reader = new HttpRemnaReader({ baseUrl: 'https://panel.test', token: 't' }, ver);
    expect((await reader.fetchNodeSessions('n1')).success).toBe(true);

    stubFetch([{ status: 404 }]);
    await expect(reader.fetchNodeSessions('n1')).rejects.toThrow(/HTTP 404/);
  }, 20_000);
});
