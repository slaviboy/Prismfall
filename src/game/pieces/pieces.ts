/**
 * The seven tetrominoes and their Super Rotation System (SRS) data.
 *
 * Coordinates are y-up: (0,0) is the bottom-left cell of a piece's bounding box.
 * Rotation states: 0 = spawn, 1 = R (clockwise), 2 = 180, 3 = L (counter-clockwise).
 */

export const PIECE_TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'] as const;
export type PieceType = (typeof PIECE_TYPES)[number];
export type Rotation = 0 | 1 | 2 | 3;

/** Cell ids stored on the board: 0 = empty, 1..7 = piece type (index + 1), 8 = garbage. */
export const EMPTY_CELL = 0;
export const GARBAGE_CELL = 8;

export function pieceCellId(type: PieceType): number {
  return PIECE_TYPES.indexOf(type) + 1;
}

export function pieceTypeFromCell(cell: number): PieceType | null {
  return cell >= 1 && cell <= 7 ? (PIECE_TYPES[cell - 1] ?? null) : null;
}

export interface Cell {
  readonly x: number;
  readonly y: number;
}

/** Spawn-orientation shapes, written top row first. */
const SPAWN_ROWS: Record<PieceType, readonly string[]> = {
  I: ['....', 'XXXX', '....', '....'],
  O: ['XX', 'XX'],
  T: ['.X.', 'XXX', '...'],
  S: ['.XX', 'XX.', '...'],
  Z: ['XX.', '.XX', '...'],
  J: ['X..', 'XXX', '...'],
  L: ['..X', 'XXX', '...'],
};

function parseShape(rows: readonly string[]): Cell[] {
  const size = rows.length;
  const cells: Cell[] = [];
  rows.forEach((row, rowIndex) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === 'X') cells.push({ x, y: size - 1 - rowIndex });
    }
  });
  return cells;
}

/** Clockwise rotation inside an N×N box in y-up coordinates: (x, y) -> (y, N-1-x). */
function rotateCW(cells: readonly Cell[], size: number): Cell[] {
  return cells.map(({ x, y }) => ({ x: y, y: size - 1 - x }));
}

function sortCells(cells: Cell[]): Cell[] {
  return cells.sort((a, b) => a.y - b.y || a.x - b.x);
}

export interface PieceDefinition {
  readonly type: PieceType;
  readonly boxSize: number;
  /** cells[rotation] — the occupied cells of each rotation state. */
  readonly cells: readonly (readonly Cell[])[];
}

function buildDefinition(type: PieceType): PieceDefinition {
  const rows = SPAWN_ROWS[type];
  const size = rows.length;
  const states: Cell[][] = [sortCells(parseShape(rows))];
  for (let r = 1; r < 4; r++) {
    const prev = states[r - 1] as Cell[];
    states.push(sortCells(type === 'O' ? prev.map((c) => ({ ...c })) : rotateCW(prev, size)));
  }
  return { type, boxSize: size, cells: states };
}

export const PIECES: Readonly<Record<PieceType, PieceDefinition>> = Object.fromEntries(
  PIECE_TYPES.map((t) => [t, buildDefinition(t)]),
) as Record<PieceType, PieceDefinition>;

export function pieceCells(type: PieceType, rotation: Rotation): readonly Cell[] {
  return PIECES[type].cells[rotation] as readonly Cell[];
}

/** Spawn box position for a 10-wide board (guideline: 3-wide pieces left-centred). */
export function spawnColumn(type: PieceType, boardWidth: number): number {
  return Math.floor((boardWidth - PIECES[type].boxSize) / 2);
}

/**
 * Box bottom row such that the piece's lowest filled cells occupy row `spawnRow`
 * (0-indexed from the bottom). Guideline spawn is row 21 (1-indexed) = 20.
 */
export function spawnBoxBottom(type: PieceType, spawnRow: number): number {
  const lowest = Math.min(...pieceCells(type, 0).map((c) => c.y));
  return spawnRow - lowest;
}

// ---------------------------------------------------------------------------
// Kick tables (y-up offsets). Index = test number; test 0 is always (0,0).
// ---------------------------------------------------------------------------

type KickList = readonly (readonly [number, number])[];
type KickKey = `${Rotation}${Rotation}`;

const JLSTZ_KICKS: Record<string, KickList> = {
  '01': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '10': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '12': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '21': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '23': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '32': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '30': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '03': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};

const I_KICKS: Record<string, KickList> = {
  '01': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '10': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '12': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '21': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '23': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '32': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '30': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '03': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

/** 180° kicks (SRS+-style). Only used when 180° rotation is enabled. */
const JLSTZ_180_KICKS: Record<string, KickList> = {
  '02': [[0, 0], [0, 1], [1, 1], [-1, 1], [1, 0], [-1, 0]],
  '20': [[0, 0], [0, -1], [-1, -1], [1, -1], [-1, 0], [1, 0]],
  '13': [[0, 0], [1, 0], [1, 2], [1, 1], [0, 2], [0, 1]],
  '31': [[0, 0], [-1, 0], [-1, 2], [-1, 1], [0, 2], [0, 1]],
};

const I_180_KICKS: Record<string, KickList> = {
  '02': [[0, 0], [0, 1]],
  '20': [[0, 0], [0, -1]],
  '13': [[0, 0], [1, 0]],
  '31': [[0, 0], [-1, 0]],
};

const NO_KICK: KickList = [[0, 0]];

export function kickTests(type: PieceType, from: Rotation, to: Rotation): KickList {
  if (type === 'O') return NO_KICK;
  const key: KickKey = `${from}${to}`;
  const isHalfTurn = (from + 2) % 4 === to;
  if (isHalfTurn) return (type === 'I' ? I_180_KICKS : JLSTZ_180_KICKS)[key] ?? NO_KICK;
  return (type === 'I' ? I_KICKS : JLSTZ_KICKS)[key] ?? NO_KICK;
}

export function rotateState(rotation: Rotation, delta: 1 | 2 | 3): Rotation {
  return ((rotation + delta) % 4) as Rotation;
}
