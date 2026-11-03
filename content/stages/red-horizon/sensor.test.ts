import { describe, expect, it } from 'vitest';
import { twoBone, wrapAngle } from './rig';
import { SensorController } from './sensor';

describe('optical sensor controller', () => {
  it('stays inside its field and keeps moving (scan, hold, focus)', () => {
    const s = new SensorController({ seed: 7, yaw: [-0.8, 0.6], pitch: [-0.4, 0.1] });
    const modes = new Set<string>();
    let minYaw = Infinity;
    let maxYaw = -Infinity;
    for (let i = 0; i < 60 * 120; i++) {
      s.update(1 / 60);
      modes.add(s.mode);
      minYaw = Math.min(minYaw, s.yaw);
      maxYaw = Math.max(maxYaw, s.yaw);
      expect(s.pitch).toBeGreaterThan(-0.45);
      expect(s.pitch).toBeLessThan(0.15);
    }
    expect(minYaw).toBeGreaterThan(-0.85);
    expect(maxYaw).toBeLessThan(0.65);
    expect(maxYaw - minYaw).toBeGreaterThan(0.6);
    expect(modes.has('scan')).toBe(true);
    expect(modes.has('focus') || modes.has('hold')).toBe(true);
    expect(s.intensity).toBeGreaterThan(0.5);
  });

  it('turns towards a fresh event in front of it and focuses', () => {
    const s = new SensorController({ seed: 3, curiosity: 1 });
    for (let i = 0; i < 30; i++) s.update(1 / 60);
    // An explosion 300 m away, 30 degrees to the left of a mount facing -Z.
    const a = (30 * Math.PI) / 180;
    const ev = [{ x: -Math.sin(a) * 300, y: 10, z: -Math.cos(a) * 300, t: 1, weight: 1 }];
    for (let i = 0; i < 90; i++) s.update(1 / 60, ev, 1, { x: 0, y: 2, z: 0, heading: 0 });
    expect(s.mode).toBe('track');
    expect(Math.abs(s.yaw - a)).toBeLessThan(0.08);
    expect(s.focus).toBeGreaterThan(0.6);
  });

  it('is dark while powered down and boots up', () => {
    const s = new SensorController({ seed: 1 });
    s.power = 0;
    for (let i = 0; i < 120; i++) s.update(1 / 60);
    expect(s.intensity).toBeLessThan(0.05);
    s.power = 1;
    for (let i = 0; i < 120; i++) s.update(1 / 60);
    expect(s.intensity).toBeGreaterThan(0.5);
  });

  it('is deterministic for a seed', () => {
    const a = new SensorController({ seed: 42 });
    const b = new SensorController({ seed: 42 });
    for (let i = 0; i < 600; i++) {
      a.update(1 / 60);
      b.update(1 / 60);
    }
    expect(a.yaw).toBe(b.yaw);
    expect(a.pitch).toBe(b.pitch);
  });
});

describe('rig helpers', () => {
  it('solves two-bone IK and clamps out-of-reach targets', () => {
    const { a1, a2 } = twoBone(1, 1, Math.SQRT2);
    expect(a1).toBeCloseTo(Math.PI / 4, 5);
    expect(a2).toBeCloseTo(Math.PI / 4, 5);
    const far = twoBone(1, 1, 5);
    expect(far.a1).toBeLessThan(0.05);
    expect(Number.isFinite(twoBone(1, 0.5, 0).a1)).toBe(true);
  });

  it('wraps angles into -pi..pi', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 6);
    expect(wrapAngle(-Math.PI / 2 - 2 * Math.PI)).toBeCloseTo(-Math.PI / 2, 6);
  });
});
