import { describe, expect, it } from 'vitest';
import { stageManifestSchema } from '../../stages/schema';
import { CallInDispatcher, EnvironmentEventDirector, maxWait, parseTrigger, type CallInSpec } from './callins';

const spec = (over: Partial<CallInSpec>): CallInSpec => ({ layer: 'herd', on: 'clear>=4', quantize: 'none', cooldown: 0, chance: 1, action: 'pass', params: {}, ...over });
const clear = (lines: number, extra: Partial<{ combo: number; backToBack: boolean; perfectClear: boolean; spin: boolean }> = {}) =>
  ({ kind: 'clear', lines, intensity: lines / 4, spin: false, perfectClear: false, combo: -1, backToBack: false, ...extra }) as const;

describe('call-in triggers', () => {
  it('parses every trigger form and rejects others', () => {
    expect(parseTrigger('clear>=4')).toEqual({ kind: 'clear', min: 4 });
    expect(parseTrigger(' combo >= 3 ')).toEqual({ kind: 'combo', min: 3 });
    expect(parseTrigger('progress>=0.5')).toEqual({ kind: 'progress', min: 0.5 });
    expect(parseTrigger('heat>=0.6')).toEqual({ kind: 'heat', min: 0.6 });
    expect(parseTrigger('section:drop')).toEqual({ kind: 'section', section: 'drop' });
    for (const k of ['b2b', 'perfect', 'spin', 'levelUp', 'danger']) expect(parseTrigger(k)).toEqual({ kind: k });
    expect(parseTrigger('clear>4')).toBeNull();
    expect(parseTrigger('progress>=2')).toBeNull();
    expect(parseTrigger('whenever')).toBeNull();
  });

  it('the manifest schema validates events and fills defaults', () => {
    const base = {
      schemaVersion: 1, id: 't', name: 'T', description: '',
      palette: { accent: '#ffffff', secondary: '#ffffff', highlight: '#ffffff', fog: '#000000' },
      lighting: { key: { color: '#ffffff', intensity: 1, azimuth: 0, elevation: 30 }, rim: { color: '#ffffff', intensity: 1 }, ambient: { sky: '#ffffff', ground: '#000000', intensity: 1 }, accents: [] },
      environment: { layers: [{ type: 'sky' }] },
      music: { bpm: 100 },
    };
    const ok = stageManifestSchema.parse({ ...base, events: [{ layer: 'herd', on: 'clear>=4', action: 'pass' }] });
    expect(ok.events[0]).toMatchObject({ quantize: 'bar', cooldown: 8, chance: 1, params: {} });
    expect(ok.clearWave).toEqual({ near: 6, far: 900, travel: 3.2, strength: 1 });
    expect(ok.sectionStates).toEqual({ fade: 3, states: [] });
    expect(stageManifestSchema.safeParse({ ...base, events: [{ layer: 'herd', on: 'often', action: 'pass' }] }).success).toBe(false);
    expect(stageManifestSchema.safeParse({ ...base, events: [{ layer: 'herd', on: 'b2b', action: 'dance' }] }).success).toBe(false);
  });
});

