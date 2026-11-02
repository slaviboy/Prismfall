import { Engine, ENGINE_VERSION } from '../core/engine';
import { GAME_ACTIONS, type GameAction, type HandlingConfig } from '../core/types';
import type { RuleConfig } from '../rules/rules';

/** One recorded engine mutation, stamped with the tick it was applied on. */
export type ReplayEntry =
  | { readonly t: number; readonly k: 'i'; readonly a: number; readonly d: 0 | 1 }
  | { readonly t: number; readonly k: 'level'; readonly v: number }
  | { readonly t: number; readonly k: 'gravity'; readonly v: number | null }
  | { readonly t: number; readonly k: 'handling'; readonly v: HandlingConfig };

export interface ReplayData {
  readonly format: 1;
  readonly engineVersion: number;
  readonly seed: number;
  readonly rules: RuleConfig;
  readonly handling: HandlingConfig;
  readonly entries: readonly ReplayEntry[];
  readonly finalTick: number;
  readonly finalHash: number;
  readonly modeId: string;
  readonly variantId: string;
  readonly recordedAt: string;
}

export function actionIndex(action: GameAction): number {
  return GAME_ACTIONS.indexOf(action);
}

export function actionFromIndex(index: number): GameAction {
  return GAME_ACTIONS[index] ?? 'hardDrop';
}

/** Applies one entry to an engine (the engine must already be at entry.t). */
export function applyEntry(engine: Engine, entry: ReplayEntry): void {
  switch (entry.k) {
    case 'i':
      if (entry.d === 1) engine.press(actionFromIndex(entry.a));
      else engine.release(actionFromIndex(entry.a));
      break;
    case 'level':
      engine.setLevel(entry.v);
      break;
    case 'gravity':
      engine.setGravityOverride(entry.v);
      break;
    case 'handling':
      engine.setHandling(entry.v);
      break;
  }
}

/** Re-simulates a replay from scratch; returns the resulting engine. */
export function simulateReplay(replay: ReplayData): Engine {
  const engine = new Engine({ rules: replay.rules, seed: replay.seed, handling: replay.handling });
  engine.start();
  for (const entry of replay.entries) {
    engine.advanceTo(entry.t);
    applyEntry(engine, entry);
  }
  engine.advanceTo(replay.finalTick);
  return engine;
}

/** Steps a replay incrementally (for the replay viewer). */
export class ReplayPlayer {
  readonly engine: Engine;
  private cursor = 0;

  constructor(private readonly replay: ReplayData) {
    this.engine = new Engine({ rules: replay.rules, seed: replay.seed, handling: replay.handling });
    this.engine.start();
  }

  get finished(): boolean {
    return this.engine.tick >= this.replay.finalTick || this.engine.isOver;
  }

  get durationMs(): number {
    return this.replay.finalTick;
  }

  advanceTo(tick: number): void {
    const target = Math.min(tick, this.replay.finalTick);
    const entries = this.replay.entries;
    while (this.cursor < entries.length && (entries[this.cursor] as ReplayEntry).t <= target) {
      const entry = entries[this.cursor] as ReplayEntry;
      this.engine.advanceTo(entry.t);
      applyEntry(this.engine, entry);
      this.cursor++;
    }
    this.engine.advanceTo(target);
  }
}

/** JSON helpers: Infinity (instant soft drop) is not representable in JSON. */
export function serializeReplay(replay: ReplayData): string {
  return JSON.stringify(replay, (_k, v: unknown) => (v === Infinity ? '__inf__' : v));
}

export function deserializeReplay(text: string): ReplayData {
  return JSON.parse(text, (_k, v: unknown) => (v === '__inf__' ? Infinity : v)) as ReplayData;
}

export { ENGINE_VERSION };
