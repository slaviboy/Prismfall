/**
 * The eruption's timing, kept free of rendering so it can be tested: when Strombolian bursts go
 * off, how big they are, and which of them charge the plume enough for volcanic lightning.
 *
 * Bursts come at irregular intervals in seconds (a triangular spread between the bounds, with
 * the odd quick doublet), never on the musical grid. A long, intense music section swells them
 * and shortens the gaps a little; a big line clear (QUAD or perfect clear) sets one off after a
 * natural delay. Lightning only follows large bursts, after a delay, with a long cooldown.
 */

export interface EruptionClockOptions {
  /** Seconds between bursts: [shortest, longest]. */
  readonly interval: readonly [number, number];
  /** 0..1: how much a sustained intense music section enlarges bursts and shortens gaps. */
  readonly music: number;
  /** Chance that the largest burst is followed by lightning (smaller bursts scale down to 0). */
  readonly lightningChance: number;
  /** Minimum seconds between lightning events. */
  readonly cooldown: number;
}

export interface BurstEvent {
  readonly kind: 'burst';
  readonly time: number;
  /** 0..1 (0.25 a small puff of spatter, 1 a big explosion). */
  readonly size: number;
}

export interface BoltEvent {
  readonly kind: 'lightning';
  readonly time: number;
  /** Return strokes in this discharge (1..3). */
  readonly strokes: number;
  /** 0..1 strength, from the burst that charged the plume. */
  readonly size: number;
}

export type EruptionEvent = BurstEvent | BoltEvent;

/** Bursts smaller than this never charge the plume. */
export const LIGHTNING_MIN_SIZE = 0.55;

export class EruptionClock {
  private nextBurst: number | null = null;
  private readonly pending: EruptionEvent[] = [];
  private lastBolt = -Infinity;
  private lastForced = -Infinity;
  /** Slow envelope of the music's section intensity (an intense section must last to count). */
  private intensity = 0.5;

  constructor(
    private readonly rand: () => number,
    private readonly o: EruptionClockOptions,
  ) {}

  /** Smoothed music intensity (0..1) the clock is currently using. */
  get musicLevel(): number {
    return this.intensity;
  }

  private interval(): number {
    const [a, b] = this.o.interval;
    const base = a + (b - a) * ((this.rand() + this.rand()) / 2);
    return base * (1 - 0.35 * this.o.music * Math.max(0, this.intensity - 0.3));
  }

  private size(): number {
    const s = 0.25 + 0.75 * Math.pow(this.rand(), 1.7);
    return Math.min(1, s * (1 + 0.6 * this.o.music * Math.max(0, this.intensity - 0.4)));
  }

  private queue(e: EruptionEvent): void {
    this.pending.push(e);
    this.pending.sort((x, y) => x.time - y.time);
  }

  private burst(time: number, size: number): void {
    this.queue({ kind: 'burst', time, size });
    if (this.o.lightningChance <= 0 || size < LIGHTNING_MIN_SIZE) return;
    const chance = this.o.lightningChance * ((size - LIGHTNING_MIN_SIZE) / (1 - LIGHTNING_MIN_SIZE));
    if (this.rand() >= chance) return;
    const at = time + 0.8 + this.rand() * 3;
    if (at - this.lastBolt < this.o.cooldown) return;
    this.lastBolt = at;
    const strokes = 1 + Math.floor(this.rand() * 2.6);
    this.queue({ kind: 'lightning', time: at, strokes: Math.min(3, strokes), size });
  }

  /**
   * Advances to `now` (seconds); returns the events that are due, in time order. `music` is the
   * current section intensity (0..1); lightning is dropped when `lightning` is false (flash
   * reduction).
   */
  update(now: number, dt: number, music: number, lightning: boolean): EruptionEvent[] {
    this.intensity += (Math.min(1, Math.max(0, music)) - this.intensity) * (1 - Math.exp(-Math.max(0, dt) / 8));
    // First burst a little after the world appears; after a long stall (hidden tab) resume
    // calmly instead of replaying every missed burst.
    if (this.nextBurst === null || now - this.nextBurst > 5) this.nextBurst = now + 1.5 + this.rand() * 4;
    while (now >= this.nextBurst) {
      const size = this.size();
      this.burst(this.nextBurst, size);
      // Now and then a second, smaller explosion follows closely.
      if (this.rand() < 0.18) this.burst(this.nextBurst + 1.4 + this.rand() * 2.6, size * (0.4 + this.rand() * 0.3));
      this.nextBurst += this.interval();
    }
    const due: EruptionEvent[] = [];
    while (this.pending.length > 0 && (this.pending[0] as EruptionEvent).time <= now) {
      const e = this.pending.shift() as EruptionEvent;
      if (e.kind === 'burst' || lightning) due.push(e);
    }
    return due;
  }

  /** A big line clear: a large burst follows after a short, natural delay (rate-limited). */
  bigClear(now: number): void {
    if (now - this.lastForced < 4) return;
    this.lastForced = now;
    const at = now + 0.6 + this.rand() * 1.6;
    this.burst(at, 0.85 + this.rand() * 0.15);
    // Keep the next regular burst from crowding it.
    if (this.nextBurst !== null) this.nextBurst = Math.max(this.nextBurst, at + this.o.interval[0]);
  }

  /** Immediate event (previews and captures). */
  trigger(kind: 'burst' | 'lightning', now: number, size = 1): void {
    if (kind === 'burst') this.queue({ kind: 'burst', time: now, size });
    else {
      this.lastBolt = now;
      this.queue({ kind: 'lightning', time: now, strokes: 3, size });
    }
  }
}

/** The crater as the viewer sees it: the floor at the vent and the highest rim on the near side. */
export interface CraterShape {
  readonly floorY: number;
  readonly rimY: number;
}

/**
 * Mean height on rings around the vent over the half of the cone facing the viewer; the rim is
 * the highest ring within the crater radius (noisy summits rarely peak exactly at it).
 */
export function craterShape(height: (x: number, z: number) => number, vent: readonly [number, number], crater: number, viewer: readonly [number, number]): CraterShape {
  const [vx, vz] = vent;
  const toward = Math.atan2(viewer[1] - vz, viewer[0] - vx);
  const angles = Array.from({ length: 13 }, (_, i) => toward + ((i - 6) / 6) * (Math.PI / 2));
  const ring = (r: number): number => angles.reduce((s, a) => s + height(vx + Math.cos(a) * r, vz + Math.sin(a) * r), 0) / angles.length;
  let rimY = -Infinity;
  for (let i = 1; i <= 12; i++) rimY = Math.max(rimY, ring((i / 12) * crater));
  return { floorY: height(vx, vz), rimY };
}

/**
 * Heights on a size×size grid covering vent ± reach, normalised to bytes (0..255 over
 * [min, max]) for a small filterable texture. Bombs find where they land on it.
 */
export function sampleSummit(height: (x: number, z: number) => number, vent: readonly [number, number], reach: number, size: number): { bytes: Uint8Array; min: number; max: number } {
  const values = new Float32Array(size * size);
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const h = height(vent[0] + ((i + 0.5) / size - 0.5) * 2 * reach, vent[1] + ((j + 0.5) / size - 0.5) * 2 * reach);
      values[j * size + i] = h;
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
  }
  const range = Math.max(1e-3, max - min);
  const bytes = new Uint8Array(size * size * 4);
  for (let k = 0; k < values.length; k++) {
    const v = Math.round((((values[k] as number) - min) / range) * 255);
    bytes.set([v, v, v, 255], k * 4);
  }
  return { bytes, min, max };
}
