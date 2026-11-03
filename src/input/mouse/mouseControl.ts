import type { GameAction } from '../../game/core/types';
import { pieceCells, type PieceType, type Rotation } from '../../game/pieces/pieces';

const BOARD_COLUMNS = 10;

export interface MousePiece {
  readonly type: PieceType;
  readonly rotation: Rotation;
  readonly x: number;
}

/**
 * Signed number of one-cell shifts that centres `piece` under a fractional board column
 * (0 = left wall, 10 = right wall), clamped so the piece stays inside the walls.
 */
export function shiftToward(column: number, piece: MousePiece): number {
  const xs = pieceCells(piece.type, piece.rotation).map((c) => c.x);
  const min = Math.min(...xs);
  const width = Math.max(...xs) - min + 1;
  const left = Math.max(0, Math.min(BOARD_COLUMNS - width, Math.round(column - width / 2)));
  return left - (piece.x + min);
}

export interface MouseControlHost {
  /** Whether a game is running and taking input. */
  playing(): boolean;
  /** Fractional board column under a viewport point, or null. */
  columnAt(clientX: number, clientY: number): number | null;
  /** The falling piece, plus a value that changes with each new piece. */
  piece(): { piece: MousePiece; serial: number } | null;
  /** True while inputs are queued but not yet simulated (the piece position is stale). */
  pending(): boolean;
  send(action: GameAction, time: number): void;
}

/** Elements that keep their own clicks (HUD pause button, menus) instead of dropping a piece. */
const INTERACTIVE = 'button, a, input, select, textarea, [data-focusable], [role="switch"], [role="dialog"]';

/**
 * Mouse play: the piece (and so its ghost) follows the pointer across the board; left click
 * hard drops, right click rotates clockwise, middle click holds. Movement is sent as one-cell
 * nudges through the normal input queue, so replays stay deterministic. The mouse only steers
 * after it moves or clicks, and yields as soon as the keyboard or a gamepad is used.
 */
export class MouseControl {
  enabled = false;
  private steering = false;
  private moved = false;
  private x = 0;
  private y = 0;
  private hasPointer = false;
  private lastKey = '';

  constructor(private readonly host: MouseControlHost) {}

  attach(target: Window = window): void {
    target.addEventListener('pointermove', this.onMove, { passive: true });
    target.addEventListener('pointerdown', this.onDown);
    target.addEventListener('contextmenu', this.onContextMenu);
  }

  detach(target: Window = window): void {
    target.removeEventListener('pointermove', this.onMove);
    target.removeEventListener('pointerdown', this.onDown);
    target.removeEventListener('contextmenu', this.onContextMenu);
  }

  /** Another device took over: stop steering until the mouse is used again. */
  yieldToOtherDevice(): void {
    this.steering = false;
  }

  /** Called once per frame before the simulation: lines the piece up under the pointer. */
  sync(time: number): void {
    if (!this.enabled || !this.steering || !this.hasPointer || !this.host.playing() || this.host.pending()) return;
    const current = this.host.piece();
    if (!current) return;
    const { piece, serial } = current;
    // Re-aim only when the pointer moved or the piece changed (new piece, rotation, hold), so a
    // blocked shift is not retried every frame.
    const key = `${serial}:${piece.type}:${piece.rotation}`;
    if (!this.moved && key === this.lastKey) return;
    const column = this.host.columnAt(this.x, this.y);
    if (column === null) return;
    this.moved = false;
    this.lastKey = key;
    const n = shiftToward(column, piece);
    const action: GameAction = n < 0 ? 'nudgeLeft' : 'nudgeRight';
    for (let i = 0; i < Math.abs(n); i++) this.host.send(action, time);
  }

  private readonly onMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    if (this.hasPointer && e.clientX === this.x && e.clientY === this.y) return;
    this.x = e.clientX;
    this.y = e.clientY;
    this.hasPointer = true;
    this.moved = true;
    if (this.enabled && this.host.playing()) this.steering = true;
  };

  private readonly onDown = (e: PointerEvent): void => {
    if (!this.enabled || e.pointerType !== 'mouse' || !this.host.playing()) return;
    if ((e.target as Element | null)?.closest?.(INTERACTIVE)) return;
    const action: GameAction | null = e.button === 0 ? 'hardDrop' : e.button === 2 ? 'rotateCW' : e.button === 1 ? 'hold' : null;
    if (!action) return;
    e.preventDefault(); // no middle-click autoscroll or text selection
    this.x = e.clientX;
    this.y = e.clientY;
    this.hasPointer = true;
    this.steering = true;
    // Line up with where the pointer is first, so a quick move-and-click drops in the right column.
    this.moved = true;
    this.sync(e.timeStamp);
    this.host.send(action, e.timeStamp);
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    if (this.enabled && this.host.playing()) e.preventDefault();
  };
}
