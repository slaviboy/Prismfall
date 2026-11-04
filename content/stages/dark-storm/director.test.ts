import { describe, expect, it } from 'vitest';
import { FlashGovernor, MAX_FLASHES_PER_SECOND, MAX_THUNDER_DELAY, REDUCED_FLASH_GAP, SECTION_HOLD, StormDirector, flashEnvelope, thunderDelay, type StormComfort, type Strike } from './director';

/** Runs a director for `seconds` in `step` s steps and collects every strike it starts. */
function run(seed: number, seconds: number, comfort: Partial<StormComfort> = {}, opts: { step?: number; section?: (t: number) => number; accentEvery?: number } = {}) {
  const d = new StormDirector(seed);
  d.comfort = { mode: 'full', flashReduced: false, intensity: 1, ...comfort };
  const step = opts.step ?? 0.05;
  const strikes: Strike[] = [];
  const rains: number[] = [];
  for (let t = 0; t < seconds; t += step) {
    if (opts.accentEvery && Math.floor(t / opts.accentEvery) !== Math.floor((t + step) / opts.accentEvery)) d.accent();
    strikes.push(...d.update(step, { section: opts.section?.(t) ?? 0.5, progress: 0 }));
    rains.push(d.levels.rain);
  }
  return { d, strikes, rains };
}

/** Every flash onset (absolute director time) of a strike list. */
const onsets = (strikes: readonly Strike[]): number[] => strikes.flatMap((s) => s.strokes.map((o) => s.at + o)).sort((a, b) => a - b);

/** The most onsets inside any one-second window. */
function peakPerSecond(times: readonly number[]): number {
  let best = 0;
  for (let i = 0; i < times.length; i++) {
    let n = 0;
    for (let j = i; j < times.length && times[j]! < times[i]! + 1; j++) n++;
    best = Math.max(best, n);
  }
  return best;
}

