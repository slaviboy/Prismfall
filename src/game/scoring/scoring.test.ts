import { describe, expect, it } from 'vitest';
import { GUIDELINE_SCORING, classifyClear, isDifficult, scoreClear } from './scoring';

const base = { level: 1, backToBackActive: false, combo: 0, perfectClear: false } as const;

describe('scoring', () => {
  it('scores line clears by level', () => {
    expect(scoreClear({ ...base, lines: 1, spin: 'none' }).total).toBe(100);
    expect(scoreClear({ ...base, lines: 2, spin: 'none' }).total).toBe(300);
    expect(scoreClear({ ...base, lines: 3, spin: 'none' }).total).toBe(500);
    expect(scoreClear({ ...base, lines: 4, spin: 'none' }).total).toBe(800);
    expect(scoreClear({ ...base, lines: 4, spin: 'none', level: 5 }).total).toBe(4000);
  });

  it('scores T-spins and minis', () => {
    expect(scoreClear({ ...base, lines: 0, spin: 'full' }).total).toBe(400);
    expect(scoreClear({ ...base, lines: 1, spin: 'full' }).total).toBe(800);
    expect(scoreClear({ ...base, lines: 2, spin: 'full' }).total).toBe(1200);
    expect(scoreClear({ ...base, lines: 3, spin: 'full' }).total).toBe(1600);
    expect(scoreClear({ ...base, lines: 0, spin: 'mini' }).total).toBe(100);
    expect(scoreClear({ ...base, lines: 1, spin: 'mini' }).total).toBe(200);
  });

  it('applies back-to-back only to difficult clears', () => {
    expect(scoreClear({ ...base, lines: 4, spin: 'none', backToBackActive: true }).total).toBe(1200);
    expect(scoreClear({ ...base, lines: 2, spin: 'full', backToBackActive: true }).total).toBe(1800);
    const single = scoreClear({ ...base, lines: 1, spin: 'none', backToBackActive: true });
    expect(single.backToBack).toBe(false);
    expect(single.total).toBe(100);
  });

  it('adds combo bonus 50 × combo × level', () => {
    expect(scoreClear({ ...base, lines: 1, spin: 'none', combo: 3, level: 2 }).total).toBe(200 + 300);
    expect(scoreClear({ ...base, lines: 0, spin: 'none', combo: -1 }).total).toBe(0);
  });

  it('adds perfect-clear bonuses', () => {
    expect(scoreClear({ ...base, lines: 1, spin: 'none', perfectClear: true }).total).toBe(100 + 800);
    expect(scoreClear({ ...base, lines: 4, spin: 'none', perfectClear: true }).total).toBe(800 + 2000);
    expect(scoreClear({ ...base, lines: 4, spin: 'none', perfectClear: true, backToBackActive: true }).total).toBe(1200 + 3200);
  });

  it('classifies clears and difficulty', () => {
    expect(classifyClear(4, 'none')).toBe('quad');
    expect(classifyClear(2, 'full')).toBe('tspinDouble');
    expect(classifyClear(1, 'mini')).toBe('tspinMiniSingle');
    expect(isDifficult(4, 'none')).toBe(true);
    expect(isDifficult(3, 'none')).toBe(false);
    expect(isDifficult(1, 'mini')).toBe(true);
    expect(isDifficult(0, 'full')).toBe(false);
  });

  it('accepts a custom table', () => {
    const table = { ...GUIDELINE_SCORING, lines: [0, 10, 20, 30, 40] };
    expect(scoreClear({ ...base, lines: 2, spin: 'none' }, table).total).toBe(20);
  });
});
