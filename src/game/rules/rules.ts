import type { RandomizerConfig } from '../random/randomizer';
import type { ScoringTable } from '../scoring/scoring';
import { GUIDELINE_SCORING } from '../scoring/scoring';

/** Fixed-point scale for gravity: 2^24 units == 1 row per millisecond. */
export const GRAVITY_ONE = 1 << 24;

/**
 * Guideline gravity, rows per ms × 2^24, for levels 1..20:
 * seconds per row = (0.8 − (level − 1) × 0.007)^(level − 1).
 * Precomputed so every JS engine produces identical results.
 */
const GUIDELINE_GRAVITY_FP = [
  16777, 21157, 27157, 35490, 47234, 64034, 88451, 124520, 178705, 261525, 390383, 594564, 924195,
  1466624, 2376842, 3935028, 6657404, 11513808, 20363000, 36840800,
] as const;

/** 20G: 20 rows per 1/60 s frame = 1.2 rows/ms. Treated as "instant drop". */
export const TWENTY_G = 20132659;

export function guidelineGravity(level: number): number {
  const idx = Math.max(1, Math.min(level, GUIDELINE_GRAVITY_FP.length)) - 1;
  return Math.min(GUIDELINE_GRAVITY_FP[idx] as number, TWENTY_G);
}

export type LockResetMode = 'move' | 'step' | 'infinite';
export type TopOutBehavior = 'gameOver' | 'clearBoard';

export type GravityRule =
  | { readonly kind: 'guideline' }
  /** Fixed rows per ms × 2^24; 0 = no gravity. */
  | { readonly kind: 'fixed'; readonly gravity: number };

export type GoalRule =
  | { readonly kind: 'none' }
  | { readonly kind: 'lines'; readonly lines: number }
  | { readonly kind: 'time'; readonly ms: number };

export interface RuleConfig {
  readonly boardWidth: number;
  readonly visibleRows: number;
  readonly hiddenRows: number;
  /** Row (0-indexed from the bottom) holding the lowest cells of a freshly spawned piece. */
  readonly spawnRow: number;
  /** Guideline: piece drops one row immediately after spawning when possible. */
  readonly spawnDrop: boolean;
  readonly randomizer: RandomizerConfig;
  readonly previewCount: number;
  readonly holdEnabled: boolean;
  /** Practice: hold may be used any number of times per piece. */
  readonly infiniteHold: boolean;
  readonly rotation180: boolean;
  readonly gravity: GravityRule;
  readonly startLevel: number;
  readonly linesPerLevel: number;
  /** 0 = unlimited. */
  readonly maxLevel: number;
  readonly lockDelayMs: number;
  readonly lockResetMode: LockResetMode;
  readonly maxLockResets: number;
  /** Lock delay shrinks to this value after 20G (Marathon Endless "master" levels). */
  readonly lockDelayCurve: readonly { readonly level: number; readonly lockDelayMs: number }[];
  readonly areMs: number;
  readonly lineClearDelayMs: number;
  readonly lockOut: boolean;
  readonly topOut: TopOutBehavior;
  readonly allSpin: boolean;
  readonly goal: GoalRule;
  readonly scoring: ScoringTable;
}

export const DEFAULT_RULES: RuleConfig = {
  boardWidth: 10,
  visibleRows: 20,
  hiddenRows: 20,
  spawnRow: 20,
  spawnDrop: true,
  randomizer: { kind: 'bag7' },
  previewCount: 6,
  holdEnabled: true,
  infiniteHold: false,
  rotation180: false,
  gravity: { kind: 'guideline' },
  startLevel: 1,
  linesPerLevel: 10,
  maxLevel: 0,
  lockDelayMs: 500,
  lockResetMode: 'move',
  maxLockResets: 15,
  lockDelayCurve: [],
  areMs: 0,
  lineClearDelayMs: 0,
  lockOut: true,
  topOut: 'gameOver',
  allSpin: false,
  goal: { kind: 'none' },
  scoring: GUIDELINE_SCORING,
};

export function makeRules(overrides: Partial<RuleConfig> = {}): RuleConfig {
  return { ...DEFAULT_RULES, ...overrides };
}

export function gravityForLevel(rules: RuleConfig, level: number): number {
  return rules.gravity.kind === 'fixed' ? rules.gravity.gravity : guidelineGravity(level);
}

export function lockDelayForLevel(rules: RuleConfig, level: number): number {
  let delay = rules.lockDelayMs;
  for (const step of rules.lockDelayCurve) if (level >= step.level) delay = step.lockDelayMs;
  return delay;
}

/** Converts ms-per-row (as shown in Practice settings) to fixed-point gravity. */
export function gravityFromMsPerRow(msPerRow: number): number {
  if (msPerRow <= 0) return TWENTY_G;
  return Math.round(GRAVITY_ONE / msPerRow);
}

export function msPerRowFromGravity(gravity: number): number {
  return gravity <= 0 ? Infinity : GRAVITY_ONE / gravity;
}
