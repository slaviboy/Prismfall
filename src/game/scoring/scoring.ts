/**
 * Configurable scoring. Pure functions — testable without the engine.
 */

export type SpinKind = 'none' | 'mini' | 'full';

export interface ScoringTable {
  /** Index = lines cleared (0..4). */
  readonly lines: readonly number[];
  readonly tSpinMini: readonly number[];
  readonly tSpin: readonly number[];
  readonly backToBackMultiplier: number;
  readonly comboPerStep: number;
  /** Perfect-clear bonus by lines cleared (index 0 unused). */
  readonly perfectClear: readonly number[];
  readonly perfectClearBackToBackQuad: number;
  readonly softDropPerRow: number;
  readonly hardDropPerRow: number;
}

export const GUIDELINE_SCORING: ScoringTable = {
  lines: [0, 100, 300, 500, 800],
  tSpinMini: [100, 200, 400, 400, 400],
  tSpin: [400, 800, 1200, 1600, 1600],
  backToBackMultiplier: 1.5,
  comboPerStep: 50,
  perfectClear: [0, 800, 1200, 1800, 2000],
  perfectClearBackToBackQuad: 3200,
  softDropPerRow: 1,
  hardDropPerRow: 2,
};

export type ClearKind =
  | 'none'
  | 'single'
  | 'double'
  | 'triple'
  | 'quad'
  | 'tspin'
  | 'tspinSingle'
  | 'tspinDouble'
  | 'tspinTriple'
  | 'tspinMini'
  | 'tspinMiniSingle'
  | 'tspinMiniDouble';

export function classifyClear(lines: number, spin: SpinKind): ClearKind {
  if (spin === 'full') return (['tspin', 'tspinSingle', 'tspinDouble', 'tspinTriple', 'tspinTriple'] as const)[lines] ?? 'tspinTriple';
  if (spin === 'mini') return (['tspinMini', 'tspinMiniSingle', 'tspinMiniDouble', 'tspinMiniDouble', 'tspinMiniDouble'] as const)[lines] ?? 'tspinMiniDouble';
  return (['none', 'single', 'double', 'triple', 'quad'] as const)[lines] ?? 'quad';
}

/** A "difficult" clear keeps or extends back-to-back. */
export function isDifficult(lines: number, spin: SpinKind): boolean {
  return lines > 0 && (lines >= 4 || spin !== 'none');
}

export interface ClearScoreInput {
  readonly lines: number;
  readonly spin: SpinKind;
  readonly level: number;
  /** Back-to-back was active before this lock. */
  readonly backToBackActive: boolean;
  /** Combo index after this lock (0 = first clear in a chain, -1 = no clear). */
  readonly combo: number;
  readonly perfectClear: boolean;
}

export interface ClearScore {
  readonly kind: ClearKind;
  readonly base: number;
  readonly backToBack: boolean;
  readonly comboBonus: number;
  readonly perfectClearBonus: number;
  readonly total: number;
}

export function scoreClear(input: ClearScoreInput, table: ScoringTable = GUIDELINE_SCORING): ClearScore {
  const lines = Math.max(0, Math.min(4, input.lines));
  const level = Math.max(1, input.level);
  const kind = classifyClear(lines, input.spin);
  const row = input.spin === 'full' ? table.tSpin : input.spin === 'mini' ? table.tSpinMini : table.lines;
  let base = (row[lines] ?? 0) * level;
  const backToBack = input.backToBackActive && isDifficult(lines, input.spin);
  if (backToBack) base = Math.floor(base * table.backToBackMultiplier);
  const comboBonus = lines > 0 && input.combo > 0 ? table.comboPerStep * input.combo * level : 0;
  let perfectClearBonus = 0;
  if (input.perfectClear && lines > 0) {
    perfectClearBonus =
      (backToBack && lines === 4 ? table.perfectClearBackToBackQuad : (table.perfectClear[lines] ?? 0)) * level;
  }
  return { kind, base, backToBack, comboBonus, perfectClearBonus, total: base + comboBonus + perfectClearBonus };
}

export const CLEAR_LABELS: Record<ClearKind, string> = {
  none: '',
  single: 'Single',
  double: 'Double',
  triple: 'Triple',
  quad: 'Quad',
  tspin: 'T-Spin',
  tspinSingle: 'T-Spin Single',
  tspinDouble: 'T-Spin Double',
  tspinTriple: 'T-Spin Triple',
  tspinMini: 'T-Spin Mini',
  tspinMiniSingle: 'T-Spin Mini Single',
  tspinMiniDouble: 'T-Spin Mini Double',
};
