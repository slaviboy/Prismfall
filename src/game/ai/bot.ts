import type { Board } from '../board/board';
import type { Engine } from '../core/engine';
import type { GameAction } from '../core/types';
import { kickTests, pieceCells, rotateState, spawnBoxBottom, spawnColumn, type PieceType, type Rotation } from '../pieces/pieces';

/** El-Tetris feature weights (Islam El-Ashi), tuned for line-clearing survival. */
const W = {
  landingHeight: -4.500158825082766,
  erodedCells: 3.4181268101392694,
  rowTransitions: -3.2178882868487753,
  columnTransitions: -9.348695305445199,
  holes: -7.899265427351652,
  wells: -3.3855972247263626,
};

export interface Placement {
  readonly useHold: boolean;
  readonly piece: PieceType;
  readonly rotation: Rotation;
  readonly x: number;
  readonly score: number;
  /** Actions to perform after the hold (if any), ending with hardDrop. */
  readonly actions: readonly GameAction[];
}

interface Start {
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
}

/** Reachable final (rotation, x, y) states via rotate-then-shift-then-drop, with their action lists. */
function enumerate(board: Board, type: PieceType, start: Start): { rotation: Rotation; x: number; y: number; actions: GameAction[] }[] {
  const results: { rotation: Rotation; x: number; y: number; actions: GameAction[] }[] = [];
  const rotationPlans: { deltas: (1 | 3 | 2)[]; actions: GameAction[] }[] = [
    { deltas: [], actions: [] },
    { deltas: [1], actions: ['rotateCW'] },
    { deltas: [1, 1], actions: ['rotateCW', 'rotateCW'] },
    { deltas: [3], actions: ['rotateCCW'] },
  ];
  const seen = new Set<string>();
  for (const plan of rotationPlans) {
    let { x, y, rotation } = start;
    let ok = true;
    for (const delta of plan.deltas) {
      const to = rotateState(rotation, delta);
      const kick = kickTests(type, rotation, to).find(([dx, dy]) => !board.collides(type, to, x + dx, y + dy));
      if (!kick) {
        ok = false;
        break;
      }
      x += kick[0];
      y += kick[1];
      rotation = to;
    }
    if (!ok) continue;
    for (const dir of [0, -1, 1]) {
      let cx = x;
      const moves: GameAction[] = [];
      while (true) {
        if (dir !== 0 || moves.length === 0) {
          let fy = y;
          while (!board.collides(type, rotation, cx, fy - 1)) fy--;
          const key = cellsKey(type, rotation, cx, fy);
          if (!seen.has(key)) {
            seen.add(key);
            results.push({ rotation, x: cx, y: fy, actions: [...plan.actions, ...moves, 'hardDrop'] });
          }
        }
        if (dir === 0) break;
        if (board.collides(type, rotation, cx + dir, y)) break;
        cx += dir;
        moves.push(dir < 0 ? 'moveLeft' : 'moveRight');
      }
    }
  }
  return results;
}

function cellsKey(type: PieceType, rotation: Rotation, x: number, y: number): string {
  return pieceCells(type, rotation)
    .map((c) => `${x + c.x},${y + c.y}`)
    .sort()
    .join('|');
}

function evaluate(board: Board, type: PieceType, rotation: Rotation, x: number, y: number): number {
  const b = board.clone();
  const cells = b.place(type, rotation, x, y, 1);
  const full = b.fullRows();
  const removedPieceCells = cells.filter((c) => full.includes(c.y)).length;
  b.clearRows(full);
  const ys = cells.map((c) => c.y);
  const landingHeight = (Math.min(...ys) + Math.max(...ys)) / 2 + 1;
  const top = Math.min(b.height, b.visibleRows + 4);

  let rowTransitions = 0;
  for (let ry = 0; ry < top; ry++) {
    let prev = true;
    for (let cx = 0; cx < b.width; cx++) {
      const filled = b.get(cx, ry) !== 0;
      if (filled !== prev) rowTransitions++;
      prev = filled;
    }
    if (!prev) rowTransitions++;
  }

  let columnTransitions = 0;
  let holes = 0;
  let wells = 0;
  for (let cx = 0; cx < b.width; cx++) {
    let prev = true;
    let covered = false;
    for (let ry = top - 1; ry >= 0; ry--) {
      const filled = b.get(cx, ry) !== 0;
      if (filled) covered = true;
      else if (covered) holes++;
    }
    for (let ry = 0; ry < top; ry++) {
      const filled = b.get(cx, ry) !== 0;
      if (filled !== prev) columnTransitions++;
      prev = filled;
    }
    let depth = 0;
    for (let ry = top - 1; ry >= 0; ry--) {
      const empty = b.get(cx, ry) === 0;
      const leftFilled = cx === 0 || b.get(cx - 1, ry) !== 0;
      const rightFilled = cx === b.width - 1 || b.get(cx + 1, ry) !== 0;
      if (empty && leftFilled && rightFilled) {
        depth++;
        wells += depth;
      } else if (!empty) {
        depth = 0;
      }
    }
  }

  return (
    W.landingHeight * landingHeight +
    W.erodedCells * full.length * removedPieceCells +
    W.rowTransitions * rowTransitions +
    W.columnTransitions * columnTransitions +
    W.holes * holes +
    W.wells * wells
  );
}

function bestFor(board: Board, type: PieceType, start: Start, useHold: boolean): Placement | null {
  let best: Placement | null = null;
  for (const option of enumerate(board, type, start)) {
    const score = evaluate(board, type, option.rotation, option.x, option.y);
    if (!best || score > best.score) {
      best = { useHold, piece: type, rotation: option.rotation, x: option.x, score, actions: option.actions };
    }
  }
  return best;
}

/** Chooses the best placement for the current piece, optionally considering hold. */
export function choosePlacement(engine: Engine, considerHold = true): Placement | null {
  const active = engine.active;
  if (!active) return null;
  const current = bestFor(engine.board, active.type, { x: active.x, y: active.y, rotation: active.rotation }, false);
  if (!considerHold || !engine.rules.holdEnabled || engine.holdUsed) return current;
  const alt = engine.hold ?? engine.preview(1)[0];
  if (!alt) return current;
  const spawnY = spawnBoxBottom(alt, engine.rules.spawnRow) - (engine.rules.spawnDrop ? 1 : 0);
  const altStart = { x: spawnColumn(alt, engine.board.width), y: spawnY, rotation: 0 as Rotation };
  if (engine.board.collides(alt, 0, altStart.x, altStart.y)) return current;
  const held = bestFor(engine.board, alt, altStart, true);
  if (!current) return held;
  return held && held.score > current.score + 1e-6 ? held : current;
}
