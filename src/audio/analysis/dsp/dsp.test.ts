import { describe, expect, it } from 'vitest';
import { createAudioFeatures } from '../features';
import { BandMapper, DEFAULT_BANDS, powerToDb } from './bands';
import { FeatureProcessor } from './featureProcessor';
import { FFT, hannWindow } from './fft';
import { FRAME, FrameAnalyzer } from './frameAnalyzer';
import { OnsetDetector, TempoTracker } from './rhythm';
import { AdaptiveNormalizer, EnvelopeFollower } from './smoothing';

const SR = 48000;
const HOP = 512;

function sine(freq: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

/** Decaying noise bursts (a simple percussive "click track") at a given tempo. */
function clickTrack(bpm: number, seconds: number, offset = 0.05): { signal: Float32Array; onsets: number[] } {
  const out = new Float32Array(Math.round(seconds * SR));
  const onsets: number[] = [];
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  for (let t = offset; t < seconds; t += 60 / bpm) {
    onsets.push(t);
    const start = Math.round(t * SR);
    for (let i = 0; i < 0.08 * SR && start + i < out.length; i++) out[start + i] += rnd() * 1.2 * Math.exp(-i / (0.012 * SR));
  }
  return { signal: out, onsets };
}

/** Runs the analyzer over a whole signal in hops, yielding (frame, time). */
function analyze(signal: Float32Array, cb: (frame: Float32Array, time: number) => void): void {
  const analyzer = new FrameAnalyzer(SR, 4096, 1024, HOP);
  const frame = new Float32Array(FRAME.size);
  for (let i = 0; i + HOP <= signal.length; i += HOP) {
    analyzer.process(signal.subarray(i, i + HOP), frame);
    cb(frame, (i + HOP) / SR);
  }
}

describe('FFT', () => {
  it('puts a bin-centred sine into the right bin', () => {
    const n = 1024;
    const fft = new FFT(n);
    const bin = 37;
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * bin * i) / n);
    const p = new Float32Array(n / 2 + 1);
    fft.power(input, p);
    let best = 0;
    for (let k = 1; k < p.length; k++) if ((p[k] as number) > (p[best] as number)) best = k;
    expect(best).toBe(bin);
    expect(p[bin]).toBeCloseTo(0.25, 2); // (A/2)^2 for a unit sine with 1/N² normalisation
  });

  it('rejects non-power-of-two sizes', () => {
    expect(() => new FFT(1000)).toThrow();
  });

  it('builds symmetric windows', () => {
    const w = hannWindow(9);
    expect(w[0]).toBeCloseTo(0);
    expect(w[4]).toBeCloseTo(1);
    expect(w[8]).toBeCloseTo(0);
  });
});

describe('band mapping', () => {
  it('assigns sines to the correct band at 2048 and 4096', () => {
    for (const size of [2048, 4096]) {
      const mapper = new BandMapper(SR, size, DEFAULT_BANDS);
      const fft = new FFT(size);
      const win = hannWindow(size);
      for (const [freq, expected] of [[40, 0], [120, 1], [350, 2], [1000, 3], [3500, 4], [9000, 5]] as const) {
        const s = sine(freq, size / SR + 0.01);
        const input = new Float32Array(size);
        for (let i = 0; i < size; i++) input[i] = (s[i] as number) * (win[i] as number);
        const p = new Float32Array(size / 2 + 1);
        fft.power(input, p);
        const bands = new Float32Array(6);
        mapper.energies(p, bands);
        let best = 0;
        for (let b = 1; b < 6; b++) if ((bands[b] as number) > (bands[best] as number)) best = b;
        expect(best, `${freq} Hz at ${size}`).toBe(expected);
      }
    }
  });

  it('keeps narrow low bands populated with fractional edge bins', () => {
    const mapper = new BandMapper(SR, 2048, DEFAULT_BANDS);
    expect(mapper.binCount(0)).toBeGreaterThanOrEqual(2);
  });
});

