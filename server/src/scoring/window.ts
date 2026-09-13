import type { ScoringConfig } from './rules.js';

/** запас сверх длительности круга: первую ноду опросили в его начале, последнюю — в самом конце */
const CYCLE_MARGIN_MS = 60_000;

/**
 * Окно «активных IP»: не короче настроенного и не короче полного круга опроса нод с запасом.
 * Иначе на сотнях нод ноды, опрошенные в начале долгого круга, к моменту скоринга уже выпадают
 * из окна, и одновременность IP юзера на разных нодах теряется. При быстром круге равно настройке.
 */
export function effectiveActiveWindowMs(cfg: Pick<ScoringConfig, 'activeWindowMin'>, cycleDurationMs: number): number {
  return Math.max(cfg.activeWindowMin * 60_000, Math.max(0, cycleDurationMs) + CYCLE_MARGIN_MS);
}