describe('the Dark Storm director', () => {
  it('is reproducible for a seed and different between sessions', () => {
    const a = run(7, 600).strikes.map((s) => `${s.level}:${s.azimuth.toFixed(2)}`);
    expect(run(7, 600).strikes.map((s) => `${s.level}:${s.azimuth.toFixed(2)}`)).toEqual(a);
    expect(run(8, 600).strikes.map((s) => `${s.level}:${s.azimuth.toFixed(2)}`)).not.toEqual(a);
  });

  it('shows itself early, then strikes irregularly with lulls and clusters', () => {
    for (const seed of [1, 2, 3, 4]) {
      const { strikes } = run(seed, 1800);
      expect(strikes[0]!.at).toBeLessThan(8);
      const gaps = strikes.slice(1).map((s, i) => s.at - strikes[i]!.at);
      // Several dark, quiet stretches of more than six seconds, and some strikes close together.
      expect(gaps.filter((g) => g > 6).length).toBeGreaterThan(5);
      expect(gaps.filter((g) => g < 3).length).toBeGreaterThan(3);
      // Never a steady beat: the gaps vary widely.
      const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      const sd = Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length);
      expect(sd / mean).toBeGreaterThan(0.5);
    }
  });

  it('visits all four states over an hour, each for a while, with gradual levels', () => {
    const { d, rains } = run(11, 3600);
    const seen = new Set(d.visited.map((v) => v.state));
    expect([...seen].sort()).toEqual(['active', 'calm', 'distant', 'intense']);
    for (let i = 1; i < d.visited.length; i++) expect(d.visited[i]!.at - d.visited[i - 1]!.at).toBeGreaterThan(27);
    // Rain never jumps: at most a few percent per 50 ms step, and it never stops.
    for (let i = 1; i < rains.length; i++) expect(Math.abs(rains[i]! - rains[i - 1]!)).toBeLessThan(0.02);
    expect(Math.min(...rains)).toBeGreaterThan(0.3);
  });

  it('uses all four intensity levels, near strikes only close and far ones far', () => {
    const { strikes } = run(21, 3600, { intensity: 1.35 });
    for (const level of [1, 2, 3, 4] as const) expect(strikes.some((s) => s.level === level), `level ${level}`).toBe(true);
    for (const s of strikes) {
      if (s.level === 4) expect(s.distance).toBeLessThan(450);
      if (s.level === 1) expect(s.distance).toBeGreaterThan(1500);
      if (s.kind !== 'intracloud') expect(Math.abs(s.azimuth)).toBeGreaterThanOrEqual(13);
    }
    // Re-strikes follow the first stroke within a fraction of a second.
    expect(strikes.some((s) => s.strokes.length >= 3)).toBe(true);
    for (const s of strikes) expect(s.strokes[s.strokes.length - 1]!).toBeLessThan(0.6);
  });

  it('never exceeds three flashes in any second, even at extreme intensity with QUAD accents', () => {
    const { strikes } = run(31, 3600, { intensity: 1.7 }, { accentEvery: 9, section: () => 0.95 });
    expect(peakPerSecond(onsets(strikes))).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
  });

  it('Reduce flashing allows one smooth flash per strike, far apart', () => {
    const { strikes } = run(41, 1800, { flashReduced: true, intensity: 1.7 }, { accentEvery: 9 });
    expect(strikes.length).toBeGreaterThan(20);
    for (const s of strikes) expect(s.strokes).toEqual([0]);
    const t = onsets(strikes);
    for (let i = 1; i < t.length; i++) expect(t[i]! - t[i - 1]!).toBeGreaterThanOrEqual(REDUCED_FLASH_GAP - 1e-9);
    // The envelope has a single peak (no flicker).
    const env = Array.from({ length: 200 }, (_, i) => flashEnvelope([0], i * 0.01, true));
    let peaks = 0;
    for (let i = 1; i < env.length - 1; i++) if (env[i]! > env[i - 1]! && env[i]! >= env[i + 1]!) peaks++;
    expect(peaks).toBe(1);
  });

  it('calm keeps lightning rarer and farther; off leaves only small distant flashes', () => {
    const full = run(51, 3600).strikes;
    const calm = run(51, 3600, { mode: 'calm' }).strikes;
    const off = run(51, 3600, { mode: 'off' }).strikes;
    expect(calm.length).toBeLessThan(full.length * 0.7);
    expect(calm.every((s) => s.level <= 3 && s.distance >= 1000 && s.strokes.length <= 2)).toBe(true);
    expect(off.length).toBeLessThan(calm.length);
    expect(off.every((s) => s.level <= 2)).toBe(true);
  });

  it('the storm intensity setting scales the lightning and the rain', () => {
    const subtle = run(61, 1800, { intensity: 0.55 });
    const extreme = run(61, 1800, { intensity: 1.7 });
    expect(extreme.strikes.length).toBeGreaterThan(subtle.strikes.length * 1.4);
    const avg = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
    expect(avg(extreme.rains)).toBeGreaterThan(avg(subtle.rains) * 1.3);
    expect(extreme.strikes.filter((s) => s.level === 4).length).toBeGreaterThan(subtle.strikes.filter((s) => s.level === 4).length);
  });

  it('answers a QUAD with one controlled accent, never more than one every eight seconds', () => {
    const d = new StormDirector(71);
    for (let t = 0; t < 20; t += 0.05) d.update(0.05);
    d.accent();
    d.accent();
    const got: Strike[] = [];
    for (let t = 0; t < 1.2; t += 0.05) got.push(...d.update(0.05));
    expect(got.filter((s) => s.accent).length).toBe(1);
    d.accent();
    for (let t = 0; t < 2; t += 0.05) got.push(...d.update(0.05));
    expect(got.filter((s) => s.accent).length).toBe(1);
  });

  it('follows the song: builds stir it, drops bring the intense core, breaks let it ease off', () => {
    const d = new StormDirector(91);
    const step = (seconds: number) => {
      for (let t = 0; t < seconds; t += 0.05) d.update(0.05);
    };
    step(20);
    expect(d.state).toBe('active');
    const before = d.visited.length;
    d.followSection('drop');
    // Not on the section's downbeat: a moment later, and never before the state has held 16 s.
    step(0.9);
    expect(d.visited.length).toBe(before);
    step(6);
    expect(d.state).toBe('intense');
    const into = d.visited[d.visited.length - 1]!;
    expect(into.at - d.visited[d.visited.length - 2]!.at).toBeGreaterThanOrEqual(SECTION_HOLD);
    // Already intense when the drop goes on: it stays for the section.
    d.followSection('drop');
    step(24);
    expect(d.state).toBe('intense');
    d.followSection('break');
    step(SECTION_HOLD + 5);
    expect(['calm', 'distant']).toContain(d.state);
    // A verse asks for nothing: the storm keeps its own course (no immediate change).
    const held = d.visited.length;
    d.followSection('verse');
    step(5);
    expect(d.visited.length).toBe(held);
  });

  it('never cuts a state short when the music asks, and levels still ease', () => {
    const d = new StormDirector(92);
    for (let t = 0; t < 30; t += 0.05) d.update(0.05);
    d.followSection('build');
    d.followSection('drop');
    const rains: number[] = [];
    for (let t = 0; t < 60; t += 0.05) {
      d.update(0.05);
      rains.push(d.levels.rain);
      if (Math.floor(t / 3) !== Math.floor((t + 0.05) / 3)) d.followSection(['drop', 'break', 'build'][Math.floor(t / 3) % 3]!);
    }
    for (let i = 1; i < d.visited.length; i++) expect(d.visited[i]!.at - d.visited[i - 1]!.at).toBeGreaterThanOrEqual(SECTION_HOLD - 1e-9);
    for (let i = 1; i < rains.length; i++) expect(Math.abs(rains[i]! - rains[i - 1]!)).toBeLessThan(0.02);
  });

  it('keeps the flash ceiling and the comfort limits while following the song', () => {
    const kinds = ['verse', 'build', 'drop', 'break', 'drop', 'outro'];
    const drive = (comfort: Partial<StormComfort>) => {
      const d = new StormDirector(93);
      d.comfort = { mode: 'full', flashReduced: false, intensity: 1.7, ...comfort };
      const strikes: Strike[] = [];
      for (let t = 0; t < 1800; t += 0.05) {
        if (Math.floor(t / 20) !== Math.floor((t + 0.05) / 20)) d.followSection(kinds[Math.floor(t / 20) % kinds.length]!);
        if (Math.floor(t / 9) !== Math.floor((t + 0.05) / 9)) d.accent(4);
        strikes.push(...d.update(0.05, { section: 0.9, progress: 0 }));
      }
      return strikes;
    };
    expect(peakPerSecond(onsets(drive({})))).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
    const calm = drive({ mode: 'calm' });
    expect(calm.every((s) => s.level <= 3 && s.distance >= 1000)).toBe(true);
    expect(calm.filter((s) => s.accent).every((s) => s.level <= 2)).toBe(true);
    expect(drive({ mode: 'off' }).every((s) => s.level <= 2 && !s.accent)).toBe(true);
  });

  it('the music pushes the storm towards its stormier states', () => {
    const share = (section: number) => {
      let intense = 0;
      for (const seed of [81, 82, 83, 84, 85, 86]) {
        const { d } = run(seed, 2400, {}, { step: 0.1, section: () => section });
        intense += d.visited.filter((v) => v.state === 'intense').length / d.visited.length;
      }
      return intense;
    };
    expect(share(0.95)).toBeGreaterThan(share(0.2));
  });
});

