import { describe, expect, it } from 'vitest';
import { DEFAULT_GAMEPAD, DEFAULT_KEYBOARD, type InputAction } from '../settings/schema';
import { GamepadSource, applyRadialDeadzone, detectFamily, friendlyPadName, hatDirections, DEFAULT_TUNING } from './gamepad/gamepadSource';
import { KeyboardSource } from './keyboard/keyboardSource';
import { assignBinding, buildLookup, clearBinding, controlLabel, findConflicts } from './mappings/bindings';
import { InputManager } from './inputManager';
import type { ActionEvent, RawInputEvent } from './types';

interface FakeButton { pressed: boolean; touched: boolean; value: number }
interface FakePad {
  id: string; index: number; connected: boolean; mapping: GamepadMappingType; timestamp: number;
  buttons: FakeButton[]; axes: number[];
}

function fakePad(index: number, id = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', mapping: GamepadMappingType = 'standard'): FakePad {
  return { id, index, connected: true, mapping, timestamp: 0, buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), axes: [0, 0, 0, 0] };
}

function press(pad: FakePad, i: number, value = 1): void {
  pad.buttons[i] = { pressed: value > 0.5, touched: value > 0, value };
}

describe('bindings', () => {
  it('builds per-context lookups', () => {
    const kb = buildLookup(DEFAULT_KEYBOARD, 'keyboard', 'gameplay');
    expect(kb.get('Space')).toEqual(['hardDrop']);
    expect(kb.get('Escape')).toEqual(['pause']);
    const menu = buildLookup(DEFAULT_KEYBOARD, 'keyboard', 'menu');
    expect(menu.get('Escape')).toContain('back');
    expect(menu.get('ArrowUp')).toEqual(['up']);
    const pad = buildLookup(DEFAULT_GAMEPAD, 'gamepad', 'menu', true);
    expect(pad.get('button:1')).toContain('confirm'); // swapped
  });

  it('detects conflicts only within the same context', () => {
    expect(findConflicts(DEFAULT_KEYBOARD, 'hold', 'Space')).toEqual(['hardDrop']);
    expect(findConflicts(DEFAULT_KEYBOARD, 'confirm', 'Space')).toEqual([]); // menu vs gameplay
  });

  it('replaces or swaps conflicting bindings', () => {
    const replaced = assignBinding(DEFAULT_KEYBOARD, 'hold', 0, 'Space', 'replace');
    expect(replaced.hold[0]).toBe('Space');
    expect(replaced.hardDrop).toEqual([]);
    const swapped = assignBinding(DEFAULT_KEYBOARD, 'hold', 0, 'Space', 'swap');
    expect(swapped.hold[0]).toBe('Space');
    expect(swapped.hardDrop).toEqual(['KeyC']);
    expect(swapped.hold.length).toBeLessThanOrEqual(2);
  });

  it('replaces the chosen slot and swaps within an action', () => {
    expect(assignBinding(DEFAULT_KEYBOARD, 'hardDrop', 0, 'KeyW').hardDrop).toEqual(['KeyW']);
    const two = assignBinding(DEFAULT_KEYBOARD, 'rotateCW', 1, 'KeyV').rotateCW;
    expect(two).toEqual(['ArrowUp', 'KeyV']);
    const swapped = assignBinding(DEFAULT_KEYBOARD, 'rotateCW', 0, 'KeyX').rotateCW;
    expect(swapped).toEqual(['KeyX', 'ArrowUp']);
    expect(assignBinding(DEFAULT_KEYBOARD, 'hardDrop', 1, 'KeyW').hardDrop).toEqual(['Space', 'KeyW']);
  });

  it('refuses to leave required actions unbound', () => {
    const one = { ...DEFAULT_KEYBOARD, pause: ['KeyP'] } as Record<InputAction, string[]>;
    expect(clearBinding(one, 'pause', 0)).toBeNull();
    expect(clearBinding(DEFAULT_KEYBOARD, 'hold', 0)?.hold).toEqual(['ShiftLeft']);
  });

  it('labels controls per controller family', () => {
    expect(controlLabel('button:0', 'playstation')).toBe('Cross');
    expect(controlLabel('button:0', 'xbox')).toBe('A');
    expect(controlLabel('axis:0:-')).toBe('Left Stick Left');
    expect(controlLabel('KeyZ')).toBe('Z');
  });
});

