import type { AudioFeatures } from '../features';
import { BAND_COUNT, BAR_COUNT, FRAME } from './frameAnalyzer';
import { OnsetDetector, TempoTracker } from './rhythm';
import { AdaptiveNormalizer, EnvelopeFollower, PeakHold } from './smoothing';

export interface ProcessorTuning {
  /** Overall sensitivity multiplier applied after normalisation. */
  sensitivity: number;
  /** Per-band [attackMs, releaseMs]. */
  bandEnvelopes: readonly (readonly [number, number])[];
  /** Treble is kept delicate (scaled) to avoid flicker. */
  trebleScale: number;
}

export const DEFAULT_TUNING: ProcessorTuning = {
  sensitivity: 1,
  bandEnvelopes: [
    [40, 320], // sub-bass: heavy and smooth
    [35, 280], // bass
    [30, 220], // low-mid
    [25, 180], // mid
    [15, 140], // high-mid
    [10, 120], // treble
  ],
  trebleScale: 0.85,
};

const BAND_KEYS = ['subBass', 'bass', 'lowMid', 'mid', 'highMid', 'treble'] as const;

/** Per-band weight of an attack in the onset accent: snare body and crack count as much as kick sub (listeners lock to the backbeat), hats little. */
const ACCENT_WEIGHTS = [0.6, 0.6, 1, 1, 0.6, 0.15] as const;
/** Attack rise is measured against the minimum of this many previous frames (≈85 ms at 48 kHz). */
const ACCENT_FRAMES = 8;

/**
 * Flux of a clear drum hit at nominal mix level; flux is scaled against its recent peaks but
 * never against less than this, so smooth or quiet music doesn't read as turbulent.
 */
const FLUX_REF = 0.05;

/** Ratio of a positive signal to its recent peak (instant attack, exponential release). */
class PeakRatio {
  private peak = 0;
  constructor(
    private readonly ref: number,
    private readonly releaseS: number,
  ) {}
  update(x: number, dt: number): number {
    this.peak = x > this.peak ? x : this.peak * Math.exp(-dt / this.releaseS);
    return Math.min(1, x / Math.max(this.peak, this.ref));
  }
}

/**
 * Turns raw analysis frames into the normalised, smoothed AudioFeatures fields:
 * bands, RMS, flux, transients, centroid, quiet detection, spectrum, onsets and tempo.
 */
export class FeatureProcessor {
  private readonly normalizers = Array.from({ length: BAND_COUNT }, () => new AdaptiveNormalizer(24, -78));
  private readonly envelopes: EnvelopeFollower[];
  private readonly peaks = Array.from({ length: BAND_COUNT }, () => new PeakHold(180, 0.9));
  private readonly rmsNorm = new AdaptiveNormalizer(24, -70);
  private readonly rmsEnv = new EnvelopeFollower(30, 250);
  private readonly fluxEnv = new EnvelopeFollower(4, 120);
  private readonly transientEnv = new EnvelopeFollower(2, 160);
  private readonly centroidEnv = new EnvelopeFollower(80, 400);
  private readonly fluxScale = new PeakRatio(FLUX_REF, 8);
  /** Long-term loudness reference (dBFS) for quiet-passage detection. */
  private loudRef = -30;
  private readonly onsets = new OnsetDetector();
  readonly tempo: TempoTracker;
  private readonly hopSeconds: number;
  private quietTime = 0;
  /** Raw (unsmoothed) normalised band values of the last frame, for the debug dashboard. */
  readonly rawBands = new Float32Array(BAND_COUNT);
  readonly peakBands = new Float32Array(BAND_COUNT);
  /** Band levels (dBFS) and RMS (dBFS) of the last frame, for the debug dashboard. */
  readonly bandDb = new Float32Array(BAND_COUNT);
  rmsDb = -120;
  /** Recent band levels (dB) for attack accents: ACCENT_FRAMES × BAND_COUNT ring. */
  private readonly bandHistory = new Float32Array(ACCENT_FRAMES * BAND_COUNT).fill(-120);
  private historyIndex = 0;
  /** Low-band (kick) and mid-band (snare) parts of the last accent. */
  private accentLow = 0;
  private accentMid = 0;
  /**
   * The tempo tracker runs on a fixed hop grid. Worklet frames arrive exactly one hop apart;
   * analyser frames arrive once per render frame, so onsets are carried to the next grid step.
   */
  private tempoClock = 0;
  private pendingOnset = 0;
  private pendingAccent = 0;
  private pendingLow = 0;
  private pendingMid = 0;
  /** Raw spectral flux of the last frame (debug/tests). */
  rawFlux = 0;
  /** Detection latency of the analysis window, subtracted from reported onset times. */
  onsetLatencyS = 0;
  lastOnsetTime = -Infinity;
  onsetCount = 0;
  tuning: ProcessorTuning = DEFAULT_TUNING;

  constructor(hopSeconds: number) {
    this.hopSeconds = hopSeconds;
    this.envelopes = DEFAULT_TUNING.bandEnvelopes.map(([a, r]) => new EnvelopeFollower(a, r));
    this.tempo = new TempoTracker(hopSeconds);
  }

  setTuning(t: ProcessorTuning): void {
    this.tuning = t;
    t.bandEnvelopes.forEach(([a, r], i) => {
      const env = this.envelopes[i];
      if (env) {
        env.attackMs = a;
        env.releaseMs = r;
      }
    });
  }

