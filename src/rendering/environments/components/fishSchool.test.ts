import { describe, expect, it } from 'vitest';
import { fishGeometry, fishSchoolComponent, loopPoint } from './fishSchool';

describe('fish body', () => {
  const g = fishGeometry();
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const fish = g.getAttribute('fish');

  it('is one unit long, faces -Z and stays small enough to instance hundreds', () => {
    g.computeBoundingBox();
    const box = g.boundingBox!;
    expect(box.min.z).toBeCloseTo(-0.5, 3);
    expect(box.max.z).toBeGreaterThan(0.49);
    expect(box.max.z).toBeLessThan(0.52);
    expect(pos.count).toBeLessThan(500);
  });

  it('has a deep, laterally compressed body with sane per-vertex data', () => {
    let maxX = 0;
    let maxY = -Infinity;
    let minY = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const along = fish.getX(i);
      const part = fish.getY(i);
      const height = fish.getZ(i);
      expect(along).toBeGreaterThanOrEqual(0);
      expect(along).toBeLessThanOrEqual(1);
      expect([0, 1, 2]).toContain(part);
      expect(Math.abs(height)).toBeLessThanOrEqual(1);
      expect(Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i))).toBeCloseTo(1, 3);
      if (part === 0) {
        maxX = Math.max(maxX, Math.abs(pos.getX(i)));
        maxY = Math.max(maxY, pos.getY(i));
        minY = Math.min(minY, pos.getY(i));
      }
    }
    // Herring-like: about a fifth as deep as it is long, roughly twice as deep as wide.
    expect(maxY - minY).toBeGreaterThan(0.17);
    expect(maxY - minY).toBeLessThan(0.24);
    expect((maxY - minY) / (2 * maxX)).toBeGreaterThan(1.6);
  });

  it('has a forked tail: the notch sits well ahead of both lobe tips', () => {
    let upperTip = -Infinity;
    let lowerTip = -Infinity;
    let notch = Infinity;
    for (let i = 0; i < pos.count; i++) {
      if (fish.getY(i) !== 1) continue;
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (y > 0.08) upperTip = Math.max(upperTip, z);
      if (y < -0.08) lowerTip = Math.max(lowerTip, z);
      if (Math.abs(y) < 0.01 && z > 0.4) notch = Math.min(notch, z);
    }
    expect(upperTip - notch).toBeGreaterThan(0.05);
    expect(lowerTip - notch).toBeGreaterThan(0.05);
  });
});

describe('school loop', () => {
  it('returns the exact derivative of the loop position (the CPU speed and GPU heading rely on it)', () => {
    const params = fishSchoolComponent.schema.parse({ schools: [{ center: [10, 2, -60], radius: [30, 4, 15] }] });
    const school = params.schools[0]!;
    for (const tau of [0, 0.7, 1.9, 3.3, 5.1]) {
      const h = 1e-4;
      const a = loopPoint(school, 0.4, 1.3, tau - h);
      const b = loopPoint(school, 0.4, 1.3, tau + h);
      const d = loopPoint(school, 0.4, 1.3, tau).d;
      for (let k = 0; k < 3; k++) expect(d[k]!).toBeCloseTo(((b.p[k] as number) - (a.p[k] as number)) / (2 * h), 3);
      // Never stalls: the tangent stays well away from zero, so headings are always defined.
      expect(Math.hypot(d[0], d[2])).toBeGreaterThan(5);
    }
  });
});
