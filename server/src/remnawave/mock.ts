import type { NodeSessions, RemnaEnforcer, RemnaNode, RemnaReader, RemnaUser, TorrentReport } from './types.js';

// Мок-режим: имитирует панель по паттернам реальных данных (снятым с боевой
// панели 2026-08-26): те же 9 нод, имена юзеров rs_*/tg_*, реальные ASN,
// инфраструктурный юзер «Routing» с датацентровыми IP (кандидат в whitelist).
//
// Легитимный кейс: подписку могут делить 5–10 человек (друзья из разных городов),
// поэтому у "семейных" юзеров по 3–8 IP с 2–3 ASN — детект НЕ должен их флагать.

import { MOCK_POOLS, type MockPool } from '../geo/mock-pools.js';

interface MockUserState {
  user: RemnaUser;
  homePools: number[];
  active: Map<string, { lastSeen: number }>;
  baseRate: number;
  kind: 'single' | 'family' | 'sharer' | 'infra';
}

// Реальные ноды панели
const NODES: RemnaNode[] = [
  { uuid: 'node-cloud', name: 'Cloud', countryCode: 'RU', isConnected: true, isDisabled: false },
  { uuid: 'node-ee-1', name: 'Estonia', countryCode: 'EE', isConnected: true, isDisabled: false },
  { uuid: 'node-ee-3', name: 'Estonia3', countryCode: 'EE', isConnected: true, isDisabled: false },
  { uuid: 'node-ee-4', name: 'Estonia4', countryCode: 'EE', isConnected: true, isDisabled: false },
  { uuid: 'node-fr-1', name: 'France-estx', countryCode: 'FR', isConnected: true, isDisabled: false },
  { uuid: 'node-de-1', name: 'Germany-AV1', countryCode: 'DE', isConnected: true, isDisabled: false },
  { uuid: 'node-de-2', name: 'Germany-AV2', countryCode: 'DE', isConnected: true, isDisabled: false },
  { uuid: 'node-de-r', name: 'Germany-Routing', countryCode: 'DE', isConnected: true, isDisabled: false },
  { uuid: 'node-nl-1', name: 'Netherlands-estx', countryCode: 'NL', isConnected: true, isDisabled: false },
];

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
  const v = arr[Math.floor(Math.random() * arr.length)];
  if (v === undefined) throw new Error('pick from empty array');
  return v;
}

function ipFromPool(pool: MockPool): string {
  return `${pool.prefix}.${randInt(1, 254)}.${randInt(1, 254)}`;
}

function mockUsername(): string {
  const prefix = Math.random() < 0.7 ? 'rs' : 'tg';
  return `${prefix}_${randInt(1_000_000_000, 9_999_999_999)}`;
}

export class MockRemna implements RemnaReader, RemnaEnforcer {
  private users = new Map<number, MockUserState>();
  private disabled = new Set<string>();
  private revoked = new Set<string>();

  constructor() {
    const residential = MOCK_POOLS.map((p, i) => ({ p, i })).filter(({ p }) => !p.dc);
    const datacenter = MOCK_POOLS.map((p, i) => ({ p, i })).filter(({ p }) => p.dc);

    // инфраструктурный юзер «Routing»: датацентровые IP на всех нодах, большой трафик
    this.users.set(1, {
      user: { ...this.makeUser(1), username: 'Routing' },
      homePools: datacenter.map((d) => d.i),
      active: new Map(),
      baseRate: 20_000_000,
      kind: 'infra',
    });

    let id = 1000;
    for (let n = 0; n < 300; n++) {
      id += randInt(1, 90);
      const homeEntry = pick(residential);
      const roll = Math.random();
      let kind: MockUserState['kind'] = 'single';
      let homePools: number[] = [homeEntry.i];
      if (roll < 0.25) {
        // "семья/друзья": 2–3 провайдера, возможно разные города — это ЛЕГАЛЬНО
        kind = 'family';
        homePools = [homeEntry.i, pick(residential).i, ...(Math.random() < 0.5 ? [pick(residential).i] : [])];
      } else if (Math.random() < 0.6) {
        // обычный юзер: домашний + мобильный оператор того же города
        const sameCity = residential.filter(({ p }) => p.city === homeEntry.p.city);
        homePools = [homeEntry.i, pick(sameCity).i];
      }
      this.users.set(id, {
        user: this.makeUser(id),
        homePools,
        active: new Map(),
        baseRate: randInt(20_000, 400_000),
        kind,
      });
    }

    // 5 фродеров: ключ разошёлся по рукам — много IP с кучи ASN, иногда датацентры
    const sharers = [...this.users.keys()].filter((k) => k !== 1).slice(0, 5);
    for (const sid of sharers) {
      const st = this.users.get(sid)!;
      st.kind = 'sharer';
      st.homePools = [
        ...residential.filter(() => Math.random() < 0.6).map((r) => r.i),
        ...(Math.random() < 0.6 ? [pick(datacenter).i] : []),
      ];
      if (st.homePools.length < 6) st.homePools = residential.slice(0, 7).map((r) => r.i);
      st.baseRate = randInt(1_500_000, 6_000_000);
    }
  }

