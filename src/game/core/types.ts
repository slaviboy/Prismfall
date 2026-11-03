import type { PieceType, Rotation } from '../pieces/pieces';
import type { ClearKind, ClearScore, SpinKind } from '../scoring/scoring';

export const GAME_ACTIONS = [
  'moveLeft',
  'moveRight',
  'softDrop',
  'hardDrop',
  'rotateCW',
  'rotateCCW',
  'rotate180',
  'hold',
  // One-cell shifts without auto shift (mouse control). Appended so replay action indices stay stable.
  'nudgeLeft',
  'nudgeRight',
] as const;
export type GameAction = (typeof GAME_ACTIONS)[number];

export interface HandlingConfig {
  /** Delayed auto shift, ms. */
  readonly dasMs: number;
  /** Auto repeat rate, ms per cell; 0 = instant to wall. */
  readonly arrMs: number;
  /** Soft-drop gravity multiplier; Infinity = instant (no lock). */
  readonly softDropFactor: number;
  /** Auto-shift is suppressed this long after spawning/rotating. */
  readonly dasCutMs: number;
  /** Rotation/hold pressed during entry delay applies at spawn (IRS/IHS). */
  readonly bufferInitialActions: boolean;
  /** Hard drop pressed during entry delay applies at spawn. */
  readonly bufferHardDrop: boolean;
}

export const DEFAULT_HANDLING: HandlingConfig = {
  dasMs: 167,
  arrMs: 33,
  softDropFactor: 20,
  dasCutMs: 0,
  bufferInitialActions: true,
  bufferHardDrop: true,
};

export interface ActivePiece {
  type: PieceType;
  rotation: Rotation;
  x: number;
  y: number;
}

export type EnginePhase = 'falling' | 'entry' | 'gameOver' | 'complete';
export type GameOverReason = 'blockOut' | 'lockOut';

export interface CellPos {
  readonly x: number;
  readonly y: number;
}

export type GameEvent =
  | { readonly type: 'spawn'; readonly tick: number; readonly piece: PieceType; readonly x: number; readonly y: number; readonly rotation: Rotation; readonly fromHold: boolean }
  | { readonly type: 'move'; readonly tick: number; readonly dx: number; readonly auto: boolean }
  | { readonly type: 'shiftBlocked'; readonly tick: number; readonly dir: -1 | 1 }
  | { readonly type: 'rotate'; readonly tick: number; readonly from: Rotation; readonly to: Rotation; readonly kick: number }
  | { readonly type: 'rotateFailed'; readonly tick: number }
  | { readonly type: 'softDrop'; readonly tick: number; readonly rows: number }
  | { readonly type: 'hardDrop'; readonly tick: number; readonly rows: number; readonly piece: PieceType; readonly cells: readonly CellPos[] }
  | { readonly type: 'land'; readonly tick: number }
  | { readonly type: 'lockReset'; readonly tick: number; readonly remaining: number }
  | { readonly type: 'lock'; readonly tick: number; readonly piece: PieceType; readonly cells: readonly CellPos[]; readonly spin: SpinKind }
  | {
      readonly type: 'lineClear';
      readonly tick: number;
      readonly rows: readonly number[];
      readonly lines: number;
      readonly spin: SpinKind;
      readonly kind: ClearKind;
      readonly backToBack: boolean;
      readonly backToBackCount: number;
      readonly combo: number;
      readonly perfectClear: boolean;
      readonly score: ClearScore;
      /** Snapshot of the cleared rows' cell values before removal (for effects). */
      readonly clearedCells: readonly { readonly x: number; readonly y: number; readonly cell: number }[];
    }
  | { readonly type: 'spinNoLines'; readonly tick: number; readonly spin: SpinKind; readonly kind: ClearKind; readonly points: number }
  | { readonly type: 'comboBreak'; readonly tick: number; readonly combo: number }
  | { readonly type: 'hold'; readonly tick: number; readonly held: PieceType; readonly swappedIn: PieceType }
  | { readonly type: 'holdDenied'; readonly tick: number }
  | { readonly type: 'levelUp'; readonly tick: number; readonly level: number }
  | { readonly type: 'goal'; readonly tick: number }
  | { readonly type: 'gameOver'; readonly tick: number; readonly reason: GameOverReason }
  | { readonly type: 'boardReset'; readonly tick: number };

export type GameEventType = GameEvent['type'];

export interface SessionStats {
  pieces: number;
  inputs: number;
  lines: number;
  singles: number;
  doubles: number;
  triples: number;
  quads: number;
  tSpins: number;
  tSpinMinis: number;
  perfectClears: number;
  maxCombo: number;
  maxBackToBack: number;
  softDropRows: number;
  hardDropRows: number;
  holds: number;
}

export function emptyStats(): SessionStats {
  return {
    pieces: 0,
    inputs: 0,
    lines: 0,
    singles: 0,
    doubles: 0,
    triples: 0,
    quads: 0,
    tSpins: 0,
    tSpinMinis: 0,
    perfectClears: 0,
    maxCombo: 0,
    maxBackToBack: 0,
    softDropRows: 0,
    hardDropRows: 0,
    holds: 0,
  };
}
