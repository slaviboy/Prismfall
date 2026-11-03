/**
 * The Warden's mind: a state machine with procedural timing that decides where the searching fire
 * looks. Pure TypeScript (no three.js), deterministic for a seed, stepped with the frame's dt.
 *
 * States:
 * - scan: a slow sweep along the horizon with uneven speed and the odd hesitation;
 * - search: hops between spots on the land at varied speeds, with pauses of varied length;
 * - focus: it stops, the aperture tightens and the core intensifies for a moment, then lets go;
 * - rapid: a faster but smooth turn to a distant new spot;
 * - gaze: a long, steady look towards the horizon;
 * - return: an unhurried turn back to the horizon, then scanning again;
 * - awaken: rare; the cage opens and the fire swells (requested from outside, or on its own).
 *
 * Moves follow minimum-jerk curves with a slight arc, and the cage follows its command through a
 * critically damped spring, so it never snaps. A slow wander keeps it alive while it holds still.
 * Every timing is drawn from ranges and the next state is chosen by weights that depend on what
 * it has just done and how active the music is, so the pattern never repeats.
 */

export type WardenState = 'scan' | 'search' | 'focus' | 'rapid' | 'gaze' | 'return' | 'awaken';

/** A direction of the beam: heading (radians, from -Z towards +X) and pitch (radians, up). */
export interface Gaze {
  readonly heading: number;
  readonly pitch: number;
}

/** A place worth looking at, with a weight (how often it is picked). */
export interface GazeTarget extends Gaze {
  readonly weight: number;
}

export interface WardenSetup {
  readonly seed: number;
  /** Is this beam direction allowed (away from the viewer, out of the clear zone)? */
  readonly allowed: (heading: number, pitch: number) => boolean;
  /** Notable places on the land (the beam's sweeps light them). */
  readonly targets: readonly GazeTarget[];
  /** The horizon arc it scans: headings and the pitch range just below the horizon. */
  readonly horizon: { readonly from: number; readonly to: number; readonly pitch: readonly [number, number] };
  /** Bounds for random land targets. */
  readonly land: { readonly heading: readonly [number, number]; readonly pitch: readonly [number, number] };
  /** Mean seconds between unprompted awakenings (0 = never on its own). */
  readonly awakenEvery?: number;
  /** Long sweeps across the land (start and end of each); scanning sometimes follows one. */
  readonly sweeps?: readonly { readonly from: Gaze; readonly to: Gaze }[];
  /** Share of scans that sweep the land instead of the horizon (0..1). */
  readonly sweepShare?: number;
}

export interface WardenInputs {
  /** 0..1: how intense the music is (more searching, shorter pauses when high). */
  readonly activity: number;
  readonly reducedMotion: boolean;
}

export interface WardenOutput {
  readonly state: WardenState;
  /** Actual cage orientation (after the spring). */
  readonly heading: number;
  readonly pitch: number;
  /** 0 open .. 1 tight (focusing). */
  readonly aperture: number;
  /** Core and beam intensity factor (about 1; up to ~1.5 focusing, ~2.2 awake). */
  readonly intensity: number;
  /** 0..1 awakening level. */
  readonly awaken: number;
  /** Angular speed of the cage (rad/s). */
  readonly speed: number;
  /** 0..1 how far into a focus it is (the rising tone). */
  readonly focus: number;
}

const DEG = Math.PI / 180;

