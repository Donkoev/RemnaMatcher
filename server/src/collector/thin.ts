/**
 * Прореживание снапшотов трафика. Каждый синк пишет строку на каждого юзера с одним и тем же
 * ts (тик) — на десятках тысяч юзеров это миллионы строк в сутки. Потребителям столько не надо:
 * движку — последний час как есть, графику в отчёте — сутки по 15 минут, дальше хватит точки
 * в час. Функция чистая: по списку тиков говорит, какие удалить целиком.
 */
export interface ThinTier {
  /** тики старше этого возраста (мс)… */
  olderThanMs: number;
  /** …оставляем по одному (первому) на такой интервал */
  bucketMs: number;
}

/** ярусы по возрастанию возраста: для тика берётся самый грубый подходящий */
export const SNAPSHOT_TIERS: ThinTier[] = [
  { olderThanMs: 3600_000, bucketMs: 10 * 60_000 },
  { olderThanMs: 24 * 3600_000, bucketMs: 3600_000 },
];

export function ticksToDrop(ticks: number[], now: number, tiers: ThinTier[] = SNAPSHOT_TIERS): number[] {
  const keep = new Set<number>();
  const firstInBucket = new Map<string, number>();
  for (const ts of ticks) {
    const age = now - ts;
    let tier = -1;
    for (let i = 0; i < tiers.length; i++) if (age > tiers[i]!.olderThanMs) tier = i;
    if (tier < 0) {
      keep.add(ts);
      continue;
    }
    const key = `${tier}:${Math.floor(ts / tiers[tier]!.bucketMs)}`;
    const cur = firstInBucket.get(key);
    if (cur === undefined || ts < cur) firstInBucket.set(key, ts);
  }
  for (const ts of firstInBucket.values()) keep.add(ts);
  return ticks.filter((ts) => !keep.has(ts));
}
