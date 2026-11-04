import { describe, expect, it } from 'vitest';
import { AnimationClip, AnimationMixer, Bone, Group, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from 'three/webgpu';
import { RevealTracker, buildPath, inPlaceClip, lateralWaypoints, pathCycle, pathState, revealTarget, stopWeight, type PathPlan } from './modelMotion';

/** A root (scaled 0.01 and turned Z-up like many exports) with hips and two legs. */
function rig(): { root: Group; hips: Bone } {
  const root = new Group();
  const armature = new Bone();
  armature.name = 'Armature';
  armature.scale.setScalar(0.01);
  armature.rotation.x = -Math.PI / 2;
  const hips = new Bone();
  hips.name = 'Hips';
  hips.position.set(0, 0, 100);
  const legL = new Bone();
  legL.name = 'LegL';
  const legR = new Bone();
  legR.name = 'LegR';
  hips.add(legL, legR);
  armature.add(hips);
  root.add(armature);
  return { root, hips };
}

describe('root motion removal', () => {
  it('locks the hips horizontally, keeps the bob, and measures the ground speed', () => {
    const { root, hips } = rig();
    // In the Z-up armature, forward is -y in its space; 150 units/s there = 1.5 world units/s.
    const times = [0, 0.25, 0.5, 0.75, 1];
    const values = times.flatMap((t) => [0, -150 * t, 100 + 5 * Math.sin(t * Math.PI * 2)]);
    // The last key snaps back to the start, as looped exports often do.
    values.splice(12, 3, 0, 0, 100);
    const leg = new QuaternionKeyframeTrack('LegL.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]);
    const clip = new AnimationClip('Walk', 1, [new VectorKeyframeTrack('Hips.position', times, values), leg]);
    const result = inPlaceClip(clip, root);
    expect(result.bone).toBe('Hips');
    expect(result.speed).toBeCloseTo(1.5, 5);
    expect(result.clip.tracks[1]).toBe(leg);
    const mixer = new AnimationMixer(root);
    mixer.clipAction(result.clip).play();
    const world = new Vector3();
    for (const t of [0.1, 0.375, 0.6, 0.9]) {
      mixer.setTime(t);
      root.updateMatrixWorld(true);
      hips.getWorldPosition(world);
      expect(world.x).toBeCloseTo(0, 6);
      expect(world.z).toBeCloseTo(0, 6);
    }
    // Height still moves with the clip (rest height 1 world unit, bob ±0.05).
    mixer.setTime(0.25);
    root.updateMatrixWorld(true);
    expect(hips.getWorldPosition(world).y).toBeCloseTo(1.05, 4);
    // The source clip is untouched.
    expect(clip.tracks[0]!.values[4]).toBeCloseTo(-37.5, 5);
  });

  it('leaves clips without position tracks alone', () => {
    const { root } = rig();
    const clip = new AnimationClip('Idle', 1, [new QuaternionKeyframeTrack('LegL.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])]);
    const result = inPlaceClip(clip, root);
    expect(result.clip).toBe(clip);
    expect(result.speed).toBe(0);
    expect(result.bone).toBeNull();
  });

  it('picks the bone that carries the most of the skeleton', () => {
    const { root } = rig();
    const clip = new AnimationClip('Walk', 1, [new VectorKeyframeTrack('LegR.position', [0, 1], [0, 0, 0, 5, 0, 0]), new VectorKeyframeTrack('Hips.position', [0, 1], [0, 0, 100, 0, -100, 100])]);
    expect(inPlaceClip(clip, root).bone).toBe('Hips');
  });
});

describe('path progress', () => {
  const plain: PathPlan = { length: 100, speed: 2, phase: 0.25, stops: [], ease: 1 };

  it('without stops is phase + time · speed / length', () => {
    for (const time of [0, 3, 17.5, 60]) {
      const s = pathState(time, plain);
      expect(s.t).toBeCloseTo((0.25 + (time * 2) / 100) % 1, 9);
      expect(s.pace).toBe(1);
      expect(s.stop).toBe(-1);
    }
    expect(pathCycle(plain)).toBeCloseTo(50, 9);
  });

  it('eases into a stop, holds it, and eases out without jumps', () => {
    const plan: PathPlan = { length: 100, speed: 2, phase: 0, stops: [{ at: 0.5, for: 4 }], ease: 1 };
    // 50 s of walking plus one second per stop for the two half-speed eases, plus the stop.
    expect(pathCycle(plan)).toBeCloseTo(55, 9);
    let last = pathState(0, plan);
    let held = 0;
    for (let time = 0.01; time < 55; time += 0.01) {
      const s = pathState(time, plan);
      expect(s.distance - last.distance).toBeGreaterThanOrEqual(-1e-9);
      expect(s.distance - last.distance).toBeLessThanOrEqual(2 * 0.01 + 1e-6);
      if (s.pace === 0) {
        held += 0.01;
        expect(s.t).toBeCloseTo(0.5, 9);
        expect(stopWeight(s)).toBe(1);
      }
      last = s;
    }
    expect(held).toBeCloseTo(4, 1);
    // Halfway through slowing down (25 s of walking, the last second easing): pace 0.5.
    const slowing = pathState(25, plan);
    expect(slowing.stop).toBe(0);
    expect(slowing.pace).toBeCloseTo(0.5, 6);
    expect(stopWeight(slowing)).toBeCloseTo(0.5, 6);
    expect(slowing.stopTime).toBeLessThan(0);
    // Getting going again afterwards: stopTime beyond the stop's length.
    const leaving = pathState(30, plan);
    expect(leaving.stop).toBe(0);
    expect(leaving.pace).toBeCloseTo(0.5, 6);
    expect(leaving.stopTime).toBeGreaterThan(4);
    expect(pathState(40, plan).stop).toBe(-1);
  });
});

describe('path shapes', () => {
  it('maps distance to points along straight legs', () => {
    const path = buildPath([new Vector3(0, 0, 0), new Vector3(0, 0, 10), new Vector3(10, 0, 10)], false, false);
    expect(path.length).toBeCloseTo(20, 9);
    const p = new Vector3();
    const t = new Vector3();
    path.sample(15, p, t);
    expect(p.toArray()).toEqual([5, 0, 10]);
    expect(t.x).toBeCloseTo(1, 9);
    path.sample(99, p, t);
    expect(p.toArray()).toEqual([10, 0, 10]);
  });

  it('turns left with a positive sign on a smooth closed loop', () => {
    // Counter-clockwise seen from above when heading +z first means turning towards +x: left.
    const ring = Array.from({ length: 12 }, (_, k) => new Vector3(-Math.cos((k / 12) * Math.PI * 2) * 20, 0, Math.sin((k / 12) * Math.PI * 2) * 20));
    const path = buildPath(ring, true, true);
    expect(path.closed).toBe(true);
    expect(path.length).toBeGreaterThan(2 * Math.PI * 20 * 0.97);
    expect(path.length).toBeLessThan(2 * Math.PI * 20 * 1.03);
    for (let d = 0; d < path.length; d += path.length / 17) expect(path.turn(d)).toBeGreaterThan(0);
    expect(path.maxTurn).toBeGreaterThan(0.9 / 20);
    expect(path.maxTurn).toBeLessThan(1.3 / 20);
    // Wraps around.
    const a = new Vector3();
    const b = new Vector3();
    const t = new Vector3();
    path.sample(3, a, t);
    path.sample(3 + path.length, b, t);
    expect(a.distanceTo(b)).toBeLessThan(1e-6);
  });
});

describe('reveal with the run', () => {
  const plan = { from: 0.4, to: 0.6, unlock: 0.5, hold: 10 };

  it('ramps smoothly over its progress window', () => {
    expect(revealTarget(plan, 0, 0, -1)).toBe(0);
    expect(revealTarget(plan, 0.4, 0, -1)).toBe(0);
    expect(revealTarget(plan, 0.5, 0, -1)).toBeCloseTo(0.5, 6);
    expect(revealTarget(plan, 0.6, 0, -1)).toBe(1);
    expect(revealTarget(plan, 1, 0, -1)).toBe(1);
  });

  it('eases its level, and a big clear calls it in only once unlocked, for `hold` seconds', () => {
    const r = new RevealTracker(plan, 1);
    const run = (from: number, to: number, progress: number) => {
      for (let t = from; t < to; t += 1 / 30) r.update(t, progress, 1 / 30);
      return r.level;
    };
    expect(run(0, 5, 0)).toBe(0);
    // Below the window and below `unlock`: a big clear does nothing yet.
    r.bigClear();
    expect(run(5, 8, 0.35)).toBeCloseTo(0, 3);
    run(8, 9, 0.52);
    r.bigClear();
    expect(run(9, 16, 0.52)).toBeGreaterThan(0.99);
    // After the hold it settles back to the ramp's own value: 0.52 lies 60% into the window.
    expect(run(19, 45, 0.52)).toBeCloseTo(0.648, 2);
    expect(new RevealTracker(undefined).update(0, 0, 1)).toBe(1);
  });
});

describe('lateral passes (SDK 1.7)', () => {
  it('cross one side of the frame at a near-constant distance, never inside the widened board', () => {
    const rect = { x0: -0.35, y0: -0.9, x1: 0.35, y1: 0.9 };
    for (const side of [1, -1] as const) {
      const pts = lateralWaypoints(rect, side, 'in', -0.2, 300, 0.18);
      expect(Math.abs(pts[0]!.x)).toBeGreaterThan(1);
      for (const p of pts) {
        expect(p.x * side).toBeGreaterThanOrEqual(0.35 + 0.18);
        expect(p.distance).toBeGreaterThan(280);
        expect(p.distance).toBeLessThan(330);
        expect(p.y).toBeCloseTo(-0.2);
      }
      const out = lateralWaypoints(rect, side, 'out', -0.2, 300, 0.18);
      expect(out[0]).toEqual(pts[pts.length - 1]);
    }
  });
});
