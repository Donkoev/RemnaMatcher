import { describe, expect, it } from 'vitest';
import { ticksToDrop } from '../src/collector/thin.js';

const MIN = 60_000;
const H = 60 * MIN;

describe('ticksToDrop — прореживание снапшотов трафика', () => {
  it('последний час не трогает, старше часа оставляет тик на 10 минут, старше суток — на час', () => {
    const now = 1000 * H; // ровная граница часа и суток
    const ticks = [
      now - 30 * H, now - 30 * H + 5 * MIN, now - 30 * H + 40 * MIN, // старше суток: один тик в час
      now - 5 * H, now - 5 * H + 5 * MIN, now - 5 * H + 10 * MIN, // старше часа: один тик в 10 минут
      now - 30 * MIN, now - 25 * MIN, now - 5 * MIN, // свежее часа — как есть
    ];
    expect(ticksToDrop(ticks, now)).toEqual([now - 30 * H + 5 * MIN, now - 30 * H + 40 * MIN, now - 5 * H + 5 * MIN]);
  });

  it('пусто и только свежие тики — удалять нечего', () => {
    expect(ticksToDrop([], 0)).toEqual([]);
    expect(ticksToDrop([100, 200, 300], 400)).toEqual([]);
  });

  it('порядок тиков не важен: остаётся самый ранний в интервале', () => {
    const now = 1000 * H;
    expect(ticksToDrop([now - 5 * H + MIN, now - 5 * H], now)).toEqual([now - 5 * H + MIN]);
  });
});
