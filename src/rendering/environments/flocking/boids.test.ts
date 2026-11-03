import { describe, expect, it } from 'vitest';
import { Boids, DEFAULT_WEIGHTS, type BoidsConfig, type Vec3 } from './boids';
import { FALCON_PARK, Falcon } from './falcon';

function config(over: Partial<BoidsConfig> = {}): BoidsConfig {
  return {
    count: 300,
    seed: 7,
    neighbours: 7,
    perception: 8,
    separation: 1,
    minSpeed: 5,
    maxSpeed: 13,
    cruiseSpeed: 8,
    maxAccel: 7,
    weights: { ...DEFAULT_WEIGHTS },
    bounds: { center: [0, 50, -200], radii: [15, 6, 30], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
    avoid: [],
    panic: { duration: 0.6, delay: 0.07, refractory: 2.5, boost: 0.35 },
    spawn: { center: [0, 50, -200], spread: [6, 2, 6], heading: [1, 0, 0] },
    ...over,
  };
}

const finite = (a: Float32Array) => a.every((v) => Number.isFinite(v));

describe('boids', () => {
  it('is deterministic for a given seed and step count', () => {
    const a = new Boids(config());
    const b = new Boids(config());
    for (let i = 0; i < 240; i++) {
      a.step(1 / 60);
      b.step(1 / 60);
    }
    expect(Array.from(a.pos)).toEqual(Array.from(b.pos));
    expect(Array.from(a.vel)).toEqual(Array.from(b.vel));
    const c = new Boids(config({ seed: 8 }));
    for (let i = 0; i < 240; i++) c.step(1 / 60);
    expect(Array.from(c.pos)).not.toEqual(Array.from(a.pos));
  });

  it('never produces NaN, even when every boid starts at the same point', () => {
    const b = new Boids(config({ count: 50, spawn: { center: [0, 50, -200], spread: [0, 0, 0], heading: [0, 0, 0] } }));
    for (let i = 0; i < 120; i++) b.step(1 / 60);
    expect(finite(b.pos)).toBe(true);
    expect(finite(b.vel)).toBe(true);
    expect(finite(b.acc)).toBe(true);
    // They have parted.
    const spread = Math.hypot(b.pos[0]! - b.pos[3]!, b.pos[1]! - b.pos[4]!, b.pos[2]! - b.pos[5]!);
    expect(spread).toBeGreaterThan(0.1);
  });

  it('selects the k topologically nearest neighbours (matches brute force)', () => {
    const b = new Boids(config({ count: 400, seed: 3, spawn: { center: [0, 0, 0], spread: [5, 5, 5], heading: [1, 0, 0] } }));
    for (const i of [0, 17, 123, 399]) {
      const got = b.neighboursOf(i);
      const d = (j: number) => Math.hypot(b.pos[j * 3]! - b.pos[i * 3]!, b.pos[j * 3 + 1]! - b.pos[i * 3 + 1]!, b.pos[j * 3 + 2]! - b.pos[i * 3 + 2]!);
      const brute = Array.from({ length: b.count }, (_, j) => j)
        .filter((j) => j !== i)
        .sort((x, y) => d(x) - d(y))
        .slice(0, 7);
      expect(got).toEqual(brute);
    }
  });

  it('keeps speeds within limits and the flock together inside its soft bounds', () => {
    const b = new Boids(config({ count: 400 }));
    for (let i = 0; i < 60 * 40; i++) b.step(1 / 60);
    let outside = 0;
    for (let i = 0; i < b.count; i++) {
      const s = Math.hypot(b.vel[i * 3]!, b.vel[i * 3 + 1]!, b.vel[i * 3 + 2]!);
      expect(s).toBeGreaterThanOrEqual(5 - 1e-3);
      expect(s).toBeLessThanOrEqual(13 * 1.35 + 1e-3);
      const q = Math.hypot(b.pos[i * 3]! / 15, (b.pos[i * 3 + 1]! - 50) / 6, (b.pos[i * 3 + 2]! + 200) / 30);
      if (q > 1.4) outside++;
    }
    expect(outside).toBe(0);
    // Neighbours stay close: the flock has not dispersed.
    const nn: number[] = [];
    for (const i of [0, 50, 100, 200, 300]) {
      const j = b.neighboursOf(i)[0]!;
      nn.push(Math.hypot(b.pos[j * 3]! - b.pos[i * 3]!, b.pos[j * 3 + 1]! - b.pos[i * 3 + 1]!, b.pos[j * 3 + 2]! - b.pos[i * 3 + 2]!));
    }
    expect(Math.max(...nn)).toBeLessThan(3);
    expect(Math.min(...nn)).toBeGreaterThan(0.3);
  });

  it('flies aligned: neighbours share their heading', () => {
    const b = new Boids(config({ count: 300 }));
    for (let i = 0; i < 600; i++) b.step(1 / 60);
    let sum = 0;
    let m = 0;
    for (let i = 0; i < b.count; i += 7) {
      const vi = [b.vel[i * 3]!, b.vel[i * 3 + 1]!, b.vel[i * 3 + 2]!];
      for (const j of b.neighboursOf(i)) {
        const vj = [b.vel[j * 3]!, b.vel[j * 3 + 1]!, b.vel[j * 3 + 2]!];
        sum += (vi[0]! * vj[0]! + vi[1]! * vj[1]! + vi[2]! * vj[2]!) / (Math.hypot(...vi) * Math.hypot(...vj));
        m++;
      }
    }
    expect(sum / m).toBeGreaterThan(0.9);
  });

  it('stays out of an avoided half-space', () => {
    // Forbid x > 2 (keep dot([-1,0,0], p) + 2 >= 0) just beyond the edge of a roost centred at x = -15,
    // with the flock flying straight at it.
    const bounds = { center: [-15, 50, -200] as Vec3, radii: [12, 6, 30] as Vec3, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as [Vec3, Vec3, Vec3] };
    const b = new Boids(config({ count: 300, bounds, avoid: [{ normal: [-1, 0, 0], offset: -2, margin: 8 }], spawn: { center: [-10, 50, -200], spread: [4, 2, 4], heading: [1, 0, 0] } }));
    let worst = -Infinity;
    for (let i = 0; i < 60 * 30; i++) {
      b.step(1 / 60);
      if (i > 120) for (let k = 0; k < b.count; k++) worst = Math.max(worst, b.pos[k * 3]!);
    }
    expect(worst).toBeLessThan(4);
  });

  it('flees a threat and passes an escape wave across the flock', () => {
    const b = new Boids(config({ count: 600 }));
    for (let i = 0; i < 300; i++) b.step(1 / 60);
    const c: Vec3 = [0, 0, 0];
    const v: Vec3 = [0, 0, 0];
    b.centroid(c, v);
    // Find the boid farthest from the centroid along the flight direction (the head).
    const vl = Math.hypot(...v);
    let head = 0;
    let best = -Infinity;
    for (let i = 0; i < b.count; i++) {
      const a = ((b.pos[i * 3]! - c[0]) * v[0] + (b.pos[i * 3 + 1]! - c[1]) * v[1] + (b.pos[i * 3 + 2]! - c[2]) * v[2]) / vl;
      if (a > best) {
        best = a;
        head = i;
      }
    }
    const t = b.threats[0]!;
    t.active = true;
    t.x = b.pos[head * 3]!;
    t.y = b.pos[head * 3 + 1]! + 1;
    t.z = b.pos[head * 3 + 2]!;
    t.radius = 6;
    const firstPanic = new Float32Array(b.count).fill(-1);
    const at = Float32Array.from(b.pos);
    for (let s = 0; s < 150; s++) {
      if (s === 6) t.active = false;
      b.step(1 / 60);
      for (let i = 0; i < b.count; i++) if (firstPanic[i]! < 0 && b.panic[i]! > 0.95) firstPanic[i] = s;
    }
    // The escape reached boids far beyond the threat's reach, later the farther they were.
    let reached = 0;
    let far: number[] = [];
    let near: number[] = [];
    for (let i = 0; i < b.count; i++) {
      if (firstPanic[i]! < 0) continue;
      reached++;
      // Distance from the threat where the boid was when it struck.
      const d = Math.hypot(at[i * 3]! - t.x, at[i * 3 + 1]! - t.y, at[i * 3 + 2]! - t.z);
      (d > 12 ? far : near).push(firstPanic[i]!);
    }
    expect(reached).toBeGreaterThan(b.count * 0.5);
    far = far.sort((x, y) => x - y);
    near = near.sort((x, y) => x - y);
    expect(far.length).toBeGreaterThan(0);
    expect(far[Math.floor(far.length / 2)]!).toBeGreaterThan(near[Math.floor(near.length / 2)]!);
    expect(finite(b.pos)).toBe(true);
  });
});

describe('spontaneous turns', () => {
  it('a gentle startle at one boid sweeps across the flock and turns it', () => {
    const b = new Boids(config({ count: 400 }));
    for (let i = 0; i < 300; i++) b.step(1 / 60);
    const v0: Vec3 = [0, 0, 0];
    const c: Vec3 = [0, 0, 0];
    b.centroid(c, v0);
    b.startle(0, [-b.vel[2]!, 0, b.vel[0]!], 0.45);
    let reached = 0;
    const seen = new Uint8Array(b.count);
    for (let s = 0; s < 120; s++) {
      b.step(1 / 60);
      for (let i = 0; i < b.count; i++) if (!seen[i] && b.panic[i]! > 0.9) {
        seen[i] = 1;
        reached++;
      }
    }
    expect(reached).toBeGreaterThan(b.count * 0.4);
    expect(b.pos.every((x) => Number.isFinite(x))).toBe(true);
    // Ignored while the boid is refractory, and for zero directions.
    expect(() => b.startle(0, [0, 0, 0], 1)).not.toThrow();
  });
});

describe('falcon', () => {
  it('waits, stoops through the flock as a threat, then climbs away and parks', () => {
    const f = new Falcon({ every: 30, stoopSpeed: 26, cruiseSpeed: 16, radius: 11, above: 45, side: [-1, 0, 0], seed: 3 });
    const threat = { active: false, x: 0, y: 0, z: 0, radius: 0, strength: 0 };
    const c: Vec3 = [0, 50, -200];
    const v: Vec3 = [6, 0, 0];
    expect(f.phase).toBe('away');
    expect(f.pos).toEqual(FALCON_PARK);
    f.trigger();
    let closest = Infinity;
    const phases = new Set<string>();
    let startY = NaN;
    for (let i = 0; i < 60 * 15; i++) {
      f.update(1 / 60, c, v, 1, threat);
      if (i === 0) startY = f.pos[1];
      phases.add(f.phase);
      if (f.phase !== 'away') closest = Math.min(closest, Math.hypot(f.pos[0] - c[0], f.pos[1] - c[1], f.pos[2] - c[2]));
      expect(threat.active).toBe(f.phase === 'stoop' || f.phase === 'pass' || (f.phase === 'exit' && threat.active));
    }
    // It started well above the flock (out of view) and came within a few metres of its centre.
    expect(startY - c[1]).toBeGreaterThan(30);
    expect(closest).toBeLessThan(8);
    expect([...phases]).toEqual(expect.arrayContaining(['stoop', 'pass', 'exit', 'away']));
    expect(f.phase).toBe('away');
    expect(threat.active).toBe(false);
  });

  it('attacks more often at a higher rate, never with every ≤ 0', () => {
    const count = (rate: number, every: number) => {
      const f = new Falcon({ every, stoopSpeed: 26, cruiseSpeed: 16, radius: 11, above: 45, side: [1, 0, 0], seed: 5 });
      const threat = { active: false, x: 0, y: 0, z: 0, radius: 0, strength: 0 };
      let attacks = 0;
      let prev = 'away';
      for (let i = 0; i < 60 * 600; i++) {
        f.update(1 / 60, [0, 50, -200], [6, 0, 0], rate, threat);
        if (prev === 'away' && f.phase === 'stoop') attacks++;
        prev = f.phase;
      }
      return attacks;
    };
    expect(count(2, 40)).toBeGreaterThan(count(1, 40));
    expect(count(1, 40)).toBeGreaterThan(5);
    expect(count(1, 0)).toBe(0);
  });
});
