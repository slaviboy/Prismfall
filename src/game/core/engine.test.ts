import { describe, expect, it } from 'vitest';
import { choosePlacement } from '../ai/bot';
import { buildModeRules } from '../modes/modes';
import { GAME_ACTIONS, type GameAction, type GameEvent } from './types';
import { Engine } from './engine';
import { makeRules, type RuleConfig } from '../rules/rules';
import { Rng } from '../random/rng';
import { detectSpin } from '../rules/spin';
import { GameRunner } from '../simulation/runner';
import { simulateReplay, serializeReplay, deserializeReplay } from '../simulation/replay';
import { DEFAULT_HANDLING } from './types';

function engine(rules: Partial<RuleConfig> = {}, seed = 1, handling = DEFAULT_HANDLING): Engine {
  const e = new Engine({ rules: makeRules({ gravity: { kind: 'fixed', gravity: 0 }, ...rules }), seed, handling });
  e.start();
  return e;
}

function tap(e: Engine, action: GameAction): void {
  e.press(action);
  e.release(action);
}

function minX(e: Engine): number {
  return Math.min(...e.activeCells().map((c) => c.x));
}

function collect(e: Engine): GameEvent[] {
  return e.drainEvents();
}

/** Lets the AI play `pieces` placements directly on the engine. */
function autoplay(e: Engine, pieces: number): void {
  for (let i = 0; i < pieces && !e.isOver; i++) {
    const p = choosePlacement(e);
    if (!p) break;
    if (p.useHold) tap(e, 'hold');
    for (const a of p.actions) tap(e, a);
    while (!e.active && !e.isOver) e.step();
  }
}

describe('spawning', () => {
  it('spawns the first piece in the guideline position, dropped one row', () => {
    const e = engine();
    const p = e.active!;
    expect(p).not.toBeNull();
    const cells = e.activeCells();
    expect(Math.min(...cells.map((c) => c.y))).toBe(19);
    if (p.type === 'O') expect(minX(e)).toBe(4);
    else expect(minX(e)).toBe(3);
  });

  it('deals pieces in preview order', () => {
    const e = engine();
    const preview = e.preview(5);
    for (const expected of preview) {
      tap(e, 'hardDrop');
      expect(e.active!.type).toBe(expected);
    }
  });
});

describe('movement and collision boundaries', () => {
  it('stops at both walls', () => {
    const e = engine();
    for (let i = 0; i < 12; i++) tap(e, 'moveLeft');
    expect(minX(e)).toBe(0);
    for (let i = 0; i < 12; i++) tap(e, 'moveRight');
    expect(Math.max(...e.activeCells().map((c) => c.x))).toBe(9);
  });

  it('emits shiftBlocked on a tap into a wall', () => {
    const e = engine();
    for (let i = 0; i < 12; i++) tap(e, 'moveLeft');
    collect(e);
    tap(e, 'moveLeft');
    expect(collect(e).some((ev) => ev.type === 'shiftBlocked')).toBe(true);
  });

  it('respects DAS and ARR timing to the millisecond', () => {
    const e = engine({}, 1, { ...DEFAULT_HANDLING, dasMs: 100, arrMs: 20 });
    const x0 = e.active!.x;
    e.press('moveRight');
    expect(e.active!.x).toBe(x0 + 1); // tap
    e.advanceTo(99);
    expect(e.active!.x).toBe(x0 + 1);
    e.advanceTo(100);
    expect(e.active!.x).toBe(x0 + 2); // first auto shift exactly at DAS
    e.advanceTo(119);
    expect(e.active!.x).toBe(x0 + 2);
    e.advanceTo(120);
    expect(e.active!.x).toBe(x0 + 3);
    e.release('moveRight');
    e.advanceTo(400);
    expect(e.active!.x).toBe(x0 + 3);
  });

  it('ARR 0 shifts to the wall once DAS charges', () => {
    const e = engine({}, 1, { ...DEFAULT_HANDLING, dasMs: 50, arrMs: 0 });
    e.press('moveLeft');
    e.advanceTo(50);
    expect(minX(e)).toBe(0);
  });

  it('nudges move exactly one cell, even with DAS and ARR at 0', () => {
    const e = engine({}, 1, { ...DEFAULT_HANDLING, dasMs: 0, arrMs: 0 });
    const x0 = e.active!.x;
    tap(e, 'nudgeRight');
    tap(e, 'nudgeRight');
    expect(e.active!.x).toBe(x0 + 2);
    tap(e, 'nudgeLeft');
    e.advanceTo(300);
    expect(e.active!.x).toBe(x0 + 1);
    for (let i = 0; i < 12; i++) tap(e, 'nudgeLeft');
    collect(e);
    tap(e, 'nudgeLeft');
    expect(minX(e)).toBe(0);
    expect(collect(e).some((ev) => ev.type === 'shiftBlocked')).toBe(true);
  });

  it('last pressed direction wins and releasing it falls back to the other', () => {
    const e = engine({}, 1, { ...DEFAULT_HANDLING, dasMs: 50, arrMs: 10 });
    const x0 = e.active!.x;
    e.press('moveLeft');
    e.press('moveRight');
    expect(e.active!.x).toBe(x0); // left then right tap
    e.advanceTo(50);
    expect(e.active!.x).toBe(x0 + 1);
    e.release('moveRight');
    const x1 = e.active!.x;
    e.advanceTo(100);
    expect(e.active!.x).toBe(x1 - 1); // DAS restarted for left
  });

  it('preserves DAS charge into the next piece', () => {
    const e = engine({ areMs: 100 }, 1, { ...DEFAULT_HANDLING, dasMs: 50, arrMs: 0 });
    tap(e, 'hardDrop');
    e.press('moveLeft');
    e.advanceTo(e.tick + 101);
    expect(e.active).not.toBeNull();
    expect(minX(e)).toBe(0);
  });
});

