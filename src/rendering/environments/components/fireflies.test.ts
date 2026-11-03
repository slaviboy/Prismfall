import { describe, expect, it } from 'vitest';
import wilderness from '../../../../content/stages/enchanted-wilderness/stage.json';
import { seeded } from './common';
import { burstFlash, firefliesComponent, flashPulse, jStroke, minReach, placeFireflies, singleFlash, type FireflyHome } from './fireflies';

const DEG = Math.PI / 180;
const shipped = () => {
  const layer = wilderness.environment.layers.find((l) => l.type === 'fireflies');
  expect(layer).toBeDefined();
  return firefliesComponent.schema.parse(layer?.params);
};
/** Same seed the component uses for its layout. */
const layout = (p: ReturnType<typeof firefliesComponent.schema.parse>, count = p.count): FireflyHome[] => placeFireflies(p, count, seeded(p.seed * 5297 + 3));

describe('firefly placement', () => {
  it('keeps every firefly and its wander outside the clear zone around the board', () => {
    const base = shipped();
    for (const seed of [1, 2, 7, 42, 99]) {
      const p = { ...base, seed };
      for (const h of layout(p, 200)) expect(minReach(h, p.area.eye[2])).toBeGreaterThan(p.area.clearance * DEG);
    }
  });

  it('spreads them over both sides, the distance range and low elevations', () => {
    const p = shipped();
    const homes = layout(p, 120);
    const left = homes.filter((h) => h.x < 0).length;
    expect(Math.abs(left - (homes.length - left))).toBeLessThanOrEqual(1);
    for (const h of homes) {
      expect(h.dist).toBeGreaterThanOrEqual(p.area.distance[0]);
      expect(h.dist).toBeLessThanOrEqual(p.area.distance[1]);
      expect(h.el).toBeGreaterThanOrEqual(p.area.elevation[0] * DEG - 1e-9);
      expect(h.el).toBeLessThanOrEqual(p.area.elevation[1] * DEG + 1e-9);
    }
    // Depth: log-uniform, so there are near, middle and far fireflies.
    const near = homes.filter((h) => h.dist < 15).length;
    const far = homes.filter((h) => h.dist > 60).length;
    expect(near).toBeGreaterThan(10);
    expect(far).toBeGreaterThan(10);
    // A mix of synchronous and single-flash fireflies; burst lengths within the range.
    expect(homes.some((h) => h.sync) && homes.some((h) => !h.sync)).toBe(true);
    for (const h of homes) {
      expect(h.flashes).toBeGreaterThanOrEqual(p.burstFlashes[0]);
      expect(h.flashes).toBeLessThanOrEqual(p.burstFlashes[1]);
    }
  });
});

describe('firefly flash patterns', () => {
  it('flashes once: a quick rise, a slower fade, dark outside it', () => {
    expect(flashPulse(-0.01, 0.5, 0)).toBe(0);
    expect(flashPulse(0.5, 0.5, 0)).toBe(0);
    expect(flashPulse(0.175, 0.5, 0)).toBeCloseTo(1, 5);
    // Rises faster than it fades.
    expect(flashPulse(0.1, 0.5, 0)).toBeGreaterThan(flashPulse(0.25, 0.5, 0) - 0.4);
    expect(flashPulse(0.05, 0.5, 0)).toBeLessThan(flashPulse(0.3, 0.5, 0));
  });

  it('flash reduction makes flashes gentler: lower peak, slower rise', () => {
    let peak = 0;
    for (let x = 0; x < 2; x += 0.005) peak = Math.max(peak, flashPulse(x, 0.14, 1));
    expect(peak).toBeLessThan(0.65);
    expect(flashPulse(0.02, 0.14, 1)).toBeLessThan(flashPulse(0.02, 0.14, 0));
  });

  it('patrollers light up for well under a fifth of their cycle', () => {
    const period = 5.8;
    let lit = 0;
    const n = 5800;
    for (let i = 0; i < n; i++) if (singleFlash((i / n) * period, period, 0.3, 0) > 0.05) lit++;
    expect(lit / n).toBeGreaterThan(0.03);
    expect(lit / n).toBeLessThan(0.12);
  });

  it('synchronous fireflies give a burst of separate short pulses, then stay dark', () => {
    const period = 10;
    const gap = 0.5;
    for (const flashes of [4, 6, 7]) {
      let pulses = 0;
      let on = false;
      for (let t = 0; t < period; t += 0.002) {
        const v = burstFlash(t, period, flashes, gap, 0);
        if (!on && v > 0.3) pulses++;
        on = v > 0.3;
      }
      expect(pulses).toBe(flashes);
      // Dark gaps between pulses and after the burst.
      expect(burstFlash(gap * 0.75, period, flashes, gap, 0)).toBe(0);
      expect(burstFlash(flashes * gap + 1, period, flashes, gap, 0)).toBe(0);
    }
  });

  it('the J-stroke climbs during the flash and sinks back by the end of the cycle', () => {
    const period = 6;
    expect(Math.abs(jStroke(0, period))).toBeLessThan(0.1);
    expect(jStroke(0.6, period)).toBeGreaterThan(0.8);
    expect(Math.abs(jStroke(period, period))).toBeLessThan(1e-6);
  });
});
