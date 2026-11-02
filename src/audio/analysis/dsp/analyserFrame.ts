import { BandMapper, DEFAULT_BANDS, logBars, powerToDb } from './bands';
import { BAND_COUNT, BAR_COUNT, FRAME, fluxCompress, rectifiedFlux } from './frameAnalyzer';

/** Analyser magnitudes (|X|/N, Blackman window) scaled to the worklet's calibration (full-scale sine ≈ 0.8). */
const ANALYSER_MAG_SCALE = 3.9;

/**
 * Builds a raw analysis frame (same layout as FrameAnalyzer) from AnalyserNode data:
 * `getFloatFrequencyData` dB bins and `getFloatTimeDomainData` samples. Allocation-free.
 * Shared by the live fallback path and the offline profiling in the audio lab.
 */
export class AnalyserFrameBuilder {
  private readonly bands: BandMapper;
  private readonly bars: BandMapper;
  private readonly power: Float32Array;
  private readonly prevLog: Float32Array;
  private readonly curLog: Float32Array;
  private readonly bandOut = new Float32Array(BAND_COUNT);
  private readonly barOut = new Float32Array(BAR_COUNT);
  private readonly binHz: number;

  constructor(sampleRate: number, readonly fftSize: number) {
    const bins = fftSize / 2;
    this.bands = new BandMapper(sampleRate, fftSize, DEFAULT_BANDS);
    this.bars = new BandMapper(sampleRate, fftSize, logBars(BAR_COUNT));
    this.power = new Float32Array(bins + 1);
    this.prevLog = new Float32Array(bins);
    this.curLog = new Float32Array(bins);
    this.binHz = sampleRate / fftSize;
  }

  build(freqDb: Float32Array, timeDomain: Float32Array, out: Float32Array): void {
    const n = freqDb.length;
    let wsum = 0;
    let psum = 0;
    for (let k = 0; k < n; k++) {
      const p = Math.pow(10, (freqDb[k] as number) / 10);
      this.power[k] = p;
      this.curLog[k] = fluxCompress(ANALYSER_MAG_SCALE * Math.sqrt(p));
      wsum += k * this.binHz * p;
      psum += p;
    }
    out[FRAME.flux] = rectifiedFlux(this.curLog, this.prevLog, 1);
    this.bands.energies(this.power, this.bandOut);
    for (let b = 0; b < BAND_COUNT; b++) out[FRAME.bands + b] = powerToDb((this.bandOut[b] as number) * 2);
    this.bars.energies(this.power, this.barOut);
    for (let b = 0; b < BAR_COUNT; b++) out[FRAME.bars + b] = powerToDb((this.barOut[b] as number) * 2);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < timeDomain.length; i++) {
      const v = timeDomain[i] as number;
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    out[FRAME.rms] = 20 * Math.log10(Math.max(1e-7, Math.sqrt(sum / Math.max(1, timeDomain.length))));
    out[FRAME.peak] = 20 * Math.log10(Math.max(1e-7, peak));
    out[FRAME.centroid] = psum > 0 ? wsum / psum : 0;
  }
}
