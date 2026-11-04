import { describe, expect, it } from 'vitest';
import { registerBuiltinComponents } from '../rendering/environments/builtins';
import { registerBuiltinEffects } from '../rendering/fx/lineClearEffects';
import { registerBuiltinTransitions } from '../rendering/fx/transitions';
import { AMBIENCE_PRESETS } from '../audio/sound-effects/Ambience';
import { MATERIAL_PROFILES } from '../audio/sound-effects/materialAudio';
import { SFX_PRESETS } from '../audio/sound-effects/SfxBank';
import { registries } from '../sdk/registry';
import { discoverStages, getCampaign, reactivityProfileFiles, resetStageCache } from './registry';
import { reactivityProfileSchema, satisfiesRange, stageManifestSchema } from './schema';
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
      // Names that would otherwise fall back silently at runtime (warp, silence, glass).
      registerBuiltinTransitions();
      expect(registries.transitions.has(m.effects.transition.effect) || !!m.module, `transition ${m.effects.transition.effect}`).toBe(true);
      if (m.ambience) expect(AMBIENCE_PRESETS, `ambience preset ${m.ambience.preset}`).toContain(m.ambience.preset);
      expect(Object.keys(SFX_PRESETS), `sfx preset ${m.sfx.preset}`).toContain(m.sfx.preset);
      const material = m.sfx.material;
      if (typeof material === 'string') expect(Object.keys(MATERIAL_PROFILES), `sfx material ${material}`).toContain(material);
      for (const layer of m.environment.layers) {
        const factory = registries.components.get(layer.type);
        if (!factory) continue; // provided by the stage module
        const parsed = factory.schema.safeParse(layer.params);
        expect(parsed.success, `${stage.id}/${layer.id ?? layer.type}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
      }
    });
  }

  // Composition tracks: the module's id matches the manifest id, and the tempo the Music Room
  // shows (the track's `bpm`, else the stage's) is the composition's own.
  const compositions = import.meta.glob('/content/**/music/*.ts', { eager: true, import: 'default' }) as Record<string, { id: string; bpm: number }>;
  for (const stage of stages) {
    const m = stage.manifest;
    if (!m) continue;
    it(`stage "${stage.id}" lists its compositions with their own ids and tempos`, () => {
      const ids = m.music.tracks.map((t) => t.id);
      expect(new Set(ids).size, 'track ids are unique').toBe(ids.length);
      const defaultSpec = m.music.tracks.find((t) => t.id === m.music.defaultTrack) ?? m.music.tracks[0];
      for (const t of m.music.tracks.filter((x) => x.kind === 'composition')) {
        const comp = compositions[`${stage.dir}/${t.src.replace(/^\.\//, '')}`];
        expect(comp, `${t.id}: ${t.src}`).toBeDefined();
        expect(comp?.id, `${t.src} composition id`).toBe(t.id);
        expect(t.bpm ?? m.music.bpm, `${t.id} tempo`).toBe(comp?.bpm);
      }
      if (defaultSpec?.kind === 'composition') expect(m.music.bpm, 'music.bpm is the default track tempo').toBe(compositions[`${stage.dir}/${defaultSpec.src.replace(/^\.\//, '')}`]?.bpm);
    });
  }

  for (const [path, raw] of Object.entries(reactivityProfileFiles())) {
    it(`reactivity profile ${path.slice(path.lastIndexOf('/') + 1)} is valid`, () => {
      const parsed = reactivityProfileSchema.safeParse(raw);
      expect(parsed.success, parsed.success ? '' : parsed.error.message).toBe(true);
    });
  }

  it('the Voyage campaign is valid and every leg names an available stage', () => {
    const info = getCampaign('voyage');
    expect(info.errors, info.errors.join('\n')).toEqual([]);
    expect(info.campaign?.areas.length).toBeGreaterThan(0);
  });

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

  it('checks reactivity profile references and their layer scopes', () => {
    const profiled = (profiles: unknown[]) => ({ ...minimal, environment: { layers: [{ id: 'sky', type: 'sky' }] }, reactivity: { profiles } });
    const withProfiles = { ...env, profileExists: (n: string) => n === 'bass-breath' };
    expect(validateManifest(profiled(['bass-breath']), withProfiles).errors).toEqual([]);
    expect(validateManifest(profiled([{ name: 'bass-breath', layers: ['sky'], amount: 0.5 }]), withProfiles).manifest?.reactivity.profiles[0]).toEqual({ name: 'bass-breath', layers: ['sky'], amount: 0.5 });
    expect(validateManifest(profiled(['missing']), withProfiles).errors.join()).toContain('not found');
    expect(validateManifest(profiled([{ name: 'bass-breath', layers: ['ocean'] }]), withProfiles).errors.join()).toContain('no layer with id "ocean"');
  });

  it('checks the layers that event call-ins and section states name (since SDK 1.5)', () => {
    const base = { ...minimal, environment: { layers: [{ id: 'sky', type: 'sky' }] } };
    const ok = { ...base, events: [{ layer: 'sky', on: 'clear>=4', action: 'show' }, { layer: 'type:sky', on: 'b2b', action: 'burst' }], sectionStates: { states: [{ section: ['drop'], layer: 'sky', target: 'glow', scale: 1.2 }] } };
    expect(validateManifest(ok, env).errors).toEqual([]);
    expect(validateManifest({ ...base, events: [{ layer: 'birds', on: 'clear>=4', action: 'pass' }] }, env).errors.join()).toContain('no layer with id "birds"');
    expect(validateManifest({ ...base, sectionStates: { states: [{ section: ['drop'], layer: 'haze', target: 'opacity' }] } }, env).errors.join()).toContain('no layer with id "haze"');
    expect(validateManifest({ ...base, events: [{ layer: 'sky', on: 'sometimes', action: 'pass' }] }, env).errors.join()).toContain('unknown trigger');
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
