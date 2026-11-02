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
 * Level-adaptive normaliser for dB signals. A slow mean tracks the typical level and a
 * fast-attack/slow-release peak tracks the loud moments: the typical level maps to `rest`
 * (about 0.45) and peaks map to 1, so steady material sits mid-scale and accents stand out.
 * The mapped window is at least `minRangeDb` wide, so quiet noise is never stretched to full
 * scale, and anything at or below the gate reads 0.
 */
export class AdaptiveNormalizer {
  private mean = 0;
  private peak = 0;
  private low = 0;
  private primed = false;
  constructor(
    private readonly minRangeDb = 24,
    private readonly gateDb = -70,
    private readonly rest = 0.45,
  ) {}

  update(db: number, dt: number): number {
    if (db <= this.gateDb || !Number.isFinite(db)) return 0;
    if (!this.primed) {
      this.mean = this.peak = this.low = db;
      this.primed = true;
    }
    // The mean rises faster than it falls, so a quiet passage reads quiet for a while.
    this.mean += (db - this.mean) * (1 - Math.exp(-dt / (db > this.mean ? 2.5 : 6)));
    this.peak += (db - this.peak) * (1 - Math.exp(-dt / (db > this.peak ? 0.03 : 3)));
    this.peak = Math.max(this.peak, this.mean);
    this.low += (db - this.low) * (1 - Math.exp(-dt / (db < this.low ? 0.3 : 8)));
    this.low = Math.min(this.low, this.mean);
    const half = Math.max(this.minRangeDb / 2, this.peak - this.mean);
    const v = this.rest + ((1 - this.rest) * (db - this.mean)) / half;
    return Math.max(0, Math.min(1, v));
  }

  /** Typical level (dB) of the signal. */
  get level(): number {
    return this.mean;
  }

  get dynamicRangeDb(): number {
    return this.peak - this.low;
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