describe('smoothing and normalisation', () => {
  it('envelope followers are update-rate independent', () => {
    const run = (hz: number): number => {
      const env = new EnvelopeFollower(50, 300);
      for (let i = 0; i < hz * 0.2; i++) env.update(1, 1 / hz);
      for (let i = 0; i < hz * 0.1; i++) env.update(0, 1 / hz);
      return env.value;
    };
    expect(Math.abs(run(60) - run(240))).toBeLessThan(0.01);
    expect(Math.abs(run(94) - run(144))).toBeLessThan(0.01);
  });

  it('gates silence to zero and does not amplify quiet noise to full scale', () => {
    const n = new AdaptiveNormalizer(24, -70);
    for (let i = 0; i < 200; i++) n.update(-90, 0.01);
    expect(n.update(-90, 0.01)).toBe(0);
    const q = new AdaptiveNormalizer(24, -70);
    let v = 0;
    for (let i = 0; i < 500; i++) v = q.update(-60 + Math.sin(i) * 1.5, 0.01);
    expect(v).toBeLessThan(0.6);
  });

  it('handles clipping-level input without exceeding 1', () => {
    const n = new AdaptiveNormalizer(24, -70);
    for (let i = 0; i < 100; i++) expect(n.update(6, 0.01)).toBeLessThanOrEqual(1);
  });
});

describe('frame analysis', () => {
  it('reports band levels, RMS and silence correctly', () => {
    const bass = sine(100, 1, 0.5);
    let last = new Float32Array(FRAME.size);
    analyze(bass, (f) => (last = f.slice()));
    const bands = Array.from(last.subarray(0, 6));
    expect(bands.indexOf(Math.max(...bands))).toBe(1);
    expect(last[FRAME.rms]).toBeCloseTo(20 * Math.log10(0.5 / Math.SQRT2), 0);
    let silentRms = 0;
    analyze(new Float32Array(SR), (f) => (silentRms = f[FRAME.rms] as number));
    expect(silentRms).toBeLessThan(-100);
  });

  it('produces bright centroids for bright sounds', () => {
    let low = 0;
    let high = 0;
    analyze(sine(200, 0.5), (f) => (low = f[FRAME.centroid] as number));
    analyze(sine(6000, 0.5), (f) => (high = f[FRAME.centroid] as number));
    expect(high).toBeGreaterThan(low * 10);
  });
});

describe('onsets and tempo', () => {
  it('detects percussive onsets with high precision and recall (±50 ms)', () => {
    const { signal, onsets } = clickTrack(120, 8);
    const detector = new OnsetDetector();
    const found: number[] = [];
    analyze(signal, (f, t) => {
      const r = detector.push(f[FRAME.flux] as number, t);
      if (r.onset) found.push(r.time);
    });
    const matched = onsets.filter((o) => found.some((d) => Math.abs(d - o) < 0.05)).length;
    const precision = found.filter((d) => onsets.some((o) => Math.abs(d - o) < 0.05)).length / Math.max(1, found.length);
    const recall = matched / onsets.length;
    expect(precision).toBeGreaterThan(0.9);
    expect(recall).toBeGreaterThan(0.9);
  });

  for (const bpm of [90, 120, 140]) {
    it(`estimates ${bpm} BPM within ±2% from a click track`, () => {
      const { signal } = clickTrack(bpm, 12);
      const processor = new FeatureProcessor(HOP / SR);
      const f = createAudioFeatures();
      analyze(signal, (frame, t) => processor.process(frame, t, f));
      const est = processor.tempo.bpm;
      const ratio = est / bpm;
      // Octave errors are flagged by the prior but still count as the same tempo family.
      const nearest = [0.5, 1, 2].reduce((a, b) => (Math.abs(ratio - b) < Math.abs(ratio - a) ? b : a), 1);
      expect(nearest).toBe(1);
      expect(Math.abs(est - bpm) / bpm).toBeLessThan(0.02);
    });
  }

  it('tempo tracker reports low confidence without rhythm', () => {
    const tracker = new TempoTracker(HOP / SR);
    for (let i = 0; i < 1500; i++) tracker.push(0, i * (HOP / SR));
    expect(tracker.confidence).toBeLessThan(0.3);
  });

  it('feature processor outputs stay finite and bounded on extreme input', () => {
    const processor = new FeatureProcessor(HOP / SR);
    const f = createAudioFeatures();
    const loud = sine(80, 1, 1.4);
    const quiet = sine(80, 1, 0.0005);
    for (const sig of [loud, quiet, new Float32Array(SR)]) {
      analyze(sig, (frame, t) => processor.process(frame, t, f));
      for (const k of ['subBass', 'bass', 'mid', 'treble', 'waveformRms', 'spectralFlux', 'overallEnergy'] as const) {
        expect(Number.isFinite(f[k]), k).toBe(true);
        expect(f[k]).toBeGreaterThanOrEqual(0);
        expect(f[k]).toBeLessThanOrEqual(1.0001);
      }
    }
    expect(powerToDb(0)).toBeLessThan(-100);
  });
});
