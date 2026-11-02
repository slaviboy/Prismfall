import type { InputAction } from '../settings/schema';
import { GamepadSource, type GamepadTuning } from './gamepad/gamepadSource';
import { KeyboardSource } from './keyboard/keyboardSource';
import { buildLookup, GAMEPLAY_ACTIONS, type Bindings } from './mappings/bindings';
import type { ActionEvent, InputContext, InputDevice, MenuAction, PadInfo, RawInputEvent } from './types';

type Listener<T> = (e: T) => void;

/**
 * Unified input: device sources -> raw control events -> context-specific action events.
 * Gameplay and menus use separate contexts; capture mode forwards raw controls for rebinding.
 */
export class InputManager {
  readonly keyboard: KeyboardSource;
  readonly gamepad: GamepadSource;
  private context: InputContext = 'none';
  private keyboardBindings: Bindings | null = null;
  private gamepadBindings: Bindings | null = null;
  private swapConfirmBack = false;
  private lookups = new Map<string, Map<string, string[]>>();
  /** action -> controls currently holding it (per context). */
  private active = new Map<string, Set<string>>();
  private highRateTimer: ReturnType<typeof setInterval> | null = null;

  private gameplayListeners = new Set<Listener<ActionEvent<InputAction>>>();
  private menuListeners = new Set<Listener<ActionEvent<MenuAction>>>();
  private captureListener: Listener<RawInputEvent> | null = null;
  private connectionListeners = new Set<(pad: PadInfo, connected: boolean) => void>();
  private focusLostListeners = new Set<() => void>();
  private anyInputListeners = new Set<(e: RawInputEvent) => void>();
  lastDevice: InputDevice = 'keyboard';

  constructor() {
    this.keyboard = new KeyboardSource(
      (e) => this.handleRaw(e),
      () => this.focusLostListeners.forEach((l) => l()),
    );
    this.gamepad = new GamepadSource(
      (e) => this.handleRaw(e),
      (pad, connected) => this.connectionListeners.forEach((l) => l(pad, connected)),
    );
  }

  attach(): void {
    this.keyboard.attach();
  }

  detach(): void {
    this.keyboard.detach();
    this.setHighRatePolling(false);
  }

  setBindings(keyboard: Bindings, gamepad: Bindings, swapConfirmBack: boolean): void {
    this.keyboardBindings = keyboard;
    this.gamepadBindings = gamepad;
    this.swapConfirmBack = swapConfirmBack;
    this.lookups.clear();
    const prevent = new Set<string>();
    for (const action of GAMEPLAY_ACTIONS) for (const code of keyboard[action]) prevent.add(code);
    for (const code of ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Backspace']) prevent.add(code);
    this.keyboard.preventDefaultCodes = prevent;
  }

  setTuning(tuning: GamepadTuning): void {
    this.gamepad.tuning = tuning;
  }

  getContext(): InputContext {
    return this.context;
  }

  setContext(context: InputContext, time = performance.now()): void {
    if (context === this.context) return;
    this.releaseActive(time);
    this.context = context;
  }

  /** Optional ~250 Hz gamepad polling between frames for finer input timestamps. */
  setHighRatePolling(enabled: boolean): void {
    if (enabled && !this.highRateTimer) this.highRateTimer = setInterval(() => this.gamepad.poll(), 4);
    else if (!enabled && this.highRateTimer) {
      clearInterval(this.highRateTimer);
      this.highRateTimer = null;
    }
  }

  poll(now = performance.now()): void {
    this.gamepad.poll(now);
  }

  onGameplay(l: Listener<ActionEvent<InputAction>>): () => void {
    this.gameplayListeners.add(l);
    return () => this.gameplayListeners.delete(l);
  }

  onMenu(l: Listener<ActionEvent<MenuAction>>): () => void {
    this.menuListeners.add(l);
    return () => this.menuListeners.delete(l);
  }

  onConnection(l: (pad: PadInfo, connected: boolean) => void): () => void {
    this.connectionListeners.add(l);
    return () => this.connectionListeners.delete(l);
  }

  onFocusLost(l: () => void): () => void {
    this.focusLostListeners.add(l);
    return () => this.focusLostListeners.delete(l);
  }

  /** Every raw press regardless of context (audio unlock, "press any key"). */
  onAnyInput(l: (e: RawInputEvent) => void): () => void {
    this.anyInputListeners.add(l);
    return () => this.anyInputListeners.delete(l);
  }

  /** Enters capture mode; the listener receives raw presses until `endCapture`. */
  beginCapture(listener: Listener<RawInputEvent>): void {
    this.releaseActive(performance.now());
    this.captureListener = listener;
  }

  endCapture(): void {
    this.captureListener = null;
  }

  get capturing(): boolean {
    return this.captureListener !== null;
  }

  private lookup(device: InputDevice, context: InputContext): Map<string, string[]> {
    const key = `${device}:${context}`;
    let map = this.lookups.get(key);
    if (!map) {
      const bindings = device === 'keyboard' ? this.keyboardBindings : this.gamepadBindings;
      map = bindings ? buildLookup(bindings, device, context, this.swapConfirmBack) : new Map();
      this.lookups.set(key, map);
    }
    return map;
  }

  private handleRaw(e: RawInputEvent): void {
    if (e.down) {
      this.lastDevice = e.device;
      this.anyInputListeners.forEach((l) => l(e));
    }
    if (this.captureListener) {
      if (e.down) this.captureListener(e);
      return;
    }
    if (this.context === 'none' || this.context === 'capture') return;
    const actions = this.lookup(e.device, this.context).get(e.control);
    if (!actions) return;
    const controlKey = `${e.device}:${e.pad}:${e.control}`;
    for (const action of actions) {
      let holders = this.active.get(action);
      if (!holders) {
        holders = new Set();
        this.active.set(action, holders);
      }
      if (e.down) {
        const wasEmpty = holders.size === 0;
        holders.add(controlKey);
        if (wasEmpty) this.emit(action, true, e.time, e.device);
      } else if (holders.delete(controlKey) && holders.size === 0) {
        this.emit(action, false, e.time, e.device);
      }
    }
  }

  private emit(action: string, down: boolean, time: number, device: InputDevice): void {
    if (this.context === 'gameplay') {
      const ev: ActionEvent<InputAction> = { action: action as InputAction, down, time, device, repeat: false };
      this.gameplayListeners.forEach((l) => l(ev));
    } else if (this.context === 'menu') {
      const ev: ActionEvent<MenuAction> = { action: action as MenuAction, down, time, device, repeat: false };
      this.menuListeners.forEach((l) => l(ev));
    }
  }

  /** Releases all active actions in the current context (context switch, capture). */
  private releaseActive(time: number): void {
    for (const [action, holders] of this.active) {
      if (holders.size > 0) {
        holders.clear();
        this.emit(action, false, time, this.lastDevice);
      }
    }
    this.active.clear();
  }

  /** True when any control mapped to `action` in the given context is currently held. */
  isActionHeld(action: string): boolean {
    return (this.active.get(action)?.size ?? 0) > 0;
  }
}
