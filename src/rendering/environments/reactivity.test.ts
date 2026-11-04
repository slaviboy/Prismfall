import { describe, expect, it } from 'vitest';
import { createAudioFeatures } from '../../audio/analysis/features';
import type { GameSignals } from '../../sdk/types';
import { bindingSchema, sectionStateSchema } from '../../stages/schema';
import { crossfade, pulseEnvelope, readFeature, ReactivityLayer, sectionStateTarget, type ReactivitySettings } from './reactivity';
import { NEUTRAL_LEVELS } from './living/intensity';
import { createMusicDrive } from './living/musicDirector';

const settings: ReactivitySettings = {
  enabled: true,
  preset: 'custom',
  strength: 1,
  bassSensitivity: 1,
  trebleSensitivity: 1,
  beatSensitivity: 1,
  particleResponse: 1,
  environmentResponse: 1,
  lightingResponse: 1,
};
const game: GameSignals = { danger: 0, combo: -1, backToBack: -1, level: 1, clearPulse: 0, progress: 0, heat: 0, clearWave: 0, stackHeight: 0, pieceX: 0 };

/**
 * Runs a bass-driven binding at `hz` frames per second and samples the output every 1/12 s —
 * a whole number of frames at 60, 144 and 240 Hz, so every rate is sampled at identical instants.
 */
function simulate(hz: number, seconds: number, bass: (t: number) => number): number[] {
  const layer = new ReactivityLayer();
  const target = { value: 1 };
  layer.add(bindingSchema.parse({ target: 'x', feature: 'bass', amount: 1, curve: 'linear', attackMs: 50, releaseMs: 300 }), target);
  const audio = createAudioFeatures();
  const samples: number[] = [];
  const dt = 1 / hz;
  const every = hz / 12;
  for (let frame = 1; frame <= Math.round(seconds * hz); frame++) {
    audio.bass = bass(frame * dt);
    layer.update(dt, audio, game, settings);
    if (frame % every === 0) samples.push(target.value);
  }
  return samples;
}

describe('reactivity layer', () => {
  it('produces the same response at 60, 144 and 240 Hz (time-based smoothing)', () => {
    // A continuously varying feature: differences can then only come from frame-rate dependence.
    const signal = (t: number) => 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.3 * t) * Math.sin(2 * Math.PI * 0.4 * t);
    const a = simulate(60, 3, signal);
    const b = simulate(144, 3, signal);
    const c = simulate(240, 3, signal);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(Math.abs((a[i] as number) - (c[i] as number))).toBeLessThan(0.03);
      expect(Math.abs((b[i] as number) - (c[i] as number))).toBeLessThan(0.015);
    }
  });

  it('attacks faster than it releases', () => {
    const s = simulate(240, 1, (t) => (t < 0.3 ? 1 : 0));
    // Samples every 1/12 s: index 1 ≈ 0.17 s (attacking), index 4 ≈ 0.42 s (0.12 s into release).
    expect(s[1]).toBeGreaterThan(1.9);
    expect(s[4]).toBeGreaterThan(1.5);
    expect(s[11]).toBeLessThan(1.2);
  });

  it('combines several bindings on one target and clamps', () => {
    const layer = new ReactivityLayer();
    const target = { value: 2 };
    layer.add(bindingSchema.parse({ target: 'x', feature: 'bass', amount: 1, mode: 'mul', attackMs: 0, curve: 'linear' }), target);
    layer.add(bindingSchema.parse({ target: 'x', feature: 'treble', amount: 0.5, mode: 'add', attackMs: 0, curve: 'linear', max: 4.2 }), target);
    const audio = createAudioFeatures();
    audio.bass = 1;
    audio.treble = 1;
    layer.update(0.1, audio, game, settings);
    expect(target.value).toBeCloseTo(4.2);
    layer.reset();
    expect(target.value).toBe(2);
  });

  it('is silenced by the master switch but keeps game signals', () => {
    const layer = new ReactivityLayer();
    const a = { value: 1 };
    const b = { value: 1 };
    layer.add(bindingSchema.parse({ target: 'a', feature: 'bass', amount: 1, attackMs: 0 }), a);
    layer.add(bindingSchema.parse({ target: 'b', feature: 'game.danger', amount: 1, attackMs: 0, curve: 'linear' }), b);
    const audio = createAudioFeatures();
    audio.bass = 1;
    layer.update(0.1, audio, { ...game, danger: 1 }, { ...settings, enabled: false });
    expect(a.value).toBe(1);
    expect(b.value).toBeCloseTo(2);
  });
});

