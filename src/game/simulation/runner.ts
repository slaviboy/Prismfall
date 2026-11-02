import { Engine, ENGINE_VERSION } from '../core/engine';
import type { GameAction, GameEvent, HandlingConfig } from '../core/types';
import type { RuleConfig } from '../rules/rules';
import { actionIndex, applyEntry, type ReplayData, type ReplayEntry } from './replay';

interface QueuedInput {
  readonly action: GameAction;
  readonly down: boolean;
  /** performance.now()-compatible timestamp, ms. */
  readonly time: number;
}

export interface RunnerOptions {
  readonly rules: RuleConfig;
  readonly seed: number;
  readonly handling: HandlingConfig;
  readonly modeId: string;
  readonly variantId: string;
}

/**
 * Bridges wall-clock time and the 1 ms engine. Inputs carry their own timestamps and
 * are applied at the matching tick, so input timing doesn't depend on frame rate.
 * Every engine mutation is recorded for deterministic replays.
 */
export class GameRunner {
  static readonly MAX_CATCH_UP_MS = 100;

  readonly engine: Engine;
  readonly options: RunnerOptions;
  private origin: number | null = null;
  private pausedAt: number | null = null;
  private readonly queue: QueuedInput[] = [];
  private readonly entries: ReplayEntry[] = [];
  private readonly held = new Set<GameAction>();

  constructor(options: RunnerOptions) {
    this.options = options;
    this.engine = new Engine({ rules: options.rules, seed: options.seed, handling: options.handling });
  }

  get started(): boolean {
    return this.origin !== null;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  /** Elapsed game time in ms (excludes pauses). */
  get elapsedMs(): number {
    return this.engine.tick;
  }

  start(now: number): void {
    this.origin = now;
    this.engine.start();
  }

  enqueue(action: GameAction, down: boolean, time: number): void {
    if (this.paused || this.origin === null) return;
    this.queue.push({ action, down, time });
  }

  /** Advances the simulation to `now`. Returns the events produced. */
  update(now: number): GameEvent[] {
    if (this.origin === null || this.pausedAt !== null || this.engine.isOver) {
      this.queue.length = 0;
      return this.engine.drainEvents();
    }
    let target = Math.floor(now - this.origin);
    const behind = target - this.engine.tick;
    if (behind > GameRunner.MAX_CATCH_UP_MS) {
      // Long hitch: shift the time base rather than applying a burst of gravity.
      this.origin += behind - GameRunner.MAX_CATCH_UP_MS;
      target = this.engine.tick + GameRunner.MAX_CATCH_UP_MS;
    }
    if (this.queue.length > 1) this.queue.sort((a, b) => a.time - b.time);
    for (const input of this.queue) {
      const tick = Math.min(target, Math.max(this.engine.tick, Math.floor(input.time - this.origin)));
      this.engine.advanceTo(tick);
      if (this.engine.isOver) break;
      this.applyInput(input.action, input.down);
    }
    this.queue.length = 0;
    this.engine.advanceTo(target);
    return this.engine.drainEvents();
  }

  private applyInput(action: GameAction, down: boolean): void {
    if (down) this.held.add(action);
    else if (!this.held.delete(action)) return; // release without press: ignore (e.g. key held over pause)
    this.record({ t: this.engine.tick, k: 'i', a: actionIndex(action), d: down ? 1 : 0 });
  }

  private record(entry: ReplayEntry): void {
    applyEntry(this.engine, entry);
    this.entries.push(entry);
  }

  /** Releases everything currently held (pause, focus loss) — recorded for replays. */
  releaseAll(): void {
    for (const action of [...this.held]) {
      this.held.delete(action);
      this.record({ t: this.engine.tick, k: 'i', a: actionIndex(action), d: 0 });
    }
  }

  setLevel(level: number): void {
    this.record({ t: this.engine.tick, k: 'level', v: level });
  }

  setGravityOverride(gravity: number | null): void {
    this.record({ t: this.engine.tick, k: 'gravity', v: gravity });
  }

  setHandling(handling: HandlingConfig): void {
    this.record({ t: this.engine.tick, k: 'handling', v: handling });
  }

  pause(now: number): void {
    if (this.pausedAt !== null || this.origin === null) return;
    this.update(now);
    this.releaseAll();
    this.pausedAt = now;
  }

  resume(now: number): void {
    if (this.pausedAt === null || this.origin === null) return;
    this.origin += now - this.pausedAt;
    this.pausedAt = null;
  }

  exportReplay(): ReplayData {
    return {
      format: 1,
      engineVersion: ENGINE_VERSION,
      seed: this.options.seed,
      rules: this.options.rules,
      handling: this.options.handling,
      entries: [...this.entries],
      finalTick: this.engine.tick,
      finalHash: this.engine.stateHash(),
      modeId: this.options.modeId,
      variantId: this.options.variantId,
      recordedAt: new Date().toISOString(),
    };
  }
}
