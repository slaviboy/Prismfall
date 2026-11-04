import { describe, expect, it } from 'vitest';
import { Group, Scene } from 'three/webgpu';
import { z } from 'zod';
import { createAudioFeatures } from '../../audio/analysis/features';
import { registries } from '../../sdk/registry';
import type { CallInfo, ComponentFactory, EnvFrame, EnvironmentContext, GameSignals, SectionInfo, StageGameEvent } from '../../sdk/types';
import { stageManifestSchema } from '../../stages/schema';
import { frameUniforms } from '../shaders/uniforms';
import type { ReactivitySettings } from './reactivity';
import { StageEnvironment } from './StageEnvironment';

/** A component that records what the stage environment delivers to it. */
interface Probe {
  calls: CallInfo[];
  sections: SectionInfo[];
  events: StageGameEvent[];
  level: { value: number };
}
const probes = new Map<string, Probe>();
const probeFactory: ComponentFactory<{ name: string }> = {
  type: 'testProbe',
  version: 1,
  description: 'test probe',
  schema: z.object({ name: z.string() }),
  create(_ctx, p) {
    const probe: Probe = { calls: [], sections: [], events: [], level: { value: 2 } };
    probes.set(p.name, probe);
    return {
      object: new Group(),
      reactive: { level: probe.level },
      onCall: (c) => probe.calls.push(c),
      onSection: (s) => probe.sections.push(s),
      onGameEvent: (e) => probe.events.push(e),
      dispose: () => undefined,
    };
  },
};
registries.components.register(probeFactory as unknown as ComponentFactory);

const settings: ReactivitySettings = { enabled: true, preset: 'custom', strength: 1, bassSensitivity: 1, trebleSensitivity: 1, beatSensitivity: 1, particleResponse: 1, environmentResponse: 1, lightingResponse: 1 };
const game: GameSignals = { danger: 0, combo: -1, backToBack: -1, level: 1, clearPulse: 0, progress: 0, heat: 0, clearWave: 0, stackHeight: 0, pieceX: 0 };

const manifest = stageManifestSchema.parse({
  schemaVersion: 1,
  id: 'test-stage',
  name: 'Test',
  description: '',
  palette: { accent: '#ffffff', secondary: '#ffffff', highlight: '#ffffff', fog: '#000000' },
  lighting: { key: { color: '#ffffff', intensity: 1, azimuth: 0, elevation: 30 }, rim: { color: '#ffffff', intensity: 1 }, ambient: { sky: '#ffffff', ground: '#000000', intensity: 1 }, accents: [] },
  environment: { layers: [{ id: 'a', type: 'testProbe', params: { name: 'a' } }, { id: 'b', type: 'testProbe', params: { name: 'b' } }] },
  music: { bpm: 120 },
  events: [
    { layer: 'a', on: 'clear>=4', quantize: 'bar', cooldown: 0, action: 'pass', params: { side: 'left' } },
    { layer: 'type:testProbe', on: 'section:drop', quantize: 'none', cooldown: 0, action: 'show' },
    { layer: 'b', on: 'progress>=0.5', quantize: 'none', cooldown: 0, action: 'reveal' },
  ],
  sectionStates: { fade: 1, states: [{ section: ['drop'], layer: 'b', target: 'level', scale: 2 }] },
});

function context(): EnvironmentContext {
  return {
    stageId: 'test-stage',
    scene: new Scene(),
    quality: { detail: 'high', particles: 1, reflections: 'off', reducedMotion: false },
    uniforms: frameUniforms,
    assets: {} as EnvironmentContext['assets'],
    bursts: {} as EnvironmentContext['bursts'],
    palette: manifest.palette,
    ground: { height: () => 0, provide: () => undefined, surface: () => 0, setWaterLevel: () => undefined },
    sounds: { emit: () => undefined },
  };
}

describe('stage environment: sections, section states and call-ins', () => {
  it('routes call-ins to the layers they name, quantised to the bar', async () => {
    probes.clear();
    const env = await StageEnvironment.build(manifest, context());
    const audio = createAudioFeatures();
    const frame = (time: number, g: Partial<GameSignals> = {}): EnvFrame => ({ time, dt: 1 / 60, audio, game: { ...game, ...g }, presence: 1 });
    env.update(frame(0), settings);
    env.onGameEvent({ kind: 'clear', lines: 4, intensity: 1, spin: false, perfectClear: false, combo: -1, backToBack: false });
    env.update(frame(0.1), settings);
    expect(probes.get('a')!.calls).toHaveLength(0);
    env.onBeat({ beat: 4, bar: 1, beatInBar: 0, downbeat: true, time: 0 });
    env.update(frame(0.2), settings);
    const a = probes.get('a')!;
    expect(a.calls).toHaveLength(1);
    expect(a.calls[0]).toMatchObject({ action: 'pass', trigger: 'clear>=4', params: { side: 'left' } });
    expect(a.calls[0]!.strength).toBeCloseTo(1);
    expect(probes.get('b')!.calls).toHaveLength(0);
    // Every component still sees the game event itself.
    expect(probes.get('b')!.events[0]).toMatchObject({ kind: 'clear', lines: 4 });
    env.dispose();
  });

  it('tells components about sections, fires section call-ins on changes and crossfades section states', async () => {
    probes.clear();
    const env = await StageEnvironment.build(manifest, context());
    const audio = createAudioFeatures();
    audio.section = 'opening';
    audio.sectionKind = 'intro';
    let t = 0;
    const step = (n: number, g: Partial<GameSignals> = {}) => {
      for (let i = 0; i < n; i++) env.update({ time: (t += 1 / 60), dt: 1 / 60, audio, game: { ...game, ...g }, presence: 1 }, settings);
    };
    step(1);
    const b = probes.get('b')!;
    // The section the world opens in: announced, but no call-in.
    expect(b.sections).toEqual([expect.objectContaining({ kind: 'intro', name: 'opening', previous: null })]);
    expect(b.level.value).toBe(2);
    audio.section = 'peak';
    audio.sectionKind = 'drop';
    step(120);
    expect(b.sections[1]).toMatchObject({ kind: 'drop', name: 'peak', previous: 'intro' });
    expect(probes.get('a')!.calls.map((c) => c.action)).toEqual(['show']);
    expect(b.calls.map((c) => c.action)).toEqual(['show']);
    expect(b.level.value).toBeGreaterThan(3.9);
    expect(probes.get('a')!.level.value).toBe(2);
    // Progress crossings count from what the world first saw.
    step(1, { progress: 0.6 });
    expect(b.calls.map((c) => c.action)).toEqual(['show', 'reveal']);
    audio.sectionKind = 'break';
    audio.section = 'rest';
    step(240);
    expect(b.level.value).toBeCloseTo(2, 2);
    env.dispose();
  });

  it('warns about section states that reach no target', async () => {
    const bad = stageManifestSchema.parse({ ...manifest, sectionStates: { states: [{ section: ['drop'], layer: 'b', target: 'nothing', scale: 2 }] } });
    const env = await StageEnvironment.build(bad, context());
    expect(env.warnings.join()).toContain('no layer "b" exposes "nothing"');
    env.dispose();
  });
});
