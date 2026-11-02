/** Frequency bands defined in Hz (independent of FFT size and sample rate). */
export interface BandSpec {
  readonly name: string;
  readonly lo: number;
  readonly hi: number;
}

export const DEFAULT_BANDS: readonly BandSpec[] = [
  { name: 'subBass', lo: 20, hi: 60 },
  { name: 'bass', lo: 60, hi: 250 },
  { name: 'lowMid', lo: 250, hi: 500 },
  { name: 'mid', lo: 500, hi: 2000 },
  { name: 'highMid', lo: 2000, hi: 6000 },
  { name: 'treble', lo: 6000, hi: 16000 },
];

/** Log-spaced bars between two frequencies (for spectrum visuals). */
export function logBars(count: number, lo = 30, hi = 16000): BandSpec[] {
  const bars: BandSpec[] = [];
  const ratio = Math.pow(hi / lo, 1 / count);
  for (let i = 0; i < count; i++) bars.push({ name: `bar${i}`, lo: lo * Math.pow(ratio, i), hi: lo * Math.pow(ratio, i + 1) });
  return bars;
}

interface Weighted {
  readonly bins: Uint16Array;
  readonly weights: Float32Array;
}

/**
 * Maps FFT power bins to bands with fractional edge weights: a bin straddling a band edge
 * contributes in proportion to its overlap, so narrow low bands stay accurate.
 */
export class BandMapper {
  private readonly bands: Weighted[];
  readonly count: number;

  constructor(sampleRate: number, fftSize: number, specs: readonly BandSpec[]) {
    const binHz = sampleRate / fftSize;
    const maxBin = fftSize / 2;
    this.count = specs.length;
    this.bands = specs.map((b) => {
      const bins: number[] = [];
      const weights: number[] = [];
      const first = Math.max(1, Math.floor(b.lo / binHz - 0.5));
      const last = Math.min(maxBin, Math.ceil(b.hi / binHz + 0.5));
      for (let k = first; k <= last; k++) {
        const binLo = (k - 0.5) * binHz;
        const binHi = (k + 0.5) * binHz;
        const overlap = Math.max(0, Math.min(binHi, b.hi) - Math.max(binLo, b.lo)) / binHz;
        if (overlap > 0) {
          bins.push(k);
          weights.push(overlap);
        }
      }
      if (bins.length === 0) {
        // Band narrower than a bin: use the nearest bin.
        bins.push(Math.min(maxBin, Math.max(1, Math.round(((b.lo + b.hi) / 2) / binHz))));
        weights.push(1);
      }
      return { bins: Uint16Array.from(bins), weights: Float32Array.from(weights) };
    });
  }

  /** Writes each band's summed power into `out`. */
  energies(power: Float32Array, out: Float32Array): void {
    for (let i = 0; i < this.bands.length; i++) {
      const b = this.bands[i] as Weighted;
      let sum = 0;
      for (let j = 0; j < b.bins.length; j++) sum += (power[b.bins[j] as number] as number) * (b.weights[j] as number);
      out[i] = sum;
    }
  }

  binCount(band: number): number {
    return this.bands[band]?.bins.length ?? 0;
  }
}

export function powerToDb(p: number): number {
  return 10 * Math.log10(Math.max(p, 1e-14));
}
