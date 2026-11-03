/**
 * The Veil's event director: decides what happens out in the fog, and when.
 *
 * Pure logic (no three.js), seeded per session, so a session's run of events is reproducible in
 * tests but different every time you play. It never runs everything: after a quiet opening, an
 * event is drawn from the kinds whose cooldowns have expired, weighted, with long gaps between
 * them (and sometimes a stretch where nothing happens at all). Creature events never overlap one
 * another; fog events may run alongside them. A big rise in the music's section intensity can call
 * the next creature event a little early, never on the beat.
 *
 * Comfort: `calm` (the world-events setting, or reduced motion) doubles the gaps, keeps creatures
 * further away and drops the sudden shadow events; `off` keeps only the slow fog weather.
 */

export type EventKind =
  | 'giantShadow' // a massive shadow behind the fog (the unseen giant)
  | 'treeWalker' // a creature walking between two trees, pausing
  | 'bankRoll' // a big fog bank rolling across
  | 'silhouette' // a silhouette against a brighter fog layer (the strider, backlit)
  | 'swarm' // several creatures moving together
  | 'shadowRuin' // a shadow passing over a ruined structure
  | 'reveal' // the mist clearing to reveal distant architecture
  | 'closing'; // fog closing over a previously visible area

export type Comfort = 'full' | 'calm' | 'off';

export const CREATURE_EVENTS: readonly EventKind[] = ['giantShadow', 'treeWalker', 'silhouette', 'swarm', 'shadowRuin'];
const SUDDEN: readonly EventKind[] = ['giantShadow', 'shadowRuin'];

interface KindSpec {
  /** Duration range (s). */
  readonly duration: readonly [number, number];
  /** Cooldown after it ends before the same kind may run again (s). */
  readonly cooldown: readonly [number, number];
  readonly weight: number;
}

export const KINDS: Readonly<Record<EventKind, KindSpec>> = {
  giantShadow: { duration: [70, 95], cooldown: [300, 420], weight: 0.6 },
  treeWalker: { duration: [55, 80], cooldown: [140, 220], weight: 1.2 },
  bankRoll: { duration: [45, 65], cooldown: [110, 180], weight: 1.0 },
  silhouette: { duration: [80, 110], cooldown: [200, 300], weight: 1.0 },
  swarm: { duration: [35, 55], cooldown: [120, 200], weight: 1.0 },
  shadowRuin: { duration: [60, 85], cooldown: [260, 380], weight: 0.7 },
  reveal: { duration: [55, 75], cooldown: [240, 360], weight: 0.8 },
  closing: { duration: [40, 60], cooldown: [150, 240], weight: 0.7 },
};

export interface VeilEvent {
  readonly id: number;
  readonly kind: EventKind;
  readonly start: number;
  readonly duration: number;
  /** A per-event random value (path variant, side). */
  readonly variant: number;
  /** Whether this event was forced (debug captures) rather than scheduled. */
  readonly forced: boolean;
}

