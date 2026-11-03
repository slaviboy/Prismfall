import { Board } from '../board/board';
import {
  kickTests,
  pieceCellId,
  pieceCells,
  rotateState,
  spawnBoxBottom,
  spawnColumn,
  type PieceType,
  type Rotation,
} from '../pieces/pieces';
import { PieceQueue } from '../random/randomizer';
import { GRAVITY_ONE, TWENTY_G, gravityForLevel, guidelineGravity, lockDelayForLevel, type RuleConfig } from '../rules/rules';
import { detectSpin } from '../rules/spin';
import { classifyClear, isDifficult, scoreClear, type SpinKind } from '../scoring/scoring';
import {
  DEFAULT_HANDLING,
  emptyStats,
  type ActivePiece,
  type CellPos,
  type EnginePhase,
  type GameAction,
  type GameEvent,
  type GameOverReason,
  type HandlingConfig,
  type SessionStats,
} from './types';

export const ENGINE_VERSION = 1;

export interface EngineOptions {
  readonly rules: RuleConfig;
  readonly seed: number;
  readonly handling?: HandlingConfig;
}

export interface EngineSnapshot {
  readonly cells: Uint8Array;
  readonly active: ActivePiece | null;
  readonly hold: PieceType | null;
  readonly holdUsed: boolean;
  readonly queue: ReturnType<PieceQueue['snapshot']>;
  readonly score: number;
  readonly lines: number;
  readonly level: number;
  readonly combo: number;
  readonly backToBackActive: boolean;
  readonly backToBackCount: number;
  readonly stats: SessionStats;
}

/**
 * Deterministic falling-tetromino engine. Time advances in fixed 1 ms ticks via `step()`.
 * Inputs (`press`/`release`) take effect at the current tick. No DOM/clock access.
 */
export class Engine {
  readonly rules: RuleConfig;
  readonly seed: number;
  readonly board: Board;
  readonly queue: PieceQueue;
  handling: HandlingConfig;

  tick = 0;
  phase: EnginePhase = 'entry';
  gameOverReason: GameOverReason | null = null;
  active: ActivePiece | null = null;
  hold: PieceType | null = null;
  holdUsed = false;
  score = 0;
  lines = 0;
  level: number;
  combo = -1;
  backToBackActive = false;
  backToBackCount = 0;
  stats: SessionStats = emptyStats();
  /** Incremented whenever the active piece changes position/rotation/type. */
  pieceVersion = 0;

  private gravityOverride: number | null = null;
  private entryTimer = 0;
  private gravityAcc = 0;
  private lockTimer = 0;
  private lockResets = 0;
  private lowestY = 0;
  private grounded = false;
  private lastActionRotation = false;
  private lastKickIndex = -1;

  private leftHeld = false;
  private rightHeld = false;
  private softHeld = false;
  private dir: -1 | 0 | 1 = 0;
  private dasTimer = 0;
  private arrAcc = 0;
  private autoShifting = false;
  private dasCutUntil = 0;

  private bufferedRotation: 0 | 1 | 2 | 3 = 0;
  private bufferedHold = false;
  private bufferedHardDrop = false;

  private events: GameEvent[] = [];

  constructor(options: EngineOptions) {
    this.rules = options.rules;
    this.seed = options.seed >>> 0;
    this.handling = options.handling ?? DEFAULT_HANDLING;
    this.board = new Board(this.rules.boardWidth, this.rules.visibleRows, Math.max(4, this.rules.hiddenRows));
    this.queue = new PieceQueue(this.seed, this.rules.randomizer);
    this.level = Math.max(1, this.rules.startLevel);
    this.entryTimer = 0;
  }

  // ------------------------------------------------------------------ queries

  get isOver(): boolean {
    return this.phase === 'gameOver' || this.phase === 'complete';
  }

  get currentGravity(): number {
    return this.gravityOverride ?? gravityForLevel(this.rules, this.level);
  }

  get currentLockDelay(): number {
    return lockDelayForLevel(this.rules, this.level);
  }

  /** Remaining lock delay in [0, 1] (1 = full), for lock-progress visuals. */
  get lockProgress(): number {
    if (!this.active || !this.grounded || this.rules.lockResetMode === 'infinite') return 0;
    return Math.min(1, this.lockTimer / Math.max(1, this.currentLockDelay));
  }

