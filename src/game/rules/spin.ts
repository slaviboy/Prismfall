import type { Board } from '../board/board';
import type { PieceType, Rotation } from '../pieces/pieces';
import type { SpinKind } from '../scoring/scoring';

export interface SpinContext {
  readonly type: PieceType;
  readonly rotation: Rotation;
  readonly x: number;
  readonly y: number;
  /** The last successful action on the piece was a rotation. */
  readonly lastActionRotation: boolean;
  /** Kick test index used by that rotation (0-based), -1 if none. */
  readonly lastKickIndex: number;
}

/** Front corners (the side the T's nub points to) for each rotation state, as [dx, dy] from centre. */
const T_FRONT: Record<Rotation, readonly (readonly [number, number])[]> = {
  0: [[-1, 1], [1, 1]],
  1: [[1, 1], [1, -1]],
  2: [[-1, -1], [1, -1]],
  3: [[-1, 1], [-1, -1]],
};
const T_CORNERS: readonly (readonly [number, number])[] = [[-1, 1], [1, 1], [-1, -1], [1, -1]];

/**
 * T-spin detection with the 3-corner rule. Both front corners filled = full T-spin,
 * otherwise mini — unless the rotation used the 5th kick test (index 4), which upgrades to full.
 * With `allSpin`, other pieces that are immobile after a rotation count as a mini spin.
 * Must be called before the piece is written into the board.
 */
export function detectSpin(board: Board, ctx: SpinContext, allSpin: boolean): SpinKind {
  if (!ctx.lastActionRotation) return 'none';
  if (ctx.type === 'T') {
    const cx = ctx.x + 1;
    const cy = ctx.y + 1;
    let corners = 0;
    for (const [dx, dy] of T_CORNERS) if (board.isBlocked(cx + dx, cy + dy)) corners++;
    if (corners < 3) return 'none';
    const front = T_FRONT[ctx.rotation].filter(([dx, dy]) => board.isBlocked(cx + dx, cy + dy)).length;
    if (front === 2 || ctx.lastKickIndex === 4) return 'full';
    return 'mini';
  }
  if (allSpin && ctx.type !== 'O') {
    const immobile =
      board.collides(ctx.type, ctx.rotation, ctx.x - 1, ctx.y) &&
      board.collides(ctx.type, ctx.rotation, ctx.x + 1, ctx.y) &&
      board.collides(ctx.type, ctx.rotation, ctx.x, ctx.y + 1);
    return immobile ? 'mini' : 'none';
  }
  return 'none';
}
