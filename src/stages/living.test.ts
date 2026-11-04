import { describe, expect, it } from 'vitest';
import { availableStages, livingFiles } from './registry';
import { EMPTY_LIVING, reactionBinding, reactionSchema, validateLiving } from './living';
import { bindingSchema, stageManifestSchema } from './schema';

const manifest = stageManifestSchema.parse({
  schemaVersion: 1,
  id: 'test-stage',
  name: 'Test',
  description: '',
  palette: { accent: '#ffffff', secondary: '#ffffff', highlight: '#ffffff', fog: '#000000' },
  lighting: { key: { color: '#ffffff', intensity: 1, azimuth: 0, elevation: 30 }, rim: { color: '#ffffff', intensity: 1 }, ambient: { sky: '#ffffff', ground: '#000000', intensity: 1 }, accents: [] },
  environment: { layers: [{ id: 'sky', type: 'sky' }, { id: 'snow', type: 'particles' }] },
  music: { bpm: 100 },
});

describe('living profiles', () => {
  it('a world without living.json gets the empty profile', () => {
    expect(validateLiving(undefined, manifest)).toEqual({ profile: EMPTY_LIVING, errors: [] });
  });

  it('parses reactions, classes and events with defaults', () => {
    const { profile, errors } = validateLiving(
      {
        schemaVersion: 1,
        classes: { 'snow.size': 'none' },
        music: [{ layer: 'snow', target: 'brightness', drive: 'detail', amount: 0.4, role: 'fine' }],
        events: [{ layer: 'sky', on: 'music:drop', action: 'wave' }, { layer: 'snow', on: 'ambient', every: [20, 40], action: 'pulse', group: 'g' }],
      },
      manifest,
    );
    expect(errors).toEqual([]);
    expect(profile.music[0]).toMatchObject({ mode: 'mul', curve: 'linear', attackMs: 0, releaseMs: 0 });
    expect(profile.events[1]).toMatchObject({ every: [20, 40], group: 'g', weight: 1, quantize: 'bar' });
  });

  it('reports layers that do not exist and bad fields', () => {
    const { errors } = validateLiving({ schemaVersion: 1, classes: { 'ghost.glow': 'light' }, music: [{ layer: 'moon', target: 'glow', drive: 'body' }], events: [{ layer: 'nowhere', on: 'music:peak', action: 'pulse' }] }, manifest);
    expect(errors.join('\n')).toMatch(/no layer with id "moon"/);
    expect(errors.join('\n')).toMatch(/no layer with id "nowhere"/);
    expect(errors.join('\n')).toMatch(/no layer with id "ghost"/);
    expect(validateLiving({ schemaVersion: 1, music: [{ layer: 'snow', target: 'x', drive: 'loudness' }] }, manifest).errors[0]).toMatch(/living.json music/);
    expect(validateLiving({ schemaVersion: 2 }, manifest).errors).toHaveLength(1);
  });

  it('turns a reaction into a music.* binding whose category follows the class', () => {
    const r = reactionSchema.parse({ layer: 'snow', target: 'brightness', drive: 'shimmer', amount: 0.7 });
    const b = reactionBinding(r, 'particles');
    expect(bindingSchema.parse(b)).toMatchObject({ feature: 'music.shimmer', amount: 0.7, category: 'particles', attackMs: 0 });
    expect(reactionBinding(r, 'light').category).toBe('lighting');
    expect(reactionBinding(r, 'motion').category).toBe('environment');
  });

  it('every shipped world has a valid living profile with music reactions or events', () => {
    const files = livingFiles();
    const worlds = availableStages();
    expect(worlds.length).toBeGreaterThan(0);
    for (const w of worlds) {
      expect(Object.keys(files)).toContain(`${w.dir}/living.json`);
      expect(w.living.music.length + w.living.events.length).toBeGreaterThan(0);
    }
  });
});