  get lockResetsRemaining(): number {
    return Math.max(0, this.rules.maxLockResets - this.lockResets);
  }

  get isGrounded(): boolean {
    return this.grounded;
  }

  preview(count = this.rules.previewCount): readonly PieceType[] {
    return this.queue.peek(count);
  }

  /** Y position the active piece would land at (ghost). */
  ghostY(): number {
    const p = this.active;
    if (!p) return 0;
    let y = p.y;
    while (!this.board.collides(p.type, p.rotation, p.x, y - 1)) y--;
    return y;
  }

  activeCells(): CellPos[] {
    const p = this.active;
    if (!p) return [];
    return pieceCells(p.type, p.rotation).map((c) => ({ x: p.x + c.x, y: p.y + c.y }));
  }

  drainEvents(): GameEvent[] {
    if (this.events.length === 0) return EMPTY_EVENTS;
    const out = this.events;
    this.events = [];
    return out;
  }

  // ------------------------------------------------------------------ control

  setHandling(handling: HandlingConfig): void {
    this.handling = handling;
  }

  /** Used by modes (e.g. Voyage legs) to drive speed externally. */
  setLevel(level: number): void {
    const next = Math.max(1, Math.floor(level));
    if (next !== this.level) {
      this.level = next;
      this.emit({ type: 'levelUp', tick: this.tick, level: next });
    }
  }

  /** Overrides gravity (fixed-point rows/ms); null restores the level curve. */
  setGravityOverride(gravity: number | null): void {
    this.gravityOverride = gravity;
  }

  /** Releases every held input (focus loss, pause). */
  releaseAll(): void {
    this.leftHeld = this.rightHeld = this.softHeld = false;
    this.dir = 0;
    this.autoShifting = false;
  }

  press(action: GameAction): void {
    if (this.isOver) return;
    this.stats.inputs++;
    switch (action) {
      case 'moveLeft':
      case 'moveRight': {
        const d: -1 | 1 = action === 'moveLeft' ? -1 : 1;
        if (d === -1) this.leftHeld = true;
        else this.rightHeld = true;
        this.dir = d;
        this.dasTimer = 0;
        this.arrAcc = 0;
        this.autoShifting = false;
        if (this.active) {
          if (!this.shift(d, false)) this.emit({ type: 'shiftBlocked', tick: this.tick, dir: d });
          if (this.handling.dasMs === 0) this.beginAutoShift();
        }
        break;
      }
      case 'nudgeLeft':
      case 'nudgeRight': {
        const d: -1 | 1 = action === 'nudgeLeft' ? -1 : 1;
        if (this.active && !this.shift(d, false)) this.emit({ type: 'shiftBlocked', tick: this.tick, dir: d });
        break;
      }
      case 'softDrop':
        this.softHeld = true;
        if (this.active && this.handling.softDropFactor === Infinity) this.sonicDrop(true);
        break;
      case 'hardDrop':
        if (this.active) this.hardDrop();
        else if (this.phase === 'entry' && this.handling.bufferHardDrop) this.bufferedHardDrop = true;
        break;
      case 'rotateCW':
      case 'rotateCCW':
      case 'rotate180': {
        const delta = action === 'rotateCW' ? 1 : action === 'rotateCCW' ? 3 : 2;
        if (delta === 2 && !this.rules.rotation180) break;
        if (this.active) this.rotate(delta);
        else if (this.phase === 'entry' && this.handling.bufferInitialActions) this.bufferedRotation = delta;
        break;
      }
      case 'hold':
        if (this.active) this.doHold();
        else if (this.phase === 'entry' && this.handling.bufferInitialActions) this.bufferedHold = true;
        break;
    }
  }

  release(action: GameAction): void {
    switch (action) {
      case 'moveLeft':
        this.leftHeld = false;
        if (this.dir === -1) this.switchDirection(this.rightHeld ? 1 : 0);
        break;
      case 'moveRight':
        this.rightHeld = false;
        if (this.dir === 1) this.switchDirection(this.leftHeld ? -1 : 0);
        break;
      case 'softDrop':
        this.softHeld = false;
        break;
      default:
        break;
    }
  }

