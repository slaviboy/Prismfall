import { describe, expect, it } from 'vitest';
import { seeded } from './common';
import { angleBetween, azEl, direction, MeteorScheduler, planMeteor, skylineAt, type MeteorSkyConfig, type Vec3 } from './meteorPlan';

const cfg = (over: Partial<MeteorSkyConfig> = {}): MeteorSkyConfig => ({
  interval: 9,
  intensityBoost: 0.6,
  fireballs: 0.03,
  showers: { enabled: true, every: 180, duration: 30, rate: 3 },
  azimuth: [24, 58],
  elevation: [3, 32],
  view: { azimuth: [24, 38], elevation: [3, 15] },
  skyline: [],
  margin: 1.2,
  avoid: [],
  length: [5, 16],
  speed: [10, 28],
  colors: { green: 0.45, orange: 0.35 },
  ...over,
});

/** Points along the drawn arc (the shader interpolates the chord and normalises). */
function along(a: Vec3, b: Vec3, n = 20): Vec3[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const p: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const l = Math.hypot(...p);
    return [p[0] / l, p[1] / l, p[2] / l];
  });
}

describe('meteor planning', () => {
  it('round-trips azimuth and elevation', () => {
    const [az, el] = azEl(direction(-33, 12));
    expect(az).toBeCloseTo(-33, 6);
    expect(el).toBeCloseTo(12, 6);
  });

  it('interpolates a skyline and holds its end values', () => {
    const line = [
      [10, 2],
      [20, 6],
    ] as const;
    expect(skylineAt(line, 15)).toBeCloseTo(4);
    expect(skylineAt(line, 0)).toBe(2);
    expect(skylineAt(line, 40)).toBe(6);
    expect(skylineAt([], 0)).toBe(-90);
  });

  it('keeps every path out of the clear zone, above the skyline, with its bright half in view', () => {
    const skyline = [
      [-60, 2],
      [-30, 7],
      [0, 3],
      [30, 5],
      [60, 12],
    ] as const;
    const c = cfg({ skyline });
    const rand = seeded(42);
    let planned = 0;
    for (let i = 0; i < 400; i++) {
      const plan = planMeteor(c, rand, { radiant: null, fireball: i % 10 === 0 });
      if (!plan) continue;
      planned++;
      const pts = along(plan.a, plan.b);
      const side = Math.sign(azEl(plan.a)[0]);
      pts.forEach((p, k) => {
        const [az, el] = azEl(p);
        expect(Math.sign(az)).toBe(side);
        expect(Math.abs(az)).toBeGreaterThanOrEqual(c.azimuth[0] - 0.5);
        expect(el).toBeGreaterThanOrEqual(skylineAt(skyline, az) + c.margin - 0.5);
        expect(el).toBeLessThanOrEqual(c.elevation[1] + 0.5);
        if (k >= pts.length * 0.5) {
          expect(Math.abs(az)).toBeLessThanOrEqual(c.view.azimuth[1] + 0.5);
          expect(el).toBeLessThanOrEqual(c.view.elevation[1] + 0.5);
        }
      });
      expect(plan.duration).toBeGreaterThan(0.1);
      expect(plan.duration).toBeLessThanOrEqual(plan.fireball ? 3.2 : 1.2);
    }
    expect(planned).toBeGreaterThan(300);
  });

  it('keeps paths clear of avoided directions (the moon)', () => {
    const moon = direction(29, 8.5);
    const c = cfg({ avoid: [{ direction: moon, radius: 6 }] });
    const rand = seeded(7);
    for (let i = 0; i < 300; i++) {
      const plan = planMeteor(c, rand, { radiant: null, fireball: false });
      if (plan) for (const p of along(plan.a, plan.b)) expect(angleBetween(p, moon)).toBeGreaterThan(5.5);
    }
  });

  it('moves shower meteors away from their radiant', () => {
    const radiant = direction(10, 60);
    const rand = seeded(3);
    let n = 0;
    for (let i = 0; i < 200; i++) {
      const plan = planMeteor(cfg(), rand, { radiant, fireball: false, showerSpeed: 25 });
      if (!plan) continue;
      n++;
      expect(angleBetween(plan.b, radiant)).toBeGreaterThan(angleBetween(plan.a, radiant));
      // On the great circle through the radiant: a, b and the radiant are coplanar.
      const [a, b] = [plan.a, plan.b];
      const nx = a[1] * b[2] - a[2] * b[1];
      const ny = a[2] * b[0] - a[0] * b[2];
      const nz = a[0] * b[1] - a[1] * b[0];
      expect(Math.abs(nx * radiant[0] + ny * radiant[1] + nz * radiant[2]) / Math.hypot(nx, ny, nz)).toBeLessThan(1e-6);
    }
    expect(n).toBeGreaterThan(100);
  });

  it('has no fireballs and a capped peak with flash reduction', () => {
    const rand = seeded(11);
    for (let i = 0; i < 200; i++) {
      const plan = planMeteor(cfg(), rand, { radiant: null, fireball: true, flashSafe: true });
      if (!plan) continue;
      expect(plan.fireball).toBe(false);
      expect(plan.mag).toBeLessThanOrEqual(0.75);
    }
  });

  it('makes faint meteors common and bright ones rare', () => {
    const rand = seeded(5);
    const mags: number[] = [];
    for (let i = 0; i < 600; i++) {
      const plan = planMeteor(cfg(), rand, { radiant: null, fireball: false });
      if (plan) mags.push(plan.mag);
    }
    const bright = mags.filter((m) => m > 0.6).length / mags.length;
    expect(bright).toBeGreaterThan(0.1);
    expect(bright).toBeLessThan(0.4);
  });
});

