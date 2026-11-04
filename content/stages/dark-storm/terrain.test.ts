import { describe, expect, it } from 'vitest';
import { buildChannel } from './bolt';
import { EYE, LEDGE, LOCH, boardLimit, ledgeMask, pointAt, puddle, streamMask, terrainHeight } from './terrain';

describe('the Dark Storm landscape', () => {
  it('gives the viewer a ledge to stand on and never hides the playfield', () => {
    expect(terrainHeight(EYE.x, EYE.z)).toBeGreaterThan(LEDGE - 0.6);
    expect(terrainHeight(EYE.x, EYE.z)).toBeLessThan(LEDGE + 1);
    expect(terrainHeight(0, 30)).toBeLessThan(EYE.y - 1.5);
    // Sample the board's view frustum in front of the board: the ground stays under its bottom ray.
    for (let z = 1; z < EYE.z - 1; z += 1.5) {
      const ahead = EYE.z - z;
      const halfW = (10.6 * ahead) / EYE.z;
      for (let x = -halfW; x <= halfW; x += halfW / 4 || 1) {
        const bottomRay = EYE.y + ((-11.8 - EYE.y) * ahead) / EYE.z;
        expect(terrainHeight(x, z)).toBeLessThan(bottomRay + 0.05);
      }
    }
    expect(boardLimit(0, -10)).toBe(Infinity);
  });

  it('runs the ledge out to the sides, with puddles and a stream on it', () => {
    for (const az of [-50, -35, 35, 50]) {
      const p = pointAt(az, 40);
      expect(ledgeMask(p.x, p.z), `az ${az}`).toBeGreaterThan(0.9);
      expect(terrainHeight(p.x, p.z)).toBeGreaterThan(LEDGE - 2);
    }
    let wet = 0;
    let stream = 0;
    for (let i = 0; i < 4000; i++) {
      const p = pointAt(-70 + (i % 140), 6 + Math.floor(i / 140) * 2);
      if (puddle(p.x, p.z) > 0.5) wet++;
      if (streamMask(p.x, p.z) > 0.5) stream++;
    }
    expect(wet).toBeGreaterThan(150);
    expect(stream).toBeGreaterThan(10);
  });

  it('drops to a loch in the glen and rises to mountains far out', () => {
    let water = 0;
    for (let i = 0; i < 60; i++) {
      const p = pointAt(-40 + (i % 12) * 7, 300 + Math.floor(i / 12) * 150);
      if (terrainHeight(p.x, p.z) < LOCH) water++;
    }
    expect(water).toBeGreaterThan(30);
    let peak = -Infinity;
    for (let a = -70; a <= 70; a += 2) {
      const p = pointAt(a, 1650);
      peak = Math.max(peak, terrainHeight(p.x, p.z));
    }
    expect(peak).toBeGreaterThan(80);
  });
});

describe('lightning channels', () => {
  it('grow from the cloud to the strike point, branched and different for every seed', () => {
    const spec = { kind: 'cloudToGround' as const, top: [300, 520, -400] as [number, number, number], bottom: [380, -44, -520] as [number, number, number], seed: 17 };
    const c = buildChannel(spec);
    const main = c.segments.filter((s) => s.level === 0);
    expect(main[0]!.a).toEqual(spec.top);
    expect(main[main.length - 1]!.b).toEqual(spec.bottom);
    expect(c.length).toBeGreaterThan(560);
    expect(new Set(c.segments.map((s) => s.branch)).size).toBeGreaterThan(5);
    // Tortuous: the channel is clearly longer than the straight line.
    expect(c.length / Math.hypot(80, 564, 120)).toBeGreaterThan(1.15);
    // Branches end in the air above the ground and lean down.
    for (const s of c.segments) expect(Math.min(s.a[1], s.b[1])).toBeGreaterThan(-60);
    const other = buildChannel({ ...spec, seed: 18 });
    expect(other.segments[5]!.a).not.toEqual(c.segments[5]!.a);
    expect(buildChannel(spec).segments).toEqual(c.segments);
    // Orders run from the cloud downwards.
    expect(main[0]!.order).toBe(0);
    expect(main[main.length - 1]!.order).toBeGreaterThan(0.9);
  });

  it('crawls along under the cloud base for cloud-to-cloud discharges and stays within budget', () => {
    const c = buildChannel({ kind: 'cloudToCloud', top: [-900, 480, -700], bottom: [-200, 470, -1100], seed: 5, maxSegments: 400 });
    expect(c.segments.length).toBeLessThanOrEqual(400);
    for (const s of c.segments) expect(s.a[1]).toBeGreaterThan(300);
    expect(buildChannel({ kind: 'intracloud', top: [0, 500, 0], bottom: [0, 500, 0], seed: 1 }).segments).toEqual([]);
  });
});
