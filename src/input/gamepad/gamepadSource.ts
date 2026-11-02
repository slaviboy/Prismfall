import type { PadFamily, PadInfo, RawInputEvent } from '../types';

export interface GamepadTuning {
  deadzoneInner: number;
  deadzoneOuter: number;
  /** Rescaled stick deflection that counts as a digital press (the "sensitivity" setting). */
  stickThreshold: number;
  triggerThreshold: number;
  activePadId: string | null;
  ignoredPadIds: readonly string[];
  /** Per pad id: logical standard control -> raw control on that pad. */
  profiles: Readonly<Record<string, { rawMap: Readonly<Record<string, string>> }>>;
}

export const DEFAULT_TUNING: GamepadTuning = {
  deadzoneInner: 0.22,
  deadzoneOuter: 0.95,
  stickThreshold: 0.55,
  triggerThreshold: 0.35,
  activePadId: null,
  ignoredPadIds: [],
  profiles: {},
};

/** Logical controls in standard-mapping space that bindings refer to. */
export const STANDARD_BUTTON_COUNT = 18;
const STICK_AXES: readonly (readonly [number, number])[] = [
  [0, 1],
  [2, 3],
];
/** Release threshold as a fraction of the press threshold (hysteresis). */
const HYSTERESIS = 0.7;

export function detectFamily(id: string): PadFamily {
  const s = id.toLowerCase();
  if (/054c|sony|dualshock|dualsense|playstation|wireless controller/.test(s)) return 'playstation';
  if (/xinput|xbox|045e|microsoft/.test(s)) return 'xbox';
  return 'generic';
}

export function friendlyPadName(id: string): string {
  const s = id.toLowerCase();
  if (s.includes('0df2')) return 'DualSense Edge';
  if (s.includes('0ce6') || s.includes('dualsense')) return 'DualSense';
  if (s.includes('05c4') || s.includes('09cc') || s.includes('dualshock')) return 'DualShock 4';
  if (detectFamily(id) === 'playstation') return 'PlayStation Controller';
  if (detectFamily(id) === 'xbox') return 'Xbox Controller';
  const short = id.replace(/\(.*\)/, '').trim();
  return short.length > 0 ? short.slice(0, 40) : 'Controller';
}

/** Radial dead zone with rescaling, applied to a stick's two axes. */
export function applyRadialDeadzone(x: number, y: number, inner: number, outer: number): [number, number] {
  const mag = Math.hypot(x, y);
  if (mag <= inner || mag === 0) return [0, 0];
  const scaled = Math.min(1, (mag - inner) / Math.max(1e-6, outer - inner));
  return [(x / mag) * scaled, (y / mag) * scaled];
}

/** Direct-input style hat switch: value in [-1, 1] encodes 8 directions; > 1 = neutral. */
export function hatDirections(value: number): { up: boolean; down: boolean; left: boolean; right: boolean } {
  if (value > 1.05 || value < -1.05) return { up: false, down: false, left: false, right: false };
  const step = Math.round(((value + 1) / 2) * 7); // 0..7: up, up-right, right, down-right, down, down-left, left, up-left
  return {
    up: step === 0 || step === 1 || step === 7,
    right: step === 1 || step === 2 || step === 3,
    down: step === 3 || step === 4 || step === 5,
    left: step === 5 || step === 6 || step === 7,
  };
}

interface PadState {
  readonly id: string;
  readonly info: PadInfo;
  /** Logical control -> pressed. */
  readonly controls: Map<string, boolean>;
  /** Raw control -> pressed (for capture/wizard). */
  readonly raw: Map<string, boolean>;
}

type GamepadLike = Pick<Gamepad, 'id' | 'index' | 'connected' | 'mapping' | 'buttons' | 'axes' | 'timestamp'> & {
  readonly vibrationActuator?: GamepadHapticActuator | null;
};

/**
 * Polls the Gamepad API (polling is the source of truth; connection events are only hints),
 * converts buttons/sticks/triggers into digital logical controls with hysteresis, and reports changes.
 */
export class GamepadSource {
  tuning: GamepadTuning = DEFAULT_TUNING;
  private readonly pads = new Map<number, PadState>();
  private readonly onRaw: (e: RawInputEvent) => void;
  private readonly onConnection: (pad: PadInfo, connected: boolean) => void;
  /** Receives unmapped raw control presses (mapping wizard). */
  rawCaptureListener: ((pad: number, control: string) => void) | null = null;
  private lastUsedPad = -1;