  /** Advances simulation time by one millisecond. */
  step(): void {
    if (this.isOver) return;
    this.tick++;
    if (this.dir !== 0) this.dasTimer++;

    if (this.phase === 'entry') {
      this.entryTimer--;
      if (this.entryTimer <= 0) this.spawn(null, false);
    } else if (this.phase === 'falling' && this.active) {
      this.updateAutoShift();
      if (this.active) this.updateGravity();
      if (this.active) this.updateLock();
    }

    const goal = this.rules.goal;
    if (goal.kind === 'time' && !this.isOver && this.tick >= goal.ms) this.complete();
  }

  /** Steps until `targetTick` (inclusive) or the game ends. */
  advanceTo(targetTick: number): void {
    while (this.tick < targetTick && !this.isOver) this.step();
  }

  /** Begins the game: spawns the first piece. */
  start(): void {
    if (this.phase === 'entry' && !this.active && this.tick === 0 && this.stats.pieces === 0) this.spawn(null, false);
  }

  // ------------------------------------------------------------------ snapshots (Practice undo)

  snapshot(): EngineSnapshot {
    return {
      cells: this.board.cells.slice(),
      active: this.active ? { ...this.active } : null,
      hold: this.hold,
      holdUsed: this.holdUsed,
      queue: this.queue.snapshot(),
      score: this.score,
      lines: this.lines,
      level: this.level,
      combo: this.combo,
      backToBackActive: this.backToBackActive,
      backToBackCount: this.backToBackCount,
      stats: { ...this.stats },
    };
  }

  restore(s: EngineSnapshot): void {
    this.board.cells.set(s.cells);
    this.board.version++;
    this.active = s.active ? { ...s.active } : null;
    this.hold = s.hold;
    this.holdUsed = s.holdUsed;
    this.queue.restore(s.queue);
    this.score = s.score;
    this.lines = s.lines;
    this.level = s.level;
    this.combo = s.combo;
    this.backToBackActive = s.backToBackActive;
    this.backToBackCount = s.backToBackCount;
    this.stats = { ...s.stats };
    this.phase = this.active ? 'falling' : 'entry';
    this.entryTimer = 0;
    this.resetPieceState();
    this.pieceVersion++;
  }

  /** FNV-1a hash of the observable game state (replay verification). */
  stateHash(): number {
    let h = 0x811c9dc5;
    const mix = (v: number): void => {
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= (v >>> 8) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= (v >>> 16) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= (v >>> 24) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    };
    for (let i = 0; i < this.board.cells.length; i++) mix(this.board.cells[i] as number);
    mix(this.score);
    mix(this.lines);
    mix(this.level);
    mix(this.tick);
    mix(this.stats.pieces);
    if (this.active) {
      mix(pieceCellId(this.active.type));
      mix(this.active.rotation);
      mix(this.active.x + 100);
      mix(this.active.y + 100);
    }
    for (const p of this.queue.peek(7)) mix(pieceCellId(p));
    return h >>> 0;
  }

  // ------------------------------------------------------------------ internals

  private emit(e: GameEvent): void {
    this.events.push(e);
  }

  private switchDirection(next: -1 | 0 | 1): void {
    this.dir = next;
    this.dasTimer = 0;
    this.arrAcc = 0;
    this.autoShifting = false;
  }

  private resetPieceState(): void {
    this.gravityAcc = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.lastActionRotation = false;
    this.lastKickIndex = -1;
    this.lowestY = this.active ? this.active.y : 0;
    this.grounded = this.active ? this.board.collides(this.active.type, this.active.rotation, this.active.x, this.active.y - 1) : false;
  }

  private collides(p: ActivePiece, dx: number, dy: number, rotation: Rotation = p.rotation): boolean {
    return this.board.collides(p.type, rotation, p.x + dx, p.y + dy);
  }

