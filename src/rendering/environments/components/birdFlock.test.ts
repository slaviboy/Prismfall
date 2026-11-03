import { describe, expect, it } from 'vitest';
import { Boids } from '../flocking/boids';
import { Falcon } from '../flocking/falcon';
import {
  RAPTOR_FINGERS,
  azimuthOf,
  birdFlockComponent,
  guardAzimuth,
  murmurationConfig,
  raptorGeometry,
  raptorPosition,
  raptorTrack,
  skyDirection,
  skyFrame,
  skyPoint,
  starlingGeometry,
} from './birdFlock';

const EYE: [number, number, number] = [0, 1, 31];

describe('sky placement', () => {
  it('puts a sky point at the given azimuth, elevation and distance from the eye', () => {
    const at = { azimuth: -27, elevation: 12, distance: 210 };
    const p = skyPoint(EYE, at);
    expect(azimuthOf(EYE, p)).toBeCloseTo(-27, 6);
    expect(Math.hypot(p[0] - EYE[0], p[1] - EYE[1], p[2] - EYE[2])).toBeCloseTo(210, 6);
    expect(Math.asin((p[1] - EYE[1]) / 210) / (Math.PI / 180)).toBeCloseTo(12, 6);
    // Straight ahead is −Z.
    const ahead = skyDirection(0, 0);
    expect(ahead[2]).toBeCloseTo(-1, 9);
  });

  it('builds an orthonormal view-facing frame whose back axis points at the viewer', () => {
    const f = skyFrame({ azimuth: 31, elevation: 17, distance: 100 });
    const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    for (const v of [f.right, f.up, f.back]) expect(Math.hypot(...v)).toBeCloseTo(1, 9);
    expect(dot(f.right, f.up)).toBeCloseTo(0, 9);
    expect(dot(f.right, f.back)).toBeCloseTo(0, 9);
    expect(dot(f.up, f.back)).toBeCloseTo(0, 9);
    const d = skyDirection(31, 17);
    expect(dot(f.back, d)).toBeCloseTo(-1, 9);
    // right × up = back (the shader derives back that way).
    const c = [f.right[1] * f.up[2] - f.right[2] * f.up[1], f.right[2] * f.up[0] - f.right[0] * f.up[2], f.right[0] * f.up[1] - f.right[1] * f.up[0]];
    for (let k = 0; k < 3; k++) expect(c[k]!).toBeCloseTo(f.back[k]!, 9);
  });
});

describe('clear zone guard', () => {
  it('leaves azimuths beyond the margin alone and never lets one into the clear zone', () => {
    expect(guardAzimuth(-30, -1, 20, 3)).toBe(-30);
    expect(guardAzimuth(26, 1, 20, 3)).toBe(26);
    let prev = -Infinity;
    for (let a = -60; a <= 40; a += 0.25) {
      const g = guardAzimuth(a, 1, 20, 3);
      expect(g).toBeGreaterThan(20);
      // Monotonic, so a flock pressed against the zone is squeezed, never folded over.
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
      expect(guardAzimuth(-a, -1, 20, 3)).toBeCloseTo(-g, 9);
    }
    // Continuous (C1) where the easing starts.
    const h = 1e-4;
    expect((guardAzimuth(23 + h, 1, 20, 3) - guardAzimuth(23 - h, 1, 20, 3)) / (2 * h)).toBeCloseTo(1, 3);
  });
});