  constructor(
    onRaw: (e: RawInputEvent) => void,
    onConnection: (pad: PadInfo, connected: boolean) => void,
    private readonly getGamepads: () => readonly (GamepadLike | null)[] = () =>
      typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [],
  ) {
    this.onRaw = onRaw;
    this.onConnection = onConnection;
  }

  connectedPads(): PadInfo[] {
    return [...this.pads.values()].map((p) => p.info);
  }

  /** Raw button/axis values for the controller test page. */
  rawSnapshot(index: number): { buttons: number[]; axes: number[] } | null {
    const pad = this.getGamepads()[index];
    if (!pad) return null;
    return { buttons: pad.buttons.map((btn) => btn.value), axes: [...pad.axes] };
  }

  /** Logical control states for a pad (controller test page). */
  logicalSnapshot(index: number): ReadonlyMap<string, boolean> | null {
    return this.pads.get(index)?.controls ?? null;
  }

  poll(now = performance.now()): void {
    const list = this.getGamepads();
    const seen = new Set<number>();
    // Register every connected pad first so the active-pad filter sees them all.
    for (let i = 0; i < list.length; i++) {
      const pad = list[i];
      if (!pad || !pad.connected) continue;
      seen.add(pad.index);
      const state = this.pads.get(pad.index);
      if (!state || state.id !== pad.id) {
        if (state) this.disconnect(pad.index, now);
        this.connect(pad);
      }
    }
    for (let i = 0; i < list.length; i++) {
      const pad = list[i];
      if (!pad || !pad.connected) continue;
      const state = this.pads.get(pad.index) as PadState;
      if (this.tuning.ignoredPadIds.includes(pad.id)) continue;
      if (this.tuning.activePadId && this.tuning.activePadId !== pad.id && this.isPadConnected(this.tuning.activePadId)) continue;
      const stamp = pad.timestamp > 0 && pad.timestamp <= now && now - pad.timestamp < 100 ? pad.timestamp : now;
      this.readRaw(pad, state);
      this.readLogical(pad, state, stamp);
    }
    for (const index of [...this.pads.keys()]) if (!seen.has(index)) this.disconnect(index, now);
  }

  private isPadConnected(id: string): boolean {
    for (const p of this.pads.values()) if (p.id === id) return true;
    return false;
  }

  private connect(pad: GamepadLike): PadState {
    const actuator = pad.vibrationActuator ?? null;
    const effects: readonly string[] = (actuator as unknown as { effects?: string[] } | null)?.effects ?? [];
    const legacyType = (actuator as unknown as { type?: string } | null)?.type;
    const info: PadInfo = {
      index: pad.index,
      id: pad.id,
      name: friendlyPadName(pad.id),
      family: detectFamily(pad.id),
      standard: pad.mapping === 'standard',
      buttons: pad.buttons.length,
      axes: pad.axes.length,
      vibration: !!actuator && (effects.includes('dual-rumble') || legacyType === 'dual-rumble' || effects.length === 0),
      triggerRumble: effects.includes('trigger-rumble'),
    };
    const state: PadState = { id: pad.id, info, controls: new Map(), raw: new Map() };
    this.pads.set(pad.index, state);
    this.onConnection(info, true);
    return state;
  }

  private disconnect(index: number, now: number): void {
    const state = this.pads.get(index);
    if (!state) return;
    for (const [control, pressed] of state.controls) {
      if (pressed) this.onRaw({ device: 'gamepad', pad: index, control, down: false, time: now });
    }
    this.pads.delete(index);
    this.onConnection(state.info, false);
  }

  private setControl(state: PadState, padIndex: number, control: string, down: boolean, time: number): void {
    const prev = state.controls.get(control) ?? false;
    if (prev === down) return;
    state.controls.set(control, down);
    if (down) this.lastUsedPad = padIndex;
    this.onRaw({ device: 'gamepad', pad: padIndex, control, down, time });
  }

