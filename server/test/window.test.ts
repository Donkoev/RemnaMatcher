import { describe, expect, it } from 'vitest';
import { effectiveActiveWindowMs } from '../src/scoring/window.js';

const MIN = 60_000;

describe('effectiveActiveWindowMs — окно активных IP и длительность круга опроса', () => {
  it('при быстром круге равно настройке', () => {
    expect(effectiveActiveWindowMs({ activeWindowMin: 5 }, 30_000)).toBe(5 * MIN);
    expect(effectiveActiveWindowMs({ activeWindowMin: 5 }, 0)).toBe(5 * MIN);
  });

  it('при круге длиннее окна растягивается до круга с запасом в минуту', () => {
    expect(effectiveActiveWindowMs({ activeWindowMin: 5 }, 6 * MIN)).toBe(7 * MIN);
    expect(effectiveActiveWindowMs({ activeWindowMin: 5 }, 4.5 * MIN)).toBe(5.5 * MIN);
  });
});
