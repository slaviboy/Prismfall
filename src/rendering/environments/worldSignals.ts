/**
 * Long-lived game signals and the world clear wave (pure TypeScript: no three, DOM or audio).
 *
 * The renderer feeds it the clears it presents (never the engine itself), so gameplay stays
 * deterministic. It publishes:
 * - `heat` 0..1: rises with consecutive clears, combos, back-to-back and spins; held for a few
 *   seconds after each clear, then decays over roughly 10 to 20 seconds;
 * - `clearWave` 0..1: a long-release clear signal, set by the size of each clear and falling over
 *   about three seconds (unlike `clearPulse`, which is gone in under half a second);
 * - up to `FRONT_SLOTS` travelling clear fronts that roll outward from the board through the world
 *   (`frontValue` below, mirrored by the TSL `clearFront` helper in shaders/clearFront.ts).
 */

/** What the renderer knows about a presented line clear. */
export interface ClearMoment {
  readonly lines: number;
  readonly spin: boolean;
  readonly perfectClear: boolean;
  /** Combo count after this clear (-1 or 0 = none). */
  readonly combo: number;
  readonly backToBack: boolean;
}

/** One travelling front: when it left the board and how big it is. */
export interface FrontSlot {
  /** Start time (seconds, frame clock); -1000 = idle. */
  start: number;
  /** Amplitude 0..1.5. */
  strength: number;
  /** How far it travels before fading, as a share of the far distance (0..~1). */
  reach: number;
  /** Thickness of the front in normalised log-distance units. */
  width: number;
}

/** How a world's clear fronts travel (manifest `clearWave`). */
export interface FrontShape {
  /** Distance from the board (world units) where the front starts. */
  readonly near: number;
  /** Distance at which the front has crossed the whole world (horizon, sky dome). */
  readonly far: number;
  /** Seconds the front takes from `near` to `far`. */
  readonly travel: number;
}

export const FRONT_SLOTS = 4;
export const DEFAULT_FRONT_SHAPE: FrontShape = { near: 6, far: 900, travel: 3.2 };

/** Heat: gain per clear, the hold after a clear and the decay time constant afterwards. */
export const HEAT = { hold: 3, tau: 9 } as const;
/** Clear wave: hold at its peak, then exponential release (seconds). */
export const CLEAR_WAVE = { hold: 0.35, tau: 2.2 } as const;

/**
 * The size of a clear's response, 0..1.5: a single is a third of a QUAD; spins, back-to-back,
 * combos and perfect clears add to it.
 */
export function clearStrength(c: ClearMoment): number {
  const byLines = [0, 0.32, 0.5, 0.68, 1][Math.max(0, Math.min(4, c.lines))] ?? 1;
  const s = byLines + (c.spin ? 0.18 : 0) + (c.backToBack ? 0.15 : 0) + Math.min(0.25, Math.max(0, c.combo) * 0.04) + (c.perfectClear ? 0.4 : 0);
  return Math.min(1.5, s);
}

/** How much one clear heats the run (before saturation). */
export function heatGain(c: ClearMoment): number {
  if (c.lines <= 0 && !c.perfectClear) return 0;
  return 0.05 + 0.06 * Math.min(4, c.lines) + (c.spin ? 0.08 : 0) + (c.backToBack ? 0.1 : 0) + Math.min(0.2, Math.max(0, c.combo) * 0.035) + (c.perfectClear ? 0.35 : 0);
}

/** Front parameters for a clear of `strength`: bigger clears travel further and are thicker. */
export function frontFor(strength: number, start: number): FrontSlot {
  const s = Math.min(1, Math.max(0, strength));
  return { start, strength: Math.max(0, strength), reach: 0.55 + 0.75 * s, width: 0.03 + 0.05 * s };
}

