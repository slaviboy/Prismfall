/**
 * Dark Storm's storm director: what the storm is doing, and when lightning strikes.
 *
 * Pure logic (no three.js, no audio), seeded per session, so a session's storm is reproducible in
 * tests but different every time you play. The storm moves between four states:
 *
 * - calm: continuous rain, dark clouds, occasional distant lightning and soft thunder;
 * - active: heavy rain, stronger wind, more frequent lightning, louder thunder;
 * - intense: very heavy rain, powerful lightning, large illumination events, deep rolls;
 * - distant: the storm carries on, its lightning mostly far away, thunder late and soft.
 *
 * States last tens of seconds to a couple of minutes and are left by weighted, never scripted,
 * transitions; the music's section intensity and the game's progress lean the choice towards the
 * stormier states (gameplay is never touched). Every level (rain, wind, lightning rate, thunder) eases
 * towards its state's target over many seconds, so the storm swells and ebbs instead of switching.
 *
 * Strikes come from a Poisson process at the current rate with clusters (a second strike soon after a
 * first in the stormy states) and lulls (stretches of dark and quiet). Each strike has one of four
 * intensity levels (1 small flashes inside distant clouds, 2 strikes along the horizon, 3 large
 * branching bolts, 4 powerful nearby lightning), a kind, a place, an energy, its return strokes and a
 * shape seed. A flash governor guarantees, whatever the settings, that no more than three flash onsets
 * ever fall inside any one second (photosensitivity guidance), and the comfort settings thin the storm
 * much further (see `StormComfort`).
 */

export type StormState = 'calm' | 'active' | 'intense' | 'distant';
export type StrikeKind = 'intracloud' | 'cloudToCloud' | 'cloudToGround';
export type StrikeLevel = 1 | 2 | 3 | 4;

export const STORM_STATES: readonly StormState[] = ['calm', 'active', 'intense', 'distant'];

export interface Strike {
  readonly id: number;
  /** Director time (s) of the first return stroke: the flash onset. */
  readonly at: number;
  readonly level: StrikeLevel;
  readonly kind: StrikeKind;
  /** Degrees from the view direction (towards −z), positive to the right. */
  readonly azimuth: number;
  /** Distance from the viewer in world metres (what is drawn). */
  readonly distance: number;
  /** 0..1: peak illumination and loudness. */
  readonly energy: number;
  /** Onset times of the return strokes, seconds after `at` (the first is 0). */
  readonly strokes: readonly number[];
  /** Shape seed of the channel (a 32-bit integer). */
  readonly seed: number;
  /** Started by a QUAD accent rather than by the storm itself. */
  readonly accent: boolean;
}

export interface StormLevels {
  /** Rain intensity: 1 = heavy rain, up to about 1.4 in a cloudburst. */
  rain: number;
  /** Base wind strength 0..1.2. */
  wind: number;
  /** Current gust 0..1 (on top of the wind). */
  gust: number;
  /** Lightning rate (strikes per minute) before comfort scaling. */
  lightning: number;
  /** Share of strikes that come close (levels 3 and 4). */
  near: number;
  /** Thunder loudness scale 0..1. */
  thunder: number;
  /** Cloud motion speed (relative). */
  cloudSpeed: number;
}

/**
 * Comfort and intensity. `mode` maps the accessibility settings: `full`; `calm` (World events: calm,
 * or reduced motion) halves the lightning, keeps it at least a kilometre away and caps the return
 * strokes; `off` (World events: off) keeps only small, distant flashes. `flashReduced` (Reduce
 * flashing) allows a single smooth flash per strike, at least 2.5 s apart. `intensity` is the
 * Storm intensity setting (0.55 subtle, 1 normal, 1.35 heavy, 1.7 extreme).
 */
export interface StormComfort {
  mode: 'full' | 'calm' | 'off';
  flashReduced: boolean;
  intensity: number;
}

interface StateSpec {
  readonly dwell: readonly [number, number];
  readonly target: Omit<StormLevels, 'gust'>;
  /** Weights of the levels 1..4. */
  readonly levels: readonly [number, number, number, number];
  readonly next: Partial<Record<StormState, number>>;
  /** Chance that a strike is followed closely by another (a cluster). */
  readonly cluster: number;
}