describe('meteor timing', () => {
  /** Meteors launched over `seconds` at 60 fps with the given section intensity. */
  function count(s: MeteorScheduler, seconds: number, intensity: number, from = 0): number {
    let n = 0;
    const dt = 1 / 60;
    for (let t = from; t < from + seconds; t += dt) if (s.step(t, dt, intensity, 1, false)) n++;
    return n;
  }

  it('averages one meteor per interval in calm music, without showers', () => {
    const s = new MeteorScheduler(cfg({ showers: { enabled: false, every: 180, duration: 30, rate: 3 } }), seeded(9), { reduced: false, density: 1 });
    const n = count(s, 3600, 0.3);
    // 400 expected; a few paths may not fit and are skipped.
    expect(n).toBeGreaterThan(330);
    expect(n).toBeLessThan(460);
  });

  it('comes a little more often in intense sections', () => {
    const c = cfg({ showers: { enabled: false, every: 180, duration: 30, rate: 3 } });
    const calm = new MeteorScheduler(c, seeded(1), { reduced: false, density: 1 }).rate(0, 0.3);
    const intense = new MeteorScheduler(c, seeded(1), { reduced: false, density: 1 }).rate(0, 1);
    expect(intense / calm).toBeCloseTo(1.6, 5);
  });

  it('runs showers at several times the rate, and none with reduced motion', () => {
    const s = new MeteorScheduler(cfg(), seeded(2), { reduced: false, density: 1 });
    s.startShower(100);
    expect(s.inShower(101)).toBe(true);
    expect(s.rate(101, 0.3) / s.rate(1000, 0.3)).toBeCloseTo(3, 5);
    const reduced = new MeteorScheduler(cfg(), seeded(2), { reduced: true, density: 1 });
    reduced.startShower(100);
    expect(reduced.rate(101, 0.3)).toBeCloseTo((1 / 9) * 0.4, 6);
  });

  it('launches nothing at zero particle density', () => {
    const s = new MeteorScheduler(cfg(), seeded(4), { reduced: false, density: 0 });
    expect(count(s, 600, 1)).toBe(0);
  });
});
