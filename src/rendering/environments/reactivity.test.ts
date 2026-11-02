import { describe, expect, it } from 'vitest';
import { createAudioFeatures } from '../../audio/analysis/features';
import type { GameSignals } from '../../sdk/types';
import { bindingSchema } from '../../stages/schema';
import { ReactivityLayer, type ReactivitySettings } from './reactivity';

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
const game: GameSignals = { danger: 0, combo: -1, backToBack: -1, level: 1, clearPulse: 0, progress: 0 };

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
