/**
 * Meteor planning and timing (pure, no three.js): where a meteor crosses the sky, how fast, how
 * bright and what colour, and when the next one comes. Directions are unit vectors in world space
 * (x right, y up, -z ahead); azimuth 0 is straight ahead and positive to the right.
 */

export type Vec3 = [number, number, number];

export interface MeteorSkyConfig {
  /** Mean seconds between meteors in calm music. */
  interval: number;
  /** Extra rate in intense sections: rate × (1 + boost × intensity above calm). */
  intensityBoost: number;
  /** Fraction of meteors that are fireballs. */
  fireballs: number;
  showers: { enabled: boolean; every: number; duration: number; rate: number };
  /** |azimuth| range in degrees, mirrored left and right of the view axis: where paths may run. */
  azimuth: readonly [number, number];
  /** Elevation range in degrees: where paths may run (they may start out of view). */
  elevation: readonly [number, number];
  /** Where the bright second half of every path lies: the sky a screen shows beside the board. */
  view: { azimuth: readonly [number, number]; elevation: readonly [number, number] };
  /** Skyline of a photo horizon: [azimuth, elevation] degree points, sorted by azimuth. */
  skyline: readonly (readonly [number, number])[];
  /** Clearance above the skyline in degrees. */
  margin: number;
  /** Directions to keep clear (the moon), with a radius in degrees. */
  avoid: readonly { direction: Vec3; radius: number }[];
  /** Path length range of ordinary meteors (degrees). */
  length: readonly [number, number];
  /** Angular speed range (degrees per second). */
  speed: readonly [number, number];
  /** Shares of bright meteors with a green (fast) or orange (slow) tint. */
  colors: { green: number; orange: number };
}

export interface MeteorPlan {
  /** Where the meteor lights up and where it burns out. */
  a: Vec3;
  b: Vec3;
  /** Seconds the head takes from a to b. */
  duration: number;
  /** Peak brightness: about 0.1 (faint) to 1 (bright); fireballs about 2. */
  mag: number;
  /** -1 orange (slow, sodium) .. 0 white .. +1 green (fast, magnesium and oxygen). */
  tint: number;
  fireball: boolean;
  /** Per-event randomness for the shader (flares along the path, the train's shape). */
  seed: number;
}

const DEG = Math.PI / 180;

export function direction(azDeg: number, elDeg: number): Vec3 {
  const az = azDeg * DEG;
  const el = elDeg * DEG;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

export function azEl(v: Vec3): [number, number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [Math.atan2(v[0], -v[2]) / DEG, Math.asin(Math.max(-1, Math.min(1, v[1] / len))) / DEG];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Angle between two unit vectors, degrees. */
export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) / DEG;
}

/** Elevation of the skyline at an azimuth (piecewise linear; flat beyond the ends; none = -90). */
export function skylineAt(points: readonly (readonly [number, number])[], azDeg: number): number {
  if (points.length === 0) return -90;
  const first = points[0] as readonly [number, number];
  const last = points[points.length - 1] as readonly [number, number];
  if (azDeg <= first[0]) return first[1];
  if (azDeg >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const p1 = points[i] as readonly [number, number];
    if (azDeg <= p1[0]) {
      const p0 = points[i - 1] as readonly [number, number];
      return lerp(p0[1], p1[1], (azDeg - p0[0]) / Math.max(1e-6, p1[0] - p0[0]));
    }
  }
  return last[1];
}

/**
 * Whether the arc from a to b stays in the meteor region (one side, outside the clear zone, above
 * the land) with its bright second half in view.
 */
export function pathClear(cfg: MeteorSkyConfig, a: Vec3, b: Vec3): boolean {
  const side = Math.sign(azEl(a)[0]);
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = normalize([lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]);
    const [az, el] = azEl(p);
    const abs = Math.abs(az);
    if (Math.sign(az) !== side) return false;
    if (abs < cfg.azimuth[0] || abs > cfg.azimuth[1]) return false;
    if (el > cfg.elevation[1]) return false;
    if (el < Math.max(cfg.elevation[0], skylineAt(cfg.skyline, az) + cfg.margin)) return false;
    for (const o of cfg.avoid) if (angleBetween(p, o.direction) < o.radius) return false;
    if (t >= 0.45 && (abs < cfg.view.azimuth[0] || abs > cfg.view.azimuth[1] || el > cfg.view.elevation[1] || el < cfg.view.elevation[0])) return false;
  }
  return true;
}

