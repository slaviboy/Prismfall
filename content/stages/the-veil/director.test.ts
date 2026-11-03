import { describe, expect, it } from 'vitest';
import { CREATURE_EVENTS, Director, KINDS, type EventKind } from './director';
import { EYE, WATER, boardLimit, terrainHeight } from './terrain';

/** Runs a director for `seconds` in 0.1 s steps and records every event it starts. */
function run(seed: number, seconds: number, comfort: 'full' | 'calm' | 'off' = 'full', section = () => 0.5) {
  const d = new Director(seed);
  d.comfort = comfort;
  const started: { kind: EventKind; at: number; duration: number }[] = [];
  const seen = new Set<number>();
  for (let t = 0; t < seconds; t += 0.1) {
    d.update(0.1, section());
    for (const e of d.active) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        started.push({ kind: e.kind, at: e.start, duration: e.duration });
      }
    }
  }
  return { d, started };
}

describe('the Veil event director', () => {
  it('opens quietly and never overlaps creature events', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { started } = run(seed, 1800);
      expect(started.length).toBeGreaterThan(4);
      expect(started[0]!.at).toBeGreaterThanOrEqual(25);
      const creatures = started.filter((e) => CREATURE_EVENTS.includes(e.kind));
      for (let i = 1; i < creatures.length; i++) {
        const prev = creatures[i - 1]!;
        // Each creature event ends, then at least 20 s pass, before the next one starts.
        expect(creatures[i]!.at).toBeGreaterThanOrEqual(prev.at + prev.duration + 19.9);
      }
    }
  });

  it('respects cooldowns and is different from session to session', () => {
    const a = run(11, 3600).started.map((e) => e.kind).join(',');
    const b = run(12, 3600).started.map((e) => e.kind).join(',');
    expect(a).not.toBe(b);
    const { started } = run(13, 3600);
    for (const kind of Object.keys(KINDS) as EventKind[]) {
      const runs = started.filter((e) => e.kind === kind);
      for (let i = 1; i < runs.length; i++) expect(runs[i]!.at - (runs[i - 1]!.at + runs[i - 1]!.duration)).toBeGreaterThanOrEqual(KINDS[kind].cooldown[0] - 0.2);
    }
  });

  it('is reproducible for a seed', () => {
    expect(run(21, 900).started).toEqual(run(21, 900).started);
  });

  it('calm drops the sudden shadow events and thins the rest; off keeps only the weather', () => {
    const full = run(31, 3600).started;
    const calm = run(31, 3600, 'calm').started;
    const off = run(31, 3600, 'off').started;
    expect(calm.some((e) => e.kind === 'giantShadow' || e.kind === 'shadowRuin')).toBe(false);
    expect(calm.length).toBeLessThan(full.length);
    expect(off.every((e) => e.kind === 'bankRoll' || e.kind === 'reveal' || e.kind === 'closing')).toBe(true);
    const d = new Director(1);
    d.comfort = 'off';
    expect(d.force('silhouette')).toBeNull();
  });

  it('a sustained rise in the music brings the next creature forward', () => {
    let t = 0;
    const lift = () => ((t += 0.1) > 20 ? 0.95 : 0.3);
    const early = run(41, 600, 'full', lift).started.find((e) => CREATURE_EVENTS.includes(e.kind));
    const plain = run(41, 600).started.find((e) => CREATURE_EVENTS.includes(e.kind));
    expect(early && plain).toBeTruthy();
    expect(early!.at).toBeLessThanOrEqual(plain!.at);
  });
});

describe('the Veil terrain', () => {
  it('never hides the playfield and gives the viewer ground to stand on', () => {
    expect(terrainHeight(EYE.x, EYE.z)).toBeCloseTo(-1.1, 0);
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

  it('holds water in the marsh behind the board and rises to ridges far out', () => {
    let wet = 0;
    for (let i = 0; i < 40; i++) if (terrainHeight(Math.sin(i) * 40, -150 - i * 4) < WATER) wet++;
    expect(wet).toBeGreaterThan(10);
    let peak = -Infinity;
    for (let a = -60; a <= 60; a += 2) {
      const r = (a * Math.PI) / 180;
      peak = Math.max(peak, terrainHeight(Math.sin(r) * 1500, EYE.z - Math.cos(r) * 1500));
    }
    expect(peak).toBeGreaterThan(60);
  });
});