describe('the flash governor', () => {
  it('admits at most three onsets per second and keeps them 40 ms apart', () => {
    const g = new FlashGovernor();
    const got = g.admit([0, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5], false);
    expect(got).toEqual([0, 0.05, 0.1]);
    expect(g.allows(0.99, false)).toBe(false);
    expect(g.allows(1.06, false)).toBe(true);
  });

  it('counts strokes recorded ahead of time too', () => {
    const g = new FlashGovernor();
    g.admit([10.2, 10.3, 10.4], false);
    expect(g.allows(10, false)).toBe(false);
    expect(g.allows(9.3, false)).toBe(true);
  });
});

describe('thunder timing', () => {
  it('follows the speed of sound near by, and stays within fifteen seconds far away', () => {
    expect(thunderDelay(0)).toBe(0);
    expect(thunderDelay(170)).toBeGreaterThan(0.9);
    expect(thunderDelay(170)).toBeLessThan(1.2);
    let prev = 0;
    for (let d = 50; d <= 6000; d += 50) {
      const t = thunderDelay(d);
      expect(t).toBeGreaterThan(prev);
      expect(t).toBeLessThan(MAX_THUNDER_DELAY);
      prev = t;
    }
    expect(thunderDelay(1400)).toBeGreaterThan(6);
    expect(thunderDelay(3400)).toBeGreaterThan(11);
  });
});

describe('the flash envelope', () => {
  it('rises instantly on each stroke and never drops to black between strokes', () => {
    const strokes = [0, 0.08, 0.19];
    expect(flashEnvelope(strokes, 0, false)).toBeCloseTo(1, 1);
    expect(flashEnvelope(strokes, 0.075, false)).toBeGreaterThan(0.25);
    expect(flashEnvelope(strokes, 0.08, false)).toBeGreaterThan(0.8);
    expect(flashEnvelope(strokes, 2.5, false)).toBeLessThan(0.01);
    expect(flashEnvelope(strokes, -0.03, false)).toBeGreaterThan(0);
    expect(flashEnvelope(strokes, -0.2, false)).toBe(0);
  });
});
