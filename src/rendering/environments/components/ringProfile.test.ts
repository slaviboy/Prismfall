import { describe, expect, it } from 'vitest';
import { SATURN_RING_KM, saturnRingProfile } from './ringProfile';

const N = 4096;
const profile = saturnRingProfile(N, 1);
const tauAt = (km: number): number => {
  const i = Math.round(((km - SATURN_RING_KM.inner) / (SATURN_RING_KM.outer - SATURN_RING_KM.inner)) * N - 0.5);
  return profile[i * 4 + 3] as number;
};
const mean = (from: number, to: number): number => {
  let s = 0;
  let n = 0;
  for (let km = from; km < to; km += 50) {
    s += tauAt(km);
    n++;
  }
  return s / n;
};

describe('saturnRingProfile', () => {
  it('has Saturn’s ring structure: faint C, dense B, Cassini Division, A ring, gaps and the F ring', () => {
    const c = mean(76_000, 90_000);
    const b = mean(100_000, 116_000);
    const cassini = mean(118_000, 121_800);
    const a = mean(123_000, 133_000);
    expect(c).toBeLessThan(0.2);
    expect(b).toBeGreaterThan(0.75);
    expect(cassini).toBeLessThan(0.15);
    expect(a).toBeGreaterThan(0.35);
    expect(a).toBeLessThan(b);
    expect(tauAt(133_580)).toBe(0); // Encke gap
    expect(tauAt(138_000)).toBeLessThan(0.02); // Roche division
    expect(tauAt(140_180)).toBeGreaterThan(0.25); // F ring
  });

  it('is deterministic, bounded and has fine ringlet variation', () => {
    expect(saturnRingProfile(256, 3)).toEqual(saturnRingProfile(256, 3));
    for (let i = 0; i < N; i++) {
      const t = profile[i * 4 + 3] as number;
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(Math.fround(0.98));
    }
    // Neighbouring samples inside the C ring are not all equal (ringlets).
    const values = new Set<number>();
    for (let km = 80_000; km < 86_000; km += 200) values.add(Math.round(tauAt(km) * 1000));
    expect(values.size).toBeGreaterThan(10);
  });
});
