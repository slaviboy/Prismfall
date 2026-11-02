import type { Engine } from '../game/core/engine';
import type { GameEvent } from '../game/core/types';
import type { AudioFeatures, BeatEvent } from '../audio/analysis/features';

export interface ViewFrame {
  readonly now: number;
  /** Seconds since the previous frame (clamped). */
  readonly dt: number;
  readonly engine: Engine | null;
  readonly events: readonly GameEvent[];
  readonly paused: boolean;
  /** Music features for this frame (stub metronome until the audio engine runs). */
  readonly audio?: Readonly<AudioFeatures>;
  readonly beats?: readonly BeatEvent[];
  /** 0..1 progress toward the current goal (Voyage leg, Sprint lines), if any. */
  readonly progress?: number;
}

export interface BoardRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A presentation of the game. Reads engine state; never mutates it. */
export interface GameView {
  readonly kind: 'webgpu' | 'webgl2' | 'canvas2d';
  render(frame: ViewFrame): void;
  resize(): void;
  /** Board bounds in CSS pixels, used to anchor the DOM HUD. */
  boardRect(): BoardRect | null;
  dispose(): void;
}