export interface PlanOptions {
  /** A shower's radiant; null = a sporadic meteor (its own random radiant). */
  radiant: Vec3 | null;
  fireball: boolean;
  /** The shower's angular speed (degrees per second) and colour character. */
  showerSpeed?: number;
  showerTint?: number;
  /** Flash reduction: no fireballs and a capped peak. */
  flashSafe?: boolean;
}

/** A random radiant for sporadic meteors: anywhere above the horizon, uniform over the dome. */
function sporadicRadiant(rand: () => number): Vec3 {
  return direction(rand() * 360 - 180, Math.asin(0.05 + 0.95 * rand()) / DEG);
}

/**
 * Plans one meteor. Every meteor moves away from its radiant along a great circle (that is what a
 * shower looks like: paths that trace back to one point); its length and speed shrink near the
 * radiant (foreshortening). Returns null when no path fits the region in a few attempts.
 */
export function planMeteor(cfg: MeteorSkyConfig, rand: () => number, o: PlanOptions): MeteorPlan | null {
  const fireball = o.fireball && !o.flashSafe;
  const [az0, az1] = cfg.view.azimuth;
  const [el0, el1] = cfg.view.elevation;
  for (let attempt = 0; attempt < 32; attempt++) {
    // A point in the bright part of the path, in view; the path runs back from it towards the radiant.
    const side = rand() < 0.5 ? -1 : 1;
    const az = side * lerp(az0, az1, Math.pow(rand(), 1.3));
    const floor = Math.max(el0, cfg.elevation[0], skylineAt(cfg.skyline, az) + cfg.margin);
    if (floor >= el1) continue;
    const el = lerp(floor, el1, rand());
    const m = direction(az, el);
    const radiant = o.radiant ?? sporadicRadiant(rand);
    const rd = angleBetween(m, radiant);
    if (rd < 6 || rd > 174) continue;
    const fore = Math.sin(rd * DEG);
    // Away from the radiant: the part of -radiant perpendicular to m.
    const k = dot(m, radiant);
    const t = normalize([m[0] * k - radiant[0], m[1] * k - radiant[1], m[2] * k - radiant[2]]);
    let length: number;
    let speed: number;
    if (fireball) {
      length = lerp(14, 26, rand());
      speed = lerp(7, 13, rand());
    } else if (o.radiant) {
      length = cfg.length[1] * 1.15 * fore * lerp(0.45, 1, rand());
      speed = (o.showerSpeed ?? 25) * (0.35 + 0.65 * fore) * lerp(0.9, 1.1, rand());
    } else {
      length = lerp(cfg.length[0], cfg.length[1], Math.pow(rand(), 1.4)) * (0.35 + 0.65 * fore);
      speed = lerp(cfg.speed[0], cfg.speed[1], rand()) * (0.45 + 0.55 * fore);
    }
    length = Math.max(cfg.length[0] * 0.5, length);
    // Where the chosen point sits along the path (late: the bright part).
    const f = lerp(0.55, 0.85, rand());
    let a: Vec3 | null = null;
    let b: Vec3 | null = null;
    // Shorten the path (around the same point) until it fits.
    for (let shrink = 0; shrink < 4; shrink++) {
      const L = length * Math.pow(0.72, shrink) * DEG;
      const ca = Math.cos(L * f);
      const sa = Math.sin(L * f);
      const cb = Math.cos(L * (1 - f));
      const sb = Math.sin(L * (1 - f));
      const pa: Vec3 = [m[0] * ca - t[0] * sa, m[1] * ca - t[1] * sa, m[2] * ca - t[2] * sa];
      const pb: Vec3 = [m[0] * cb + t[0] * sb, m[1] * cb + t[1] * sb, m[2] * cb + t[2] * sb];
      if (pathClear(cfg, pa, pb)) {
        a = pa;
        b = pb;
        length = L / DEG;
        break;
      }
    }
    if (!a || !b) continue;
    if (!fireball && length < cfg.length[0] * 0.5) continue;
    const duration = fireball ? Math.min(3.2, Math.max(1.2, length / speed)) : Math.min(1.2, Math.max(0.25, length / speed));
    let mag: number;
    let tint: number;
    if (fireball) {
      mag = lerp(1.8, 2.5, rand());
      tint = rand() < 0.55 ? lerp(0.6, 1, rand()) : -lerp(0.5, 0.9, rand());
    } else {
      // Steep brightness distribution: many faint meteors, few bright ones.
      mag = 0.12 + 0.88 * Math.pow(rand(), 2.3);
      tint = (rand() - 0.5) * 0.3;
      if (o.radiant && o.showerTint !== undefined) tint = o.showerTint + (rand() - 0.5) * 0.3;
      else if (mag > 0.45 && speed > 19 && rand() < cfg.colors.green) tint = lerp(0.45, 1, rand());
      else if (mag > 0.45 && speed < 12 && rand() < cfg.colors.orange) tint = -lerp(0.4, 1, rand());
      if (o.flashSafe) mag = Math.min(mag, 0.75);
    }
    return { a, b, duration, mag, tint: Math.max(-1, Math.min(1, tint)), fireball, seed: rand() };
  }
  return null;
}