describe('rotation', () => {
  it('rotates T through all four states and back', () => {
    const e = engine({ randomizer: { kind: 'drill', pieces: ['T'] } });
    for (let r = 1; r <= 4; r++) {
      tap(e, 'rotateCW');
      expect(e.active!.rotation).toBe(r % 4);
    }
    tap(e, 'rotateCCW');
    expect(e.active!.rotation).toBe(3);
  });

  it('kicks I off the left wall', () => {
    const e = engine({ randomizer: { kind: 'drill', pieces: ['I'] } });
    tap(e, 'rotateCW'); // vertical
    for (let i = 0; i < 6; i++) tap(e, 'moveLeft');
    expect(minX(e)).toBe(0);
    collect(e);
    tap(e, 'rotateCW'); // back to horizontal needs a kick
    const rot = collect(e).find((ev) => ev.type === 'rotate');
    expect(rot && rot.type === 'rotate' && rot.kick).toBeGreaterThan(0);
    expect(minX(e)).toBe(0);
  });

  it('180° rotation only works when enabled', () => {
    const off = engine({ randomizer: { kind: 'drill', pieces: ['T'] } });
    tap(off, 'rotate180');
    expect(off.active!.rotation).toBe(0);
    const on = engine({ randomizer: { kind: 'drill', pieces: ['T'] }, rotation180: true });
    tap(on, 'rotate180');
    expect(on.active!.rotation).toBe(2);
  });

  it('O never moves when rotated', () => {
    const e = engine({ randomizer: { kind: 'drill', pieces: ['O'] } });
    const before = e.activeCells();
    tap(e, 'rotateCW');
    expect(e.activeCells()).toEqual(before);
  });
});

