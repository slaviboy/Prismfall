import type { EngineSnapshot } from '../game/core/engine';
import type { GameAction, GameEvent, HandlingConfig } from '../game/core/types';
import { GAME_ACTIONS } from '../game/core/types';
import { buildModeRules, getMode, type ModeDefinition, type ModeId } from '../game/modes/modes';
import { randomSeed } from '../game/random/rng';
import type { RuleConfig } from '../game/rules/rules';
import { GameRunner } from '../game/simulation/runner';
import type { ReplayData } from '../game/simulation/replay';
import { ReplayPlayer } from '../game/simulation/replay';
import type { Engine } from '../game/core/engine';

export interface SessionConfig {
  readonly modeId: ModeId;
  readonly variantId: string;
  readonly stageId: string;
  readonly seed?: number;
  readonly rules?: Partial<RuleConfig>;
  readonly handling: HandlingConfig;
}

export type SessionStatus = 'intro' | 'running' | 'paused' | 'countdown' | 'finished';

export const INTRO_MS = 1300;
export const RESUME_COUNTDOWN_MS = 1800;

/**
 * One play session: wraps the runner with an intro, pause/resume countdown and
 * Practice undo. Owned by GameShell; React never touches it directly.
 */
export class GameSession {
  readonly config: SessionConfig;
  readonly mode: ModeDefinition;
  readonly runner: GameRunner;
  readonly seed: number;
  status: SessionStatus = 'intro';
  private phaseEndsAt = 0;
  private undoStack: EngineSnapshot[] = [];
  private lastPieceCount = -1;
  /** Actions physically held when the session (re)starts — re-pressed so DAS can pre-charge. */
  heldAtStart: (() => readonly GameAction[]) | null = null;

  constructor(config: SessionConfig) {
    this.config = config;
    this.mode = getMode(config.modeId);
    this.seed = config.seed ?? randomSeed();
    const rules = buildModeRules(config.modeId, config.variantId, config.rules ?? {});
    this.runner = new GameRunner({ rules, seed: this.seed, handling: config.handling, modeId: config.modeId, variantId: config.variantId });
  }

  get engine(): Engine {
    return this.runner.engine;
  }

  begin(now: number): void {
    this.status = 'intro';
    this.phaseEndsAt = now + INTRO_MS;
  }

  /** 'ready' | 'go' | null for the HUD intro. */
  introPhase(now: number): 'ready' | 'go' | null {
    if (this.status !== 'intro') return null;
    return this.phaseEndsAt - now > INTRO_MS * 0.35 ? 'ready' : 'go';
  }

  countdownValue(now: number): number | null {
    if (this.status !== 'countdown') return null;
    return Math.max(1, Math.ceil(((this.phaseEndsAt - now) / RESUME_COUNTDOWN_MS) * 3));
  }

  handleAction(action: GameAction, down: boolean, time: number): void {
    if (this.status !== 'running') return;
    this.runner.enqueue(action, down, time);
  }

  update(now: number): GameEvent[] {
    if (this.status === 'intro' && now >= this.phaseEndsAt) {
      this.status = 'running';
      this.runner.start(this.phaseEndsAt);
      this.repressHeld(this.phaseEndsAt);
    } else if (this.status === 'countdown' && now >= this.phaseEndsAt) {
      this.status = 'running';
      this.runner.resume(now);
      this.repressHeld(now);
    }
    if (this.status !== 'running') return [];
    const events = this.runner.update(now);
    if (this.mode.id === 'practice' && this.engine.stats.pieces !== this.lastPieceCount && this.engine.active) {
      this.lastPieceCount = this.engine.stats.pieces;
      this.undoStack.push(this.engine.snapshot());
      if (this.undoStack.length > 100) this.undoStack.shift();
    }
    if (this.engine.isOver) this.status = 'finished';
    return events;
  }

  private repressHeld(time: number): void {
    const held = this.heldAtStart?.() ?? [];
    for (const action of held) if (action === 'moveLeft' || action === 'moveRight' || action === 'softDrop') this.runner.enqueue(action, true, time);
  }

  pause(now: number): void {
    if (this.status === 'running') {
      this.runner.pause(now);
      this.status = 'paused';
    } else if (this.status === 'countdown' || this.status === 'intro') {
      this.status = 'paused';
      if (!this.runner.started) {
        // Paused during the intro: restart the intro on resume.
        this.phaseEndsAt = 0;
      }
    }
  }

  resume(now: number, countdown: boolean): void {
    if (this.status !== 'paused') return;
    if (!this.runner.started) {
      this.begin(now);
      return;
    }
    if (countdown) {
      this.status = 'countdown';
      this.phaseEndsAt = now + RESUME_COUNTDOWN_MS;
    } else {
      this.status = 'running';
      this.runner.resume(now);
    }
  }

  setHandling(handling: HandlingConfig): void {
    if (this.runner.started) this.runner.setHandling(handling);
  }

  /** Practice: restores the state at the previous piece's spawn. */
  undo(): boolean {
    if (this.mode.id !== 'practice' || this.undoStack.length < 2) return false;
    this.undoStack.pop();
    const snap = this.undoStack[this.undoStack.length - 1];
    if (!snap) return false;
    this.engine.restore(snap);
    this.lastPieceCount = this.engine.stats.pieces;
    return true;
  }

  get elapsedMs(): number {
    return this.runner.elapsedMs;
  }
}

/** Plays back a stored replay through the same view pipeline. */
export class ReplaySession {
  readonly player: ReplayPlayer;
  readonly mode: ModeDefinition;
  private startedAt: number | null = null;
  private pausedAt: number | null = null;
  speed = 1;
  private virtualTime = 0;
  private lastNow = 0;

  constructor(readonly replay: ReplayData, readonly stageId: string) {
    this.player = new ReplayPlayer(replay);
    this.mode = getMode(replay.modeId as ModeId);
  }

  get engine(): Engine {
    return this.player.engine;
  }

  update(now: number): GameEvent[] {
    if (this.startedAt === null) {
      this.startedAt = now;
      this.lastNow = now;
    }
    if (this.pausedAt === null) this.virtualTime += (now - this.lastNow) * this.speed;
    this.lastNow = now;
    this.player.advanceTo(Math.floor(this.virtualTime));
    return this.player.engine.drainEvents();
  }

  togglePause(now: number): void {
    this.pausedAt = this.pausedAt === null ? now : null;
  }

  get finished(): boolean {
    return this.player.finished;
  }
}

export const ALL_GAME_ACTIONS = GAME_ACTIONS;
