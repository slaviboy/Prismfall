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
  private readonly fluxScale = new AdaptiveNormalizer(18, -200, -60, -20);
  private readonly onsets = new OnsetDetector();
  readonly tempo: TempoTracker;
  private readonly hopSeconds: number;
  private quietTime = 0;
  /** Raw (unsmoothed) normalised band values of the last frame, for the debug dashboard. */
  readonly rawBands = new Float32Array(BAND_COUNT);
  readonly peakBands = new Float32Array(BAND_COUNT);
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
    for (let b = 0; b < BAND_COUNT; b++) {
      const db = frame[FRAME.bands + b] as number;
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
    const fluxNorm = silent ? 0 : this.fluxScale.update(20 * Math.log10(flux + 1e-9), dt);
    f.spectralFlux = this.fluxEnv.update(fluxNorm, dt);
    const onset = this.onsets.push(silent ? 0 : flux, time);
    if (onset.onset) {
      this.lastOnsetTime = onset.time;
      this.onsetCount++;
      this.transientEnv.value = Math.max(this.transientEnv.value, 0.4 + onset.strength * 0.6);
    }
    f.transientIntensity = this.transientEnv.update(0, dt);
    this.tempo.push(onset.onset ? 0.3 + onset.strength : fluxNorm * 0.3, time);

    const centroidHz = frame[FRAME.centroid] as number;
    const bright = centroidHz > 0 ? Math.max(0, Math.min(1, Math.log2(centroidHz / 200) / Math.log2(8000 / 200))) : 0;
    f.spectralCentroid = this.centroidEnv.update(bright, dt);

    // Quiet passage: low level for more than half a second.
    this.quietTime = level < 0.18 ? this.quietTime + dt : 0;
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
}