  private spawn(forced: PieceType | null, fromHold: boolean): void {
    const type = forced ?? this.queue.next();
    const piece: ActivePiece = {
      type,
      rotation: 0,
      x: spawnColumn(type, this.board.width),
      y: spawnBoxBottom(type, this.rules.spawnRow),
    };
    if (this.board.collides(type, 0, piece.x, piece.y)) {
      if (this.rules.topOut === 'clearBoard') {
        this.board.clear();
        this.emit({ type: 'boardReset', tick: this.tick });
      } else {
        this.active = null;
        this.gameOver('blockOut');
        return;
      }
    }
    this.active = piece;
    this.phase = 'falling';
    this.resetPieceState();
    this.pieceVersion++;
    this.emit({ type: 'spawn', tick: this.tick, piece: type, x: piece.x, y: piece.y, rotation: 0, fromHold });

    // Initial hold / rotation (buffered during entry delay).
    if (this.bufferedHold) {
      this.bufferedHold = false;
      if (this.doHold()) return;
    }
    if (this.bufferedRotation !== 0) {
      const delta = this.bufferedRotation;
      this.bufferedRotation = 0;
      this.rotate(delta);
    }
    if (this.rules.spawnDrop && this.active && !this.collides(this.active, 0, -1)) {
      this.active.y--;
      this.lowestY = this.active.y;
    }
    if (!this.active) return;
    if (this.currentGravity >= TWENTY_G) this.sonicDrop(false);
    this.dasCutUntil = this.tick + this.handling.dasCutMs;
    if (this.dir !== 0 && this.dasTimer >= this.handling.dasMs) this.beginAutoShift();
    if (this.softHeld && this.handling.softDropFactor === Infinity) this.sonicDrop(true);
    this.updateGrounded();
    if (this.bufferedHardDrop) {
      this.bufferedHardDrop = false;
      this.hardDrop();
    }
  }

  private shift(dx: number, auto: boolean): boolean {
    const p = this.active;
    if (!p || this.collides(p, dx, 0)) return false;
    p.x += dx;
    this.lastActionRotation = false;
    this.afterMove();
    this.emit({ type: 'move', tick: this.tick, dx, auto });
    return true;
  }

  private shiftToWall(dir: number, auto: boolean): void {
    const p = this.active;
    if (!p) return;
    let moved = 0;
    while (!this.collides(p, dir, 0)) {
      p.x += dir;
      moved += dir;
    }
    if (moved !== 0) {
      this.lastActionRotation = false;
      this.afterMove();
      this.emit({ type: 'move', tick: this.tick, dx: moved, auto });
    }
  }

  private beginAutoShift(): void {
    if (!this.active || this.dir === 0 || this.tick < this.dasCutUntil) return;
    this.autoShifting = true;
    this.arrAcc = 0;
    if (this.handling.arrMs === 0) this.shiftToWall(this.dir, true);
    else this.shift(this.dir, true);
  }

  private updateAutoShift(): void {
    if (this.dir === 0 || this.dasTimer < this.handling.dasMs || this.tick < this.dasCutUntil) return;
    if (!this.autoShifting) {
      this.beginAutoShift();
      return;
    }
    if (this.handling.arrMs === 0) {
      this.shiftToWall(this.dir, true);
      return;
    }
    this.arrAcc++;
    while (this.arrAcc >= this.handling.arrMs && this.active) {
      this.arrAcc -= this.handling.arrMs;
      if (!this.shift(this.dir, true)) {
        this.arrAcc = 0;
        break;
      }
    }
  }

  private softGravity(): number {
    const base = Math.max(this.currentGravity, guidelineGravity(1));
    return Math.min(base * this.handling.softDropFactor, TWENTY_G);
  }

  private updateGravity(): void {
    const p = this.active;
    if (!p) return;
    const soft = this.softHeld;
    const g = soft ? this.softGravity() : this.currentGravity;
    if (g >= TWENTY_G) {
      this.sonicDrop(soft);
      return;
    }
    if (this.collides(p, 0, -1)) {
      this.gravityAcc = 0;
      return;
    }
    this.gravityAcc += g;
    let rows = 0;
    while (this.gravityAcc >= GRAVITY_ONE) {
      this.gravityAcc -= GRAVITY_ONE;
      if (this.collides(p, 0, -1)) {
        this.gravityAcc = 0;
        break;
      }
      p.y--;
      rows++;
    }
    if (rows > 0) this.onFell(rows, soft);
  }

  /** Drops the piece to the floor without locking (20G gravity or instant soft drop). */
  private sonicDrop(soft: boolean): void {
    const p = this.active;
    if (!p) return;
    let rows = 0;
    while (!this.collides(p, 0, -1)) {
      p.y--;
      rows++;
    }
    this.gravityAcc = 0;
    if (rows > 0) this.onFell(rows, soft);
  }