export interface SchedulerOptions {
  /** Reduced motion: fewer meteors and no showers. */
  reduced: boolean;
  /** Particle density setting (0 = none). */
  density: number;
}

/**
 * When meteors come: a Poisson process (exponential gaps, never tied to beats) whose rate rises a
 * little with the music's section intensity, plus occasional showers: a stretch of half a minute or
 * so where meteors come several times as often, most of them from one radiant.
 */
export class MeteorScheduler {
  private showerEnd = -Infinity;
  private nextShower: number;
  private radiant: Vec3 | null = null;
  private showerSpeed = 25;
  private showerTint = 0;

  constructor(
    private readonly cfg: MeteorSkyConfig,
    private readonly rand: () => number,
    private readonly opts: SchedulerOptions,
    clock = 0,
  ) {
    this.nextShower = clock + this.expo(cfg.showers.every) * 0.6;
  }

  private expo(mean: number): number {
    return -Math.log(1 - Math.min(0.999999, this.rand())) * mean;
  }

  private get showersOn(): boolean {
    return this.cfg.showers.enabled && !this.opts.reduced;
  }

  inShower(clock: number): boolean {
    return clock < this.showerEnd;
  }

  /** Meteors per second at this moment. */
  rate(clock: number, intensity: number, rateMul = 1): number {
    const calm = Math.max(0, Math.min(1, (intensity - 0.35) / 0.65));
    const shower = this.showersOn && this.inShower(clock) ? this.cfg.showers.rate : 1;
    const reduced = this.opts.reduced ? 0.4 : 1;
    const density = Math.max(0, Math.min(1.25, this.opts.density));
    return (1 / this.cfg.interval) * (1 + this.cfg.intensityBoost * calm) * Math.max(0, rateMul) * shower * reduced * density;
  }

  /** Starts a shower now: a radiant above the visible sky (or low to one side), one speed and colour character. */
  startShower(clock: number): void {
    const high = this.rand() < 0.7;
    const az = high ? lerp(-70, 70, this.rand()) : (this.rand() < 0.5 ? -1 : 1) * lerp(70, 120, this.rand());
    const el = high ? lerp(38, 75, this.rand()) : lerp(10, 30, this.rand());
    this.radiant = direction(az, el);
    // Fast showers are often greenish, slow ones yellow-white.
    this.showerSpeed = lerp(14, 32, this.rand());
    this.showerTint = this.showerSpeed > 26 ? lerp(0.2, 0.6, this.rand()) : lerp(-0.4, 0.1, this.rand());
    this.showerEnd = clock + this.cfg.showers.duration * lerp(0.7, 1.3, this.rand());
    this.nextShower = this.showerEnd + this.expo(this.cfg.showers.every);
  }

  /** One meteor from the current state (a shower member most of the time during a shower). */
  plan(clock: number, flashSafe: boolean, force?: { fireball?: boolean }): MeteorPlan | null {
    const inShower = this.showersOn && this.inShower(clock) && this.radiant !== null;
    const member = inShower && this.rand() < 0.8;
    const fireball = force?.fireball ?? (this.rand() < this.cfg.fireballs * (member ? 1.5 : 1));
    return planMeteor(this.cfg, this.rand, {
      radiant: member ? this.radiant : null,
      fireball,
      showerSpeed: this.showerSpeed,
      showerTint: this.showerTint,
      flashSafe,
    });
  }

  /** Advances by dt seconds; returns a meteor to launch, if one starts in this step. */
  step(clock: number, dt: number, intensity: number, rateMul: number, flashSafe: boolean): MeteorPlan | null {
    if (this.showersOn && clock >= this.nextShower && !this.inShower(clock)) this.startShower(clock);
    const hz = this.rate(clock, intensity, rateMul);
    if (hz <= 0) return null;
    if (this.rand() >= 1 - Math.exp(-hz * Math.min(0.25, Math.max(0, dt)))) return null;
    return this.plan(clock, flashSafe);
  }
}
