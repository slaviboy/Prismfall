import type { RawInputEvent } from '../input/types';

/** Minimal structural view of the WebXR input we read (keeps tests free of DOM XR types). */
export interface XRGamepadLike {
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
  readonly axes: readonly number[];
  readonly hapticActuators?: readonly { pulse?(value: number, duration: number): Promise<boolean> }[];
  readonly vibrationActuator?: { playEffect?(type: string, params: Record<string, number>): Promise<unknown> } | null;
}

export interface XRInputSourceLike {
  readonly handedness: 'left' | 'right' | 'none';
  readonly gamepad?: XRGamepadLike | null;
  readonly profiles?: readonly string[];
}

/** Analog thresholds with hysteresis so a resting finger never chatters. */
const PRESS = 0.55;
const RELEASE = 0.35;
const STICK_ON = 0.55;
const STICK_OFF = 0.35;

/**
 * Turns WebXR controllers (xr-standard mapping: Quest Touch, Index, Vive, WMR...) into raw input
 * events "xr:<hand>:<control>" that the input manager maps through the VR bindings. Controls:
 * trigger, squeeze, a/b (right) or x/y (left), stick-press and stick directions (thumbstick, or the
 * touchpad on controllers without one).
 */
export class XRControllerInput {
  private readonly held = new Map<string, boolean>();
  private readonly sources = new Map<string, XRInputSourceLike>();

  constructor(private readonly emit: (e: RawInputEvent) => void) {}

  /** Reads every controller once per XR frame. */
  poll(inputSources: Iterable<XRInputSourceLike>, time: number): void {
    const seen = new Set<string>();
    for (const src of inputSources) {
      if (!src.gamepad || (src.handedness !== 'left' && src.handedness !== 'right')) continue;
      const hand = src.handedness;
      seen.add(hand);
      this.sources.set(hand, src);
      const g = src.gamepad;
      const pad = hand === 'left' ? 0 : 1;
      const analog = (i: number, name: string): void => {
        const b = g.buttons[i];
        if (!b) return;
        const was = this.held.get(`xr:${hand}:${name}`) ?? false;
        const v = Math.max(b.value, b.pressed ? 1 : 0);
        this.set(`xr:${hand}:${name}`, was ? v > RELEASE : v > PRESS, pad, time);
      };
      analog(0, 'trigger');
      analog(1, 'squeeze');
      const [faceA, faceB] = hand === 'right' ? ['a', 'b'] : ['x', 'y'];
      analog(4, faceA);
      analog(5, faceB);
      analog(3, 'stick-press');
      // Thumbstick on axes 2/3; controllers without one (Vive wands) use the touchpad on 0/1.
      const hasStick = g.axes.length >= 4;
      const x = g.axes[hasStick ? 2 : 0] ?? 0;
      const y = g.axes[hasStick ? 3 : 1] ?? 0;
      // A touchpad only counts while pressed, so resting a thumb on it does nothing.
      const padGate = hasStick || (g.buttons[2]?.pressed ?? false);
      const dir = (name: string, value: number): void => {
        const key = `xr:${hand}:stick-${name}`;
        const was = this.held.get(key) ?? false;
        this.set(key, padGate && (was ? value > STICK_OFF : value > STICK_ON), pad, time);
      };
      dir('left', -x);
      dir('right', x);
      dir('up', -y);
      dir('down', y);
    }
    // A controller that disappeared (battery, tracking loss) releases everything it held.
    for (const hand of ['left', 'right']) {
      if (seen.has(hand)) continue;
      this.sources.delete(hand);
      for (const [key, down] of this.held) if (down && key.startsWith(`xr:${hand}:`)) this.set(key, false, hand === 'left' ? 0 : 1, time);
    }
  }

  private set(control: string, down: boolean, pad: number, time: number): void {
    if ((this.held.get(control) ?? false) === down) return;
    this.held.set(control, down);
    this.emit({ device: 'xr', pad, control, down, time });
  }

  /** Releases every held control (session end, pause). */
  releaseAll(time: number): void {
    for (const [key, down] of this.held) if (down) this.set(key, false, key.includes(':left:') ? 0 : 1, time);
  }

  isHeld(control: string): boolean {
    return this.held.get(control) ?? false;
  }

  /** Haptic pulse on one or both controllers (0..1, milliseconds). */
  pulse(hand: 'left' | 'right' | 'both', intensity: number, ms: number): void {
    const v = Math.max(0, Math.min(1, intensity));
    if (v <= 0) return;
    for (const h of hand === 'both' ? (['left', 'right'] as const) : [hand]) {
      const g = this.sources.get(h)?.gamepad;
      const actuator = g?.hapticActuators?.[0];
      if (actuator?.pulse) void actuator.pulse(v, ms).catch(() => undefined);
      else void g?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: v, weakMagnitude: v * 0.6 })?.catch(() => undefined);
    }
  }

  /** Controller families seen this session (for the settings screen and docs). */
  profiles(): string[] {
    return [...this.sources.values()].flatMap((s) => s.profiles?.slice(0, 1) ?? []);
  }
}