describe('murmuration (boids)', () => {
  const params = birdFlockComponent.schema.parse({
    kind: 'murmuration',
    roost: { at: { azimuth: -27.5, elevation: 11.5, distance: 105 }, size: [11, 7, 42] },
    count: 600,
    separation: 0.9,
    passing: { count: 120, at: { azimuth: -28, elevation: 12, distance: 50 }, size: [7, 4, 10], away: -60, period: 75 },
    seed: 5,
  });
  if (params.kind !== 'murmuration') throw new Error('schema');

  it('places the roost in the sky window and the clear-zone edge just outside 20 degrees', () => {
    const cfg = murmurationConfig(params, 600, false);
    expect(azimuthOf(EYE, cfg.bounds.center)).toBeCloseTo(-27.5, 6);
    const plane = cfg.avoid[0]!;
    const side = (az: number) => {
      const p = skyPoint(EYE, { azimuth: az, elevation: 12, distance: 105 });
      return plane.normal[0] * p[0] + plane.normal[1] * p[1] + plane.normal[2] * p[2] - plane.offset;
    };
    expect(side(-22)).toBeCloseTo(0, 3);
    expect(side(-30)).toBeGreaterThan(0);
    expect(side(-15)).toBeLessThan(0);
  });

  it('wheels in its roost, survives a falcon stoop and never enters the clear zone', () => {
    const cfg = murmurationConfig(params, 600, false);
    const boids = new Boids(cfg);
    const falcon = new Falcon({ every: 6, stoopSpeed: 26, cruiseSpeed: 16, radius: 11, above: 45, side: [-1, 0, 0], seed: 3 });
    const c: [number, number, number] = [0, 0, 0];
    const v: [number, number, number] = [0, 0, 0];
    let minAz = Infinity;
    let maxAz = -Infinity;
    let attacks = 0;
    let wasAway = true;
    for (let s = 0; s < 60 * 45; s++) {
      boids.centroid(c, v);
      falcon.update(1 / 60, c, v, 1, boids.threats[0]!);
      if (wasAway && falcon.phase === 'stoop') attacks++;
      wasAway = falcon.phase === 'away';
      boids.step(1 / 60);
      if (s % 30 === 0) {
        for (let i = 0; i < boids.count; i++) {
          const az = azimuthOf(EYE, [boids.pos[i * 3]!, boids.pos[i * 3 + 1]!, boids.pos[i * 3 + 2]!]);
          minAz = Math.min(minAz, az);
          maxAz = Math.max(maxAz, az);
        }
      }
    }
    expect(attacks).toBeGreaterThan(1);
    expect(boids.pos.every((x) => Number.isFinite(x))).toBe(true);
    // Never inside the clear zone (the shader eases the last 2 degrees as a final guard).
    expect(maxAz).toBeLessThan(-20);
    // And within reach of the ultrawide frame edge.
    expect(minAz).toBeGreaterThan(-45);
  });
});

describe('raptor circling', () => {
  const params = birdFlockComponent.schema.parse({
    kind: 'soaring',
    birds: [{ at: { azimuth: -29, elevation: 15.5, distance: 115 }, radius: 12, speed: 9, drift: 4, climb: 3 }],
  });
  if (params.kind !== 'soaring') throw new Error('schema');
  const track = raptorTrack(EYE, params.birds[0]!, 2.7);

  it('flies at about its airspeed and banks like a real raptor in a thermal', () => {
    const h = 0.05;
    let minV = Infinity;
    let maxV = 0;
    let maxBank = 0;
    for (let t = 0; t < 600; t += 1.3) {
      const a = raptorPosition(track, t - h);
      const b = raptorPosition(track, t);
      const c = raptorPosition(track, t + h);
      const v = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]) / (2 * h);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
      const acc = [0, 1, 2].map((k) => (c[k]! - 2 * b[k]! + a[k]!) / (h * h));
      const horizontal = Math.hypot(acc[0]!, acc[2]!);
      maxBank = Math.max(maxBank, Math.atan2(horizontal, 9.81) / (Math.PI / 180));
    }
    // Airspeed breathes with the circle, but stays in a soaring raptor's range.
    expect(minV).toBeGreaterThan(5);
    expect(maxV).toBeLessThan(16);
    // Thermalling raptors bank about 20–45 degrees, never a knife edge.
    expect(maxBank).toBeGreaterThan(18);
    expect(maxBank).toBeLessThan(55);
  });

  it('stays out of the clear zone and in a believable band of sky', () => {
    for (let t = 0; t < 900; t += 0.7) {
      const p = raptorPosition(track, t);
      const az = azimuthOf(EYE, p);
      expect(az).toBeLessThan(-20);
      expect(az).toBeGreaterThan(-42);
      const el = Math.atan2(p[1] - EYE[1], Math.hypot(p[0] - EYE[0], p[2] - EYE[2])) / (Math.PI / 180);
      expect(el).toBeGreaterThan(10);
      expect(el).toBeLessThan(22);
    }
  });
});