  private makeUser(id: number): RemnaUser {
    return {
      id,
      uuid: `mock-uuid-${id}`,
      shortUuid: `short-${id}`,
      username: mockUsername(),
      status: 'ACTIVE',
      telegramId: Math.random() < 0.5 ? 100000000 + id : null,
      email: null,
      tag: null,
      trafficLimitBytes: Math.random() < 0.6 ? 0 : randInt(100, 500) * 1024 * 1024 * 1024,
      hwidDeviceLimit: Math.random() < 0.3 ? null : randInt(2, 10),
      subscriptionUrl: `https://sub.ghost-lan.com/short-${id}`,
      usedTrafficBytes: randInt(1, 80) * 1024 * 1024 * 1024,
      onlineAt: new Date().toISOString(),
      expireAt: new Date(Date.now() + 30 * 864e5).toISOString(),
    };
  }

  async getNodes(): Promise<RemnaNode[]> {
    return NODES;
  }

  async getAllUsers(): Promise<RemnaUser[]> {
    for (const st of this.users.values()) {
      const online = st.active.size > 0 || Math.random() < 0.4;
      if (online) {
        st.user.usedTrafficBytes += st.baseRate * 60 * (0.5 + Math.random());
        st.user.onlineAt = new Date().toISOString();
      }
      st.user.status = this.disabled.has(st.user.uuid) ? 'DISABLED' : 'ACTIVE';
    }
    return [...this.users.values()].map((s) => ({ ...s.user }));
  }

  async fetchNodeSessions(nodeUuid: string): Promise<NodeSessions> {
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
    const now = Date.now();
    const users: NodeSessions['users'] = [];

    for (const [id, st] of this.users) {
      if (this.disabled.has(st.user.uuid)) continue;
      const effectiveKind = st.kind === 'sharer' && this.revoked.has(st.user.uuid) ? 'single' : st.kind;

      for (const [ip, meta] of st.active) {
        if (now - meta.lastSeen > 10 * 60_000 && Math.random() < 0.5) st.active.delete(ip);
      }

      const wantOnline = effectiveKind === 'sharer' || effectiveKind === 'infra' ? true : Math.random() < 0.35;
      if (wantOnline) {
        const targetIps =
          effectiveKind === 'sharer'
            ? randInt(10, 18)
            : effectiveKind === 'infra'
              ? 5
              : effectiveKind === 'family'
                ? randInt(2, 6)
                : Math.random() < 0.15
                  ? 2
                  : 1;
        while (st.active.size < targetIps) {
          const poolIdx = pick(st.homePools);
          const pool = MOCK_POOLS[poolIdx];
          if (!pool) continue;
          st.active.set(ipFromPool(pool), { lastSeen: now });
        }
        for (const meta of st.active.values()) {
          if (Math.random() < 0.8) meta.lastSeen = now - randInt(0, 120_000);
        }
      }
      if (st.active.size === 0) continue;

      // юзер виден не на каждой ноде; Routing — в основном на своей
      const hash = (id + nodeUuid.length * 7) % 4;
      const visible =
        effectiveKind === 'infra'
          ? nodeUuid === 'node-de-r' || Math.random() < 0.4
          : effectiveKind === 'sharer'
            ? true
            : hash !== 3;
      if (!visible) continue;

      const ips = [...st.active.entries()]
        .filter(() => Math.random() < (effectiveKind === 'sharer' ? 0.7 : 0.9))
        .map(([ip, meta]) => ({ ip, lastSeen: new Date(meta.lastSeen).toISOString() }));
      if (ips.length > 0) users.push({ userId: String(id), ips });
    }

    return { nodeUuid, success: true, users };
  }

  async getHwidDeviceCount(userUuid: string): Promise<number | null> {
    const st = [...this.users.values()].find((s) => s.user.uuid === userUuid);
    if (!st) return null;
    const limit = st.user.hwidDeviceLimit ?? 5;
    // фродеры упираются в лимит, обычные — 1-2 устройства
    return st.kind === 'sharer' ? limit : Math.min(limit, randInt(1, 3));
  }

  private torrentReportId = 0;

  async getTorrentReports(): Promise<TorrentReport[]> {
    // часть юзеров (и особенно фродеры) периодически ловятся торрент-блокером
    const reports: TorrentReport[] = [];
    for (const [id, st] of this.users) {
      if (this.disabled.has(st.user.uuid)) continue;
      const chance = st.kind === 'sharer' ? 0.5 : 0.03;
      if (st.active.size > 0 && Math.random() < chance) {
        const ip = [...st.active.keys()][0];
        if (!ip) continue;
        reports.push({
          id: ++this.torrentReportId,
          userId: id,
          ip,
          nodeName: pick(NODES).name,
          createdAt: Date.now() - randInt(0, 300_000),
        });
      }
    }
    return reports;
  }

  // --- Enforcer: в моке просто меняем внутреннее состояние ---

  async disableUser(uuid: string): Promise<void> {
    this.disabled.add(uuid);
  }

  async enableUser(uuid: string): Promise<void> {
    this.disabled.delete(uuid);
  }

  async revokeSubscription(uuid: string): Promise<void> {
    this.revoked.add(uuid);
    const st = [...this.users.values()].find((s) => s.user.uuid === uuid);
    if (st) st.active.clear();
  }

  async dropConnectionsByIps(ips: string[]): Promise<void> {
    const set = new Set(ips);
    for (const st of this.users.values()) {
      for (const ip of st.active.keys()) if (set.has(ip)) st.active.delete(ip);
    }
  }

  async dropConnectionsByUser(uuid: string): Promise<void> {
    const st = [...this.users.values()].find((s) => s.user.uuid === uuid);
    if (st) st.active.clear();
  }
}
