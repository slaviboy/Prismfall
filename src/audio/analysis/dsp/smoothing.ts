/** Time-based attack/release follower: α = 1 − e^(−dt/τ). Identical behaviour at any update rate. */
export class EnvelopeFollower {
  value = 0;
  constructor(
    public attackMs: number,
    public releaseMs: number,
  ) {}

  update(target: number, dtSeconds: number): number {
    const tau = (target > this.value ? this.attackMs : this.releaseMs) / 1000;
    this.value += (target - this.value) * (tau <= 0 ? 1 : 1 - Math.exp(-dtSeconds / tau));
    return this.value;
  }
}

/** Peak hold with time-based decay (dB/s style linear fall on the normalised value). */
export class PeakHold {
  value = 0;
  private held = 0;
  constructor(
    public holdMs = 200,
    public fallPerSecond = 0.8,
  ) {}

  update(x: number, dt: number): number {
    if (x >= this.value) {
      this.value = x;
      this.held = 0;
    } else {
      this.held += dt * 1000;
      if (this.held > this.holdMs) this.value = Math.max(x, this.value - this.fallPerSecond * dt);
    }
    return this.value;
  }
}

/**
 * Adaptive normalisation of a dB level into 0..1. The ceiling follows peaks quickly and relaxes
 * slowly; the floor follows lows slowly. A minimum window keeps quiet passages from being
 * amplified into noise, and a gate maps near-silence to zero.
 */
export class AdaptiveNormalizer {
  private floor: number;
  private ceiling: number;
  constructor(
    private readonly minRangeDb = 24,
    private readonly gateDb = -70,
    initialFloor = -60,
    initialCeiling = -20,
  ) {
    this.floor = initialFloor;
    this.ceiling = initialCeiling;
  }

  update(db: number, dt: number): number {
    if (db > this.ceiling) this.ceiling += (db - this.ceiling) * (1 - Math.exp(-dt / 0.05));
    else this.ceiling += (db - this.ceiling) * (1 - Math.exp(-dt / 6));
    if (db < this.floor) this.floor += (db - this.floor) * (1 - Math.exp(-dt / 0.6));
    else this.floor += (db - this.floor) * (1 - Math.exp(-dt / 12));
    const floor = Math.max(this.floor, this.gateDb);
    const range = Math.max(this.minRangeDb, this.ceiling - floor);
    if (db <= this.gateDb) return 0;
    return Math.max(0, Math.min(1, (db - (this.ceiling - range)) / range));
  }

  get dynamicRangeDb(): number {
    return this.ceiling - this.floor;
  }
}

/** Fixed-size numeric ring buffer. */
export class Ring {
  readonly data: Float32Array;
  private index = 0;
  filled = 0;
  constructor(readonly size: number) {
    this.data = new Float32Array(size);
  }
  push(v: number): void {
    this.data[this.index] = v;
    this.index = (this.index + 1) % this.size;
    this.filled = Math.min(this.size, this.filled + 1);
  }
  /** i = 0 is the newest value. */
  get(i: number): number {
    return this.data[(this.index - 1 - i + this.size * 2) % this.size] as number;
  }
}
