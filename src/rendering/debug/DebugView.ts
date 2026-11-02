import { GARBAGE_COLOR, type PiecePalette } from '../../config/palette';
import { pieceCells, pieceTypeFromCell, type PieceType } from '../../game/pieces/pieces';
import type { BoardRect, GameView, ViewFrame } from '../view';

/**
 * Canvas2D debug view (`?view=debug2d`). A developer tool for testing gameplay in
 * isolation from the 3D renderer — not the game's presentation.
 */
export class DebugView implements GameView {
  readonly kind = 'canvas2d' as const;
  private readonly ctx: CanvasRenderingContext2D;
  private rect: BoardRect | null = null;
  palette: PiecePalette;
  showGhost = true;
  showGrid = true;
  ghostOpacity = 0.5;
  nextCount = 5;
  showNext = true;
  showHold = true;

  constructor(private readonly canvas: HTMLCanvasElement, palette: PiecePalette) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas2D unavailable');
    this.ctx = ctx;
    this.palette = palette;
    this.resize();
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cell = Math.floor(Math.min((h * 0.86) / 20, (w * 0.5) / 10));
    this.rect = { x: Math.round((w - cell * 10) / 2), y: Math.round((h - cell * 20) / 2), w: cell * 10, h: cell * 20 };
  }

  boardRect(): BoardRect | null {
    return this.rect;
  }

  private color(cell: number): string {
    const type = pieceTypeFromCell(cell);
    return type ? this.palette[type] : GARBAGE_COLOR;
  }

  private drawCell(x: number, y: number, size: number, color: string, alpha = 1): void {
    const c = this.ctx;
    c.globalAlpha = alpha;
    c.fillStyle = color;
    c.fillRect(x + 1, y + 1, size - 2, size - 2);
    c.globalAlpha = alpha * 0.35;
    c.fillStyle = '#ffffff';
    c.fillRect(x + 1, y + 1, size - 2, Math.max(2, size * 0.18));
    c.globalAlpha = 1;
  }

  private drawMini(type: PieceType | null, cx: number, cy: number, size: number, dim = false): void {
    if (!type) return;
    const cells = pieceCells(type, 0);
    const xs = cells.map((c) => c.x);
    const ys = cells.map((c) => c.y);
    const w = Math.max(...xs) - Math.min(...xs) + 1;
    const h = Math.max(...ys) - Math.min(...ys) + 1;
    for (const c of cells) {
      const px = cx - (w * size) / 2 + (c.x - Math.min(...xs)) * size;
      const py = cy + (h * size) / 2 - (c.y - Math.min(...ys) + 1) * size;
      this.drawCell(px, py, size, this.palette[type], dim ? 0.35 : 1);
    }
  }

  render(frame: ViewFrame): void {
    const c = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    c.fillStyle = '#0c0a1d';
    c.fillRect(0, 0, w, h);
    const r = this.rect;
    const e = frame.engine;
    if (!r || !e) return;
    const s = r.w / 10;
    c.fillStyle = 'rgba(255,255,255,0.04)';
    c.fillRect(r.x, r.y, r.w, r.h);
    if (this.showGrid) {
      c.strokeStyle = 'rgba(255,255,255,0.06)';
      c.lineWidth = 1;
      for (let i = 1; i < 10; i++) {
        c.beginPath();
        c.moveTo(r.x + i * s + 0.5, r.y);
        c.lineTo(r.x + i * s + 0.5, r.y + r.h);
        c.stroke();
      }
      for (let j = 1; j < 20; j++) {
        c.beginPath();
        c.moveTo(r.x, r.y + j * s + 0.5);
        c.lineTo(r.x + r.w, r.y + j * s + 0.5);
        c.stroke();
      }
    }
    const toY = (row: number): number => r.y + r.h - (row + 1) * s;
    const board = e.board;
    for (let y = 0; y < Math.min(board.height, 22); y++) {
      for (let x = 0; x < board.width; x++) {
        const v = board.get(x, y);
        if (v !== 0) this.drawCell(r.x + x * s, toY(y), s, this.color(v), y >= 20 ? 0.5 : 1);
      }
    }
    const p = e.active;
    if (p) {
      if (this.showGhost) {
        const gy = e.ghostY();
        c.strokeStyle = this.palette[p.type];
        c.globalAlpha = this.ghostOpacity;
        c.lineWidth = 2;
        for (const cell of pieceCells(p.type, p.rotation)) c.strokeRect(r.x + (p.x + cell.x) * s + 3, toY(gy + cell.y) + 3, s - 6, s - 6);
        c.globalAlpha = 1;
      }
      for (const cell of pieceCells(p.type, p.rotation)) this.drawCell(r.x + (p.x + cell.x) * s, toY(p.y + cell.y), s, this.palette[p.type]);
    }
    c.strokeStyle = 'rgba(255,255,255,0.25)';
    c.lineWidth = 2;
    c.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    const mini = s * 0.7;
    if (this.showHold) this.drawMini(e.hold, r.x - mini * 3.5, r.y + mini * 2, mini, e.holdUsed);
    if (this.showNext) e.preview(this.nextCount).forEach((t, i) => this.drawMini(t, r.x + r.w + mini * 3.5, r.y + mini * 2 + i * mini * 3, mini));
  }

  dispose(): void {
    /* nothing to release */
  }
}
