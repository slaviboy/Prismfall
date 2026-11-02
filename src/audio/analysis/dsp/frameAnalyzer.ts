import { BandMapper, DEFAULT_BANDS, logBars, powerToDb } from './bands';
import { FFT, hannWindow, windowPowerGain } from './fft';

export const BAND_COUNT = 6;
export const BAR_COUNT = 64;
/** Layout of one raw analysis frame (Float32Array). */
export const FRAME = {
  bands: 0, // 6 band levels in dBFS
  bars: BAND_COUNT, // 64 spectrum bars in dBFS
  rms: BAND_COUNT + BAR_COUNT,
  peak: BAND_COUNT + BAR_COUNT + 1,
  flux: BAND_COUNT + BAR_COUNT + 2,
  centroid: BAND_COUNT + BAR_COUNT + 3,
  size: BAND_COUNT + BAR_COUNT + 4,
} as const;

/** Magnitude compression for flux: bins below about -60 dBFS contribute almost nothing. */
const FLUX_GAMMA = 1000;

/** log(1 + γ·|X|) compression of a bin magnitude (full-scale sine ≈ 0.8). */
export function fluxCompress(mag: number): number {
  return Math.log10(1 + FLUX_GAMMA * mag);
}

/**
 * Half-wave rectified spectral flux between compressed spectra, averaged over bins from
 * `first`. Each bin is compared with the maximum of its neighbours in the previous frame,
 * which suppresses vibrato and detuned-unison beating. Copies `cur` into `prev`.
 */
export function rectifiedFlux(cur: Float32Array, prev: Float32Array, first: number): number {
  const last = cur.length - 1;
  let flux = 0;
  for (let k = first; k <= last; k++) {
    const ref = Math.max(prev[k - 1] as number, prev[k] as number, prev[Math.min(last, k + 1)] as number);
    const d = (cur[k] as number) - ref;
    if (d > 0) flux += d;
  }
  prev.set(cur);
  return flux / (last - first + 1);
}

/** Bands below this frequency use the long (high-resolution) FFT. */
const SPLIT_HZ = 250;

/**
 * Multi-resolution spectral analysis of a mono stream in fixed hops:
 * a long FFT (default 4096) resolves sub-bass and bass, a short FFT (2048) gives responsive
 * flux, centroid and high bands. 2048 rather than 1024 because a 21 ms window is shorter than
 * one cycle of a 40 Hz sub, whose power then swings with phase and fakes onsets (measured on the
 * acceptance corpus: bass-heavy onset F 0.64 -> 0.95). Allocation-free per hop.
 */
export class FrameAnalyzer {
  readonly hop: number;
  readonly sampleRate: number;
  private readonly history: Float32Array;
  private readonly longFFT: FFT;
  private readonly shortFFT: FFT;
  private readonly longWin: Float32Array;
  private readonly shortWin: Float32Array;
  private readonly longGain: number;
  private readonly shortGain: number;
  private readonly longIn: Float32Array;
  private readonly shortIn: Float32Array;
  private readonly longPow: Float32Array;
  private readonly shortPow: Float32Array;
  private readonly prevLog: Float32Array;
  private readonly curLog: Float32Array;
  private readonly fluxFirstBin: number;
  private readonly bandsLong: BandMapper;
  private readonly bandsShort: BandMapper;
  private readonly barsLong: BandMapper;
  private readonly barsShort: BandMapper;
  private readonly bandUseLong: boolean[];
  private readonly barUseLong: boolean[];
  private readonly tmpBands = new Float32Array(BAND_COUNT);
  private readonly tmpBandsS = new Float32Array(BAND_COUNT);
  private readonly tmpBars = new Float32Array(BAR_COUNT);
  private readonly tmpBarsS = new Float32Array(BAR_COUNT);

