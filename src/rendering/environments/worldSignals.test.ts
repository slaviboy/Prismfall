import { describe, expect, it } from 'vitest';
import { CLEAR_WAVE, DEFAULT_FRONT_SHAPE, HEAT, WorldSignals, clearStrength, frontDistance, frontFor, frontLifetime, frontValue, frontsAt, type ClearMoment } from './worldSignals';

const clear = (lines: number, extra: Partial<ClearMoment> = {}): ClearMoment => ({ lines, spin: false, perfectClear: false, combo: -1, backToBack: false, ...extra });

describe('clear strength', () => {
  it('grows with lines, and spins, back-to-back, combos and perfect clears add to it', () => {
    const s = [1, 2, 3, 4].map((n) => clearStrength(clear(n)));
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThan(s[i - 1] as number);
    expect(s[3]).toBeCloseTo(1);
    expect(clearStrength(clear(4, { backToBack: true }))).toBeGreaterThan(1);
    expect(clearStrength(clear(2, { spin: true }))).toBeGreaterThan(clearStrength(clear(2)));
    expect(clearStrength(clear(1, { combo: 5 }))).toBeGreaterThan(clearStrength(clear(1)));
    expect(clearStrength(clear(4, { perfectClear: true, backToBack: true, spin: true, combo: 9 }))).toBe(1.5);
  });
});

describe('heat', () => {
  it('rises with consecutive clears, holds, then cools over 10-20 s', () => {
    const w = new WorldSignals();
    let t = 0;
    for (let i = 0; i < 4; i++) {
      w.onClear(clear(2, { combo: i }), t);
      for (let f = 0; f < 60; f++) w.update(1 / 60, (t += 1 / 60));
    }
    const peak = w.heat;
    expect(peak).toBeGreaterThan(0.5);
    expect(peak).toBeLessThanOrEqual(1);
    // Still held right after the last clear.
    for (let f = 0; f < 60 * (HEAT.hold - 1.2); f++) w.update(1 / 60, (t += 1 / 60));
    expect(w.heat).toBeCloseTo(peak, 5);
    // Cooled to under a fifth within 20 s of the last clear, but not within 8 s.
    const last = t - (HEAT.hold - 1.2) - 1;
    while (t - last < 8) w.update(1 / 60, (t += 1 / 60));
    expect(w.heat).toBeGreaterThan(peak * 0.2);
    while (t - last < 20) w.update(1 / 60, (t += 1 / 60));
    expect(w.heat).toBeLessThan(peak * 0.2);
  });

  it('saturates below 1 and is frame-rate independent', () => {
    const run = (hz: number): number => {
      const w = new WorldSignals();
      w.onClear(clear(4, { backToBack: true, combo: 3 }), 0);
      let t = 0;
      for (let i = 0; i < hz * 10; i++) w.update(1 / hz, (t += 1 / hz));
      return w.heat;
    };
    expect(Math.abs(run(60) - run(240))).toBeLessThan(0.01);
    const w = new WorldSignals();
    for (let i = 0; i < 50; i++) w.onClear(clear(4, { perfectClear: true, backToBack: true, combo: 9 }), i * 0.5);
    expect(w.heat).toBeLessThanOrEqual(1);
  });

  it('a reset cools the run at once', () => {
    const w = new WorldSignals();
    w.onClear(clear(4), 0);
    w.reset();
    expect(w.heat).toBe(0);
    expect(w.clearWave).toBe(0);
    expect(w.fronts.every((f) => f.strength === 0)).toBe(true);
  });
});

describe('clear wave signal', () => {
  it('jumps by the clear size and lasts seconds (unlike the short clear pulse)', () => {
    const w = new WorldSignals();
    w.onClear(clear(4), 0);
    expect(w.clearWave).toBeCloseTo(1);
    let t = 0;
    while (t < 1.5) w.update(1 / 60, (t += 1 / 60));
    expect(w.clearWave).toBeGreaterThan(0.5);
    while (t < CLEAR_WAVE.hold + CLEAR_WAVE.tau * 3) w.update(1 / 60, (t += 1 / 60));
    expect(w.clearWave).toBeLessThan(0.08);
    const small = new WorldSignals();
    small.onClear(clear(1), 0);
    expect(small.clearWave).toBeLessThan(0.4);
  });
});