  /** Processes one raw frame. `time` is its audio-clock time; `dt` the time since the previous frame. */
  process(frame: Float32Array, time: number, f: AudioFeatures, dt = this.hopSeconds): void {
    const sens = this.tuning.sensitivity;
    const rmsDb = frame[FRAME.rms] as number;
    const silent = rmsDb < -70;
    this.rmsDb = rmsDb;
    for (let b = 0; b < BAND_COUNT; b++) {
      const db = frame[FRAME.bands + b] as number;
      this.bandDb[b] = db;
      let v = (this.normalizers[b] as AdaptiveNormalizer).update(db, dt) * sens;
      if (b === 5) v *= this.tuning.trebleScale;
      if (silent) v = 0;
      this.rawBands[b] = v;
      f[BAND_KEYS[b] as (typeof BAND_KEYS)[number]] = (this.envelopes[b] as EnvelopeFollower).update(Math.min(1, v), dt);
      this.peakBands[b] = (this.peaks[b] as PeakHold).update(v, dt);
    }
    const level = silent ? 0 : this.rmsNorm.update(rmsDb, dt);
    f.waveformRms = this.rmsEnv.update(level, dt);
    f.overallEnergy = (f.subBass * 0.15 + f.bass * 0.25 + f.lowMid * 0.15 + f.mid * 0.2 + f.highMid * 0.15 + f.treble * 0.1) * 0.6 + f.waveformRms * 0.4;
    f.dynamicRange = this.rmsNorm.dynamicRangeDb;

    const flux = frame[FRAME.flux] as number;
    this.rawFlux = flux;
    const fluxNorm = silent ? 0 : this.fluxScale.update(flux, dt);
    f.spectralFlux = this.fluxEnv.update(fluxNorm, dt);
    const onset = this.onsets.push(silent ? 0 : flux, time);
    if (onset.onset) {
      this.lastOnsetTime = onset.time - this.onsetLatencyS;
      this.onsetCount++;
      this.transientEnv.value = Math.max(this.transientEnv.value, 0.4 + onset.strength * 0.6);
    }
    f.transientIntensity = this.transientEnv.update(0, dt);
    // Onsets are reported one hop late (look-ahead) on top of the window latency.
    this.tempo.latencyS = this.onsetLatencyS + this.hopSeconds;
    if (onset.onset) {
      const accent = this.accent(frame);
      if (accent >= this.pendingAccent) {
        this.pendingAccent = accent;
        this.pendingLow = this.accentLow;
        this.pendingMid = this.accentMid;
      }
      this.pendingOnset = 1;
    }
    this.tempoClock += dt;
    while (this.tempoClock >= this.hopSeconds * 0.999) {
      this.tempoClock -= this.hopSeconds;
      this.tempo.push(this.pendingOnset, time, this.pendingAccent, this.pendingLow, this.pendingMid);
      this.pendingOnset = this.pendingAccent = this.pendingLow = this.pendingMid = 0;
    }
    this.recordBands(frame);

    const centroidHz = frame[FRAME.centroid] as number;
    const bright = centroidHz > 0 ? Math.max(0, Math.min(1, Math.log2(centroidHz / 200) / Math.log2(8000 / 200))) : 0;
    f.spectralCentroid = this.centroidEnv.update(bright, dt);

    // Quiet passage: well below the long-term loudness (or simply soft) for over half a second.
    if (!silent) this.loudRef += (rmsDb - this.loudRef) * (1 - Math.exp(-dt / (rmsDb > this.loudRef ? 4 : 20)));
    this.quietTime = silent || rmsDb < this.loudRef - 10 || rmsDb < -50 ? this.quietTime + dt : 0;
    f.quiet = this.quietTime > 0.5;

    const up = 1 - Math.exp(-dt / 0.012);
    const down = 1 - Math.exp(-dt / 0.09);
    for (let i = 0; i < BAR_COUNT && i < f.spectrum.length; i++) {
      const db = frame[FRAME.bars + i] as number;
      const target = silent ? 0 : Math.max(0, Math.min(1, (db + 75) / 60));
      const prev = f.spectrum[i] as number;
      f.spectrum[i] = prev + (target - prev) * (target > prev ? up : down);
    }

    f.estimatedBpm = this.tempo.bpm;
  }

  /**
   * Weighted attack size: each band's rise (dB) over its minimum in the last ~85 ms. Also splits
   * it into a low part (sub-bass, bass: kicks) and a mid part (low-mid to high-mid: snares).
   */
  private accent(frame: Float32Array): number {
    let a = 0;
    this.accentLow = 0;
    this.accentMid = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      let min = Infinity;
      for (let i = 0; i < ACCENT_FRAMES; i++) min = Math.min(min, this.bandHistory[i * BAND_COUNT + b] as number);
      const rise = Math.max(0, Math.min(30, (frame[FRAME.bands + b] as number) - min));
      const v = (ACCENT_WEIGHTS[b] as number) * rise;
      a += v;
      if (b < 2) this.accentLow += v;
      else if (b < 5) this.accentMid += v;
    }
    return a;
  }

  private recordBands(frame: Float32Array): void {
    const base = this.historyIndex * BAND_COUNT;
    for (let b = 0; b < BAND_COUNT; b++) this.bandHistory[base + b] = frame[FRAME.bands + b] as number;
    this.historyIndex = (this.historyIndex + 1) % ACCENT_FRAMES;
  }
}