/** Deterministic mulberry32 in 0..1. */
function makeRng(seed: number): () => number {
  let st = seed >>> 0 || 1;
  return () => {
    st = (st + 0x6d2b79f5) >>> 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Director {
  /** Seconds since the world was first shown. */
  time = 0;
  readonly active: VeilEvent[] = [];
  readonly history: VeilEvent[] = [];
  comfort: Comfort = 'full';
  private readonly rng: () => number;
  private readonly cooldownUntil = new Map<EventKind, number>();
  private nextCreatureAt: number;
  private nextFogAt: number;
  private nextId = 1;
  private sectionAvg = 0.5;

  constructor(seed: number) {
    this.rng = makeRng(seed);
    // A quiet opening: the first sign of anything comes after 25..45 s, the first fog event later.
    this.nextCreatureAt = 25 + this.rng() * 20;
    this.nextFogAt = 50 + this.rng() * 40;
  }

  private range(r: readonly [number, number]): number {
    return r[0] + (r[1] - r[0]) * this.rng();
  }

  private gapScale(): number {
    return this.comfort === 'calm' ? 2 : 1;
  }

  /** Kinds allowed under the current comfort setting. */
  allowed(kind: EventKind): boolean {
    if (this.comfort === 'off') return kind === 'bankRoll' || kind === 'reveal' || kind === 'closing';
    if (this.comfort === 'calm') return !SUDDEN.includes(kind);
    return true;
  }

  /** The active event of a kind, with its progress 0..1, or null. */
  find(kind: EventKind): { event: VeilEvent; progress: number; elapsed: number } | null {
    for (const e of this.active) {
      if (e.kind === kind) {
        const elapsed = this.time - e.start;
        return { event: e, progress: Math.min(1, Math.max(0, elapsed / e.duration)), elapsed };
      }
    }
    return null;
  }

  creatureBusy(): boolean {
    return this.active.some((e) => CREATURE_EVENTS.includes(e.kind));
  }

  /** Starts an event now (debug captures and tests); ignores cooldowns, not comfort. */
  force(kind: EventKind, variant = this.rng()): VeilEvent | null {
    if (!this.allowed(kind)) return null;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i]!;
      if (e.kind === kind || (CREATURE_EVENTS.includes(kind) && CREATURE_EVENTS.includes(e.kind))) this.active.splice(i, 1);
    }
    return this.begin(kind, variant, true);
  }

  private begin(kind: EventKind, variant: number, forced: boolean): VeilEvent {
    const e: VeilEvent = { id: this.nextId++, kind, start: this.time, duration: this.range(KINDS[kind].duration), variant, forced };
    this.active.push(e);
    this.history.push(e);
    if (this.history.length > 64) this.history.shift();
    return e;
  }

  private pick(kinds: readonly EventKind[]): EventKind | null {
    const ready = kinds.filter((k) => this.allowed(k) && (this.cooldownUntil.get(k) ?? -1) <= this.time && !this.active.some((e) => e.kind === k));
    if (ready.length === 0) return null;
    const total = ready.reduce((s, k) => s + KINDS[k].weight, 0);
    let r = this.rng() * total;
    for (const k of ready) {
      r -= KINDS[k].weight;
      if (r <= 0) return k;
    }
    return ready[ready.length - 1]!;
  }

  /**
   * Advances the director. `section` is the music's section intensity (0..1): a sustained rise of
   * more than about 0.2 above its slow average brings the next creature event forward.
   */
  update(dt: number, section = 0.5): void {
    this.time += dt;
    // End finished events and start their cooldowns.
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i]!;
      if (this.time >= e.start + e.duration) {
        this.active.splice(i, 1);
        this.cooldownUntil.set(e.kind, this.time + this.range(KINDS[e.kind].cooldown) * this.gapScale());
        if (CREATURE_EVENTS.includes(e.kind)) this.nextCreatureAt = Math.max(this.nextCreatureAt, this.time + (20 + this.rng() * 50) * this.gapScale());
      }
    }
    // Big musical transitions: the next creature may come early (by at most half the wait).
    this.sectionAvg += (section - this.sectionAvg) * Math.min(1, dt / 20);
    if (section - this.sectionAvg > 0.2 && !this.creatureBusy()) {
      const wait = this.nextCreatureAt - this.time;
      if (wait > 8) this.nextCreatureAt = this.time + Math.max(6, wait * 0.5);
      this.sectionAvg = section;
    }
    if (this.time >= this.nextCreatureAt && !this.creatureBusy()) {
      // Sometimes nothing: a stretch with no creature at all.
      if (this.rng() < 0.22) {
        this.nextCreatureAt = this.time + (45 + this.rng() * 60) * this.gapScale();
      } else {
        const k = this.pick(CREATURE_EVENTS);
        if (k) this.begin(k, this.rng(), false);
        this.nextCreatureAt = this.time + (k ? 30 : 15) * this.gapScale();
      }
    }
    if (this.time >= this.nextFogAt) {
      const k = this.pick(['bankRoll', 'reveal', 'closing']);
      if (k) this.begin(k, this.rng(), false);
      this.nextFogAt = this.time + (70 + this.rng() * 80) * this.gapScale();
    }
  }
}
