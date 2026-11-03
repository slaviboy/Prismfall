import { describe, expect, it } from 'vitest';
import { buildDuneMesh, createDuneField, noise1, noise2, skyline, type DuneFieldSpec } from './duneField';

const spec: DuneFieldSpec = {
  center: [0, 30],
  span: [-100, 100],
  start: 470,
  floor: -17,
  floorRise: 6,
  ridges: [
    { distance: 620, height: 30, meander: 0.06, variation: 0.7, peaks: 0.3 },
    { distance: 770, height: 44, meander: 0.06, variation: 0.75, peaks: 0.4 },
    { distance: 960, height: 66, meander: 0.055, variation: 0.75, peaks: 0.5 },
    { distance: 1200, height: 92, meander: 0.05, variation: 0.7, peaks: 0.5 },
  ],
  lee: 'near',
  slip: 33,
  stoss: 20,
  undulation: 0.08,
  perspective: 0.35,
  seed: 5,
};

describe('dune field', () => {
  it('noise stays in range and is deterministic', () => {
    const a = noise1(3);
    const b = noise1(3);
    const n2 = noise2(4);
    for (let x = -50; x < 50; x += 0.37) {
      expect(a(x)).toBe(b(x));
      expect(Math.abs(a(x))).toBeLessThanOrEqual(1.01);
      expect(Math.abs(n2(x, x * 0.7))).toBeLessThanOrEqual(1.21);
    }
  });

  it('keeps the crests in order and each crest a local maximum', () => {
    const field = createDuneField(spec);
    for (let az = -100; az <= 100; az += 0.5) {
      for (let k = 0; k < spec.ridges.length; k++) {
        const r = field.crestDistance(k, az);
        if (k > 0) expect(r).toBeGreaterThan(field.crestDistance(k - 1, az) + 40);
        const h = field.height(az, r);
        expect(Number.isFinite(h)).toBe(true);
        expect(h).toBeGreaterThan(field.height(az, r - 6));
        expect(h).toBeGreaterThan(field.height(az, r + 6));
      }
    }
  });

  it('builds a finite crest-aligned mesh that stays under the near terrain', () => {
    const field = createDuneField(spec);
    const near = { apex: [0, 34] as const, far: 520, spread: 1.45, height: () => -10 };
    const mesh = buildDuneMesh(field, { columnsPerDegree: 2, rowsPerGap: 10, near });
    expect(mesh.positions.length / 3).toBe(mesh.normals.length / 3);
    for (let i = 0; i < mesh.positions.length; i++) expect(Number.isFinite(mesh.positions[i]!)).toBe(true);
    for (let i = 1; i < mesh.normals.length; i += 3) expect(mesh.normals[i]!).toBeGreaterThan(0);
    for (let i = 0; i < mesh.index.length; i++) expect(mesh.index[i]!).toBeLessThan(mesh.positions.length / 3);
    // Triangles wind counter-clockwise seen from above: their geometric normals point up, so the
    // faces the viewer looks at are front faces.
    const p = (i: number) => [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!];
    for (let t = 0; t < mesh.index.length; t += 997 * 3) {
      const [a, b, c] = [p(mesh.index[t]!), p(mesh.index[t + 1]!), p(mesh.index[t + 2]!)];
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      expect(u[2]! * v[0]! - u[0]! * v[2]!).toBeGreaterThan(0);
    }
    // Inside the near terrain's wedge the field is at least 2.5 units under it.
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const x = mesh.positions[i * 3]!;
      const y = mesh.positions[i * 3 + 1]!;
      const z = mesh.positions[i * 3 + 2]!;
      if (z > 34 - 520 && Math.abs(x) < (34 - z) * 1.45 + 20) expect(y).toBeLessThanOrEqual(-12.4);
    }
    expect(mesh.crests).toHaveLength(spec.ridges.length);
  });

  it('gives a low skyline above the horizon ahead', () => {
    const field = createDuneField(spec);
    const mesh = buildDuneMesh(field, { columnsPerDegree: 2, rowsPerGap: 10 });
    const line = skyline(mesh, [0, 1.06, 30.36], 2);
    const ahead = line.filter(([az]) => Math.abs(az) <= 45);
    expect(ahead.length).toBeGreaterThan(30);
    for (const [, el] of ahead) {
      expect(el).toBeGreaterThan(0);
      expect(el).toBeLessThan(9);
    }
  });
});
