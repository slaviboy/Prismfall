import { describe, expect, it } from 'vitest';
import type { BurstParticle } from '../particles/BurstSystem';
import type { BurstSystem } from '../particles/BurstSystem';
import { BUILTIN_TRANSITIONS } from './transitions';

function fakeBursts(): { bursts: BurstSystem; emitted: BurstParticle[] } {
  const emitted: BurstParticle[] = [];
  const bursts = { budget: (n: number) => Math.round(n), emit: (p: BurstParticle) => emitted.push(p) } as unknown as BurstSystem;
  return { bursts, emitted };
}

const palette = { accent: '#ffb257', secondary: '#ff7a45', highlight: '#ffe6b8', fog: '#8c5236' };

describe('stage transitions', () => {
  for (const t of BUILTIN_TRANSITIONS) {
    it(`${t.id} emits finite particles within the crossfade and keeps the playfield readable`, () => {
      const { bursts, emitted } = fakeBursts();
      t.play({ bursts, palette, duration: 2.5, time: 10, intensityScale: 1, reducedMotion: false }, {});
      expect(emitted.length).toBeGreaterThan(50);
      expect(emitted.length).toBeLessThan(4000);
      for (const p of emitted) {
        for (const v of [p.x, p.y, p.z, p.vx, p.vy, p.vz, p.r, p.g, p.b, p.size, p.life]) expect(Number.isFinite(v)).toBe(true);
        expect(p.delay ?? 0).toBeLessThanOrEqual(2.5);
        expect(p.size).toBeLessThan(8);
      }
      // Spawn points over the playfield (in front of it) stay a small minority.
      const over = emitted.filter((p) => Math.abs(p.x) < 6 && Math.abs(p.y) < 10.5 && p.z > -2).length;
      expect(over / emitted.length).toBeLessThan(0.35);
    });
  }

  it('reduced motion thins every transition', () => {
    for (const t of BUILTIN_TRANSITIONS) {
      const full = fakeBursts();
      const calm = fakeBursts();
      t.play({ bursts: full.bursts, palette, duration: 2.5, time: 0, intensityScale: 1, reducedMotion: false }, {});
      t.play({ bursts: calm.bursts, palette, duration: 2.5, time: 0, intensityScale: 1, reducedMotion: true }, {});
      expect(calm.emitted.length, t.id).toBeLessThan(full.emitted.length * 0.5);
    }
  });
});
