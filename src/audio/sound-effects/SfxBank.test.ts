import { describe, expect, it } from 'vitest';
import { pickVariant } from './SfxBank';

/** A deterministic stand-in for Math.random. */
function seq(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

describe('pickVariant', () => {
  it('never plays the same variant twice in a row', () => {
    const r = seq(7);
    let last = -1;
    for (let i = 0; i < 200; i++) {
      const v = pickVariant(4, last, undefined, r);
      expect(v).not.toBe(last);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(4);
      last = v;
    }
  });

  it('with a weight, stays among the variants nearest it (light to heavy) and still avoids repeats', () => {
    const r = seq(11);
    for (const [weight, allowed] of [
      [0, [0, 1]],
      [0.2, [0, 1, 2]],
      [0.6, [2, 3, 4]],
      [1, [4, 5]],
    ] as const) {
      let last = -1;
      const seen = new Set<number>();
      for (let i = 0; i < 100; i++) {
        const v = pickVariant(6, last, weight, r);
        expect(allowed as readonly number[], `weight ${weight}`).toContain(v);
        expect(v).not.toBe(last);
        seen.add(v);
        last = v;
      }
      expect(seen.size, `weight ${weight} varies`).toBeGreaterThan(1);
    }
  });

  it('clamps the weight and handles a single variant', () => {
    expect(pickVariant(1, 0, 0.5)).toBe(0);
    expect([4, 5]).toContain(pickVariant(6, -1, 3, seq(3)));
    expect([0, 1]).toContain(pickVariant(6, -1, -2, seq(3)));
  });
});