describe('gravity, drops and locking', () => {
  it('falls one row per second at level 1 guideline gravity', () => {
    const e = engine({ gravity: { kind: 'guideline' } });
    const y0 = e.active!.y;
    e.advanceTo(999);
    expect(e.active!.y).toBe(y0);
    e.advanceTo(1001);
    expect(e.active!.y).toBe(y0 - 1);
  });

  it('soft drop multiplies gravity and scores 1 point per row', () => {
    const e = engine({ gravity: { kind: 'guideline' } }, 1, { ...DEFAULT_HANDLING, softDropFactor: 20 });
    const y0 = e.active!.y;
    e.press('softDrop');
    // Fixed-point level-1 gravity is 16777/2^24 rows/ms, so 20× takes 50.0006 ms per row.
    e.advanceTo(499);
    expect(y0 - e.active!.y).toBe(9);
    e.advanceTo(501);
    expect(y0 - e.active!.y).toBe(10);
    expect(e.score).toBe(10);
  });

  it('hard drop lands on the ghost row, scores 2 per row and locks immediately', () => {
    const e = engine();
    const ghost = e.ghostY();
    const rows = e.active!.y - ghost;
    const type = e.active!.type;
    tap(e, 'hardDrop');
    expect(e.score).toBe(rows * 2);
    expect(e.stats.pieces).toBe(1);
    expect(e.board.filledCount()).toBe(4);
    expect(e.active!.type).not.toBe(undefined);
    expect(collect(e).find((ev) => ev.type === 'lock' && ev.piece === type)).toBeTruthy();
  });

  it('locks after the lock delay once grounded', () => {
    const e = engine({ gravity: { kind: 'guideline' } }, 1, { ...DEFAULT_HANDLING, softDropFactor: Infinity });
    e.press('softDrop');
    e.release('softDrop');
    expect(e.isGrounded).toBe(true);
    const t = e.tick;
    e.advanceTo(t + 499);
    expect(e.stats.pieces).toBe(0);
    e.advanceTo(t + 500);
    expect(e.stats.pieces).toBe(1);
  });

  it('move resets the lock timer at most 15 times', () => {
    const e = engine({}, 1, { ...DEFAULT_HANDLING, softDropFactor: Infinity });
    e.press('softDrop');
    e.release('softDrop');
    for (let i = 0; i < 15; i++) {
      e.advanceTo(e.tick + 400);
      tap(e, i % 2 === 0 ? 'moveLeft' : 'moveRight');
    }
    expect(e.stats.pieces).toBe(0);
    expect(e.lockResetsRemaining).toBe(0);
    const t = e.tick;
    e.advanceTo(t + 300);
    tap(e, 'moveLeft'); // no further reset
    e.advanceTo(t + 500);
    expect(e.stats.pieces).toBe(1);
  });

  it('infinite lock never locks without a hard drop', () => {
    const e = engine({ lockResetMode: 'infinite' }, 1, { ...DEFAULT_HANDLING, softDropFactor: Infinity });
    e.press('softDrop');
    e.advanceTo(20000);
    expect(e.stats.pieces).toBe(0);
    tap(e, 'hardDrop');
    expect(e.stats.pieces).toBe(1);
  });

  it('20G drops pieces straight to the floor on spawn', () => {
    const e = engine({ gravity: { kind: 'fixed', gravity: 20132659 } });
    expect(e.isGrounded).toBe(true);
    expect(Math.min(...e.activeCells().map((c) => c.y))).toBe(0);
  });
});

describe('hold', () => {
  it('holds into an empty slot, then swaps, once per piece', () => {
    const e = engine();
    const first = e.active!.type;
    const next = e.preview(1)[0];
    tap(e, 'hold');
    expect(e.hold).toBe(first);
    expect(e.active!.type).toBe(next);
    collect(e);
    tap(e, 'hold');
    expect(collect(e).some((ev) => ev.type === 'holdDenied')).toBe(true);
    expect(e.active!.type).toBe(next);
    tap(e, 'hardDrop');
    tap(e, 'hold');
    expect(e.active!.type).toBe(first);
  });

  it('can be disabled or made infinite by rules', () => {
    const off = engine({ holdEnabled: false });
    const t = off.active!.type;
    tap(off, 'hold');
    expect(off.active!.type).toBe(t);
    const inf = engine({ infiniteHold: true });
    tap(inf, 'hold');
    tap(inf, 'hold');
    tap(inf, 'hold');
    expect(inf.stats.holds).toBe(3);
  });

  it('applies buffered initial hold at spawn', () => {
    const e = engine({ areMs: 200 });
    tap(e, 'hardDrop');
    expect(e.active).toBeNull();
    const upcoming = e.preview(1)[0];
    tap(e, 'hold');
    e.advanceTo(e.tick + 201);
    expect(e.hold).toBe(upcoming);
  });
});