/** Normalised log distance: 0 at the board (`near`), 1 at `far`. */
export function frontDistance(distance: number, shape: FrontShape = DEFAULT_FRONT_SHAPE): number {
  return Math.log(Math.max(distance, shape.near) / shape.near) / Math.log(shape.far / shape.near);
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * One front's value at normalised distance `x` (see frontDistance), `age` seconds after it left
 * the board. The front moves at a constant speed in log distance (so it sweeps the screen evenly
 * from the board to the horizon), with a sharp leading edge and a soft tail behind it; it fades
 * out as it nears its reach. The TSL helper computes exactly this per pixel.
 */
export function frontValue(x: number, age: number, slot: FrontSlot, travel = DEFAULT_FRONT_SHAPE.travel): number {
  if (age < 0 || slot.strength <= 0) return 0;
  const f = age / travel;
  const s = x - f;
  const band = s > 0 ? Math.exp(-((s / (slot.width * 0.85)) ** 2)) : Math.exp(s / (slot.width * 1.6));
  const alive = 1 - smoothstep(slot.reach * 0.55, slot.reach, f);
  return band * alive * slot.strength;
}

/** Sum of every front at a point, capped as in the shader. */
export function frontsAt(x: number, time: number, slots: readonly FrontSlot[], travel = DEFAULT_FRONT_SHAPE.travel): number {
  let sum = 0;
  for (const s of slots) sum += frontValue(x, time - s.start, s, travel);
  return Math.min(1.5, sum);
}

/** Seconds a front of this strength is visible (until it fades or leaves the far edge, plus its tail). */
export function frontLifetime(strength: number, travel = DEFAULT_FRONT_SHAPE.travel): number {
  return Math.min(1, frontFor(strength, 0).reach) * travel + 0.6;
}

export class WorldSignals {
  heat = 0;
  clearWave = 0;
  /** World multiplier for front strength (manifest `clearWave.strength`). */
  worldStrength = 1;
  readonly fronts: FrontSlot[] = Array.from({ length: FRONT_SLOTS }, () => ({ start: -1000, strength: 0, reach: 0, width: 0.05 }));
  private lastClear = -1e9;
  private wavePeak = -1e9;

  /** A presented line clear at `time` (seconds). Returns the clear's strength. */
  onClear(c: ClearMoment, time: number): number {
    const strength = clearStrength(c);
    const gain = heatGain(c);
    // Saturating: each clear closes part of the remaining gap.
    this.heat = Math.min(1, this.heat + gain * (1 - this.heat * 0.55));
    this.lastClear = time;
    const wave = Math.min(1, strength);
    if (wave >= this.clearWave) {
      this.clearWave = wave;
      this.wavePeak = time;
    } else this.clearWave = Math.min(1, this.clearWave + wave * 0.35);
    const scaled = strength * this.worldStrength;
    if (scaled > 0.01) {
      // Reuse the oldest slot.
      let slot = 0;
      for (let i = 1; i < FRONT_SLOTS; i++) if ((this.fronts[i] as FrontSlot).start < (this.fronts[slot] as FrontSlot).start) slot = i;
      Object.assign(this.fronts[slot] as FrontSlot, frontFor(scaled, time));
    }
    return strength;
  }

  /**
   * A front sent by the music (the `wave` call-in action, SDK 1.7): it rolls out through the world
   * like a clear's front, without heating the run or raising the clear wave. It never takes the slot
   * of a front less than a second old, so clears keep theirs.
   */
  musicFront(strength: number, time: number): boolean {
    const scaled = Math.min(1.2, strength) * this.worldStrength;
    if (scaled <= 0.01) return false;
    let slot = 0;
    for (let i = 1; i < FRONT_SLOTS; i++) if ((this.fronts[i] as FrontSlot).start < (this.fronts[slot] as FrontSlot).start) slot = i;
    if (time - (this.fronts[slot] as FrontSlot).start < 1) return false;
    Object.assign(this.fronts[slot] as FrontSlot, frontFor(scaled, time));
    return true;
  }

  update(dt: number, time: number): void {
    if (time - this.lastClear > HEAT.hold) this.heat *= Math.exp(-dt / HEAT.tau);
    if (this.heat < 1e-4) this.heat = 0;
    if (time - this.wavePeak > CLEAR_WAVE.hold) this.clearWave *= Math.exp(-dt / CLEAR_WAVE.tau);
    if (this.clearWave < 1e-4) this.clearWave = 0;
  }

  /** A new game: the run cools down at once and no front is in flight. */
  reset(): void {
    this.heat = 0;
    this.clearWave = 0;
    this.lastClear = -1e9;
    this.wavePeak = -1e9;
    for (const f of this.fronts) Object.assign(f, { start: -1000, strength: 0, reach: 0, width: 0.05 });
  }
}