function mulberry(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Minimum-jerk position profile: 0 → 1 with zero velocity and acceleration at both ends. */
export function minJerk(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (10 + x * (-15 + x * 6));
}

/** Smooth 1D value noise (for the wander), deterministic per seed. */
function noise1(rand: () => number): (t: number) => number {
  const table = Array.from({ length: 256 }, rand);
  return (t: number) => {
    const i = Math.floor(t);
    const f = t - i;
    const a = table[i & 255]!;
    const b = table[(i + 1) & 255]!;
    const s = f * f * (3 - 2 * f);
    return (a + (b - a) * s) * 2 - 1;
  };
}

interface Move {
  from: Gaze;
  to: Gaze;
  duration: number;
  t: number;
  /** Arc offset (radians) perpendicular to the move at its middle. */
  arc: number;
}

interface Step {
  /** Gaze to move to, or null to hold. */
  to: Gaze | null;
  duration: number;
  /** Hold time after arriving. */
  dwell: number;
  /** Values to ease towards during this step. */
  aperture: number;
  intensity: number;
}

export class WardenController {
  private readonly rand: () => number;
  private readonly wander: (t: number) => number;
  private readonly wander2: (t: number) => number;
  private readonly setup: WardenSetup;
  private state: WardenState = 'scan';
  private readonly history: WardenState[] = [];
  private plan: Step[] = [];
  private move: Move | null = null;
  private dwell = 0;
  private time = 0;
  /** Commanded gaze (before the spring). */
  private cmd: { heading: number; pitch: number };
  /** Actual orientation and its velocity (critically damped follower). */
  private cur: { heading: number; pitch: number };
  private vel = { heading: 0, pitch: 0 };
  private aperture = 0.15;
  private apertureTarget = 0.15;
  private intensity = 1;
  private intensityTarget = 1;
  private awakenLevel = 0;
  private awakenPhase: 'none' | 'rise' | 'hold' | 'fall' = 'none';
  private awakenTimer = 0;
  private awakenPending = 0;
  private nextAwaken: number;
  private focusLevel = 0;
  private resumeAfterAwaken: WardenState = 'search';
  private speed = 0;

  constructor(setup: WardenSetup, start?: Gaze) {
    this.setup = setup;
    this.rand = mulberry(setup.seed * 7919 + 13);
    this.wander = noise1(mulberry(setup.seed * 31 + 7));
    this.wander2 = noise1(mulberry(setup.seed * 53 + 3));
    const h = setup.horizon;
    const g = start ?? { heading: h.from + (h.to - h.from) * 0.3, pitch: (h.pitch[0] + h.pitch[1]) / 2 };
    this.cmd = { heading: g.heading, pitch: g.pitch };
    this.cur = { heading: g.heading, pitch: g.pitch };
    this.nextAwaken = setup.awakenEvery ? setup.awakenEvery * (0.6 + this.rand() * 0.8) : Infinity;
    this.enter('scan', { activity: 0.5, reducedMotion: false });
  }

  get currentState(): WardenState {
    return this.state;
  }

  /** Asks for an awakening (a big event stirred it); strength 0..1 scales how long it lasts. */
  awaken(strength = 1): void {
    if (this.awakenPhase !== 'none') return;
    this.awakenPending = Math.max(this.awakenPending, Math.min(1, Math.max(0.3, strength)));
  }

  private range(a: number, b: number): number {
    return a + (b - a) * this.rand();
  }

  private pick<T>(items: readonly { item: T; w: number }[]): T {
    let total = 0;
    for (const i of items) total += Math.max(0, i.w);
    let r = this.rand() * total;
    for (const i of items) {
      r -= Math.max(0, i.w);
      if (r <= 0) return i.item;
    }
    return items[items.length - 1]!.item;
  }

  /** Is every point along a move from a to b allowed? */
  private pathAllowed(a: Gaze, b: Gaze): boolean {
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      if (!this.setup.allowed(a.heading + (b.heading - a.heading) * t, a.pitch + (b.pitch - a.pitch) * t)) return false;
    }
    return true;
  }

  /**
   * The same direction as b, its heading shifted by whole turns so the move from a to it stays
   * allowed (it may have to turn the long way round, away from the viewer); null if neither way is.
   */
  private route(a: Gaze, b: Gaze): Gaze | null {
    const tau = Math.PI * 2;
    const base = b.heading + Math.round((a.heading - b.heading) / tau) * tau;
    const options = [base, base + tau, base - tau].map((h) => ({ heading: h, pitch: b.pitch })).sort((x, y) => Math.abs(x.heading - a.heading) - Math.abs(y.heading - a.heading));
    for (const o of options) if (this.pathAllowed(a, o)) return o;
    return null;
  }

  private angle(a: Gaze, b: Gaze): number {
    const dh = (b.heading - a.heading) * Math.cos((a.pitch + b.pitch) / 2);
    return Math.hypot(dh, b.pitch - a.pitch);
  }

  /** A land spot: a named target near `near` (within `maxAngle`), or a random allowed one. */
  private landTarget(near: Gaze, minAngle: number, maxAngle: number): Gaze {
    const s = this.setup;
    for (let attempt = 0; attempt < 40; attempt++) {
      let g: Gaze;
      if (s.targets.length > 0 && this.rand() < 0.55) {
        g = this.pick(s.targets.map((t) => ({ item: t as Gaze, w: t.weight })));
        // Look around the feature, not always at its exact centre.
        g = { heading: g.heading + this.range(-2.5, 2.5) * DEG, pitch: g.pitch + this.range(-1.5, 1.5) * DEG };
      } else {
        g = { heading: this.range(s.land.heading[0], s.land.heading[1]), pitch: this.range(s.land.pitch[0], s.land.pitch[1]) };
      }
      if (!s.allowed(g.heading, g.pitch)) continue;
      const r = this.route(near, g);
      if (!r) continue;
      const a = this.angle(near, r);
      if (a < minAngle || a > maxAngle) continue;
      return r;
    }
    return { heading: near.heading, pitch: near.pitch };
  }

  private horizonTarget(near: Gaze, minAngle = 0): Gaze {
    const h = this.setup.horizon;
    for (let attempt = 0; attempt < 30; attempt++) {
      const g = { heading: this.range(h.from, h.to), pitch: this.range(h.pitch[0], h.pitch[1]) };
      if (!this.setup.allowed(g.heading, g.pitch)) continue;
      const r = this.route(near, g);
      if (!r || this.angle(near, r) < minAngle) continue;
      return r;
    }
    return { heading: near.heading, pitch: near.pitch };
  }

  private enter(state: WardenState, env: WardenInputs): void {
    this.state = state;
    this.history.push(state);
    if (this.history.length > 6) this.history.shift();
    const act = Math.min(1, Math.max(0, env.activity));
    const slow = env.reducedMotion ? 0.6 : 1;
    const here: Gaze = { heading: this.cmd.heading, pitch: this.cmd.pitch };
    const plan: Step[] = [];
    const deg = (x: number) => x * DEG;
    switch (state) {
      case 'scan': {
        // Sometimes a long, slow sweep across the land; otherwise two to four legs along the
        // horizon in one direction, uneven speeds, brief hesitations.
        const sweeps = this.setup.sweeps ?? [];
        if (sweeps.length > 0 && this.rand() < (this.setup.sweepShare ?? 0.4)) {
          const sw = sweeps[Math.floor(this.rand() * sweeps.length)]!;
          const flip = this.rand() < 0.5;
          const a0 = flip ? sw.to : sw.from;
          const a = this.route(here, a0);
          const b = a ? this.route(a, flip ? sw.from : sw.to) : null;
          if (a && b) {
            const speedIn = this.range(5, 9) * DEG * slow;
            plan.push({ to: a, duration: Math.max(1.6, this.angle(here, a) / speedIn), dwell: this.range(0.3, 1.0), aperture: 0.2, intensity: 1.05 });
            // Across in two legs with an uneven pace and a short hesitation between them.
            const mid = { heading: a.heading + (b.heading - a.heading) * this.range(0.35, 0.65), pitch: a.pitch + (b.pitch - a.pitch) * this.range(0.35, 0.65) + this.range(-1.5, 1.5) * DEG };
            const v1 = this.range(3.2, 6) * DEG * slow * (0.85 + act * 0.3);
            const v2 = this.range(3.2, 6) * DEG * slow * (0.85 + act * 0.3);
            if (this.pathAllowed(a, mid) && this.pathAllowed(mid, b)) {
              plan.push({ to: mid, duration: Math.max(2, this.angle(a, mid) / v1), dwell: this.rand() < 0.5 ? this.range(0.4, 1.4) : 0.1, aperture: 0.25, intensity: 1.08 });
              plan.push({ to: b, duration: Math.max(2, this.angle(mid, b) / v2), dwell: this.range(0.3, 1.2), aperture: 0.2, intensity: 1.05 });
            } else {
              plan.push({ to: b, duration: Math.max(3, this.angle(a, b) / v1), dwell: this.range(0.3, 1.2), aperture: 0.2, intensity: 1.05 });
            }
            break;
          }
        }
        const h = this.setup.horizon;
        const dir = here.heading > (h.from + h.to) / 2 ? -1 : 1;
        const legs = 2 + Math.floor(this.rand() * 3);
        let at = here;
        for (let i = 0; i < legs; i++) {
          const span = this.range(9, 22) * DEG * dir;
          let to = { heading: Math.min(h.to, Math.max(h.from, at.heading + span)), pitch: this.range(h.pitch[0], h.pitch[1]) };
          if (!this.pathAllowed(at, to)) to = this.horizonTarget(at);
          const speed = this.range(2.2, 4.8) * DEG * slow * (0.85 + act * 0.3);
          plan.push({ to, duration: Math.max(2, this.angle(at, to) / speed), dwell: this.rand() < 0.45 ? this.range(0.5, 1.8) : this.range(0, 0.3), aperture: 0.15, intensity: 1 });
          at = to;
        }
        break;
      }
      case 'search': {
        const hops = 2 + Math.floor(this.rand() * (3 + act * 2));
        let at = here;
        for (let i = 0; i < hops; i++) {
          const to = this.landTarget(at, deg(4), deg(24));
          const speed = this.range(6, 15) * DEG * slow * (0.8 + act * 0.45);
          const dwell = this.rand() < 0.3 ? this.range(1.4, 2.6) : this.range(0.35, 1.2);
          plan.push({ to, duration: Math.max(0.8, this.angle(at, to) / speed), dwell: dwell * (1.15 - act * 0.3), aperture: 0.2, intensity: 1.05 });
          at = to;
        }
        break;
      }
      case 'focus': {
        const hold = this.range(1.4, 3.2);
        plan.push({ to: null, duration: this.range(0.8, 1.2), dwell: hold, aperture: 1, intensity: 1.5 });
        plan.push({ to: null, duration: this.range(1.0, 1.5), dwell: 0, aperture: 0.2, intensity: 1.05 });
        break;
      }
      case 'rapid': {
        if (env.reducedMotion) {
          this.enter('search', env);
          return;
        }
        const to = this.landTarget(here, deg(26), deg(70));
        const a = this.angle(here, to);
        plan.push({ to, duration: Math.max(1.0, Math.min(2.0, a / (deg(38) * (0.9 + act * 0.25)))), dwell: this.range(0.5, 1.4), aperture: 0.3, intensity: 1.12 });
        break;
      }
      case 'gaze': {
        const to = this.horizonTarget(here, deg(6));
        plan.push({ to, duration: Math.max(2.8, this.angle(here, to) / (deg(5) * slow)), dwell: this.range(8, 16), aperture: 0.4, intensity: 1.12 });
        break;
      }
      case 'return': {
        const to = this.horizonTarget(here);
        plan.push({ to, duration: Math.max(2.5, this.angle(here, to) / (deg(6) * slow)), dwell: this.range(0.3, 1.2), aperture: 0.15, intensity: 1 });
        break;
      }
      case 'awaken': {
        // Rises to look out over the horizon as the fire swells; the cage opens wide.
        const to = this.horizonTarget(here);
        plan.push({ to, duration: Math.max(2.4, this.angle(here, to) / (deg(7) * slow)), dwell: 0, aperture: -0.6, intensity: 2.5 });
        break;
      }
    }
    this.plan = plan;
    this.move = null;
    this.dwell = 0;
    this.nextStep();
  }

  private nextStep(): boolean {
    const step = this.plan.shift();
    if (!step) return false;
    this.apertureTarget = step.aperture;
    this.intensityTarget = step.intensity;
    const from: Gaze = { heading: this.cmd.heading, pitch: this.cmd.pitch };
    if (step.to) {
      this.move = { from, to: step.to, duration: step.duration, t: 0, arc: this.range(-1, 1) * Math.min(0.12, this.angle(from, step.to) * 0.18) };
    } else {
      this.move = { from, to: from, duration: step.duration, t: 0, arc: 0 };
    }
    this.dwell = step.dwell;
    return true;
  }

  private chooseNext(env: WardenInputs): WardenState {
    const act = Math.min(1, Math.max(0, env.activity));
    const last = this.history[this.history.length - 1];
    const prev = this.history[this.history.length - 2];
    const w = (s: WardenState, base: number) => {
      let v = base;
      if (s === last) v *= 0.45;
      if (s === last && s === prev) v *= 0.3;
      return { item: s, w: v };
    };
    switch (this.state) {
      case 'scan':
        return this.pick([w('search', 0.45 + act * 0.2), w('gaze', 0.22 - act * 0.08), w('rapid', 0.1 + act * 0.15), w('scan', 0.15)]);
      case 'search':
        return this.pick([w('focus', 0.4), w('rapid', 0.12 + act * 0.18), w('return', 0.24 - act * 0.08), w('gaze', 0.14), w('search', 0.12)]);
      case 'focus':
        return this.pick([w('search', 0.45), w('rapid', 0.18 + act * 0.12), w('return', 0.22), w('gaze', 0.1)]);
      case 'rapid':
        return this.pick([w('focus', 0.45), w('search', 0.45), w('gaze', 0.1)]);
      case 'gaze':
        return 'return';
      case 'return':
        return 'scan';
      case 'awaken':
        return this.resumeAfterAwaken;
    }
  }

  update(dtIn: number, env: WardenInputs): WardenOutput {
    const dt = Math.min(0.1, Math.max(0, dtIn));
    this.time += dt;

    // Awakening: requested, or rarely on its own.
    if (this.time > this.nextAwaken && this.awakenPhase === 'none') {
      this.awakenPending = 0.8;
      this.nextAwaken = this.time + (this.setup.awakenEvery ?? Infinity) * (0.6 + this.rand() * 0.8);
    }
    if (this.awakenPending > 0 && this.awakenPhase === 'none') {
      this.awakenPhase = 'rise';
      this.awakenTimer = 0;
      this.resumeAfterAwaken = this.rand() < 0.6 ? 'search' : 'rapid';
      this.enter('awaken', env);
      this.awakenTimer = -this.awakenPending * 4.5;
      this.awakenPending = 0;
    }
    if (this.awakenPhase !== 'none') {
      if (this.awakenPhase === 'rise') {
        this.awakenLevel = Math.min(1, this.awakenLevel + dt / 1.8);
        if (this.awakenLevel >= 1) this.awakenPhase = 'hold';
      } else if (this.awakenPhase === 'hold') {
        this.awakenTimer += dt;
        if (this.awakenTimer > 0) this.awakenPhase = 'fall';
      } else {
        this.awakenLevel = Math.max(0, this.awakenLevel - dt / 3.2);
        if (this.awakenLevel <= 0) {
          this.awakenPhase = 'none';
          this.intensityTarget = 1;
          this.apertureTarget = 0.2;
          this.enter(this.chooseNext(env), env);
        }
      }
    }

    // Advance the plan.
    if (this.move) {
      const m = this.move;
      m.t += dt;
      const k = minJerk(m.t / m.duration);
      const bump = Math.sin(Math.PI * Math.min(1, m.t / m.duration));
      const dh = m.to.heading - m.from.heading;
      const dp = m.to.pitch - m.from.pitch;
      const len = Math.hypot(dh, dp) || 1;
      this.cmd.heading = m.from.heading + dh * k + (-dp / len) * m.arc * bump;
      this.cmd.pitch = m.from.pitch + dp * k + (dh / len) * m.arc * bump * 0.5;
      if (m.t >= m.duration) this.move = null;
    } else if (this.dwell > 0) {
      this.dwell -= dt;
    } else if (!this.nextStep() && this.state !== 'awaken') {
      this.enter(this.chooseNext(env), env);
    } else if (this.state === 'awaken' && this.plan.length === 0 && !this.move) {
      // Hold the wide gaze while the awakening runs its course.
      this.dwell = 0.25;
    }

    // Living wander on top of the command: slow, small, never periodic.
    const still = this.move ? 0.35 : 1;
    const wanderAmp = (this.state === 'gaze' ? 0.35 : this.state === 'focus' ? 0.18 : 0.5) * DEG * still;
    const th = this.cmd.heading + this.wander(this.time * 0.23) * wanderAmp + this.wander2(this.time * 0.71) * wanderAmp * 0.3;
    const tp = this.cmd.pitch + this.wander2(this.time * 0.19 + 40) * wanderAmp * 0.6;

    // Critically damped follower (the cage's mass): no snaps, a little lag.
    const omega = env.reducedMotion ? 2.2 : 3.4;
    const follow = (x: number, v: number, target: number): [number, number] => {
      const a = omega * omega * (target - x) - 2 * omega * v;
      v += a * dt;
      x += v * dt;
      return [x, v];
    };
    [this.cur.heading, this.vel.heading] = follow(this.cur.heading, this.vel.heading, th);
    [this.cur.pitch, this.vel.pitch] = follow(this.cur.pitch, this.vel.pitch, tp);
    this.speed = Math.hypot(this.vel.heading * Math.cos(this.cur.pitch), this.vel.pitch);

    // Aperture and intensity ease (focus tightens over about a second).
    const ease = (x: number, target: number, rate: number) => x + (target - x) * (1 - Math.exp(-dt * rate));
    this.aperture = ease(this.aperture, this.apertureTarget, 2.6);
    const awakeBoost = this.awakenLevel * 1.2;
    this.intensity = ease(this.intensity, this.intensityTarget, 2.0);
    this.focusLevel = Math.max(0, Math.min(1, this.aperture));

    return {
      state: this.state,
      heading: this.cur.heading,
      pitch: this.cur.pitch,
      aperture: this.aperture,
      intensity: this.awakenPhase !== 'none' ? Math.max(this.intensity, 1 + awakeBoost) : this.intensity,
      awaken: this.awakenLevel,
      speed: this.speed,
      focus: this.focusLevel,
    };
  }
}
