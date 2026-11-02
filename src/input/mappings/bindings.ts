import { INPUT_ACTIONS, type InputAction } from '../../settings/schema';
import type { InputContext, InputDevice, MenuAction } from '../types';

export type Bindings = Readonly<Record<InputAction, readonly string[]>>;

export const GAMEPLAY_ACTIONS: readonly InputAction[] = ['moveLeft', 'moveRight', 'softDrop', 'hardDrop', 'rotateCW', 'rotateCCW', 'rotate180', 'hold', 'pause', 'practiceUndo', 'practiceReset'];
export const MENU_BINDABLE: readonly InputAction[] = ['confirm', 'back'];
/** Actions that must always keep at least one binding so the player can't lock themselves out. */
export const REQUIRED_ACTIONS: readonly InputAction[] = ['pause', 'confirm', 'back'];

export const ACTION_LABELS: Record<InputAction, string> = {
  moveLeft: 'Move Left',
  moveRight: 'Move Right',
  softDrop: 'Soft Drop',
  hardDrop: 'Hard Drop',
  rotateCW: 'Rotate Clockwise',
  rotateCCW: 'Rotate Counter-clockwise',
  rotate180: 'Rotate 180°',
  hold: 'Hold',
  pause: 'Pause',
  practiceUndo: 'Practice: Undo',
  practiceReset: 'Practice: Reset Board',
  confirm: 'Confirm',
  back: 'Back',
};

/** Fixed menu navigation controls (in addition to bindable confirm/back). */
export const MENU_KEYS: Record<Exclude<MenuAction, 'confirm' | 'back'>, readonly string[]> = {
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  tabPrev: ['KeyQ', 'PageUp'],
  tabNext: ['KeyE', 'PageDown'],
};

export const MENU_PAD: Record<Exclude<MenuAction, 'confirm' | 'back'>, readonly string[]> = {
  up: ['button:12', 'axis:1:-'],
  down: ['button:13', 'axis:1:+'],
  left: ['button:14', 'axis:0:-'],
  right: ['button:15', 'axis:0:+'],
  tabPrev: ['button:4'],
  tabNext: ['button:5'],
};

export function actionContext(action: InputAction): InputContext {
  return MENU_BINDABLE.includes(action) ? 'menu' : 'gameplay';
}

/** control -> actions for one device and context. */
export function buildLookup(
  bindings: Bindings,
  device: InputDevice,
  context: InputContext,
  swapConfirmBack = false,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (control: string, action: string): void => {
    const list = map.get(control);
    if (list) {
      if (!list.includes(action)) list.push(action);
    } else map.set(control, [action]);
  };
  if (context === 'gameplay') {
    for (const action of GAMEPLAY_ACTIONS) for (const control of bindings[action]) add(control, action);
  } else if (context === 'menu') {
    const fixed = device === 'keyboard' ? MENU_KEYS : MENU_PAD;
    for (const [action, controls] of Object.entries(fixed)) for (const control of controls) add(control, action);
    const confirm = swapConfirmBack && device === 'gamepad' ? bindings.back : bindings.confirm;
    const back = swapConfirmBack && device === 'gamepad' ? bindings.confirm : bindings.back;
    for (const control of confirm) add(control, 'confirm');
    for (const control of back) add(control, 'back');
  }
  return map;
}

/** Other actions in the same context that already use `control`. */
export function findConflicts(bindings: Bindings, action: InputAction, control: string): InputAction[] {
  const context = actionContext(action);
  return INPUT_ACTIONS.filter((a) => a !== action && actionContext(a) === context && bindings[a].includes(control));
}

export type ConflictResolution = 'replace' | 'swap';

/**
 * Assigns `control` to `action` at `slot` (0 or 1).
 * - replace: the control is removed from conflicting actions.
 * - swap: conflicting actions receive this action's previous control in that slot.
 */
export function assignBinding(
  bindings: Bindings,
  action: InputAction,
  slot: number,
  control: string,
  resolution: ConflictResolution = 'replace',
): Record<InputAction, string[]> {
  const next = Object.fromEntries(INPUT_ACTIONS.map((a) => [a, [...bindings[a]]])) as Record<InputAction, string[]>;
  const previous = next[action][slot];
  for (const other of findConflicts(bindings, action, control)) {
    const idx = next[other].indexOf(control);
    if (resolution === 'swap' && previous && !next[other].includes(previous)) next[other][idx] = previous;
    else next[other].splice(idx, 1);
  }
  const own = next[action].filter((c) => c !== control);
  if (slot >= own.length) own.push(control);
  else own.splice(slot, 0, control);
  if (previous && own.length > 2) {
    const prevIdx = own.indexOf(previous);
    if (prevIdx >= 0) own.splice(prevIdx, 1);
  }
  next[action] = own.slice(0, 2);
  return next;
}

export function clearBinding(bindings: Bindings, action: InputAction, slot: number): Record<InputAction, string[]> | null {
  const next = Object.fromEntries(INPUT_ACTIONS.map((a) => [a, [...bindings[a]]])) as Record<InputAction, string[]>;
  next[action].splice(slot, 1);
  if (REQUIRED_ACTIONS.includes(action) && next[action].length === 0) return null;
  return next;
}

/** Human-readable name of a keyboard code or gamepad control. */
export function controlLabel(control: string, family: 'playstation' | 'xbox' | 'generic' = 'generic'): string {
  if (control.startsWith('button:')) {
    const i = Number(control.slice(7));
    const names: Record<typeof family, readonly string[]> = {
      playstation: ['Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2', 'Create', 'Options', 'L3', 'R3', 'D-pad Up', 'D-pad Down', 'D-pad Left', 'D-pad Right', 'PS', 'Touchpad'],
      xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'D-pad Up', 'D-pad Down', 'D-pad Left', 'D-pad Right', 'Guide', 'Share'],
      generic: ['Button 1', 'Button 2', 'Button 3', 'Button 4', 'L Bumper', 'R Bumper', 'L Trigger', 'R Trigger', 'Select', 'Start', 'L Stick', 'R Stick', 'D-pad Up', 'D-pad Down', 'D-pad Left', 'D-pad Right', 'Home', 'Extra'],
    };
    return names[family][i] ?? `Button ${i}`;
  }
  if (control.startsWith('axis:')) {
    const [, idx, sign] = control.split(':');
    const stick = Number(idx) < 2 ? 'Left Stick' : 'Right Stick';
    const horizontal = Number(idx) % 2 === 0;
    const dir = horizontal ? (sign === '-' ? 'Left' : 'Right') : sign === '-' ? 'Up' : 'Down';
    return `${stick} ${dir}`;
  }
  if (control.startsWith('hat:')) return `Hat ${control.split(':')[2] ?? ''}`;
  const special: Record<string, string> = {
    Space: 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Enter: 'Enter',
    NumpadEnter: 'Num Enter', ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl',
    AltLeft: 'L Alt', AltRight: 'R Alt', Backspace: 'Backspace', Tab: 'Tab', CapsLock: 'Caps Lock', PageUp: 'Page Up', PageDown: 'Page Down',
  };
  if (special[control]) return special[control];
  if (control.startsWith('Key')) return control.slice(3);
  if (control.startsWith('Digit')) return control.slice(5);
  if (control.startsWith('Numpad')) return `Num ${control.slice(6)}`;
  return control;
}
