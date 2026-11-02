/**
 * In-place iterative radix-2 FFT for real input (independent implementation; no third-party code).
 * Precomputes bit-reversal and twiddle tables per size; allocation-free after construction.
 */
export class FFT {
  readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two');
    this.size = size;
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    this.re = new Float32Array(size);
    this.im = new Float32Array(size);
  }

  /**
   * Transforms `input` (length = size, already windowed) and writes the power spectrum
   * |X[k]|² / N² for k = 0..N/2 into `power` (length N/2 + 1).
   */
  power(input: Float32Array, power: Float32Array): void {
    const n = this.size;
    const re = this.re;
    const im = this.im;
    for (let i = 0; i < n; i++) {
      re[this.rev[i] as number] = input[i] as number;
      im[i] = 0;
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const wr = this.cos[j * step] as number;
          const wi = this.sin[j * step] as number;
          const a = i + j;
          const b = a + half;
          const tr = (re[b] as number) * wr - (im[b] as number) * wi;
          const ti = (re[b] as number) * wi + (im[b] as number) * wr;
          re[b] = (re[a] as number) - tr;
          im[b] = (im[a] as number) - ti;
          re[a] = (re[a] as number) + tr;
          im[a] = (im[a] as number) + ti;
        }
      }
    }
    const norm = 1 / (n * n);
    for (let k = 0; k <= n / 2; k++) power[k] = ((re[k] as number) ** 2 + (im[k] as number) ** 2) * norm;
  }
}

export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

export function blackmanHarrisWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / (n - 1);
    w[i] = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
  }
  return w;
}

/** Sum of squared window values (for power normalisation). */
export function windowPowerGain(w: Float32Array): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += (w[i] as number) ** 2;
  return s / w.length;
}