export const STATES: Readonly<Record<StormState, StateSpec>> = {
  calm: {
    dwell: [50, 110],
    target: { rain: 0.72, wind: 0.35, lightning: 3.2, near: 0.06, thunder: 0.62, cloudSpeed: 0.6 },
    levels: [0.52, 0.36, 0.12, 0],
    next: { active: 0.6, distant: 0.3, intense: 0.1 },
    cluster: 0.04,
  },
  active: {
    dwell: [45, 100],
    target: { rain: 1.0, wind: 0.62, lightning: 7, near: 0.22, thunder: 0.85, cloudSpeed: 1 },
    levels: [0.32, 0.33, 0.26, 0.09],
    next: { intense: 0.45, calm: 0.35, distant: 0.2 },
    cluster: 0.12,
  },
  intense: {
    dwell: [28, 65],
    target: { rain: 1.28, wind: 0.95, lightning: 12.5, near: 0.45, thunder: 1, cloudSpeed: 1.45 },
    levels: [0.18, 0.27, 0.33, 0.22],
    next: { active: 0.7, calm: 0.2, distant: 0.1 },
    cluster: 0.3,
  },
  distant: {
    dwell: [40, 95],
    target: { rain: 0.55, wind: 0.3, lightning: 4.2, near: 0, thunder: 0.45, cloudSpeed: 0.7 },
    levels: [0.6, 0.35, 0.05, 0],
    next: { calm: 0.55, active: 0.45 },
    cluster: 0.03,
  },
};

/**
 * What the music's sections ask of the storm (StormDirector.followSection): a build stirs it up, a
 * drop brings the intense core, a break lets it ease off or draw away, an outro carries it into the
 * distance. Intros, verses and bridges leave the storm to its own course.
 */
export const SECTION_STATES: Readonly<Record<string, readonly StormState[]>> = {
  build: ['active'],
  drop: ['intense'],
  break: ['calm', 'distant'],
  outro: ['distant', 'calm'],
};

/** A state lasts at least this long (s) before a section of the music may move the storm on. */
export const SECTION_HOLD = 16;

/** Distance range (world metres) of each level. */
export const LEVEL_DISTANCE: Readonly<Record<StrikeLevel, readonly [number, number]>> = {
  1: [1600, 3400],
  2: [1150, 1700],
  3: [560, 1100],
  4: [170, 420],
};

const LEVEL_ENERGY: Readonly<Record<StrikeLevel, readonly [number, number]>> = {
  1: [0.15, 0.35],
  2: [0.3, 0.55],
  3: [0.55, 0.8],
  4: [0.82, 1],
};

const LEVEL_STROKES: Readonly<Record<StrikeLevel, readonly [number, number]>> = {
  1: [1, 3],
  2: [1, 3],
  3: [1, 4],
  4: [2, 5],
};

/** The photosensitivity ceiling: flash onsets allowed in any one-second window. */
export const MAX_FLASHES_PER_SECOND = 3;
/** Minimum spacing between strikes with Reduce flashing on (seconds). */
export const REDUCED_FLASH_GAP = 2.5;

/** World metres are compressed against the sky's real scale: thunder is timed by this apparent distance. */
export const APPARENT_SCALE = 2.2;
export const SPEED_OF_SOUND = 343;
/** Longest thunder delay: very distant storms still answer within this many seconds. */
export const MAX_THUNDER_DELAY = 15;

/** Apparent (acoustic) distance of a strike drawn `distance` world metres away. */
export function apparentDistance(distance: number): number {
  return Math.max(0, distance) * APPARENT_SCALE;
}

/**
 * Seconds from the flash to its thunder: the apparent distance at the speed of sound, compressed
 * smoothly so the farthest storms still arrive within MAX_THUNDER_DELAY.
 */
export function thunderDelay(distance: number): number {
  const raw = apparentDistance(distance) / SPEED_OF_SOUND;
  return MAX_THUNDER_DELAY * (1 - Math.exp(-raw / MAX_THUNDER_DELAY));
}