describe('clear fronts', () => {
  it('maps distance to 0 at the board and 1 at the far distance', () => {
    expect(frontDistance(1)).toBe(0);
    expect(frontDistance(DEFAULT_FRONT_SHAPE.near)).toBe(0);
    expect(frontDistance(DEFAULT_FRONT_SHAPE.far)).toBeCloseTo(1);
    expect(frontDistance(60)).toBeGreaterThan(frontDistance(20));
  });

  it('peaks where the front is and rolls outward over time', () => {
    const slot = frontFor(1, 0);
    const peakAt = (age: number): number => {
      let best = 0;
      let bestX = 0;
      for (let x = 0; x <= 1.2; x += 0.002) {
        const v = frontValue(x, age, slot);
        if (v > best) {
          best = v;
          bestX = x;
        }
      }
      return bestX;
    };
    const a = peakAt(0.5);
    const b = peakAt(1.5);
    const c = peakAt(2.5);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(a).toBeCloseTo(0.5 / DEFAULT_FRONT_SHAPE.travel, 1);
    expect(frontValue(a, 0.5, slot)).toBeCloseTo(1, 1);
  });

  it('has a sharp leading edge and a soft tail', () => {
    const slot = frontFor(1, 0);
    const f = 1 / DEFAULT_FRONT_SHAPE.travel;
    const ahead = frontValue(f + 0.1, 1, slot);
    const behind = frontValue(f - 0.1, 1, slot);
    expect(behind).toBeGreaterThan(ahead * 3);
    expect(frontValue(f + 0.3, 1, slot)).toBeLessThan(1e-6);
  });

  it('bigger clears travel further and are thicker and brighter', () => {
    const single = frontFor(clearStrength(clear(1)), 0);
    const quad = frontFor(clearStrength(clear(4)), 0);
    expect(quad.reach).toBeGreaterThan(single.reach);
    expect(quad.width).toBeGreaterThan(single.width);
    // A single has faded out halfway to the horizon; a QUAD still lights the far field.
    const travel = DEFAULT_FRONT_SHAPE.travel;
    expect(frontValue(0.8, 0.8 * travel, single)).toBeLessThan(0.02);
    expect(frontValue(0.8, 0.8 * travel, quad)).toBeGreaterThan(0.3);
    expect(frontLifetime(1)).toBeGreaterThan(frontLifetime(0.3));
    expect(frontLifetime(1)).toBeGreaterThan(3);
    expect(frontLifetime(1)).toBeLessThan(4.5);
    expect(frontLifetime(0.3)).toBeGreaterThan(1.5);
  });

  it('is zero before a front starts, and sums overlapping fronts up to 1.5', () => {
    const slot = frontFor(1, 5);
    expect(frontValue(0.1, -0.1, slot)).toBe(0);
    const w = new WorldSignals();
    for (let i = 0; i < 6; i++) w.onClear(clear(4, { perfectClear: true, backToBack: true }), 0);
    expect(frontsAt(0, 0, w.fronts)).toBeLessThanOrEqual(1.5);
    expect(frontsAt(0, 0, w.fronts)).toBeGreaterThan(1);
  });

  it('reuses the oldest of its four slots and honours the world strength', () => {
    const w = new WorldSignals();
    for (let i = 0; i < 5; i++) w.onClear(clear(2), i);
    const starts = w.fronts.map((f) => f.start).sort();
    expect(starts).toEqual([1, 2, 3, 4]);
    const off = new WorldSignals();
    off.worldStrength = 0;
    off.onClear(clear(4), 0);
    expect(off.fronts.every((f) => f.strength === 0)).toBe(true);
    // The signals still respond in a world without fronts.
    expect(off.clearWave).toBeGreaterThan(0.9);
  });
});