describe('section gating and section states', () => {
  it('a binding with `when` follows its feature only inside those sections', () => {
    const layer = new ReactivityLayer();
    const target = { value: 1 };
    layer.add(bindingSchema.parse({ target: 'x', feature: 'bass', amount: 1, curve: 'linear', attackMs: 1, releaseMs: 1, when: { section: ['drop'] } }), target);
    const audio = createAudioFeatures();
    audio.bass = 1;
    audio.sectionKind = 'verse';
    for (let i = 0; i < 60; i++) layer.update(1 / 60, audio, game, settings);
    expect(target.value).toBeCloseTo(1, 3);
    audio.sectionKind = 'drop';
    for (let i = 0; i < 60; i++) layer.update(1 / 60, audio, game, settings);
    expect(target.value).toBeCloseTo(2, 2);
    // A composition's own section name also matches.
    const named = new ReactivityLayer();
    const t2 = { value: 1 };
    named.add(bindingSchema.parse({ target: 'x', feature: 'bass', amount: 1, curve: 'linear', attackMs: 1, releaseMs: 1, when: { section: ['cranes'] } }), t2);
    audio.section = 'cranes';
    audio.sectionKind = 'verse';
    for (let i = 0; i < 60; i++) named.update(1 / 60, audio, game, settings);
    expect(t2.value).toBeCloseTo(2, 2);
  });

  it('crossfade reaches about 95 % in the fade time at any frame rate', () => {
    for (const hz of [60, 144, 240]) {
      let w = 0;
      for (let i = 0; i < hz * 3; i++) w = crossfade(w, 1, 1 / hz, 3);
      expect(w).toBeGreaterThan(0.94);
      expect(w).toBeLessThan(0.96);
    }
  });

  it('a section state scales its target in its section and fades back out', () => {
    const layer = new ReactivityLayer();
    const target = { value: 2 };
    layer.addState(sectionStateSchema.parse({ section: ['drop'], target: 'x', scale: 1.5 }), target, 2);
    const audio = createAudioFeatures();
    audio.sectionKind = 'drop';
    for (let i = 0; i < 60 * 4; i++) layer.update(1 / 60, audio, game, settings);
    expect(target.value).toBeCloseTo(3, 1);
    audio.sectionKind = 'break';
    for (let i = 0; i < 60; i++) layer.update(1 / 60, audio, game, settings);
    // Partway back after one second of a two-second fade.
    expect(target.value).toBeGreaterThan(2.1);
    expect(target.value).toBeLessThan(2.5);
    for (let i = 0; i < 60 * 6; i++) layer.update(1 / 60, audio, game, settings);
    expect(target.value).toBeCloseTo(2, 2);
  });

  it('anticipation winds a state up before its section starts', () => {
    const state = sectionStateSchema.parse({ section: ['drop'], target: 'x', scale: 2, anticipate: 0.8 });
    const audio = createAudioFeatures();
    audio.sectionKind = 'build';
    audio.nextEvent = 'drop';
    audio.anticipation = 0.5;
    expect(sectionStateTarget(state, audio)).toBeCloseTo(0.4, 5);
    audio.nextEvent = 'break';
    expect(sectionStateTarget(state, audio)).toBe(0);
    audio.sectionKind = 'drop';
    expect(sectionStateTarget(state, audio)).toBe(1);
  });

  it('reads the long-lived game signals', () => {
    const audio = createAudioFeatures();
    expect(readFeature('game.heat', audio, { ...game, heat: 0.7 })).toBeCloseTo(0.7);
    expect(readFeature('game.clearWave', audio, { ...game, clearWave: 0.4 })).toBeCloseTo(0.4);
    expect(readFeature('game.backToBack', audio, { ...game, backToBack: -1 })).toBe(0);
    expect(readFeature('game.backToBack', audio, { ...game, backToBack: 0 })).toBeCloseTo(0.25);
    expect(readFeature('game.backToBack', audio, { ...game, backToBack: 5 })).toBe(1);
    expect(readFeature('game.stackHeight', audio, { ...game, stackHeight: 0.3 })).toBeCloseTo(0.3);
  });
});

