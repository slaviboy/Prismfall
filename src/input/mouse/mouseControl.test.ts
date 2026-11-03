import { describe, expect, it } from 'vitest';
import type { GameAction } from '../../game/core/types';
import { Engine } from '../../game/core/engine';
import { DEFAULT_HANDLING } from '../../game/core/types';
import { makeRules } from '../../game/rules/rules';
import { MouseControl, shiftToward, type MouseControlHost } from './mouseControl';

function engine(): Engine {
  const e = new Engine({ rules: makeRules({ gravity: { kind: 'fixed', gravity: 0 } }), seed: 3, handling: { ...DEFAULT_HANDLING, dasMs: 0, arrMs: 0 } });
  e.start();
  return e;
}

const cols = (e: Engine): number[] => e.activeCells().map((c) => c.x);

/** A host that applies inputs straight to an engine and maps clientX 0..1000 to columns 0..10. */
function setup(): { e: Engine; mouse: MouseControl; sent: GameAction[]; host: MouseControlHost & { isPlaying: boolean } } {
  const e = engine();
  const sent: GameAction[] = [];
  const host = {
    isPlaying: true,
    playing: () => host.isPlaying,
    columnAt: (x: number) => x / 100,
    piece: () => (e.active ? { piece: e.active, serial: e.stats.pieces } : null),
    pending: () => false,
    send: (a: GameAction) => {
      sent.push(a);
      e.press(a);
      e.release(a);
    },
  };
  const mouse = new MouseControl(host);
  mouse.enabled = true;
  return { e, mouse, sent, host };
}

function fakeWindow(): Window & { fire: (type: string, init: Partial<PointerEvent>) => PointerEvent } {
  const handlers = new Map<string, (e: Event) => void>();
  const w = {
    addEventListener: (type: string, h: (e: Event) => void) => handlers.set(type, h),
    removeEventListener: (type: string) => handlers.delete(type),
    fire(type: string, init: Partial<PointerEvent>) {
      let prevented = false;
      const ev = { pointerType: 'mouse', button: 0, timeStamp: 0, target: null, preventDefault: () => (prevented = true), get defaultPrevented() { return prevented; }, ...init } as unknown as PointerEvent;
      handlers.get(type)?.(ev);
      return ev;
    },
  };
  return w as unknown as Window & { fire: (type: string, init: Partial<PointerEvent>) => PointerEvent };
}

describe('shiftToward', () => {
  it('centres each piece under the pointer and clamps at the walls', () => {
    // I piece flat at spawn: cells 3..6.
    expect(shiftToward(5, { type: 'I', rotation: 0, x: 3 })).toBe(0);
    expect(shiftToward(0.2, { type: 'I', rotation: 0, x: 3 })).toBe(-3);
    expect(shiftToward(9.9, { type: 'I', rotation: 0, x: 3 })).toBe(3);
    expect(shiftToward(-4, { type: 'I', rotation: 0, x: 3 })).toBe(-3);
    // O spans two columns (3..4 here); centred on the line between columns 0 and 1 it sits at the wall.
    expect(shiftToward(1, { type: 'O', rotation: 0, x: 3 })).toBe(-3);
    expect(shiftToward(5.4, { type: 'O', rotation: 0, x: 3 })).toBe(1);
  });
});

describe('MouseControl', () => {
  it('moves the piece under the pointer and drops it with a left click', () => {
    const { e, mouse } = setup();
    const w = fakeWindow();
    mouse.attach(w);
    w.fire('pointermove', { clientX: 50, clientY: 300 });
    mouse.sync(0);
    expect(Math.min(...cols(e))).toBe(0);
    const before = e.stats.pieces;
    w.fire('pointerdown', { clientX: 950, clientY: 300, button: 0 });
    expect(e.stats.pieces).toBe(before + 1); // dropped, after lining up on the right
    expect(e.board.get(9, 0) || e.board.get(9, 1)).toBeGreaterThan(0);
  });

  it('rotates on right click, holds on middle click and blocks the context menu while playing', () => {
    const { e, mouse, sent } = setup();
    const w = fakeWindow();
    mouse.attach(w);
    const r0 = e.active!.rotation;
    w.fire('pointerdown', { clientX: 500, button: 2 });
    expect(sent).toContain('rotateCW');
    expect(e.active!.rotation).toBe((r0 + 1) % 4);
    w.fire('pointerdown', { clientX: 500, button: 1 });
    expect(sent).toContain('hold');
    expect(w.fire('contextmenu', {}).defaultPrevented).toBe(true);
  });

  it('does nothing when disabled, outside play, or on interface buttons', () => {
    const { mouse, sent, host } = setup();
    const w = fakeWindow();
    mouse.attach(w);
    mouse.enabled = false;
    w.fire('pointerdown', { button: 0 });
    mouse.enabled = true;
    host.isPlaying = false;
    w.fire('pointerdown', { button: 0 });
    expect(w.fire('contextmenu', {}).defaultPrevented).toBe(false);
    host.isPlaying = true;
    const button = { closest: () => ({}) };
    w.fire('pointerdown', { button: 0, target: button as unknown as EventTarget });
    expect(sent).toEqual([]);
  });

  it('stops steering when another device is used, and does not retry a blocked move every frame', () => {
    const { mouse, sent } = setup();
    const w = fakeWindow();
    mouse.attach(w);
    w.fire('pointermove', { clientX: 0, clientY: 0 });
    mouse.sync(0);
    const n = sent.length;
    mouse.sync(1);
    expect(sent.length).toBe(n);
    mouse.yieldToOtherDevice();
    w.fire('pointermove', { clientX: 900, clientY: 0 });
    mouse.yieldToOtherDevice();
    mouse.sync(2);
    expect(sent.length).toBe(n);
  });
});
