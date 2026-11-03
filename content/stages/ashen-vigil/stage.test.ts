import { describe, expect, it } from 'vitest';
import { cloudShape, detonationInterval, flashEnvelope, measureSkyline, placeDetonation, skylineAt, timeCapPasses, type Detonation } from './stage';

const det = (over: Partial<Detonation> = {}): Detonation => ({
  start: 0,
  azimuth: 30,
  distance: 650,
  size: 180,
  ground: [325, 2, -563],
  air: 0.1,
  wilson: true,
  collar: true,
  collarHeight: 0.45,
  collarPass: timeCapPasses({ air: 0.1 }, 0.45),
  seed: 1,
  shock: 10,
  life: 280,
  timescale: 1,
  retire: null,
  ...over,
});

const seq = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length] as number;
};

describe('Ashen Vigil detonations', () => {
  it('flashes fast and localized normally, and only swells slowly and dimly with flash reduction', () => {
    expect(flashEnvelope(-1, false)).toBe(0);
    const peak = Math.max(...Array.from({ length: 200 }, (_, i) => flashEnvelope(i * 0.01, false)));
    expect(peak).toBeGreaterThan(0.7);
    expect(flashEnvelope(8, false)).toBeLessThan(0.05);
    // Reduced: never above a third of the normal peak, and no frame-to-frame jump.
    let prev = 0;
    for (let t = 0; t < 12; t += 1 / 60) {
      const v = flashEnvelope(t, true);
      expect(v).toBeLessThanOrEqual(0.3 + 1e-9);
      expect(Math.abs(v - prev)).toBeLessThan(0.01);
      prev = v;
    }
  });

  it('rises, rolls into a cap, burns for tens of seconds and cools from the outside in', () => {
    const d = det();
    const early = cloudShape(d, 2, 2);
    const mid = cloudShape(d, 30, 30);
    const late = cloudShape(d, 200, 200);
    expect(early.emission).toBeGreaterThan(mid.emission * 10);
    expect(mid.hc).toBeGreaterThan(early.hc);
    expect(late.hc).toBeGreaterThan(mid.hc);
    expect(late.hc).toBeLessThan(0.75);
    expect(mid.ringR).toBeGreaterThan(early.ringR);
    // Fire still visible at half a minute, and the hot region shrinking.
    expect(mid.core).toBeGreaterThan(0.4);
    expect(mid.heatR).toBeLessThan(early.heatR);
    expect(late.core).toBeLessThan(mid.core);
    // The skirt races out early; the Wilson shell is gone within seconds.
    expect(cloudShape(d, 3, 3).skirtR).toBeGreaterThan(0.25);
    expect(cloudShape(d, 0.8, 0.8).wilsonA).toBeGreaterThan(0.3);
    expect(cloudShape(d, 4, 4).wilsonA).toBe(0);
    // Gone at the end of its life.
    expect(cloudShape(d, d.life, d.life).fade).toBe(0);
  });

  it('shows the condensation collar only after the cap has climbed past it', () => {
    const d = det();
    expect(d.collarPass).not.toBeNull();
    expect(cloudShape(d, (d.collarPass as number) - 1, 0).collarA).toBe(0);
    expect(cloudShape(d, (d.collarPass as number) + 4, 0).collarA).toBeGreaterThan(0.5);
  });

  it('comes more often as the run progresses, and less often under reduced motion', () => {
    expect(detonationInterval(1, false)).toBeLessThan(detonationInterval(0, false) / 2.5);
    expect(detonationInterval(0.5, true)).toBeGreaterThan(detonationInterval(0.5, false));
  });

  it('keeps every cloud, its widest cap included, outside the board clear zone', () => {
    const rand = seq([0.13, 0.71, 0.42, 0.97, 0.05, 0.58, 0.33, 0.86, 0.21, 0.64, 0.49, 0.02, 0.77]);
    for (let i = 0; i < 300; i++) {
      const p = placeDetonation(rand, [{ azimuth: 30 }]);
      const halfWidth = Math.atan((p.size * 0.42) / p.distance) * (180 / Math.PI);
      expect(Math.abs(p.azimuth) - halfWidth).toBeGreaterThanOrEqual(21);
      expect(p.distance).toBeGreaterThan(520);
    }
  });

  it('measures the skyline where the bright sky meets the dark land', () => {
    // 4 columns x 20 rows, 1 row per degree from +10 down: sky (200) above row 12, land (40) below.
    const w = 4;
    const rows = 20;
    const px = new Uint8ClampedArray(w * rows * 4);
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < w; x++) {
        const v = y < 12 + (x === 3 ? -4 : 0) ? 200 : 40;
        px.set([v, v, v, 255], (y * w + x) * 4);
      }
    const line = measureSkyline(px, w, rows, 10, 1, 0.3);
    expect(line[0]).toBeCloseTo(10 - 12, 0);
    expect(line[3]).toBeCloseTo(10 - 8, 0);
    // Column 0 covers the first quarter turn; its centre is at 45 degrees.
    expect(skylineAt({ skyline: line, offset: 0 }, 45)).toBeCloseTo(-2, 0);
    expect(skylineAt({ skyline: null, offset: 0 }, 10)).toBe(2);
  });
});