describe('call-in dispatcher', () => {
  it('fires on matching clears only', () => {
    const d = new CallInDispatcher([spec({ on: 'clear>=4' }), spec({ layer: 'birds', on: 'combo>=3', action: 'show' }), spec({ layer: 'fx', on: 'b2b', action: 'burst' })]);
    d.onGameEvent(clear(3), 1);
    expect(d.update(1)).toHaveLength(0);
    d.onGameEvent(clear(4), 2, 1);
    expect(d.update(2).map((c) => c.layer)).toEqual(['herd']);
    d.onGameEvent(clear(2, { combo: 3, backToBack: true }), 3);
    expect(d.update(3).map((c) => c.layer).sort()).toEqual(['birds', 'fx']);
    // A perfect clear counts as a QUAD.
    d.onGameEvent(clear(2, { perfectClear: true }), 4);
    expect(d.update(4).map((c) => c.layer)).toEqual(['herd']);
  });

  it('carries the clear strength and the trigger', () => {
    const d = new CallInDispatcher([spec({})]);
    d.onGameEvent(clear(4), 1, 1.15);
    const [c] = d.update(1);
    expect(c).toMatchObject({ action: 'pass', trigger: 'clear>=4', strength: 1.15, time: 1 });
  });

  it('honours the cooldown and ignores triggers while one waits', () => {
    const d = new CallInDispatcher([spec({ cooldown: 10 })]);
    d.onGameEvent(clear(4), 0);
    expect(d.update(0)).toHaveLength(1);
    d.onGameEvent(clear(4), 5);
    expect(d.update(5)).toHaveLength(0);
    d.onGameEvent(clear(4), 10.5);
    expect(d.update(10.5)).toHaveLength(1);
    const q = new CallInDispatcher([spec({ quantize: 'bar' })]);
    q.onGameEvent(clear(4), 0);
    q.onGameEvent(clear(4), 0.1);
    q.onBeat({ bar: 1, downbeat: true }, 0.5);
    expect(q.update(0.5)).toHaveLength(1);
  });

  it('quantises to the next beat, bar or phrase', () => {
    const d = new CallInDispatcher([spec({ layer: 'b', quantize: 'beat' }), spec({ layer: 'r', quantize: 'bar' }), spec({ layer: 'p', quantize: 'phrase' })], 4);
    d.onGameEvent(clear(4), 0);
    expect(d.update(0)).toHaveLength(0);
    d.onBeat({ bar: 5, downbeat: false }, 0.2);
    expect(d.update(0.2).map((c) => c.layer)).toEqual(['b']);
    d.onBeat({ bar: 6, downbeat: true }, 0.6);
    expect(d.update(0.6).map((c) => c.layer)).toEqual(['r']);
    d.onBeat({ bar: 7, downbeat: true }, 1.2);
    expect(d.update(1.2)).toHaveLength(0);
    d.onBeat({ bar: 8, downbeat: true }, 1.8);
    expect(d.update(1.8).map((c) => c.layer)).toEqual(['p']);
  });

  it('goes anyway when the quantised moment never comes', () => {
    const d = new CallInDispatcher([spec({ quantize: 'bar' })]);
    d.bpm = 120;
    d.onGameEvent(clear(4), 10);
    expect(d.update(10 + maxWait('bar', 120, 4, 4) - 0.01)).toHaveLength(0);
    expect(d.update(10 + maxWait('bar', 120, 4, 4) + 0.01)).toHaveLength(1);
    expect(maxWait('phrase', 30, 4, 16)).toBeLessThanOrEqual(16);
  });

  it('section, level-up, danger, progress and heat triggers', () => {
    const d = new CallInDispatcher([
      spec({ layer: 's', on: 'section:drop' }),
      spec({ layer: 'n', on: 'section:cranes' }),
      spec({ layer: 'l', on: 'levelUp' }),
      spec({ layer: 'd', on: 'danger' }),
      spec({ layer: 'p', on: 'progress>=0.5' }),
      spec({ layer: 'h', on: 'heat>=0.6' }),
    ]);
    d.onSection('drop', 'peak', 0);
    d.onSection('verse', 'cranes', 0);
    d.onGameEvent({ kind: 'levelUp', level: 3 }, 0);
    d.onGameEvent({ kind: 'danger', active: false }, 0);
    expect(d.update(0).map((c) => c.layer).sort()).toEqual(['l', 'n', 's']);
    d.onGameEvent({ kind: 'danger', active: true }, 1);
    d.resetSignals(0.2);
    d.onSignals(0.49, 0.5, 1);
    expect(d.update(1).map((c) => c.layer)).toEqual(['d']);
    d.onSignals(0.51, 0.65, 2);
    expect(d.update(2).map((c) => c.layer).sort()).toEqual(['h', 'p']);
    // Staying above does not fire again; falling back and rising again does.
    d.onSignals(0.6, 0.7, 3);
    expect(d.update(3)).toHaveLength(0);
    d.resetSignals(0);
    d.onSignals(0.55, 0, 4);
    expect(d.update(4).map((c) => c.layer)).toEqual(['p']);
  });

  it('calm world events halve the chance and double the cooldown; off stops call-ins', () => {
    let roll = 0.6;
    const d = new CallInDispatcher([spec({ chance: 1, cooldown: 4 })], 4, () => roll);
    d.worldEvents = 0.5;
    d.onGameEvent(clear(4), 0);
    expect(d.update(0)).toHaveLength(0);
    roll = 0.2;
    d.onGameEvent(clear(4), 1);
    expect(d.update(1)).toHaveLength(1);
    d.onGameEvent(clear(4), 6);
    expect(d.update(6)).toHaveLength(0);
    d.onGameEvent(clear(4), 9.5);
    expect(d.update(9.5)).toHaveLength(1);
    d.worldEvents = 0;
    d.onGameEvent(clear(4), 100);
    expect(d.update(100)).toHaveLength(0);
  });

  it('reports entries with unknown triggers', () => {
    const d = new CallInDispatcher([spec({ on: 'nope' }), spec({})]);
    expect(d.size).toBe(1);
    expect(d.errors[0]).toMatch(/nope/);
  });
});

