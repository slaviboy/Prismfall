/**
 * Song-relative contrast for the environment drives (part of the Environment Music Director).
 *
 * The Music Analysis Engine already normalises each band to its own long-term level: steady music
 * sits near 0.45 and accents reach 1. A world should answer what the music is doing now compared
 * with a moment ago, so each drive mixes that level with its excitation above a slow mean: steady
 * loud music keeps a moderate drive, a swell or a hit stands out, and a quiet song still moves the
 * world as much as a loud one. Frame-rate independent (time constants, not per-frame factors).
 */
export interface NormalizerOptions {
  /** Time constant of the slow mean (s). */
  readonly meanTau: number;
  /** Release of the running peak towards the mean (s). */
  readonly peakRelease: number;
  /** Share of the plain level in the output (the rest is excitation). */
  readonly levelShare: number;
  /** Smallest peak-to-mean span, so near-constant input is not stretched to full scale. */
  readonly floor: number;
}

export const DEFAULT_NORMALIZER: NormalizerOptions = { meanTau: 8, peakRelease: 6, levelShare: 0.5, floor: 0.15 };

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export class AudioFeatureNormalizer {
  private mean = 0;
  private peak = 0;
  private primed = false;

  constructor(readonly options: NormalizerOptions = DEFAULT_NORMALIZER) {}

  /** One sample (0..1) after `dt` seconds; `live` false (no music) returns 0 and keeps the statistics. */
  update(x: number, dt: number, live: boolean): number {
    if (!live) return 0;
    const o = this.options;
    if (!this.primed) {
      this.mean = x;
      this.peak = Math.min(1, x + o.floor);
      this.primed = true;
    }
    this.mean += (x - this.mean) * (1 - Math.exp(-dt / o.meanTau));
    if (x > this.peak) this.peak = x;
    else this.peak += (Math.max(x, this.mean) - this.peak) * (1 - Math.exp(-dt / o.peakRelease));
    const base = this.mean * 0.85;
    const excitation = clamp01((x - base) / Math.max(o.floor, this.peak - base));
    return clamp01(o.levelShare * x + (1 - o.levelShare) * excitation);
  }

  reset(): void {
    this.primed = false;
    this.mean = 0;
    this.peak = 0;
  }
}