describe('line clears, spins and scoring', () => {
  it('clears a QUAD with an I piece', () => {
    const e = engine({ randomizer: { kind: 'drill', pieces: ['I'] } });
    e.board.loadRows(['XXXXXXXXX.', 'XXXXXXXXX.', 'XXXXXXXXX.', 'XXXXXXXXX.']);
    tap(e, 'rotateCW');
    for (let i = 0; i < 6; i++) tap(e, 'moveRight');
    collect(e);
    tap(e, 'hardDrop');
    const clear = collect(e).find((ev) => ev.type === 'lineClear');
    expect(clear && clear.type === 'lineClear' && clear.kind).toBe('quad');
    expect(clear && clear.type === 'lineClear' && clear.perfectClear).toBe(true);
    expect(e.lines).toBe(4);
    expect(e.board.isEmpty()).toBe(true);
  });

  it('detects a T-spin double with the 3-corner rule', () => {
    const e = engine({ randomizer: { kind: 'drill', pieces: ['T'] } });
    e.board.loadRows(['...X......', 'XXX...XXXX', 'XXXX.XXXXX']);
    e.active = { type: 'T', rotation: 1, x: 3, y: 0 };
    collect(e);
    tap(e, 'rotateCW');
    tap(e, 'hardDrop');
    const clear = collect(e).find((ev) => ev.type === 'lineClear');
    expect(clear?.type === 'lineClear' && clear.kind).toBe('tspinDouble');
    expect(clear?.type === 'lineClear' && clear.score.total).toBe(1200);
  });

  it('classifies minis and upgrades kick-5 rotations to full spins', () => {
    const e = engine();
    e.board.loadRows(['X.........', '..........', 'X.X.......']);
    const ctx = { type: 'T' as const, rotation: 0 as const, x: 0, y: 0, lastActionRotation: true };
    expect(detectSpin(e.board, { ...ctx, lastKickIndex: 0 }, false)).toBe('mini');
    expect(detectSpin(e.board, { ...ctx, lastKickIndex: 4 }, false)).toBe('full');
    expect(detectSpin(e.board, { ...ctx, lastKickIndex: 0, lastActionRotation: false }, false)).toBe('none');
  });

  it('tracks combos and back-to-back', () => {
    const e = engine({ randomizer: { kind: 'drill', pieces: ['I'] } });
    e.board.loadRows([
      'XXXXXXXXX.', 'XXXXXXXXX.', 'XXXXXXXXX.', 'XXXXXXXXX.',
      'XXXXXXXXX.', 'XXXXXXXXX.', 'XXXXXXXXX.', 'XXXXXXXXX.',
    ]);
    const drop = (): GameEvent[] => {
      tap(e, 'rotateCW');
      for (let i = 0; i < 6; i++) tap(e, 'moveRight');
      collect(e);
      tap(e, 'hardDrop');
      return collect(e);
    };
    const first = drop().find((ev) => ev.type === 'lineClear');
    const second = drop().find((ev) => ev.type === 'lineClear');
    expect(first?.type === 'lineClear' && first.backToBack).toBe(false);
    expect(second?.type === 'lineClear' && second.backToBack).toBe(true);
    expect(second?.type === 'lineClear' && second.combo).toBe(1);
    // 800 + (1200 + 50*1) + PC (B2B quad PC 3200)
    expect(e.stats.quads).toBe(2);
    expect(e.combo).toBe(1);
    tap(e, 'hardDrop');
    expect(e.combo).toBe(-1);
  });

  it('levels up every 10 lines', () => {
    const e = engine({ randomizer: { kind: 'drill', pieces: ['I'] } });
    const events: GameEvent[] = [];
    for (let i = 0; i < 3; i++) {
      e.board.loadRows(['XXXXXXXXX.', 'XXXXXXXXX.', 'XXXXXXXXX.', 'XXXXXXXXX.']);
      tap(e, 'rotateCW');
      for (let j = 0; j < 6; j++) tap(e, 'moveRight');
      tap(e, 'hardDrop');
      events.push(...collect(e));
    }
    expect(e.lines).toBe(12);
    expect(e.level).toBe(2);
    expect(events.some((ev) => ev.type === 'levelUp' && ev.level === 2)).toBe(true);
  });
});

describe('game over and modes', () => {
  it('ends with block-out when the spawn area is filled', () => {
    const e = engine();
    for (let y = 18; y < 23; y++) for (let x = 0; x < 10; x++) if (x !== 0) e.board.set(x, y, 8);
    tap(e, 'hardDrop');
    for (let i = 0; i < 5 && !e.isOver; i++) tap(e, 'hardDrop');
    expect(e.phase).toBe('gameOver');
    expect(collect(e).some((ev) => ev.type === 'gameOver')).toBe(true);
  });

  it('Zen clears the board on top-out instead of ending', () => {
    const e = new Engine({ rules: buildModeRules('zen', 'still', { gravity: { kind: 'fixed', gravity: 0 } }), seed: 3 });
    e.start();
    for (let y = 0; y < 22; y++) for (let x = 1; x < 10; x++) e.board.set(x, y, 8);
    for (let i = 0; i < 4; i++) tap(e, 'hardDrop');
    expect(e.isOver).toBe(false);
    expect(collect(e).some((ev) => ev.type === 'boardReset')).toBe(true);
  });

  it('Ultra completes when its time goal elapses', () => {
    const e = new Engine({ rules: buildModeRules('ultra', '120', { gravity: { kind: 'fixed', gravity: 0 } }), seed: 3 });
    e.start();
    e.advanceTo(120_000);
    expect(e.phase).toBe('complete');
  });

  it('the AI completes a 40-line Sprint', () => {
    const e = new Engine({ rules: buildModeRules('sprint', '40'), seed: 11 });
    e.start();
    autoplay(e, 400);
    expect(e.phase).toBe('complete');
    expect(e.lines).toBeGreaterThanOrEqual(40);
  });

  it('restarting with the same seed reproduces the sequence', () => {
    const a = engine({}, 77);
    const b = engine({}, 77);
    expect(a.active!.type).toBe(b.active!.type);
    expect(a.preview(6)).toEqual(b.preview(6));
  });
});