/** A seeded generator so timer intervals and picks are reproducible. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

describe('event director (SDK 1.7)', () => {
  it('parses music cue and ambient triggers', () => {
    expect(parseTrigger('music:drop')).toEqual({ kind: 'music', cue: 'drop' });
    expect(parseTrigger('music:phrase')).toEqual({ kind: 'music', cue: 'phrase' });
    expect(parseTrigger('music:wobble')).toBeNull();
    expect(parseTrigger('ambient')).toEqual({ kind: 'ambient' });
  });

  it('fires on music cues with their strength', () => {
    const d = new EnvironmentEventDirector([spec({ layer: 'aurora', on: 'music:drop', action: 'pulse' }), spec({ layer: 'owl', on: 'music:phrase' })]);
    d.onMusicCue('drop', 1.3, 2);
    const calls = d.update(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ layer: 'aurora', action: 'pulse', trigger: 'music:drop', strength: 1.3 });
  });

  it('ambient timers call within their interval, more often at a higher frequency, never at 0', () => {
    const count = (frequency: number) => {
      const d = new EnvironmentEventDirector([spec({ layer: 'owl', on: 'ambient', every: [20, 40] })], 4, seeded(7));
      d.frequency = frequency;
      d.onMusicState({ section: '', sectionKind: '', intensity: 0.5, calm: 0.5 });
      let n = 0;
      for (let t = 0; t < 600; t += 0.1) n += d.update(t).length;
      return n;
    };
    const normal = count(1);
    // About one call per 30 s over 10 minutes (minus the delayed first call).
    expect(normal).toBeGreaterThanOrEqual(14);
    expect(normal).toBeLessThanOrEqual(26);
    expect(count(1.8)).toBeGreaterThan(normal);
    expect(count(0)).toBe(0);
  });

  it('a group takes turns: never the same entry twice in a row', () => {
    const d = new EnvironmentEventDirector(
      [spec({ layer: 'a', on: 'ambient', every: [5, 5], group: 'g' }), spec({ layer: 'b', on: 'ambient', every: [5, 5], group: 'g' }), spec({ layer: 'c', on: 'ambient', every: [5, 5], group: 'g', weight: 3 })],
      4,
      seeded(3),
    );
    d.onMusicState({ section: '', sectionKind: '', intensity: 0.5, calm: 0.5 });
    const picks: string[] = [];
    for (let t = 0; t < 300; t += 0.1) for (const c of d.update(t)) picks.push(c.layer);
    expect(picks.length).toBeGreaterThan(30);
    for (let i = 1; i < picks.length; i++) expect(picks[i]).not.toBe(picks[i - 1]);
    // The heavier entry is picked most, and the others still appear.
    expect(new Set(picks)).toEqual(new Set(['a', 'b', 'c']));
    expect(picks.filter((p) => p === 'c').length).toBeGreaterThan(picks.filter((p) => p === 'a').length);
  });

  it('a trigger shared by a group calls one of its entries', () => {
    const d = new EnvironmentEventDirector([spec({ layer: 'x', on: 'clear>=4', group: 'quad' }), spec({ layer: 'y', on: 'clear>=4', group: 'quad' }), spec({ layer: 'z', on: 'clear>=4' })], 4, seeded(1));
    d.onGameEvent(clear(4), 0);
    const layers = d.update(0).map((c) => c.layer);
    expect(layers).toContain('z');
    expect(layers.filter((l) => l === 'x' || l === 'y')).toHaveLength(1);
  });

  it('when limits calls to sections, intensity and calm', () => {
    const d = new EnvironmentEventDirector([
      spec({ layer: 'drop-only', on: 'music:accent', when: { section: ['drop'] } }),
      spec({ layer: 'loud', on: 'music:accent', when: { minIntensity: 0.6 } }),
      spec({ layer: 'quiet', on: 'music:accent', when: { calm: true } }),
    ]);
    d.onMusicState({ section: 'v1', sectionKind: 'verse', intensity: 0.3, calm: 0.8 });
    d.onMusicCue('accent', 1, 0);
    expect(d.update(0).map((c) => c.layer)).toEqual(['quiet']);
    d.onMusicState({ section: 'd1', sectionKind: 'drop', intensity: 0.9, calm: 0.1 });
    d.onMusicCue('accent', 1, 1);
    expect(d.update(1).map((c) => c.layer).sort()).toEqual(['drop-only', 'loud']);
  });

  it('vary spreads the strength', () => {
    const d = new EnvironmentEventDirector([spec({ on: 'music:peak', vary: 0.4 })], 4, seeded(9));
    const seen = new Set<number>();
    for (let i = 0; i < 20; i++) {
      d.onMusicCue('peak', 1, i * 10);
      for (const c of d.update(i * 10)) {
        expect(c.strength).toBeGreaterThanOrEqual(0.6 - 1e-9);
        expect(c.strength).toBeLessThanOrEqual(1.4 + 1e-9);
        seen.add(Math.round(c.strength * 100));
      }
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it('the schema needs every on ambient calls', () => {
    const base = {
      schemaVersion: 1, id: 't', name: 'T', description: '',
      palette: { accent: '#ffffff', secondary: '#ffffff', highlight: '#ffffff', fog: '#000000' },
      lighting: { key: { color: '#ffffff', intensity: 1, azimuth: 0, elevation: 30 }, rim: { color: '#ffffff', intensity: 1 }, ambient: { sky: '#ffffff', ground: '#000000', intensity: 1 }, accents: [] },
      environment: { layers: [{ type: 'sky' }] },
      music: { bpm: 100 },
    };
    expect(stageManifestSchema.safeParse({ ...base, events: [{ layer: 'x', on: 'ambient', action: 'pass' }] }).success).toBe(false);
    const ok = stageManifestSchema.parse({ ...base, events: [{ layer: 'x', on: 'ambient', every: [30, 60], action: 'pulse' }] });
    expect(ok.events[0]).toMatchObject({ weight: 1, vary: 0 });
  });
});
