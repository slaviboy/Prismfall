import { describe, expect, it } from 'vitest';
import { stageManifestSchema } from '../../stages/schema';
import { CallInDispatcher, maxWait, parseTrigger, type CallInSpec } from './callins';

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
