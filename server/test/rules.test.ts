import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, computeSignals, levelFor, type ActiveIp } from '../src/scoring/rules.js';

const ip = (n: number, extra: Partial<ActiveIp> = {}): ActiveIp => ({
  ip: `10.0.${Math.floor(n / 250)}.${(n % 250) + 1}`,
  asn: 8359,
  asnOrg: 'MTS',
  country: 'RU',
  city: 'Moscow',
  lat: null,
  lon: null,
  isDatacenter: false,
  lastSeen: Date.now(),
  nodes: ['node-1'],
  ...extra,
});

const keys = (s: ReturnType<typeof computeSignals>) => s.map((x) => x.key);

describe('computeSignals', () => {
  it('молчит без активных IP и на одном домашнем IP', () => {
    expect(computeSignals([], null, 0, null, DEFAULT_CONFIG)).toEqual([]);
    expect(computeSignals([ip(1)], null, 0, null, DEFAULT_CONFIG)).toEqual([]);
  });

  it('без HWID-лимита работает глобальный порог minIps (>=)', () => {
    const many = Array.from({ length: DEFAULT_CONFIG.signals.ipCount.minIps }, (_, i) => ip(i));
    expect(keys(computeSignals(many, null, 0, null, DEFAULT_CONFIG))).toContain('ip_count');
    expect(keys(computeSignals(many.slice(1), null, 0, null, DEFAULT_CONFIG))).not.toContain('ip_count');
  });

  it('с HWID-лимитом порог персональный: лимит × perDeviceIps, срабатывает строго выше', () => {
    // лимит 3 устройства × 2 IP = 6: шесть IP — норма, семь — сигнал
    const six = Array.from({ length: 6 }, (_, i) => ip(i));
    expect(keys(computeSignals(six, null, 0, 3, DEFAULT_CONFIG))).not.toContain('ip_count');
    const seven = [...six, ip(6)];
    const signals = computeSignals(seven, null, 0, 3, DEFAULT_CONFIG);
    const hit = signals.find((s) => s.key === 'ip_count');
    expect(hit).toBeDefined();
    expect(hit!.ipsCount).toBe(7);
    expect(hit!.evidence).toContain('лимите 3');
  });

  it('разные провайдеры считаются только при превышении порога IP', () => {
    const asns = [8359, 25159, 3216, 12958, 12389];
    const few = asns.map((asn, i) => ip(i, { asn, asnOrg: `AS${asn}` }));
    // 5 ASN, но IP всего 5 при лимите 10 — multi_asn не должен сработать
    expect(keys(computeSignals(few, null, 0, 5, DEFAULT_CONFIG))).not.toContain('multi_asn');
    // а вот при лимите 1 (порог 2) — сработает вместе с ip_count
    const k = keys(computeSignals(few, null, 0, 1, DEFAULT_CONFIG));
    expect(k).toContain('ip_count');
    expect(k).toContain('multi_asn');
  });

  it('страны, датацентры и торренты — независимые слабые сигналы', () => {
    const list = [ip(1, { country: 'RU' }), ip(2, { country: 'DE', isDatacenter: true, asnOrg: 'Hetzner' })];
    const k = keys(computeSignals(list, null, 2, null, DEFAULT_CONFIG));
    expect(k).toEqual(expect.arrayContaining(['multi_country', 'datacenter', 'torrent']));
    expect(k).not.toContain('ip_count');
  });

  it('всплеск трафика: выше порога — 30 очков, выше двойного — 55', () => {
    const one = [ip(1)];
    const bps = DEFAULT_CONFIG.trafficRateBps;
    expect(computeSignals(one, bps, 0, null, DEFAULT_CONFIG)).toEqual([]);
    expect(computeSignals(one, bps + 1, 0, null, DEFAULT_CONFIG)[0]?.points).toBe(30);
    expect(computeSignals(one, bps * 2 + 1, 0, null, DEFAULT_CONFIG)[0]?.points).toBe(55);
  });

  it('выключенная проверка не срабатывает', () => {
    const cfg = { ...DEFAULT_CONFIG, signals: { ...DEFAULT_CONFIG.signals, torrent: { enabled: false } } };
    expect(computeSignals([ip(1)], null, 5, null, cfg)).toEqual([]);
  });
});

describe('levelFor', () => {
  it('раскладывает очки по порогам', () => {
    const t = DEFAULT_CONFIG.thresholds;
    expect(levelFor(0, DEFAULT_CONFIG)).toBe('green');
    expect(levelFor(t.yellow, DEFAULT_CONFIG)).toBe('yellow');
    expect(levelFor(t.orange, DEFAULT_CONFIG)).toBe('orange');
    expect(levelFor(t.red + 100, DEFAULT_CONFIG)).toBe('red');
  });
});