  constructor(sampleRate: number, longSize = 4096, shortSize = 2048, hop = 512, fluxMinHz = 0) {
    this.sampleRate = sampleRate;
    this.hop = hop;
    this.history = new Float32Array(longSize);
    this.longFFT = new FFT(longSize);
    this.shortFFT = new FFT(shortSize);
    this.longWin = hannWindow(longSize);
    this.shortWin = hannWindow(shortSize);
    this.longGain = windowPowerGain(this.longWin);
    this.shortGain = windowPowerGain(this.shortWin);
    this.longIn = new Float32Array(longSize);
    this.shortIn = new Float32Array(shortSize);
    this.longPow = new Float32Array(longSize / 2 + 1);
    this.shortPow = new Float32Array(shortSize / 2 + 1);
    this.prevLog = new Float32Array(shortSize / 2 + 1);
    this.curLog = new Float32Array(shortSize / 2 + 1);
    this.fluxFirstBin = Math.max(1, Math.round((fluxMinHz * shortSize) / sampleRate));
    const bars = logBars(BAR_COUNT);
    this.bandsLong = new BandMapper(sampleRate, longSize, DEFAULT_BANDS);
    this.bandsShort = new BandMapper(sampleRate, shortSize, DEFAULT_BANDS);
    this.barsLong = new BandMapper(sampleRate, longSize, bars);
    this.barsShort = new BandMapper(sampleRate, shortSize, bars);
    this.bandUseLong = DEFAULT_BANDS.map((b) => b.hi <= SPLIT_HZ + 1);
    this.barUseLong = bars.map((b) => b.hi <= SPLIT_HZ * 1.5);
  }

  /** Appends one hop of mono samples and writes a raw frame into `out` (length FRAME.size). */
  process(hopSamples: Float32Array, out: Float32Array): void {
    const h = this.history;
    const n = hopSamples.length;
    h.copyWithin(0, n);
    h.set(hopSamples, h.length - n);

    // Long window: whole history.
    for (let i = 0; i < h.length; i++) this.longIn[i] = (h[i] as number) * (this.longWin[i] as number);
    this.longFFT.power(this.longIn, this.longPow);
    // Short window: newest samples.
    const s = this.shortIn.length;
    const off = h.length - s;
    for (let i = 0; i < s; i++) this.shortIn[i] = (h[off + i] as number) * (this.shortWin[i] as number);
    this.shortFFT.power(this.shortIn, this.shortPow);

    // Scale so a full-scale sine reads about -3 dBFS in its band (window power compensation).
    const longScale = 4 / this.longGain;
    const shortScale = 4 / this.shortGain;
    this.bandsLong.energies(this.longPow, this.tmpBands);
    this.bandsShort.energies(this.shortPow, this.tmpBandsS);
    for (let b = 0; b < BAND_COUNT; b++) {
      const p = this.bandUseLong[b] ? (this.tmpBands[b] as number) * longScale : (this.tmpBandsS[b] as number) * shortScale;
      out[FRAME.bands + b] = powerToDb(p);
    }
    this.barsLong.energies(this.longPow, this.tmpBars);
    this.barsShort.energies(this.shortPow, this.tmpBarsS);
    for (let b = 0; b < BAR_COUNT; b++) {
      const p = this.barUseLong[b] ? (this.tmpBars[b] as number) * longScale : (this.tmpBarsS[b] as number) * shortScale;
      out[FRAME.bars + b] = powerToDb(p);
    }

    // Time-domain level of the newest hop.
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const v = hopSamples[i] as number;
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    out[FRAME.rms] = 20 * Math.log10(Math.max(1e-7, Math.sqrt(sum / Math.max(1, n))));
    out[FRAME.peak] = 20 * Math.log10(Math.max(1e-7, peak));

    // Spectral flux and centroid from the short FFT.
    let wsum = 0;
    let psum = 0;
    const binHz = this.sampleRate / s;
    const cur = this.curLog;
    for (let k = 0; k < cur.length; k++) {
      const p = this.shortPow[k] as number;
      cur[k] = fluxCompress(Math.sqrt(p * shortScale));
      wsum += k * binHz * p;
      psum += p;
    }
    out[FRAME.flux] = rectifiedFlux(cur, this.prevLog, this.fluxFirstBin);
    out[FRAME.centroid] = psum > 1e-14 ? wsum / psum : 0;
  }
}