describe('bird geometry', () => {
  it('starling: one unit of wingspan, faces −Z, tiny enough to instance thousands', () => {
    const g = starlingGeometry();
    g.computeBoundingBox();
    const box = g.boundingBox!;
    expect(box.max.x - box.min.x).toBeCloseTo(1, 6);
    // Bill forward (−Z), short body: length about half the wingspan, as in a starling.
    expect(box.min.z).toBeLessThan(-0.2);
    expect(box.max.z - box.min.z).toBeGreaterThan(0.4);
    expect(box.max.z - box.min.z).toBeLessThan(0.6);
    expect(g.getAttribute('position').count).toBeLessThanOrEqual(24);
  });

  it('raptor: broad wings with seven slotted primaries, a protruding head and a long tail', () => {
    const g = raptorGeometry();
    const pos = g.getAttribute('position');
    const bird = g.getAttribute('bird');
    const nrm = g.getAttribute('normal');
    expect(pos.count).toBeLessThan(400);
    let span = 0;
    let headZ = 0;
    let tailZ = 0;
    const tips: [number, number][] = [];
    for (let i = 0; i < pos.count; i++) {
      const part = bird.getX(i);
      expect([0, 1, 2, 3]).toContain(part);
      expect(Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i))).toBeCloseTo(1, 3);
      span = Math.max(span, Math.abs(pos.getX(i)));
      if (part === 0) headZ = Math.min(headZ, pos.getZ(i));
      if (part === 3) tailZ = Math.max(tailZ, pos.getZ(i));
      // Finger tips on the right wing.
      if (part === 2 && bird.getZ(i) > 0.9 && pos.getX(i) > 0) tips.push([pos.getX(i), pos.getZ(i)]);
    }
    expect(span).toBeGreaterThan(0.47);
    expect(span).toBeLessThanOrEqual(0.5);
    // Head projects well ahead of the leading edge; the tail is longer than the head projection.
    expect(headZ).toBeLessThan(-0.17);
    expect(tailZ).toBeGreaterThan(0.24);
    // Seven fingers (two tip vertices each) whose tips are clearly separated: real slots.
    expect(tips.length).toBe(RAPTOR_FINGERS.length * 2);
    const centres: [number, number][] = [];
    for (let k = 0; k < tips.length; k += 2) centres.push([(tips[k]![0] + tips[k + 1]![0]) / 2, (tips[k]![1] + tips[k + 1]![1]) / 2]);
    for (let k = 1; k < centres.length; k++) {
      const gap = Math.hypot(centres[k]![0] - centres[k - 1]![0], centres[k]![1] - centres[k - 1]![1]);
      expect(gap).toBeGreaterThan(0.02);
    }
    // Broad wings: aspect ratio (span² / planform area) of a soaring eagle, about 5–8.
    const idx = g.index!;
    let area = 0;
    for (let k = 0; k < idx.count; k += 3) {
      const [a, b, c] = [idx.getX(k), idx.getX(k + 1), idx.getX(k + 2)];
      const pa = bird.getX(a);
      if (pa !== 1 && pa !== 2) continue;
      const ux = pos.getX(b) - pos.getX(a);
      const uz = pos.getZ(b) - pos.getZ(a);
      const vx = pos.getX(c) - pos.getX(a);
      const vz = pos.getZ(c) - pos.getZ(a);
      area += Math.abs(ux * vz - uz * vx) / 2;
    }
    const aspect = (2 * span) ** 2 / area;
    expect(aspect).toBeGreaterThan(5);
    expect(aspect).toBeLessThan(8);
  });
});

describe('schema', () => {
  it('accepts both kinds with defaults and rejects unknown kinds', () => {
    const m = birdFlockComponent.schema.safeParse({ kind: 'murmuration', roost: { at: { azimuth: 30, elevation: 12, distance: 200 } } });
    expect(m.success).toBe(true);
    const s = birdFlockComponent.schema.safeParse({ kind: 'soaring', birds: [{ at: { azimuth: -30, elevation: 15, distance: 120 } }] });
    expect(s.success).toBe(true);
    expect(birdFlockComponent.schema.safeParse({ kind: 'parrots' }).success).toBe(false);
  });
});