describe('runner: timestamps, pause and replays', () => {
  const opts = { rules: buildModeRules('marathon', '150'), seed: 2024, handling: DEFAULT_HANDLING, modeId: 'marathon', variantId: '150' };

  it('applies inputs at their timestamp tick, independent of frame timing', () => {
    const r = new GameRunner(opts);
    r.start(1000);
    r.enqueue('moveLeft', true, 1010.4);
    r.update(1100);
    // The tap happened at tick 10, DAS has not elapsed by tick 100.
    const x = r.engine.active!.x;
    r.enqueue('moveLeft', false, 1100);
    r.update(1150);
    expect(r.engine.active!.x).toBe(x);
  });

  it('clamps late inputs and shifts the time base on long hitches', () => {
    const r = new GameRunner(opts);
    r.start(0);
    r.update(50);
    r.enqueue('hardDrop', true, 10); // stamped before the last simulated tick
    r.update(5000); // 5 s hitch: only 100 ms simulated
    expect(r.engine.stats.pieces).toBe(1);
    expect(r.engine.tick).toBe(150);
  });

  it('does not advance while paused and ignores inputs during pause', () => {
    const r = new GameRunner(opts);
    r.start(0);
    r.update(100);
    r.pause(100);
    r.enqueue('hardDrop', true, 200);
    r.update(10_000);
    expect(r.engine.tick).toBe(100);
    expect(r.engine.stats.pieces).toBe(0);
    r.resume(10_000);
    r.update(10_050);
    expect(r.engine.tick).toBe(150);
  });

  it('replays reproduce the exact final state', () => {
    const r = new GameRunner(opts);
    r.start(0);
    let now = 0;
    const rng = new Rng(9);
    for (let i = 0; i < 120 && !r.engine.isOver; i++) {
      const p = choosePlacement(r.engine);
      if (!p) break;
      const actions: GameAction[] = p.useHold ? ['hold', ...p.actions] : [...p.actions];
      for (const a of actions) {
        now += 5 + rng.nextInt(40);
        r.enqueue(a, true, now);
        r.enqueue(a, false, now + 3);
        now += 4;
        r.update(now);
      }
      if (i === 30) r.setLevel(4);
      now += 30;
      r.update(now);
    }
    const replay = deserializeReplay(serializeReplay(r.exportReplay()));
    const replayed = simulateReplay(replay);
    expect(replayed.stateHash()).toBe(replay.finalHash);
    expect(replayed.score).toBe(r.engine.score);
    expect(replayed.lines).toBe(r.engine.lines);
  });
});

describe('fuzz invariants', () => {
  it('never corrupts the board under random input for 200k ticks', () => {
    for (const seed of [1, 2, 3]) {
      const e = new Engine({ rules: buildModeRules('zen', 'flowing'), seed, handling: { ...DEFAULT_HANDLING, dasMs: 60, arrMs: 5 } });
      e.start();
      const rng = new Rng(seed * 31);
      let resets = 0;
      let clearedCells = 0;
      let lockedCells = 0;
      let cellsAtReset = 0;
      for (let t = 0; t < 200_000; t++) {
        if (rng.nextInt(12) === 0) {
          const action = GAME_ACTIONS[rng.nextInt(GAME_ACTIONS.length)] as GameAction;
          if (rng.nextInt(3) === 0) e.release(action);
          else e.press(action);
        }
        e.step();
        for (const ev of e.drainEvents()) {
          if (ev.type === 'lock') lockedCells += ev.cells.length;
          if (ev.type === 'lineClear') clearedCells += ev.lines * 10;
          if (ev.type === 'boardReset') {
            resets++;
            cellsAtReset = lockedCells - clearedCells;
            lockedCells = 0;
            clearedCells = 0;
          }
        }
        const p = e.active;
        if (p) expect(e.board.collides(p.type, p.rotation, p.x, p.y)).toBe(false);
      }
      void cellsAtReset;
      if (resets === 0) expect(e.board.filledCount()).toBe(lockedCells - clearedCells);
      expect(e.isOver).toBe(false);
    }
  });
});
