import { describe, expect, it } from 'vitest';
import { registerBuiltinComponents } from '../rendering/environments/builtins';
import { registerBuiltinEffects } from '../rendering/fx/lineClearEffects';
import { registries } from '../sdk/registry';
import { discoverStages, resetStageCache } from './registry';
import { satisfiesRange, stageManifestSchema } from './schema';
import { validateManifest } from './validate';

registerBuiltinComponents();
registerBuiltinEffects();
resetStageCache();

describe('shipped content', () => {
  const stages = discoverStages();

  it('discovers at least one stage', () => {
    expect(stages.length).toBeGreaterThan(0);
  });

  for (const stage of stages) {
    it(`stage "${stage.id}" validates (schema, SDK, components, assets)`, () => {
      expect(stage.errors, stage.errors.join('\n')).toEqual([]);
      expect(stage.available).toBe(true);
      const m = stage.manifest!;
      expect(registries.lineClearEffects.has(m.effects.lineClear.effect) || !!m.module, `line-clear effect ${m.effects.lineClear.effect}`).toBe(true);
      for (const layer of m.environment.layers) {
        const factory = registries.components.get(layer.type);
        if (!factory) continue; // provided by the stage module
        const parsed = factory.schema.safeParse(layer.params);
        expect(parsed.success, `${stage.id}/${layer.id ?? layer.type}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
      }
    });
  }

  it('contains no placeholder content in release builds', () => {
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
    if (env?.PRISMFALL_RELEASE !== '1') return;
    expect(stages.filter((s) => s.manifest?.placeholder).map((s) => s.id)).toEqual([]);
  });
});

describe('manifest validation', () => {
  const env = { sdkVersion: '1.0.0', knownComponents: new Set(['sky']), assetExists: () => true, folder: 'test-stage' };
  const minimal = {
    schemaVersion: 1,
    id: 'test-stage',
    name: 'Test',
    description: '',
    palette: { accent: '#ffffff', secondary: '#ffffff', highlight: '#ffffff', fog: '#000000' },
    lighting: {
      key: { color: '#ffffff', intensity: 1, azimuth: 0, elevation: 30 },
      rim: { color: '#ffffff', intensity: 1 },
      ambient: { sky: '#ffffff', ground: '#000000', intensity: 1 },
      accents: [],
    },
    environment: { layers: [{ type: 'sky' }] },
    music: { bpm: 100 },
  };

  it('accepts a minimal manifest and fills defaults', () => {
    const r = validateManifest(minimal, env);
    expect(r.errors).toEqual([]);
    expect(r.manifest?.blocks.geometry).toBe('framed');
    expect(r.manifest?.unlock.type).toBe('always');
  });

  it('reports unknown components, missing assets, bad ids and SDK mismatches', () => {
    expect(validateManifest({ ...minimal, environment: { layers: [{ type: 'nope' }] } }, env).errors.join()).toContain('unknown environment component');
    const withTrack = { ...minimal, music: { bpm: 100, tracks: [{ id: 'a', title: 'A', kind: 'file', src: 'x.ogg' }] } };
    expect(validateManifest(withTrack, { ...env, assetExists: () => false }).errors.join()).toContain('not found');
    expect(validateManifest({ ...minimal, id: 'Bad Id' }, env).errors.length).toBeGreaterThan(0);
    expect(validateManifest({ ...minimal, requires: { sdk: '^2.0.0' } }, env).errors.join()).toContain('Content SDK');
    expect(validateManifest({ ...minimal, id: 'other' }, env).errors.join()).toContain('folder');
  });

  it('checks semver ranges', () => {
    expect(satisfiesRange('1.2.0', '^1.0.0')).toBe(true);
    expect(satisfiesRange('2.0.0', '^1.0.0')).toBe(false);
    expect(satisfiesRange('1.0.0', '>=0.9.0')).toBe(true);
    expect(satisfiesRange('1.0.0', '*')).toBe(true);
  });

  it('rejects invalid colours', () => {
    expect(stageManifestSchema.safeParse({ ...minimal, palette: { ...minimal.palette, accent: 'red' } }).success).toBe(false);
  });
});
