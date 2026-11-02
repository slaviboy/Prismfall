import { describe, expect, it } from 'vitest';
import { analyzeTrack, downmix } from './trackAnalysis';

const SR = 44100;

/** Kick-like low thumps on every beat and noise hats on the off-beats, starting at `offset`. */
function groove(bpm: number, seconds: number, offset: number, loudFrom = Infinity): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  const spb = 60 / bpm;
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  for (let t = offset; t < seconds; t += spb / 2) {
    const onBeat = Math.abs(((t - offset) / spb) % 1) < 1e-6 || Math.abs(((t - offset) / spb) % 1 - 1) < 1e-6;
    const start = Math.round(t * SR);
    const gain = t >= loudFrom ? 1 : 0.35;
    for (let i = 0; i < 0.15 * SR && start + i < out.length; i++) {
      const env = Math.exp(-i / (0.03 * SR));
      const v = onBeat ? Math.sin((2 * Math.PI * 60 * i) / SR) * 0.9 * env : rnd() * 0.25 * Math.exp(-i / (0.008 * SR));
      out[start + i] = (out[start + i] as number) + v * gain;
    }
  }
  return out;
}

describe('offline track analysis', () => {
  for (const bpm of [96, 128]) {
    it(`finds ${bpm} BPM and the beat grid offset`, () => {
      const offset = 0.37;
      const r = analyzeTrack(groove(bpm, 24, offset), SR);
      expect(Math.abs(r.bpm - bpm) / bpm).toBeLessThan(0.02);
      // The grid lands on a beat (within 12 ms), not necessarily the first one.
      const spb = 60 / bpm;
      const d = (((r.offset - offset) % spb) + spb) % spb;
      expect(Math.min(d, spb - d)).toBeLessThan(0.012);
      expect(r.confidence).toBeGreaterThan(0.3);
      expect(Math.abs(r.duration - 24)).toBeLessThan(0.01);
    });
  }

  it('marks a louder half as a new, more intense section', () => {
    const r = analyzeTrack(groove(120, 48, 0.1, 24), SR);
    expect(r.sections.length).toBeGreaterThanOrEqual(2);
    const last = r.sections[r.sections.length - 1]!;
    expect(last.startBar).toBeGreaterThan(8);
    expect(last.intensity).toBeGreaterThan(r.sections[0]!.intensity);
  });

  it('reports no confidence for silence and downmixes channels', () => {
    const r = analyzeTrack(new Float32Array(SR * 5), SR);
    expect(r.confidence).toBe(0);
    const m = downmix([new Float32Array([1, 0]), new Float32Array([0, 1])]);
    expect([...m]).toEqual([0.5, 0.5]);
  });
});
