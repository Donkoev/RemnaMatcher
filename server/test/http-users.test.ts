import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRemnaReader, PanelVersionState } from '../src/remnawave/http.js';

type Step = { status: number; body?: unknown };

function stubFetch(steps: Step[]): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(new URL(url).pathname + new URL(url).search);
      const step = steps.shift() ?? { status: 500 };
      return new Response(JSON.stringify(step.body ?? { statusCode: step.status }), {
        status: step.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { calls };
}

const raw = (id: number, uuid?: string) => ({
  id,
  uuid,
  vlessUuid: `v-${id}`,
  shortUuid: `s${id}`,
  username: `u${id}`,
  status: 'ACTIVE',
  telegramId: null,
  email: null,
  tag: null,
  expireAt: null,
  trafficLimitBytes: 0,
  hwidDeviceLimit: null,
  subscriptionUrl: null,
  userTraffic: { usedTrafficBytes: 10, onlineAt: null },
  description: null,
});

describe('streamUsers — справочник постранично, без списка целиком в памяти', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('3.x: keyset-курсор, страницы отдаются по одной, uuid берётся из vlessUuid', async () => {
    const ver = new PanelVersionState();
    ver.set('3');
    const { calls } = stubFetch([
      { status: 200, body: { response: { users: [raw(1), raw(2)], nextCursor: '2', hasMore: true } } },
      { status: 200, body: { response: { users: [raw(3)], nextCursor: null, hasMore: false } } },
    ]);
    const reader = new HttpRemnaReader({ baseUrl: 'https://panel.test', token: 't' }, ver);
    const pages: number[][] = [];
    const total = await reader.streamUsers((page) => {
      pages.push(page.map((u) => u.id));
    });
    expect(total).toBe(3);
    expect(pages).toEqual([[1, 2], [3]]);
    expect(calls).toEqual(['/api/users/stream?size=1000', '/api/users/stream?size=1000&cursor=2']);
    const all = await reader.getAllUsers().catch(() => []);
    expect(Array.isArray(all)).toBe(true);
  });

  it('2.7.x: постранично по offset, версия определяется по uuid в списке', async () => {
    const ver = new PanelVersionState();
    const { calls } = stubFetch([
      { status: 200, body: { response: { total: 3, users: [raw(1, 'a'), raw(2, 'b')] } } },
      { status: 200, body: { response: { total: 3, users: [raw(3, 'c')] } } },
    ]);
    const reader = new HttpRemnaReader({ baseUrl: 'https://panel.test', token: 't' }, ver);
    const seen: string[] = [];
    const total = await reader.streamUsers((page) => {
      seen.push(...page.map((u) => u.uuid));
    });
    expect(total).toBe(3);
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(ver.v).toBe('2');
    expect(calls).toEqual(['/api/users/?start=0&size=1000', '/api/users/?start=1000&size=1000']);
  });

  it('3.x без /users/stream (404) — молча уходит на постраничный путь', async () => {
    const ver = new PanelVersionState();
    ver.set('3');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { calls } = stubFetch([
      { status: 404 },
      { status: 200, body: { response: { total: 1, users: [raw(9)] } } },
    ]);
    const reader = new HttpRemnaReader({ baseUrl: 'https://panel.test', token: 't' }, ver);
    const total = await reader.streamUsers(() => {});
    expect(total).toBe(1);
    expect(calls[1]).toBe('/api/users/?start=0&size=1000');
    warn.mockRestore();
  });
});