  private onFell(rows: number, soft: boolean): void {
    const p = this.active as ActivePiece;
    this.lastActionRotation = false;
    if (soft) {
      this.stats.softDropRows += rows;
      this.score += rows * this.rules.scoring.softDropPerRow;
      this.emit({ type: 'softDrop', tick: this.tick, rows });
    }
    if (p.y < this.lowestY) {
      this.lowestY = p.y;
      if (this.rules.lockResetMode !== 'infinite') {
        this.lockResets = 0;
        this.lockTimer = 0;
      }
    }
    this.pieceVersion++;
    this.updateGrounded();
  }

  private updateGrounded(): void {
    const p = this.active;
    if (!p) return;
    const was = this.grounded;
    this.grounded = this.collides(p, 0, -1);
    if (this.grounded && !was) this.emit({ type: 'land', tick: this.tick });
  }

  /** Lock-delay bookkeeping after a successful translation/rotation. */
  private afterMove(): void {
    const p = this.active as ActivePiece;
    const wasGrounded = this.grounded;
    this.pieceVersion++;
    if (p.y < this.lowestY) {
      this.lowestY = p.y;
      this.lockResets = 0;
      this.lockTimer = 0;
    }
    this.updateGrounded();
    if (this.rules.lockResetMode === 'move' && (wasGrounded || this.grounded)) {
      if (this.lockResets < this.rules.maxLockResets) {
        this.lockResets++;
        this.lockTimer = 0;
        this.emit({ type: 'lockReset', tick: this.tick, remaining: this.rules.maxLockResets - this.lockResets });
      }
    }
  }

  private updateLock(): void {
    if (!this.grounded || this.rules.lockResetMode === 'infinite') return;
    this.lockTimer++;
    if (this.lockTimer >= this.currentLockDelay) this.lockPiece();
  }

  private rotate(delta: 1 | 2 | 3): boolean {
    const p = this.active;
    if (!p) return false;
    if (delta === 2 && !this.rules.rotation180) return false;
    const from = p.rotation;
    const to = rotateState(from, delta);
    const tests = kickTests(p.type, from, to);
    for (let i = 0; i < tests.length; i++) {
      const [dx, dy] = tests[i] as readonly [number, number];
      if (!this.collides(p, dx, dy, to)) {
        p.rotation = to;
        p.x += dx;
        p.y += dy;
        this.afterMove();
        this.lastActionRotation = true;
        this.lastKickIndex = i;
        this.dasCutUntil = Math.max(this.dasCutUntil, this.tick + this.handling.dasCutMs);
        this.emit({ type: 'rotate', tick: this.tick, from, to, kick: i });
        return true;
      }
    }
    this.emit({ type: 'rotateFailed', tick: this.tick });
    return false;
  }

  private hardDrop(): void {
    const p = this.active;
    if (!p) return;
    let rows = 0;
    while (!this.collides(p, 0, -1)) {
      p.y--;
      rows++;
    }
    if (rows > 0) this.lastActionRotation = false;
    this.stats.hardDropRows += rows;
    this.score += rows * this.rules.scoring.hardDropPerRow;
    this.pieceVersion++;
    this.emit({ type: 'hardDrop', tick: this.tick, rows, piece: p.type, cells: this.activeCells() });
    this.lockPiece();
  }

  /** Returns true when the hold succeeded (a new piece was spawned). */
  private doHold(): boolean {
    const p = this.active;
    if (!p || !this.rules.holdEnabled) return false;
    if (this.holdUsed && !this.rules.infiniteHold) {
      this.emit({ type: 'holdDenied', tick: this.tick });
      return false;
    }
    const current = p.type;
    const previous = this.hold;
    this.hold = current;
    this.stats.holds++;
    this.active = null;
    // Set before spawning: a buffered hard drop inside spawn() locks and must reset it.
    this.holdUsed = true;
    this.emit({ type: 'hold', tick: this.tick, held: current, swappedIn: previous ?? this.queue.peek(1)[0] ?? current });
    this.spawn(previous, true);
    return true;
  }

