import { describe, expect, it } from 'vitest';
import { renderCrack, renderRainTexture, renderThunder, type StereoBuffer } from './stormSynth';

const SR = 48000;

const peakOf = (b: StereoBuffer): number => {
  let p = 0;
  for (const c of [b.left, b.right]) for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]!));
  return p;
};

/** RMS of a channel over [from, to) seconds. */
const rms = (x: Float32Array, from: number, to: number): number => {
  let s = 0;
  const a = Math.round(from * SR);
  const b = Math.min(x.length, Math.round(to * SR));
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, b - a));
};

/** Share of energy above `hz` (first-difference energy against total, a cheap brightness measure). */
const brightness = (x: Float32Array, from: number, to: number): number => {
  let d = 0;
  let e = 0;
  const a = Math.round(from * SR);
  const b = Math.min(x.length, Math.round(to * SR));
  for (let i = a + 1; i < b; i++) {
    d += (x[i]! - x[i - 1]!) ** 2;
    e += x[i]! ** 2;
  }
  return d / Math.max(1e-12, e);
};

const finite = (b: StereoBuffer): boolean => [b.left, b.right].every((c) => c.every((v) => Number.isFinite(v)));

describe('storm synthesis', () => {
  it('renders thunder that is clean, headroomed, deterministic and unique per seed', () => {
    const a = renderThunder({ seed: 3, distance: 900, energy: 0.8, sampleRate: SR });
    expect(finite(a)).toBe(true);
    expect(peakOf(a)).toBeLessThanOrEqual(0.9);
    expect(peakOf(a)).toBeGreaterThan(0.5);
    expect(a.left.length).toBeGreaterThan(SR * 4);
    expect(a.left.length).toBeLessThanOrEqual(SR * 14);
    const again = renderThunder({ seed: 3, distance: 900, energy: 0.8, sampleRate: SR });
    expect(again.left.slice(0, 2000)).toEqual(a.left.slice(0, 2000));
    const other = renderThunder({ seed: 4, distance: 900, energy: 0.8, sampleRate: SR });
    expect(Math.abs(rms(other.left, 0, 3) - rms(a.left, 0, 3))).toBeGreaterThan(1e-4);
    // The tail decays to silence; the left and right channels differ (a wide image).
    expect(rms(a.left, a.left.length / SR - 0.2, a.left.length / SR)).toBeLessThan(0.02);
    expect(rms(a.left, 0, 2)).not.toBeCloseTo(rms(a.right, 0, 2), 4);
  });

  it('makes nearby thunder sharp and bright, distant thunder soft and dull', () => {
    const near = renderThunder({ seed: 9, distance: 380, energy: 1, strokes: [0, 0.07, 0.16], sampleRate: SR });
    const far = renderThunder({ seed: 9, distance: 7000, energy: 0.4, sampleRate: SR });
    // A sharp onset near by: most of the first 300 ms' level arrives in its first 50 ms.
    expect(rms(near.left, 0, 0.05)).toBeGreaterThan(rms(near.left, 0.25, 0.3) * 0.5);
    // Distant thunder fades in without a transient.
    expect(rms(far.left, 0, 0.02)).toBeLessThan(rms(far.left, 0.4, 1.2) * 0.5);
    expect(brightness(near.left, 0, 0.5)).toBeGreaterThan(brightness(far.left, 0, 1.5) * 3);
  });

  it('renders a short, bright crack unlike the thunder', () => {
    const c = renderCrack({ seed: 2, energy: 1, sampleRate: SR });
    expect(finite(c)).toBe(true);
    expect(peakOf(c)).toBeLessThanOrEqual(0.86);
    expect(c.left.length).toBeLessThan(SR * 2);
    expect(rms(c.left, 0, 0.15)).toBeGreaterThan(rms(c.left, 0.8, 1.2) * 8);
    const t = renderThunder({ seed: 2, distance: 400, energy: 1, sampleRate: SR });
    expect(brightness(c.left, 0, 0.15)).toBeGreaterThan(brightness(t.left, 0, 0.15) * 2);
  });

  it('renders seamless rain loops for every surface', () => {
    for (const surface of ['water', 'rock', 'wood', 'foliage'] as const) {
      const r = renderRainTexture(surface, 3, 5, SR);
      expect(finite(r), surface).toBe(true);
      expect(r.left.length).toBe(SR * 3);
      const level = rms(r.left, 0, 3);
      expect(level, surface).toBeGreaterThan(0.1);
      // No click at the seam: the jump across it is no bigger than the signal's typical step.
      const jump = Math.abs(r.left[0]! - r.left[r.left.length - 1]!);
      expect(jump, surface).toBeLessThan(level * 4);
    }
  });
});