/** Deterministic mulberry32 in 0..1. */
export function makeRng(seed: number): () => number {
  let st = seed >>> 0 || 1;
  return () => {
    st = (st + 0x6d2b79f5) >>> 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Keeps flash onsets under the photosensitivity ceiling: at most MAX_FLASHES_PER_SECOND inside any
 * one-second window, never closer than 40 ms, and with Reduce flashing one flash per strike at least
 * REDUCED_FLASH_GAP apart. Onsets are recorded in director time.
 */
export class FlashGovernor {
  private readonly onsets: number[] = [];

  /** Onsets in (t − 1, t + 1): what a new onset at t would share a window with. */
  private near(t: number): number[] {
    return this.onsets.filter((o) => o > t - 1 && o < t + 1);
  }

  /** Would an onset at time t keep every one-second window at or under the ceiling? */
  allows(t: number, reduced: boolean): boolean {
    const around = this.near(t);
    if (around.some((o) => Math.abs(o - t) < (reduced ? REDUCED_FLASH_GAP : 0.04))) return false;
    if (reduced && this.onsets.some((o) => Math.abs(o - t) < REDUCED_FLASH_GAP)) return false;
    // Every one-second window containing t is [w, w + 1) for some w in (t − 1, t]; its count only
    // changes at onsets, so the windows starting at t and at each earlier onset within a second
    // cover every case (later onsets already recorded, e.g. another strike's strokes, included).
    const starts = [t, ...around.filter((o) => o < t && o > t - 1)];
    for (const w of starts) {
      const n = around.filter((o) => o >= w && o < w + 1).length + 1;
      if (n > MAX_FLASHES_PER_SECOND) return false;
    }
    return true;
  }

  record(t: number): void {
    this.onsets.push(t);
    this.onsets.sort((a, b) => a - b);
    while (this.onsets.length > 0 && this.onsets[0]! < t - 30) this.onsets.shift();
  }

  /** The admitted subset of a strike's stroke onsets (absolute times), recorded. */
  admit(times: readonly number[], reduced: boolean): number[] {
    const out: number[] = [];
    for (const t of reduced ? times.slice(0, 1) : times) {
      if (this.allows(t, reduced)) {
        this.record(t);
        out.push(t);
      }
    }
    return out;
  }

  /** All recorded onsets (tests). */
  get history(): readonly number[] {
    return this.onsets;
  }
}

export interface MusicBias {
  /** The music's section intensity 0..1. */
  section: number;
  /** Game progress 0..1 (Voyage leg, Sprint goal) or 0. */
  progress: number;
}

export class StormDirector {
  /** Seconds since the storm began. */
  time = 0;
  state: StormState = 'active';
  /** Seconds the current state has run. */
  stateTime = 0;
  readonly levels: StormLevels;
  comfort: StormComfort = { mode: 'full', flashReduced: false, intensity: 1 };
  readonly history: Strike[] = [];
  readonly governor = new FlashGovernor();
  private readonly rng: () => number;
  private dwell: number;
  private nextStrikeAt: number;
  private nextId = 1;
  private lullUntil = 0;
  private gustTime = 0;
  private gustLength = 0;
  private gustPeak = 0;
  private nextGustAt: number;
  /** Extra rain after a big strike (a cloudburst), decaying. */
  private burst = 0;
  private pendingAccent: number | null = null;
  private lastAccent = -100;
  private sectionAvg = 0.5;
  /** States visited (tests, review tools). */
  readonly visited: { state: StormState; at: number }[] = [];

  constructor(seed: number) {
    this.rng = makeRng(seed);
    const t = STATES.active.target;
    this.levels = { rain: t.rain * 0.85, wind: t.wind * 0.8, gust: 0, lightning: t.lightning, near: t.near, thunder: t.thunder, cloudSpeed: t.cloudSpeed };
    this.dwell = this.range(STATES.active.dwell);
    // The storm shows itself early: a first strike within a few seconds of arriving.
    this.nextStrikeAt = 2.5 + this.rng() * 3.5;
    this.nextGustAt = 4 + this.rng() * 8;
    this.visited.push({ state: this.state, at: 0 });
  }

  private range(r: readonly [number, number]): number {
    return r[0] + (r[1] - r[0]) * this.rng();
  }

  private pickWeighted<T extends string>(weights: Partial<Record<T, number>>): T {
    const entries = Object.entries(weights) as [T, number][];
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.rng() * total;
    for (const [k, w] of entries) {
      r -= w;
      if (r <= 0) return k;
    }
    return entries[entries.length - 1]![0];
  }

  /** Lightning rate after comfort and the intensity setting (strikes per minute). */
  effectiveRate(): number {
    const c = this.comfort;
    const k = c.mode === 'off' ? 0.35 : c.mode === 'calm' ? 0.5 : 1;
    const intensity = 0.45 + 0.55 * c.intensity;
    return this.levels.lightning * k * intensity;
  }

  /** The highest level the comfort settings allow. */
  maxLevel(): StrikeLevel {
    if (this.comfort.mode === 'off') return 2;
    if (this.comfort.mode === 'calm') return 3;
    return 4;
  }

  private changeState(bias: MusicBias): void {
    const spec = STATES[this.state];
    const weights: Partial<Record<StormState, number>> = { ...spec.next };
    // The music's climaxes and a game nearing its goal lean towards the stormier states.
    const push = Math.max(0, this.sectionAvg - 0.55) * 1.6 + bias.progress * 0.5;
    if (weights.intense !== undefined) weights.intense *= 1 + push * 1.5;
    if (weights.active !== undefined) weights.active *= 1 + push * 0.6;
    if (weights.distant !== undefined) weights.distant *= Math.max(0.2, 1 - push);
    // A section of the music asked for a state: go there (among its choices, by the same weights).
    const wanted = this.wanted?.filter((st) => st !== this.state) ?? [];
    this.wanted = null;
    const next = wanted.length > 0 ? this.pickWeighted(Object.fromEntries(wanted.map((st) => [st, weights[st] ?? 0.5])) as Partial<Record<StormState, number>>) : this.pickWeighted(weights);
    const intoIntense = next === 'intense';
    this.state = next;
    this.stateTime = 0;
    this.dwell = this.range(STATES[next].dwell);
    this.visited.push({ state: next, at: this.time });
    if (this.visited.length > 64) this.visited.shift();
    // A change of state comes with a strong gust (stronger into the intense core).
    this.startGust(intoIntense ? 0.75 + this.rng() * 0.25 : 0.35 + this.rng() * 0.35, 3 + this.rng() * 4);
  }

  private startGust(peak: number, seconds: number): void {
    if (peak <= this.gustPeak * Math.max(0, 1 - this.gustTime / Math.max(0.001, this.gustLength))) return;
    this.gustPeak = Math.min(1, peak);
    this.gustLength = seconds;
    this.gustTime = 0;
  }

  /**
   * A controlled answer to a QUAD (or a call-in from the manifest): one strike soon, of `level` (3 by
   * default; calm comfort keeps it at 2). Rate-limited to one every eight seconds; comfort and the
   * flash governor apply.
   */
  accent(level: StrikeLevel = 3): void {
    if (this.comfort.mode === 'off') return;
    if (this.time - this.lastAccent < 8) return;
    this.lastAccent = this.time;
    this.accentLevel = level;
    this.pendingAccent = this.time + 0.3 + this.rng() * 0.6;
  }

  private accentLevel: StrikeLevel = 3;
  /** States a section of the music asked for, taken at the next change of state. */
  private wanted: readonly StormState[] | null = null;

  /**
   * The music entered a section of `kind` (SECTION_STATES): the storm moves towards the state that
   * section asks for, by its own rules. The current state still runs at least SECTION_HOLD seconds
   * and the move comes a moment after the section starts (never on the beat); every level then eases
   * there over many seconds as usual. Already in that state, it stays for the section. Sections that
   * ask for nothing leave the storm to its own course.
   */
  followSection(kind: string): void {
    const want = SECTION_STATES[kind];
    if (!want) {
      this.wanted = null;
      return;
    }
    if (want.includes(this.state)) {
      this.wanted = null;
      this.dwell = Math.max(this.dwell, this.stateTime + 25);
      return;
    }
    this.wanted = want;
    this.dwell = Math.min(this.dwell, Math.max(SECTION_HOLD, this.stateTime + 1 + this.rng() * 3));
  }

  private readonly forced: { level: StrikeLevel; azimuth?: number; distance?: number }[] = [];

  /**
   * Queues a strike for the next update (review captures and tests): any level the comfort settings
   * allow, optionally at a given azimuth and distance; the flash governor still applies.
   */
  force(level: StrikeLevel, azimuth?: number, distance?: number): void {
    this.forced.push({ level: Math.min(level, this.maxLevel()) as StrikeLevel, azimuth, distance });
  }

  private pendingFlicker: number | null = null;
  private lastFlicker = -100;

  /** A softer answer to a two- or three-line clear: a flicker inside the clouds (rate-limited). */
  flicker(): void {
    if (this.time - this.lastFlicker < 6) return;
    this.lastFlicker = this.time;
    this.pendingFlicker = this.time + 0.15 + this.rng() * 0.3;
  }

  private chooseLevel(): StrikeLevel {
    const w = [...STATES[this.state].levels];
    // Storm intensity: heavier settings bring more of the big, near strikes.
    const k = this.comfort.intensity;
    w[2] = w[2]! * (0.6 + 0.4 * k);
    w[3] = w[3]! * Math.max(0, 0.25 + 0.75 * (k - 0.4));
    const max = this.maxLevel();
    for (let i = max; i < 4; i++) w[i] = 0;
    const total = w.reduce((s, v) => s + v, 0);
    let r = this.rng() * total;
    for (let i = 0; i < 4; i++) {
      r -= w[i]!;
      if (r <= 0) return (i + 1) as StrikeLevel;
    }
    return 1;
  }

  private makeStrike(level: StrikeLevel, accent: boolean, place?: { azimuth?: number; distance?: number }): Strike | null {
    const kindRoll = this.rng();
    const kind: StrikeKind = level === 1 ? (kindRoll < 0.7 ? 'intracloud' : 'cloudToCloud') : level === 2 ? (kindRoll < 0.6 ? 'cloudToGround' : 'cloudToCloud') : level === 3 ? (kindRoll < 0.8 ? 'cloudToGround' : 'cloudToCloud') : 'cloudToGround';
    const range = LEVEL_DISTANCE[level];
    const d1 = range[1];
    let d0 = range[0];
    if (this.comfort.mode === 'calm') d0 = Math.max(d0, 1000);
    if (this.state === 'distant') d0 = d0 + (d1 - d0) * 0.5;
    const distance = place?.distance ?? d0 + (d1 - d0) * Math.pow(this.rng(), 0.8);
    // Most visible bolts fall in view to either side of the playfield (never right behind it);
    // the rest anywhere around (seen in VR, felt as light from the side on the desktop).
    let azimuth: number;
    if (this.rng() < 0.78) {
      const side = this.rng() < 0.5 ? -1 : 1;
      azimuth = side * (13 + this.rng() * 47);
    } else {
      azimuth = -170 + this.rng() * 340;
      if (kind !== 'intracloud' && Math.abs(azimuth) < 13) azimuth = Math.sign(azimuth || 1) * (13 + this.rng() * 10);
    }
    if (place?.azimuth !== undefined) azimuth = place.azimuth;
    const energy = this.range(LEVEL_ENERGY[level]) * (this.state === 'distant' ? 0.85 : 1);
    // Return strokes along the same channel, 40-140 ms apart (comfort caps them).
    let count = Math.round(this.range(LEVEL_STROKES[level]));
    if (this.comfort.mode !== 'full') count = Math.min(count, 2);
    const offsets = [0];
    let t = 0;
    for (let i = 1; i < count; i++) {
      t += 0.04 + this.rng() * 0.1;
      offsets.push(t);
    }
    const at = this.time;
    const admitted = this.governor.admit(offsets.map((o) => at + o), this.comfort.flashReduced);
    if (admitted.length === 0) return null;
    const strike: Strike = { id: this.nextId++, at, level, kind, azimuth, distance, energy, strokes: admitted.map((a) => a - at), seed: (this.rng() * 4294967296) >>> 0, accent };
    this.history.push(strike);
    if (this.history.length > 256) this.history.shift();
    if (level === 4) this.burst = Math.min(0.35, this.burst + 0.22);
    else if (level === 3) this.burst = Math.min(0.35, this.burst + 0.06);
    return strike;
  }

  private scheduleNext(): void {
    const rate = Math.max(0.2, this.effectiveRate());
    // Exponential gaps (a Poisson process), never closer than a moment apart.
    const gap = -Math.log(1 - this.rng() * 0.999) * (60 / rate);
    let next = this.time + Math.max(this.comfort.flashReduced ? REDUCED_FLASH_GAP : 1.1, gap);
    // Clusters: in the stormy states a strike may be followed quickly by another.
    if (this.rng() < STATES[this.state].cluster * (this.comfort.mode === 'full' ? 1 : 0.3)) next = this.time + 0.9 + this.rng() * 2.2;
    // Lulls: now and then the sky stays dark and quiet for a while.
    else if (this.rng() < 0.1) {
      this.lullUntil = this.time + 7 + this.rng() * 14;
      next = Math.max(next, this.lullUntil);
    }
    this.nextStrikeAt = next;
  }

  /**
   * Advances the storm by dt seconds and returns the strikes that begin in this step. The music's
   * section intensity and the game's progress bias the next state.
   */
  update(dt: number, bias: MusicBias = { section: 0.5, progress: 0 }): Strike[] {
    const out: Strike[] = [];
    if (!(dt > 0)) return out;
    this.time += dt;
    this.stateTime += dt;
    this.sectionAvg += (bias.section - this.sectionAvg) * Math.min(1, dt / 15);
    // A big build in the music shortens a calm or distant spell.
    let dwell = this.dwell;
    if ((this.state === 'calm' || this.state === 'distant') && this.sectionAvg > 0.72) dwell *= 0.6;
    if (this.stateTime >= dwell) this.changeState(bias);

    // Levels ease towards the state's targets (rain and thunder slowly, wind a little faster).
    const target = STATES[this.state].target;
    const k = this.comfort.intensity;
    const ease = (cur: number, to: number, tau: number): number => cur + (to - cur) * (1 - Math.exp(-dt / tau));
    this.burst *= Math.exp(-dt / 20);
    const L = this.levels;
    L.rain = ease(L.rain, target.rain * (0.55 + 0.45 * k) + this.burst, 12);
    L.wind = ease(L.wind, Math.min(1.2, target.wind * (0.6 + 0.4 * k)), 8);
    L.lightning = ease(L.lightning, target.lightning, 10);
    L.near = ease(L.near, target.near, 10);
    L.thunder = ease(L.thunder, target.thunder, 9);
    L.cloudSpeed = ease(L.cloudSpeed, target.cloudSpeed, 15);

    // Gusts: random ones in proportion to the wind, each rising and falling over a few seconds.
    if (this.time >= this.nextGustAt) {
      this.startGust(0.2 + this.rng() * 0.6 * (0.5 + L.wind), 2 + this.rng() * 4.5);
      this.nextGustAt = this.time + 3 + (this.rng() * 14) / (0.4 + L.wind);
    }
    if (this.gustLength > 0) {
      this.gustTime += dt;
      const p = this.gustTime / this.gustLength;
      L.gust = p >= 1 ? 0 : this.gustPeak * Math.sin(Math.PI * Math.min(1, p)) ** 2;
      if (p >= 1) {
        this.gustLength = 0;
        this.gustPeak = 0;
      }
    }

    if (this.pendingAccent !== null && this.time >= this.pendingAccent) {
      const level = Math.min(this.accentLevel, this.comfort.mode === 'calm' ? 2 : this.maxLevel()) as StrikeLevel;
      const s = this.makeStrike(level, true);
      // Held back by the governor: try again shortly, for up to three seconds.
      this.pendingAccent = s || this.time - this.lastAccent > 3 ? null : this.time + 0.3;
      if (s) out.push(s);
    }
    while (this.forced.length > 0) {
      const f = this.forced.shift()!;
      const s = this.makeStrike(f.level, false, f);
      if (s) out.push(s);
    }
    if (this.pendingFlicker !== null && this.time >= this.pendingFlicker) {
      const s = this.makeStrike(1, true);
      this.pendingFlicker = s || this.time - this.lastFlicker > 2 ? null : this.time + 0.3;
      if (s) out.push(s);
    }
    if (this.time >= this.nextStrikeAt && this.time >= this.lullUntil) {
      const s = this.makeStrike(this.chooseLevel(), false);
      if (s) {
        out.push(s);
        this.scheduleNext();
      } else {
        // The governor held this one back: try again in a moment.
        this.nextStrikeAt = this.time + 0.35;
      }
    }
    return out;
  }
}

/**
 * Brightness of a strike's flash (0..1, before energy) `t` seconds after its onset: a faint stepped
 * leader in the few tens of milliseconds before, then each return stroke a near-instant rise with a
 * fast decay over a dimmer continuing current, so the dips between strokes never go fully dark. With
 * flash reduction the strokes merge into one slow, smooth swell.
 */
export function flashEnvelope(strokes: readonly number[], t: number, reduced: boolean): number {
  if (reduced) {
    if (t < 0) return 0;
    const rise = 1 - Math.exp(-t / 0.08);
    return rise * Math.exp(-t / 0.55);
  }
  if (t < -0.06) return 0;
  if (t < 0) return 0.06 * (1 + t / 0.06);
  let v = 0;
  for (let i = 0; i < strokes.length; i++) {
    const s = t - strokes[i]!;
    if (s < 0) continue;
    const peak = i === 0 ? 1 : 0.82;
    v = Math.max(v, peak * Math.exp(-s / 0.05) + 0.32 * peak * Math.exp(-s / 0.32));
  }
  return Math.min(1, v);
}

/** How long a strike stays visible or lit (seconds after its onset). */
export function strikeDuration(strokes: readonly number[], reduced: boolean): number {
  return (reduced ? 2.6 : 1.6) + (strokes[strokes.length - 1] ?? 0);
}
