import { describe, expect, it } from 'vitest';
import camelRig from '../../../content/shared/creatures/camel.rig.json';
import { GroupMotion, PathTrack, crossingFade, type PathPoint } from './paths';
import { bodyBob, jointAngle, rigSchema, type RigJoint } from './rig';
import { sampleSurface, type CreatureGeometry } from './surface';

const joint = (over: Partial<RigJoint>): RigJoint => ({ name: 'j', pivot: [0, 0, 0], axis: [1, 0, 0], amp: 1, phase: 0, freq: 1, bias: 0, rectify: 0, ...over });

describe('creature rig', () => {
  it('swings symmetric joints both ways and rectified joints one way', () => {
    const hip = joint({ amp: 0.4 });
    expect(jointAngle(hip, 0.25)).toBeCloseTo(0.4);
    expect(jointAngle(hip, 0.75)).toBeCloseTo(-0.4);
    const knee = joint({ amp: 0.75, rectify: -1 });
    expect(jointAngle(knee, 0.25)).toBeCloseTo(-0.75);
    expect(jointAngle(knee, 0.75)).toBeCloseTo(0);
    const hock = joint({ amp: 0.6, rectify: 1 });
    expect(jointAngle(hock, 0.25)).toBeCloseTo(0.6);
    expect(jointAngle(hock, 0.75)).toBeCloseTo(0);
  });

  it('straightens every joint when standing (gait 0)', () => {
    expect(jointAngle(joint({ amp: 0.4, bias: 0.1 }), 0.3, 0)).toBeCloseTo(0.1);
  });

  it('bobs twice per cycle', () => {
    const rig = rigSchema.parse({ name: 't', height: 2, stride: 1, bob: 0.1, joints: [] });
    expect(bodyBob(rig, 0)).toBeCloseTo(0);
    expect(bodyBob(rig, 0.25)).toBeCloseTo(0.1);
    expect(bodyBob(rig, 0.5)).toBeCloseTo(0);
  });

  it('parses the shipped camel rig', () => {
    const rig = rigSchema.parse(camelRig);
    expect(rig.joints.length).toBe(10);
    expect(rig.forward).toBe('-z');
    // Camels pace: left legs move together, right legs half a cycle later.
    const byName = new Map(rig.joints.map((j) => [j.name, j]));
    expect(Math.abs((byName.get('fl_hip')?.phase ?? 0) - (byName.get('bl_hip')?.phase ?? 1))).toBeLessThan(0.1);
    expect(Math.abs((byName.get('fr_hip')?.phase ?? 0) - (byName.get('fl_hip')?.phase ?? 0) - 0.5)).toBeLessThan(0.05);
  });
});

describe('creature paths', () => {
  const pt: PathPoint = { x: 0, y: 0, z: 0, dx: 0, dz: 0 };

  it('parameterises lines by arc length', () => {
    const t = new PathTrack({ kind: 'line', from: [0, 0, 0], to: [10, 0, 0] });
    expect(t.length).toBeCloseTo(10);
    t.at(2.5, pt);
    expect(pt.x).toBeCloseTo(2.5);
    expect(pt.dx).toBeCloseTo(1);
  });

  it('wraps loops', () => {
    const t = new PathTrack({ kind: 'loop', center: [0, 0, 0], radius: [5, 5], clockwise: false });
    expect(t.length).toBeCloseTo(2 * Math.PI * 5, 0);
    t.at(t.length + 1, pt);
    const a = { ...pt };
    t.at(1, pt);
    expect(a.x).toBeCloseTo(pt.x);
    expect(a.z).toBeCloseTo(pt.z);
  });

  it('fades in and out at the ends of a crossing', () => {
    expect(crossingFade(-1, 100, 10)).toBe(0);
    expect(crossingFade(5, 100, 10)).toBeCloseTo(0.5);
    expect(crossingFade(50, 100, 10)).toBe(1);
    expect(crossingFade(95, 100, 10)).toBeCloseTo(0.5);
  });

  it('walks, rests between crossings and starts again', () => {
    const m = new GroupMotion({ speed: 2, delay: 1, rest: 3, stopEvery: 0, stopFor: 0 }, 20, false);
    m.step(0.5);
    expect(m.distance).toBe(0);
    for (let i = 0; i < 600; i++) m.step(1 / 60);
    expect(m.distance).toBeGreaterThan(15);
    for (let i = 0; i < 60 * 10; i++) m.step(1 / 60);
    expect(m.crossing).toBe(1);
  });

  it('eases into stops', () => {
    const m = new GroupMotion({ speed: 1, delay: 0, rest: 0, stopEvery: 2, stopFor: 3 }, 1000, true);
    for (let i = 0; i < 60 * 1.9; i++) m.step(1 / 60);
    expect(m.walking).toBeGreaterThan(0.9);
    for (let i = 0; i < 60 * 2.5; i++) m.step(1 / 60);
    expect(m.walking).toBeLessThan(0.1);
  });
});

describe('surface sampling', () => {
  it('distributes samples by area and keeps joint attributes', () => {
    // Two triangles: a large one (joint 1) and a tiny one (joint 2).
    const geo: CreatureGeometry = {
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 1, 0.1, 0, 1, 0, 0.1, 1]),
      normals: new Float32Array(18).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)),
      ja: new Float32Array([1, 1, 1, 2, 2, 2]),
      jb: new Float32Array([-1, -1, -1, 0, 0, 0]),
      index: new Uint32Array([0, 1, 2, 3, 4, 5]),
    };
    let s = 1;
    const rand = (): number => ((s = (s * 16807) % 2147483647) / 2147483647);
    const out = sampleSurface(geo, 2000, rand);
    let small = 0;
    for (let i = 0; i < out.count; i++) {
      if (out.a[i * 4 + 3] === 2) {
        small++;
        expect(out.b[i * 4]).toBe(0);
        expect(out.a[i * 4 + 2]).toBeCloseTo(1);
      } else {
        expect(out.a[i * 4 + 2]).toBeCloseTo(0);
        expect(out.b[i * 4]).toBe(-1);
      }
    }
    // Area ratio is 10000:1, so almost no samples land on the tiny triangle.
    expect(small).toBeLessThan(5);
  });
});
