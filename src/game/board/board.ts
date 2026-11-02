import { EMPTY_CELL, pieceCells, type PieceType, type Rotation } from '../pieces/pieces';

/**
 * Playfield grid. y = 0 is the bottom row; rows [0, visibleRows) are visible and
 * rows [visibleRows, height) form the hidden buffer above the field.
 */
export class Board {
  readonly width: number;
  readonly visibleRows: number;
  readonly height: number;
  readonly cells: Uint8Array;
  /** Incremented on every mutation so renderers can skip redundant uploads. */
  version = 0;

  constructor(width: number, visibleRows: number, hiddenRows: number) {
    this.width = width;
    this.visibleRows = visibleRows;
    this.height = visibleRows + hiddenRows;
    this.cells = new Uint8Array(width * this.height);
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  get(x: number, y: number): number {
    return this.inBounds(x, y) ? (this.cells[this.index(x, y)] as number) : EMPTY_CELL;
  }

  /** Out-of-bounds cells count as occupied (walls/floor); above the top counts as free. */
  isBlocked(x: number, y: number): boolean {
    if (x < 0 || x >= this.width || y < 0) return true;
    if (y >= this.height) return false;
    return this.cells[this.index(x, y)] !== EMPTY_CELL;
  }

  set(x: number, y: number, value: number): void {
    if (!this.inBounds(x, y)) return;
    this.cells[this.index(x, y)] = value;
    this.version++;
  }

  collides(type: PieceType, rotation: Rotation, px: number, py: number): boolean {
    for (const c of pieceCells(type, rotation)) {
      if (this.isBlocked(px + c.x, py + c.y)) return true;
    }
    return false;
  }

  /** Writes a piece into the grid. Returns the cells it occupied. */
  place(type: PieceType, rotation: Rotation, px: number, py: number, cellValue: number): { x: number; y: number }[] {
    const placed: { x: number; y: number }[] = [];
    for (const c of pieceCells(type, rotation)) {
      const x = px + c.x;
      const y = py + c.y;
      if (this.inBounds(x, y)) {
        this.cells[this.index(x, y)] = cellValue;
        placed.push({ x, y });
      }
    }
    this.version++;
    return placed;
  }

  isRowFull(y: number): boolean {
    const start = y * this.width;
    for (let x = 0; x < this.width; x++) if (this.cells[start + x] === EMPTY_CELL) return false;
    return true;
  }

  isRowEmpty(y: number): boolean {
    const start = y * this.width;
    for (let x = 0; x < this.width; x++) if (this.cells[start + x] !== EMPTY_CELL) return false;
    return true;
  }

  fullRows(): number[] {
    const rows: number[] = [];
    for (let y = 0; y < this.height; y++) if (this.isRowFull(y)) rows.push(y);
    return rows;
  }

  /** Removes the given rows (ascending or not) and collapses everything above. */
  clearRows(rows: readonly number[]): void {
    if (rows.length === 0) return;
    const remove = new Set(rows);
    let write = 0;
    for (let read = 0; read < this.height; read++) {
      if (remove.has(read)) continue;
      if (write !== read) {
        this.cells.copyWithin(write * this.width, read * this.width, (read + 1) * this.width);
      }
      write++;
    }
    this.cells.fill(EMPTY_CELL, write * this.width);
    this.version++;
  }

  isEmpty(): boolean {
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] !== EMPTY_CELL) return false;
    return true;
  }

  /** Highest occupied row + 1 (0 when empty). */
  stackHeight(): number {
    for (let y = this.height - 1; y >= 0; y--) if (!this.isRowEmpty(y)) return y + 1;
    return 0;
  }

  filledCount(): number {
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] !== EMPTY_CELL) n++;
    return n;
  }

  clear(): void {
    this.cells.fill(EMPTY_CELL);
    this.version++;
  }

  copyFrom(other: Board): void {
    this.cells.set(other.cells);
    this.version++;
  }

  clone(): Board {
    const b = new Board(this.width, this.visibleRows, this.height - this.visibleRows);
    b.cells.set(this.cells);
    return b;
  }

  /** Loads rows written top-first, e.g. ['..........', 'XXXX.XXXXX']; any non-'.' is garbage-like. */
  loadRows(rows: readonly string[], cellValue = 8): void {
    this.clear();
    rows.forEach((row, i) => {
      const y = rows.length - 1 - i;
      for (let x = 0; x < Math.min(row.length, this.width); x++) {
        if (row[x] !== '.') this.cells[this.index(x, y)] = cellValue;
      }
    });
    this.version++;
  }
}
