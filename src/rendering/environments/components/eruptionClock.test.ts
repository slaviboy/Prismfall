import { describe, expect, it } from 'vitest';
import { seeded } from './common';
import { EruptionClock, LIGHTNING_MIN_SIZE, craterShape, sampleSummit, type EruptionEvent } from './eruptionClock';
import { makeBolt } from './lightningBolt';

const OPTS = { interval: [6, 18] as const, music: 0.6, lightningChance: 0.5, cooldown: 16 };

/** Runs a clock at 60 fps for `seconds` with a fixed music intensity. */
function run(clock: EruptionClock, seconds: number, music = 0.5, lightning = true, from = 0): EruptionEvent[] {
  const events: EruptionEvent[] = [];
  for (let t = from; t < from + seconds; t += 1 / 60) events.push(...clock.update(t, 1 / 60, music, lightning));
  return events;
}

describe('eruption clock', () => {
  it('fires bursts at irregular intervals within the bounds, never on a fixed grid', () => {
    const bursts = run(new EruptionClock(seeded(5), OPTS), 1200).filter((e) => e.kind === 'burst');
    expect(bursts.length).toBeGreaterThan(50);
    const gaps = bursts.slice(1).map((b, i) => b.time - (bursts[i] as EruptionEvent).time);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length);
    // Spread out (coefficient of variation), mostly within the configured range (doublets aside).
    expect(sd / mean).toBeGreaterThan(0.3);
    expect(gaps.filter((g) => g > OPTS.interval[1] + 0.01).length).toBe(0);
    for (const b of bursts) expect(b.kind === 'burst' && b.size > 0 && b.size <= 1).toBe(true);
  });

  it('swells bursts during a long intense music section', () => {
    const calm = run(new EruptionClock(seeded(9), OPTS), 900, 0.2).filter((e) => e.kind === 'burst');
    const loud = run(new EruptionClock(seeded(9), OPTS), 900, 1).filter((e) => e.kind === 'burst');
    const avg = (xs: EruptionEvent[]) => xs.reduce((s, e) => s + e.size, 0) / xs.length;
    expect(avg(loud)).toBeGreaterThan(avg(calm));
    expect(loud.length).toBeGreaterThanOrEqual(calm.length);
  });

  it('answers a big clear with a large burst after a natural delay, rate-limited', () => {
    const clock = new EruptionClock(seeded(3), { ...OPTS, interval: [500, 600] });
    run(clock, 1);
    clock.bigClear(1);
    clock.bigClear(2);
    const events = run(clock, 6, 0.5, true, 1).filter((e) => e.kind === 'burst');
    expect(events).toHaveLength(1);
    const e = events[0] as EruptionEvent;
    expect(e.time).toBeGreaterThanOrEqual(1.6);
    expect(e.time).toBeLessThanOrEqual(3.2);
    expect(e.size).toBeGreaterThanOrEqual(0.85);
  });

  it('only follows large bursts with lightning, with a cooldown, and never when flashes are reduced', () => {
    const clock = new EruptionClock(seeded(11), { ...OPTS, lightningChance: 1, cooldown: 30 });
    const events = run(clock, 1800);
    const bolts = events.filter((e) => e.kind === 'lightning');
    expect(bolts.length).toBeGreaterThan(5);
    for (let i = 1; i < bolts.length; i++) expect((bolts[i] as EruptionEvent).time - (bolts[i - 1] as EruptionEvent).time).toBeGreaterThanOrEqual(30);
    for (const b of bolts) {
      expect(b.size).toBeGreaterThanOrEqual(LIGHTNING_MIN_SIZE);
      // Some burst of that size went off shortly before.
      expect(events.some((e) => e.kind === 'burst' && e.size === b.size && b.time - e.time > 0.7 && b.time - e.time < 4)).toBe(true);
    }
    const reduced = run(new EruptionClock(seeded(11), { ...OPTS, lightningChance: 1, cooldown: 30 }), 1800, 0.5, false);
    expect(reduced.some((e) => e.kind === 'lightning')).toBe(false);
  });

  it('does not replay missed bursts after a long stall', () => {
    const clock = new EruptionClock(seeded(2), OPTS);
    run(clock, 30);
    expect(clock.update(3000, 1 / 60, 0.5, true).length).toBeLessThanOrEqual(1);
  });
});

describe('crater sampling', () => {
  // A cone with a crater bowl: rim at r = 20, floor 10 below it.
  const cone = (x: number, z: number): number => {
    const r = Math.hypot(x - 100, z + 200);
    return r < 20 ? 90 + (r / 20) ** 2 * 10 : 100 - (r - 20) * 0.6;
  };

  it('finds the vent floor and the visible rim', () => {
    const c = craterShape(cone, [100, -200], 30, [0, 30]);
    expect(c.floorY).toBeCloseTo(90, 5);
    expect(c.rimY).toBeGreaterThan(98);
    expect(c.rimY).toBeLessThanOrEqual(100.01);
  });

  it('bakes the summit into bytes spanning its height range', () => {
    const s = sampleSummit(cone, [100, -200], 100, 32);
    expect(s.bytes).toHaveLength(32 * 32 * 4);
    expect(s.max).toBeGreaterThan(97);
    expect(s.min).toBeLessThan(45);
    expect(Math.max(...s.bytes.filter((_, i) => i % 4 === 0))).toBe(255);
  });
});

describe('lightning bolts', () => {
  it('builds a connected main channel with branches leaving it', () => {
    for (const seed of [1, 4, 9]) {
      const segs = makeBolt(seeded(seed));
      const main = segs.filter((s) => s.level === 0);
      expect(main.length).toBe(64);
      for (let i = 1; i < main.length; i++) expect((main[i] as (typeof main)[number]).a).toEqual((main[i - 1] as (typeof main)[number]).b);
      const branches = new Set(segs.filter((s) => s.level > 0).map((s) => s.branch));
      expect(branches.size).toBeGreaterThanOrEqual(4);
      // Branches start on the main channel; the bolt spans about one unit downwards.
      const points = new Set(main.flatMap((s) => [s.a.join(','), s.b.join(',')]));
      for (const id of branches) expect(points.has((segs.find((s) => s.branch === id) as (typeof segs)[number]).a.join(','))).toBe(true);
      const bottom = Math.min(...main.map((s) => s.b[1]));
      expect(bottom).toBeCloseTo(-1, 5);
    }
  });
});