  private lockPiece(): void {
    const p = this.active;
    if (!p) return;
    const spin: SpinKind = detectSpin(
      this.board,
      { type: p.type, rotation: p.rotation, x: p.x, y: p.y, lastActionRotation: this.lastActionRotation, lastKickIndex: this.lastKickIndex },
      this.rules.allSpin,
    );
    const cells = this.board.place(p.type, p.rotation, p.x, p.y, pieceCellId(p.type));
    this.active = null;
    this.pieceVersion++;
    this.stats.pieces++;
    this.holdUsed = false;
    this.emit({ type: 'lock', tick: this.tick, piece: p.type, cells, spin });

    if (this.rules.lockOut && cells.every((c) => c.y >= this.board.visibleRows)) {
      if (this.rules.topOut === 'clearBoard') {
        this.board.clear();
        this.emit({ type: 'boardReset', tick: this.tick });
      } else {
        this.gameOver('lockOut');
        return;
      }
    }

    const rows = this.board.fullRows();
    const lines = rows.length;
    const clearedCells: { x: number; y: number; cell: number }[] = [];
    for (const y of rows) {
      for (let x = 0; x < this.board.width; x++) clearedCells.push({ x, y, cell: this.board.get(x, y) });
    }
    this.board.clearRows(rows);
    const perfectClear = lines > 0 && this.board.isEmpty();

    const prevCombo = this.combo;
    this.combo = lines > 0 ? this.combo + 1 : -1;
    if (lines === 0 && prevCombo >= 1) this.emit({ type: 'comboBreak', tick: this.tick, combo: prevCombo });

    const result = scoreClear(
      { lines, spin, level: this.level, backToBackActive: this.backToBackActive, combo: this.combo, perfectClear },
      this.rules.scoring,
    );
    this.score += result.total;

    if (lines > 0) {
      if (isDifficult(lines, spin)) {
        if (this.backToBackActive) this.backToBackCount++;
        else {
          this.backToBackActive = true;
          this.backToBackCount = 0;
        }
      } else {
        this.backToBackActive = false;
        this.backToBackCount = 0;
      }
      this.updateClearStats(lines, spin, perfectClear);
      this.emit({
        type: 'lineClear',
        tick: this.tick,
        rows,
        lines,
        spin,
        kind: result.kind,
        backToBack: result.backToBack,
        backToBackCount: this.backToBackCount,
        combo: this.combo,
        perfectClear,
        score: result,
        clearedCells,
      });
      this.lines += lines;
      this.stats.lines = this.lines;
      this.updateLevel();
    } else if (spin !== 'none') {
      if (spin === 'full') this.stats.tSpins++;
      else this.stats.tSpinMinis++;
      this.emit({ type: 'spinNoLines', tick: this.tick, spin, kind: classifyClear(0, spin), points: result.total });
    }

    const goal = this.rules.goal;
    if (goal.kind === 'lines' && this.lines >= goal.lines) {
      this.complete();
      return;
    }

    this.phase = 'entry';
    this.entryTimer = (lines > 0 ? this.rules.lineClearDelayMs : 0) + this.rules.areMs;
    this.autoShifting = false;
    if (this.entryTimer <= 0) this.spawn(null, false);
  }

  private updateClearStats(lines: number, spin: SpinKind, perfectClear: boolean): void {
    const s = this.stats;
    if (lines === 1) s.singles++;
    else if (lines === 2) s.doubles++;
    else if (lines === 3) s.triples++;
    else if (lines >= 4) s.quads++;
    if (spin === 'full') s.tSpins++;
    else if (spin === 'mini') s.tSpinMinis++;
    if (perfectClear) s.perfectClears++;
    s.maxCombo = Math.max(s.maxCombo, this.combo);
    if (this.backToBackActive) s.maxBackToBack = Math.max(s.maxBackToBack, this.backToBackCount);
  }

  private updateLevel(): void {
    const linesPerLevel = Math.max(1, this.rules.linesPerLevel);
    let target = Math.max(1, this.rules.startLevel) + Math.floor(this.lines / linesPerLevel);
    if (this.rules.maxLevel > 0) target = Math.min(target, this.rules.maxLevel);
    if (target > this.level) {
      this.level = target;
      this.emit({ type: 'levelUp', tick: this.tick, level: target });
    }
  }

  private gameOver(reason: GameOverReason): void {
    this.phase = 'gameOver';
    this.gameOverReason = reason;
    this.active = null;
    this.emit({ type: 'gameOver', tick: this.tick, reason });
  }

  private complete(): void {
    this.phase = 'complete';
    this.active = null;
    this.pieceVersion++;
    this.emit({ type: 'goal', tick: this.tick });
  }
}

const EMPTY_EVENTS: GameEvent[] = [];