  /** Reads a raw control as pressed/not, with hysteresis relative to its previous state. */
  private rawPressed(pad: GamepadLike, raw: string, wasDown: boolean, analogTrigger: boolean): boolean {
    const parts = raw.split(':');
    const kind = parts[0];
    const idx = Number(parts[1]);
    if (kind === 'button') {
      const btn = pad.buttons[idx];
      if (!btn) return false;
      if (analogTrigger) {
        const t = this.tuning.triggerThreshold;
        return btn.value > (wasDown ? t * HYSTERESIS : t);
      }
      return btn.pressed || btn.value > 0.5;
    }
    if (kind === 'axis') {
      const v = pad.axes[idx] ?? 0;
      const sign = parts[2] === '-' ? -1 : 1;
      const t = this.tuning.stickThreshold;
      return v * sign > (wasDown ? t * HYSTERESIS : t);
    }
    if (kind === 'hat') {
      const dirs = hatDirections(pad.axes[idx] ?? 9);
      return dirs[parts[2] as 'up' | 'down' | 'left' | 'right'] ?? false;
    }
    return false;
  }

  private readLogical(pad: GamepadLike, state: PadState, time: number): void {
    const rawMap = this.tuning.profiles[pad.id]?.rawMap;
    const useStandard = pad.mapping === 'standard' && !rawMap;
    // Buttons.
    for (let j = 0; j < STANDARD_BUTTON_COUNT; j++) {
      const logical = `button:${j}`;
      const raw = useStandard ? logical : rawMap?.[logical] ?? (pad.mapping === 'standard' ? logical : null);
      const was = state.controls.get(logical) ?? false;
      const down = raw ? this.rawPressed(pad, raw, was, j === 6 || j === 7) : false;
      this.setControl(state, pad.index, logical, down, time);
    }
    // Sticks with radial dead zone (rescaled), then digital thresholds with hysteresis.
    for (const [ax, ay] of STICK_AXES) {
      const rx = rawMap?.[`axis:${ax}`];
      const ry = rawMap?.[`axis:${ay}`];
      const x = pad.axes[rx !== undefined ? Number(rx.split(':')[1]) : ax] ?? 0;
      const y = pad.axes[ry !== undefined ? Number(ry.split(':')[1]) : ay] ?? 0;
      const [dx, dy] = applyRadialDeadzone(x, y, this.tuning.deadzoneInner, this.tuning.deadzoneOuter);
      for (const [axis, value] of [[ax, dx], [ay, dy]] as const) {
        for (const sign of [-1, 1] as const) {
          const control = `axis:${axis}:${sign < 0 ? '-' : '+'}`;
          const was = state.controls.get(control) ?? false;
          const t = this.tuning.stickThreshold;
          this.setControl(state, pad.index, control, value * sign > (was ? t * HYSTERESIS : t), time);
        }
      }
    }
  }

  private readRaw(pad: GamepadLike, state: PadState): void {
    if (!this.rawCaptureListener) return;
    const check = (control: string, down: boolean): void => {
      const prev = state.raw.get(control) ?? false;
      if (prev !== down) {
        state.raw.set(control, down);
        if (down) this.rawCaptureListener?.(pad.index, control);
      }
    };
    pad.buttons.forEach((btn, i) => check(`button:${i}`, btn.pressed || btn.value > 0.6));
    pad.axes.forEach((v, i) => {
      if (Math.abs(v) <= 1.05) {
        check(`axis:${i}:+`, v > 0.6);
        check(`axis:${i}:-`, v < -0.6);
      }
      const hat = hatDirections(v);
      if (v >= -1.05 && v <= 1.05 && pad.mapping !== 'standard') {
        for (const d of ['up', 'down', 'left', 'right'] as const) check(`hat:${i}:${d}`, hat[d]);
      }
    });
  }

  /** Plays a rumble on the most recently used pad (or the active pad). */
  rumble(strong: number, weak: number, durationMs: number, triggers?: { left: number; right: number }): void {
    const list = this.getGamepads();
    const index = this.lastUsedPad >= 0 ? this.lastUsedPad : [...this.pads.keys()][0];
    if (index === undefined) return;
    const pad = list[index];
    const actuator = pad?.vibrationActuator;
    if (!actuator || typeof actuator.playEffect !== 'function') return;
    const s = Math.max(0, Math.min(1, strong));
    const w = Math.max(0, Math.min(1, weak));
    const info = this.pads.get(index)?.info;
    const effect = triggers && info?.triggerRumble ? 'trigger-rumble' : 'dual-rumble';
    const params: Record<string, number> = { startDelay: 0, duration: Math.round(durationMs), strongMagnitude: s, weakMagnitude: w };
    if (effect === 'trigger-rumble' && triggers) {
      params.leftTrigger = triggers.left;
      params.rightTrigger = triggers.right;
    }
    actuator.playEffect(effect as GamepadHapticEffectType, params as GamepadEffectParameters).catch(() => undefined);
  }
}