describe('reactivity with the music drives and Background intensity (SDK 1.7)', () => {
  const drive = { ...createMusicDrive(), body: 0.8, detail: 0.2, active: true };

  it('reads music.* features from the drives', () => {
    const audio = createAudioFeatures();
    expect(readFeature('music.body', audio, game, drive)).toBe(0.8);
    expect(readFeature('music.detail', audio, game, drive)).toBe(0.2);
    expect(readFeature('music.body', audio, game)).toBe(0);
  });

  it('a music binding follows its drive, scaled by the music level', () => {
    const run = (music: number) => {
      const layer = new ReactivityLayer();
      const target = { value: 1 };
      layer.add(bindingSchema.parse({ target: 'glow', feature: 'music.body', amount: 0.5, curve: 'linear', attackMs: 0, releaseMs: 0 }), target, 'light');
      layer.update(1 / 60, createAudioFeatures(), game, settings, { music: drive, levels: { ...NEUTRAL_LEVELS, music } });
      return target.value;
    };
    expect(run(1)).toBeCloseTo(1 + 0.5 * 0.8);
    expect(run(0)).toBeCloseTo(1);
    expect(run(1.5)).toBeCloseTo(1 + 0.5 * 0.8 * 1.5);
  });

  it('Balanced leaves bases alone; other levels scale them by class', () => {
    const layer = new ReactivityLayer();
    const glow = { value: 2 };
    const density = { value: 1 };
    const size = { value: 3 };
    const dusk = { value: 0.4 };
    layer.track(glow, 'light', 'glow');
    layer.track(density, 'particles', 'density');
    layer.track(size, 'particles', 'size');
    layer.track(dusk, 'none', 'dusk');
    const audio = createAudioFeatures();
    layer.update(1 / 60, audio, game, settings, { levels: NEUTRAL_LEVELS });
    expect([glow.value, density.value, size.value, dusk.value]).toEqual([2, 1, 3, 0.4]);
    layer.update(1 / 60, audio, game, settings, { levels: { ...NEUTRAL_LEVELS, lighting: 0.5, particles: 1.5 } });
    expect(glow.value).toBeCloseTo(1);
    expect(density.value).toBeCloseTo(1.5);
    expect(size.value).toBe(3);
    expect(dusk.value).toBe(0.4);
  });

  it('a pulse rises, holds and falls back to the base', () => {
    const layer = new ReactivityLayer();
    const target = { value: 1 };
    layer.addPulse(target, { mode: 'mul', amount: 1, attack: 1, hold: 1, release: 1 }, 1, 'light', 'intensity');
    const audio = createAudioFeatures();
    const at: number[] = [];
    for (let i = 1; i <= 240; i++) {
      layer.update(1 / 60, audio, game, settings);
      if (i % 30 === 0) at.push(target.value);
    }
    // 0.5 s: rising; 1.5 s: holding at 2; 2.5 s: falling; 3.5 s: back to 1 and gone.
    expect(at[0]).toBeGreaterThan(1.2);
    expect(at[0]).toBeLessThan(1.8);
    expect(at[2]).toBeCloseTo(2);
    expect(at[4]).toBeLessThan(2);
    expect(at[4]).toBeGreaterThan(1);
    expect(at[6]).toBeCloseTo(1);
    expect(layer.pulseCount).toBe(0);
    expect(pulseEnvelope({ attack: 1, hold: 1, release: 1 }, 1.5)).toBe(1);
  });
});