describe('gamepad source', () => {
  it('recognizes controller families, including XInput ids without vendor ids', () => {
    expect(detectFamily('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)')).toBe('playstation');
    expect(detectFamily('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe('playstation');
    expect(detectFamily('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe('xbox');
    expect(detectFamily('USB Joystick (Vendor: 0079 Product: 0006)')).toBe('generic');
    expect(friendlyPadName('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe('DualSense');
  });

  it('applies a rescaled radial dead zone', () => {
    expect(applyRadialDeadzone(0.1, 0.1, 0.2, 0.95)).toEqual([0, 0]);
    const [x] = applyRadialDeadzone(1, 0, 0.2, 0.95);
    expect(x).toBeCloseTo(1);
    const [hx] = applyRadialDeadzone(0.575, 0, 0.2, 0.95);
    expect(hx).toBeCloseTo(0.5);
  });

  it('decodes hat switches', () => {
    expect(hatDirections(-1)).toEqual({ up: true, down: false, left: false, right: false });
    expect(hatDirections(-0.4286).right).toBe(true);
    expect(hatDirections(3.28)).toEqual({ up: false, down: false, left: false, right: false });
  });

  it('reports presses, stick directions with hysteresis, and releases on disconnect', () => {
    const pads: (FakePad | null)[] = [fakePad(0)];
    const events: RawInputEvent[] = [];
    const conns: boolean[] = [];
    const src = new GamepadSource((e) => events.push(e), (_p, c) => conns.push(c), () => pads as unknown as Gamepad[]);
    src.poll(10);
    expect(conns).toEqual([true]);
    press(pads[0]!, 0);
    src.poll(20);
    expect(events.at(-1)).toMatchObject({ control: 'button:0', down: true });
    pads[0]!.axes[0] = -0.9;
    src.poll(30);
    expect(events.at(-1)).toMatchObject({ control: 'axis:0:-', down: true });
    pads[0]!.axes[0] = -0.55; // rescaled ~0.44: still held thanks to hysteresis
    src.poll(40);
    expect(events.filter((e) => e.control === 'axis:0:-')).toHaveLength(1);
    pads[0] = null; // unplugged while button 0 and stick are held
    src.poll(50);
    expect(conns).toEqual([true, false]);
    const releases = events.filter((e) => !e.down).map((e) => e.control).sort();
    expect(releases).toEqual(['axis:0:-', 'button:0']);
  });

  it('uses the analog trigger threshold', () => {
    const pads = [fakePad(0)];
    const events: RawInputEvent[] = [];
    const src = new GamepadSource((e) => events.push(e), () => undefined, () => pads as unknown as Gamepad[]);
    src.tuning = { ...DEFAULT_TUNING, triggerThreshold: 0.5 };
    src.poll();
    press(pads[0]!, 7, 0.3);
    src.poll();
    expect(events).toHaveLength(0);
    press(pads[0]!, 7, 0.6);
    src.poll();
    expect(events.at(-1)).toMatchObject({ control: 'button:7', down: true });
  });

  it('maps non-standard pads through a profile (hat d-pad)', () => {
    const pad = fakePad(0, 'Generic USB Gamepad (Vendor: 0810 Product: 0001)', '');
    pad.axes = [0, 0, 0, 0, 0, 0, 0, 0, 0, 3.28];
    const pads = [pad];
    const events: RawInputEvent[] = [];
    const src = new GamepadSource((e) => events.push(e), () => undefined, () => pads as unknown as Gamepad[]);
    src.tuning = { ...DEFAULT_TUNING, profiles: { [pad.id]: { rawMap: { 'button:0': 'button:2', 'button:14': 'hat:9:left' } } } };
    src.poll();
    press(pad, 2);
    pad.axes[9] = 0.714; // hat left
    src.poll();
    const downs = events.filter((e) => e.down).map((e) => e.control).sort();
    expect(downs).toEqual(['button:0', 'button:14']);
  });

  it('only listens to the active pad when one is selected', () => {
    const pads = [fakePad(0, 'pad-a'), fakePad(1, 'pad-b')];
    const events: RawInputEvent[] = [];
    const src = new GamepadSource((e) => events.push(e), () => undefined, () => pads as unknown as Gamepad[]);
    src.tuning = { ...DEFAULT_TUNING, activePadId: 'pad-b' };
    press(pads[0]!, 0);
    press(pads[1]!, 1);
    src.poll();
    expect(events.map((e) => e.pad)).toEqual([1]);
  });
});

describe('input manager', () => {
  function manager(): { im: InputManager; game: ActionEvent[]; menu: ActionEvent[]; pads: FakePad[] } {
    const im = new InputManager();
    const pads = [fakePad(0)];
    // Swap in a fake gamepad source reading our fake pads.
    (im as unknown as { gamepad: GamepadSource }).gamepad = new GamepadSource(
      (e) => (im as unknown as { handleRaw(e: RawInputEvent): void }).handleRaw(e),
      () => undefined,
      () => pads as unknown as Gamepad[],
    );
    im.setBindings(DEFAULT_KEYBOARD, DEFAULT_GAMEPAD, false);
    const game: ActionEvent[] = [];
    const menu: ActionEvent[] = [];
    im.onGameplay((e) => game.push(e));
    im.onMenu((e) => menu.push(e));
    return { im, game, menu, pads };
  }

  function key(im: InputManager, code: string, down: boolean, time = 0): void {
    (im as unknown as { handleRaw(e: RawInputEvent): void }).handleRaw({ device: 'keyboard', pad: -1, control: code, down, time });
  }

  it('routes by context', () => {
    const { im, game, menu } = manager();
    im.setContext('gameplay');
    key(im, 'Space', true, 5);
    key(im, 'Space', false, 9);
    expect(game.map((e) => [e.action, e.down, e.time])).toEqual([['hardDrop', true, 5], ['hardDrop', false, 9]]);
    im.setContext('menu');
    key(im, 'Enter', true);
    expect(menu.at(-1)?.action).toBe('confirm');
  });

  it('merges multiple controls bound to one action (keyboard + gamepad simultaneously)', () => {
    const { im, game, pads } = manager();
    im.setContext('gameplay');
    key(im, 'ArrowLeft', true);
    press(pads[0]!, 14);
    im.poll();
    key(im, 'ArrowLeft', false);
    expect(game.filter((e) => e.action === 'moveLeft')).toHaveLength(1); // still held via d-pad
    pads[0]!.buttons[14] = { pressed: false, touched: false, value: 0 };
    im.poll();
    expect(game.filter((e) => e.action === 'moveLeft').map((e) => e.down)).toEqual([true, false]);
  });

  it('releases held actions on context switch and supports capture mode', () => {
    const { im, game } = manager();
    im.setContext('gameplay');
    key(im, 'ArrowDown', true);
    im.setContext('menu');
    expect(game.at(-1)).toMatchObject({ action: 'softDrop', down: false });
    const captured: string[] = [];
    im.beginCapture((e) => captured.push(e.control));
    key(im, 'KeyJ', true);
    im.endCapture();
    expect(captured).toEqual(['KeyJ']);
  });

  it('keyboard source ignores OS repeat and releases keys on focus loss', () => {
    const raws: RawInputEvent[] = [];
    let lost = 0;
    const src = new KeyboardSource((e) => raws.push(e), () => lost++);
    const target = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
    src.attach(target, doc);
    const kev = (type: string, code: string, repeat = false) => {
      const ev = Object.assign(new Event(type), { code, repeat });
      Object.defineProperty(ev, 'timeStamp', { value: 12 });
      return ev;
    };
    target.dispatchEvent(kev('keydown', 'KeyZ'));
    target.dispatchEvent(kev('keydown', 'KeyZ', true));
    expect(raws).toHaveLength(1);
    target.dispatchEvent(new Event('blur'));
    expect(lost).toBe(1);
    expect(raws.at(-1)).toMatchObject({ control: 'KeyZ', down: false });
    src.detach();
  });
});
