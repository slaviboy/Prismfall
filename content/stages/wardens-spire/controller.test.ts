import { describe, expect, it } from 'vitest';
import { WardenController, minJerk, type WardenState } from './controller';
import { beamEnd, gazeRules, gazeTowards, offAxis, type Vec3 } from './gaze';

const DEG = Math.PI / 180;
const origin: Vec3 = [625, 355, -1052];
const eye: Vec3 = [0, 1, 30.5];
const rules = { origin, eye, ground: -55, far: 2600, minSeparation: 30, clearZone: 24, pitch: [-72, 3] as const };
const allowed = gazeRules(rules);

function setup(seed: number) {
  const spots: Vec3[] = [
    [250, -60, -560],
    [330, -60, -760],
    [480, -60, -920],
    [760, -60, -560],
    [900, -60, -1700],
    [420, -45, -1300],
  ];
  return {
    seed,
    allowed,
    targets: spots.map((p) => ({ ...gazeTowards(origin, p), weight: 1 })),
    horizon: { from: 28 * DEG, to: 115 * DEG, pitch: [-7 * DEG, -2.5 * DEG] as const },
    land: { heading: [-175 * DEG, 150 * DEG] as const, pitch: [-62 * DEG, -8 * DEG] as const },
    awakenEvery: 240,
  };
}

function run(seed: number, seconds: number, reducedMotion = false, activity = (t: number) => 0.5 + 0.4 * Math.sin(t / 37)) {
  const c = new WardenController(setup(seed));
  const dt = 1 / 60;
  const states = new Map<WardenState, number>();
  const outputs: { h: number; p: number; state: WardenState; speed: number; aperture: number }[] = [];
  for (let i = 0; i < seconds * 60; i++) {
    const t = i * dt;
    const o = c.update(dt, { activity: activity(t), reducedMotion });
    states.set(o.state, (states.get(o.state) ?? 0) + dt);
    outputs.push({ h: o.heading, p: o.pitch, state: o.state, speed: o.speed, aperture: o.aperture });
  }
  return { states, outputs, controller: c };
}

describe('Warden controller', () => {
  it('eases with a minimum-jerk profile', () => {
    expect(minJerk(0)).toBe(0);
    expect(minJerk(1)).toBe(1);
    expect(minJerk(0.5)).toBeCloseTo(0.5, 6);
    expect(minJerk(0.01)).toBeLessThan(0.001);
  });

  it('visits every behaviour over a long run', () => {
    const { states } = run(7, 1500);
    for (const s of ['scan', 'search', 'focus', 'rapid', 'gaze', 'return', 'awaken'] as const) expect(states.get(s) ?? 0, s).toBeGreaterThan(1);
  });

  it('moves smoothly, without snaps', () => {
    const { outputs } = run(11, 600);
    let maxStep = 0;
    for (let i = 1; i < outputs.length; i++) {
      const a = outputs[i - 1]!;
      const b = outputs[i]!;
      maxStep = Math.max(maxStep, Math.hypot(b.h - a.h, b.p - a.p));
    }
    // Less than 1.6 degrees per frame at 60 fps (about 95 deg/s at the very fastest).
    expect(maxStep).toBeLessThan(1.6 * DEG);
  });

  it('never points the beam at the viewer or into the clear zone', () => {
    for (const seed of [1, 2, 3]) {
      const { outputs } = run(seed, 900);
      let worst = 90;
      for (const o of outputs) {
        const end = beamEnd(origin, o.h, o.p, rules.ground, rules.far);
        for (let i = 1; i <= 6; i++) {
          const k = i / 6;
          const p: Vec3 = [origin[0] + (end.point[0] - origin[0]) * k, origin[1] + (end.point[1] - origin[1]) * k, origin[2] + (end.point[2] - origin[2]) * k];
          worst = Math.min(worst, offAxis(eye, p));
        }
      }
      // The spring may overshoot a commanded target slightly; it still stays clear of 20 degrees.
      expect(worst, `seed ${seed}`).toBeGreaterThan(21);
    }
  });

  it('does not repeat itself', () => {
    const { outputs } = run(5, 900);
    // Durations of consecutive states differ; the sequence of state changes is not periodic.
    const changes: number[] = [];
    let last = outputs[0]!.state;
    let since = 0;
    for (const o of outputs) {
      since++;
      if (o.state !== last) {
        changes.push(since);
        since = 0;
        last = o.state;
      }
    }
    expect(changes.length).toBeGreaterThan(30);
    const unique = new Set(changes.map((c) => Math.round(c / 6)));
    expect(unique.size).toBeGreaterThan(changes.length * 0.5);
  });

  it('focuses by tightening the aperture', () => {
    const { outputs } = run(9, 600);
    const focused = outputs.filter((o) => o.state === 'focus');
    expect(focused.length).toBeGreaterThan(0);
    expect(Math.max(...focused.map((o) => o.aperture))).toBeGreaterThan(0.8);
  });

  it('skips rapid turns and moves gently with reduced motion', () => {
    const { states, outputs } = run(4, 900, true);
    expect(states.get('rapid') ?? 0).toBe(0);
    expect(Math.max(...outputs.map((o) => o.speed))).toBeLessThan(30 * DEG);
  });

  it('sweeps across the land when given sweeps', () => {
    const from = gazeTowards(origin, [380, -55, -790]);
    const to = gazeTowards(origin, [560, -55, -640]);
    const c = new WardenController({ ...setup(12), sweeps: [{ from, to }], sweepShare: 1, awakenEvery: 0 });
    let near = 0;
    for (let i = 0; i < 60 * 240; i++) {
      const o = c.update(1 / 60, { activity: 0.5, reducedMotion: false });
      if (o.state === 'scan' && Math.abs(o.pitch - (from.pitch + to.pitch) / 2) < 8 * DEG) near++;
    }
    expect(allowed(from.heading, from.pitch) && allowed(to.heading, to.pitch)).toBe(true);
    expect(near).toBeGreaterThan(60 * 5);
  });

  it('wakes when asked, then settles', () => {
    const c = new WardenController(setup(3));
    for (let i = 0; i < 300; i++) c.update(1 / 60, { activity: 0.5, reducedMotion: false });
    c.awaken(1);
    let peak = 0;
    for (let i = 0; i < 60 * 20; i++) peak = Math.max(peak, c.update(1 / 60, { activity: 0.5, reducedMotion: false }).awaken);
    expect(peak).toBeGreaterThan(0.95);
    const after = c.update(1 / 60, { activity: 0.5, reducedMotion: false });
    expect(after.awaken).toBe(0);
    expect(after.state).not.toBe('awaken');
  });
});
