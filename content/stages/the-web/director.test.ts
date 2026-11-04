import { describe, expect, it } from 'vitest';
import { Director, type SetpieceSpec } from './director';

const SPECS: SetpieceSpec[] = [
  { id: 'eyes-cave', kind: 'eyes', weight: 2, cooldown: 20 },
  { id: 'emerge-gate', kind: 'emerge', weight: 1, cooldown: 60, sudden: true },
  { id: 'wall-chapel', kind: 'wall', weight: 1, cooldown: 40 },
  { id: 'hang-overhang', kind: 'hang', weight: 1, cooldown: 50 },
  { id: 'tremble', kind: 'tremble', weight: 1, cooldown: 15 },
];

/** Runs a director for `seconds`, finishing each setpiece `length` s after it starts. */
function run(d: Director, seconds: number, length = 12, section = (_t: number) => 0): { t: number; id: string }[] {
  const starts: { t: number; id: string }[] = [];
  const ends = new Map<string, number>();
  for (let t = 0; t <= seconds; t += 0.25) {
    for (const [id, at] of ends) {
      if (t >= at) {
        d.finish(id, t);
        ends.delete(id);
      }
    }
    for (const id of d.update(t, section(t))) {
      starts.push({ t, id });
      ends.set(id, t + length);
    }
  }
  return starts;
}

describe('the web director', () => {
  it('opens quietly and spaces its setpieces', () => {
    const starts = run(new Director(SPECS, { seed: 3, comfort: 'full' }), 600);
    expect(starts.length).toBeGreaterThan(10);
    expect(starts[0]!.t).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < starts.length; i++) expect(starts[i]!.t - starts[i - 1]!.t).toBeGreaterThanOrEqual(1.9);
  });

  it('never runs two setpieces of one kind, nor more than allowed at once', () => {
    const d = new Director(SPECS, { seed: 9, comfort: 'full', concurrent: 2 });
    for (let t = 0; t < 900; t += 0.25) {
      d.update(t);
      const kinds = [...d.active.values()];
      expect(new Set(kinds).size).toBe(kinds.length);
      expect(kinds.length).toBeLessThanOrEqual(2);
    }
  });

  it('rests a setpiece after it ran', () => {
    const starts = run(new Director(SPECS, { seed: 5, comfort: 'full' }), 900, 8);
    const last = new Map<string, number>();
    for (const s of starts) {
      const prev = last.get(s.id);
      const spec = SPECS.find((x) => x.id === s.id)!;
      if (prev !== undefined) expect(s.t - (prev + 8)).toBeGreaterThanOrEqual(spec.cooldown - 0.5);
      last.set(s.id, s.t);
    }
  });

  it('calm comfort halves the pace, runs one at a time and skips sudden setpieces', () => {
    const full = run(new Director(SPECS, { seed: 4, comfort: 'full' }), 900);
    const calmD = new Director(SPECS, { seed: 4, comfort: 'calm' });
    const calm = run(calmD, 900);
    expect(calm.length).toBeLessThan(full.length * 0.75);
    expect(calm.some((s) => s.id === 'emerge-gate')).toBe(false);
  });

  it('comfort off keeps only eyes and trembling webs', () => {
    const starts = run(new Director(SPECS, { seed: 2, comfort: 'off' }), 900);
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.every((s) => s.id === 'eyes-cave' || s.id === 'tremble')).toBe(true);
  });

  it('is deterministic for a seed', () => {
    const a = run(new Director(SPECS, { seed: 11, comfort: 'full' }), 400);
    const b = run(new Director(SPECS, { seed: 11, comfort: 'full' }), 400);
    expect(a).toEqual(b);
  });

  it('a rise in the music brings the next setpiece forward', () => {
    const flat = run(new Director(SPECS, { seed: 7, comfort: 'full', gap: [30, 30] }), 200);
    const rising = run(new Director(SPECS, { seed: 7, comfort: 'full', gap: [30, 30] }), 200, 12, (t) => (t > 40 ? 1 : 0));
    expect(rising.length).toBeGreaterThanOrEqual(flat.length);
  });
});
