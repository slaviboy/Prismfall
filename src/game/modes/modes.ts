import { makeRules, type RuleConfig } from '../rules/rules';

export type ModeId = 'voyage' | 'marathon' | 'sprint' | 'ultra' | 'zen' | 'practice';

/** How a finished run is ranked. */
export type ResultMetric = 'score' | 'time' | 'lines' | 'none';

export interface ModeVariant {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly rules: Partial<RuleConfig>;
}

export interface ModeDefinition {
  readonly id: ModeId;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly metric: ResultMetric;
  /** Whether a lower metric is better (Sprint time). */
  readonly lowerIsBetter: boolean;
  readonly variants: readonly ModeVariant[];
  readonly defaultVariant: string;
  /** Whether the player picks the stage (false: the mode controls stages, e.g. Voyage). */
  readonly stageSelectable: boolean;
  readonly showTimer: boolean;
  readonly baseRules: Partial<RuleConfig>;
}

const MARATHON_ENDLESS_LOCK_CURVE = [
  { level: 21, lockDelayMs: 450 },
  { level: 23, lockDelayMs: 400 },
  { level: 25, lockDelayMs: 350 },
  { level: 27, lockDelayMs: 300 },
  { level: 30, lockDelayMs: 250 },
];

export const MODES: readonly ModeDefinition[] = [
  {
    id: 'voyage',
    name: 'Voyage',
    tagline: 'Travel through every world',
    description: 'A journey across the stages. Clear each leg\'s line goal to drift into the next world while the music carries you on.',
    metric: 'score',
    lowerIsBetter: false,
    variants: [
      { id: 'relaxed', label: 'Relaxed', description: 'Gentle speeds, shorter legs.', rules: {} },
      { id: 'standard', label: 'Standard', description: 'The intended journey.', rules: {} },
      { id: 'intense', label: 'Intense', description: 'Faster speeds, longer legs.', rules: {} },
    ],
    defaultVariant: 'standard',
    stageSelectable: false,
    showTimer: true,
    baseRules: { lineClearDelayMs: 250, linesPerLevel: 1_000_000 },
  },
  {
    id: 'marathon',
    name: 'Marathon',
    tagline: 'Endurance with rising speed',
    description: 'Classic continuous play. Every 10 lines raises the level and the speed.',
    metric: 'score',
    lowerIsBetter: false,
    variants: [
      { id: '150', label: '150 Lines', description: 'Reach level 15 and clear 150 lines.', rules: { goal: { kind: 'lines', lines: 150 }, maxLevel: 15 } },
      { id: 'endless', label: 'Endless', description: 'No finish line. Beyond 20G the lock delay tightens.', rules: { lockDelayCurve: MARATHON_ENDLESS_LOCK_CURVE } },
    ],
    defaultVariant: '150',
    stageSelectable: true,
    showTimer: true,
    baseRules: { lineClearDelayMs: 200 },
  },
  {
    id: 'sprint',
    name: 'Sprint',
    tagline: 'Clear the lines as fast as you can',
    description: 'A race against the clock. Gravity stays gentle — speed is up to you.',
    metric: 'time',
    lowerIsBetter: true,
    variants: [
      { id: '20', label: '20 Lines', description: 'A quick dash.', rules: { goal: { kind: 'lines', lines: 20 } } },
      { id: '40', label: '40 Lines', description: 'The standard race.', rules: { goal: { kind: 'lines', lines: 40 } } },
      { id: '100', label: '100 Lines', description: 'A long-distance run.', rules: { goal: { kind: 'lines', lines: 100 } } },
    ],
    defaultVariant: '40',
    stageSelectable: true,
    showTimer: true,
    baseRules: { linesPerLevel: 1_000_000, lineClearDelayMs: 0 },
  },
  {
    id: 'ultra',
    name: 'Ultra',
    tagline: 'Score big before time runs out',
    description: 'A timed score attack. Spins, back-to-backs and combos are the way to the top.',
    metric: 'score',
    lowerIsBetter: false,
    variants: [
      { id: '120', label: '2 Minutes', description: 'Short and sharp.', rules: { goal: { kind: 'time', ms: 120_000 } } },
      { id: '180', label: '3 Minutes', description: 'The standard challenge.', rules: { goal: { kind: 'time', ms: 180_000 } } },
      { id: '300', label: '5 Minutes', description: 'Pace yourself.', rules: { goal: { kind: 'time', ms: 300_000 } } },
    ],
    defaultVariant: '180',
    stageSelectable: true,
    showTimer: true,
    baseRules: { linesPerLevel: 1_000_000, lineClearDelayMs: 0 },
  },
  {
    id: 'zen',
    name: 'Zen',
    tagline: 'No pressure, just flow',
    description: 'Relaxed, endless play. Topping out simply clears the board and you carry on.',
    metric: 'none',
    lowerIsBetter: false,
    variants: [
      { id: 'still', label: 'Still', description: 'Slow, constant gravity.', rules: { linesPerLevel: 1_000_000 } },
      { id: 'flowing', label: 'Flowing', description: 'Gently rising speed, capped at level 8.', rules: { linesPerLevel: 20, maxLevel: 8 } },
    ],
    defaultVariant: 'still',
    stageSelectable: true,
    showTimer: false,
    baseRules: { topOut: 'clearBoard', lockOut: false, lineClearDelayMs: 300 },
  },
  {
    id: 'practice',
    name: 'Practice',
    tagline: 'Your rules, your pace',
    description: 'Configure gravity, lock delay, previews, hold and the randomizer. Undo placements and drill setups.',
    metric: 'none',
    lowerIsBetter: false,
    variants: [{ id: 'custom', label: 'Custom', description: 'Uses the Practice settings.', rules: {} }],
    defaultVariant: 'custom',
    stageSelectable: true,
    showTimer: true,
    baseRules: { topOut: 'clearBoard', linesPerLevel: 1_000_000 },
  },
];

export function getMode(id: ModeId): ModeDefinition {
  const mode = MODES.find((m) => m.id === id);
  if (!mode) throw new Error(`Unknown mode ${id}`);
  return mode;
}

export function getVariant(mode: ModeDefinition, variantId: string): ModeVariant {
  return mode.variants.find((v) => v.id === variantId) ?? (mode.variants.find((v) => v.id === mode.defaultVariant) as ModeVariant);
}

export function buildModeRules(modeId: ModeId, variantId: string, extra: Partial<RuleConfig> = {}): RuleConfig {
  const mode = getMode(modeId);
  const variant = getVariant(mode, variantId);
  return makeRules({ ...mode.baseRules, ...variant.rules, ...extra });
}

export function highScoreKey(modeId: ModeId, variantId: string): string {
  return `${modeId}:${variantId}`;
}
