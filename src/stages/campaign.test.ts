import { describe, expect, it } from 'vitest';
import { campaignSchema, planVoyage, VoyageRun, type Campaign } from './campaign';

const campaign: Campaign = campaignSchema.parse({
  schemaVersion: 1,
  id: 'voyage',
  name: 'Voyage',
  areas: [
    { id: 'a', name: 'A', legs: [{ stage: 's1', lines: 10, level: 1 }, { stage: 's2', lines: 10, level: 3 }] },
    { id: 'b', name: 'B', legs: [{ stage: 's3', lines: 20, level: 6 }] },
  ],
  difficulties: {
    relaxed: { linesScale: 0.5, levelOffset: -2 },
    standard: { linesScale: 1, levelOffset: 0 },
    intense: { linesScale: 1.5, levelOffset: 3 },
  },
});

describe('voyage planning', () => {
  it('chains every leg from the start area with cumulative line goals', () => {
    const plan = planVoyage(campaign, 'a', 'standard');
    expect(plan.legs.map((l) => [l.stage, l.startLines, l.endLines, l.level])).toEqual([
      ['s1', 0, 10, 1],
      ['s2', 10, 20, 3],
      ['s3', 20, 40, 6],
    ]);
    expect(plan.totalLines).toBe(40);
  });

  it('starts from a later area and scales for difficulty (levels stay within 1..30)', () => {
    const relaxed = planVoyage(campaign, 'a', 'relaxed');
    expect(relaxed.legs.map((l) => [l.lines, l.level])).toEqual([[5, 1], [5, 1], [10, 4]]);
    const intense = planVoyage(campaign, 'b', 'intense');
    expect(intense.legs.map((l) => [l.stage, l.lines, l.level])).toEqual([['s3', 30, 9]]);
  });
});

describe('voyage run', () => {
  it('enters the next leg when a goal is reached and finishes after the last', () => {
    const run = new VoyageRun(planVoyage(campaign, 'a', 'standard'));
    expect(run.advance(9)).toEqual({ completed: [], entered: null });
    expect(run.progress(5)).toBeCloseTo(0.5);
    const r1 = run.advance(11);
    expect(r1.completed.map((l) => l.stage)).toEqual(['s1']);
    expect(r1.entered?.stage).toBe('s2');
    // A big clear can complete a leg and skip straight through another.
    const r2 = run.advance(25);
    expect(r2.completed.map((l) => l.stage)).toEqual(['s2']);
    expect(r2.entered?.stage).toBe('s3');
    expect(run.completedAreas()).toEqual(['a']);
    const r3 = run.advance(40);
    expect(r3.completed.map((l) => l.stage)).toEqual(['s3']);
    expect(r3.entered).toBeNull();
    expect(run.finished).toBe(true);
    expect(run.completedAreas()).toEqual(['a', 'b']);
  });

  it('rejects malformed campaigns', () => {
    expect(campaignSchema.safeParse({ ...campaign, areas: [] }).success).toBe(false);
    expect(campaignSchema.safeParse({ ...campaign, areas: [{ id: 'Bad Id', name: 'x', legs: [{ stage: 's', lines: 1, level: 1 }] }] }).success).toBe(false);
  });
});
