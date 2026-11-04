import { describe, expect, it } from 'vitest';
import { baseScale, classifyTarget, NEUTRAL_LEVELS, PRESET_LEVELS, resolveBackground, responseScale, type BackgroundSettings } from './intensity';

const custom = (preset: BackgroundSettings['preset'], over: Partial<BackgroundSettings> = {}): BackgroundSettings => ({ preset, animation: 1, music: 1, particles: 1, lighting: 1, events: 1, creatures: 1, atmosphere: 1, ...over });
const ACCESS = { reducedMotion: false, flashReduction: false };

describe('background intensity', () => {
  it('Balanced is every world as authored', () => {
    expect(resolveBackground(custom('balanced'), ACCESS)).toEqual(NEUTRAL_LEVELS);
  });

  it('presets order from Subtle to Cinematic on every knob', () => {
    for (const k of Object.keys(NEUTRAL_LEVELS) as (keyof typeof NEUTRAL_LEVELS)[]) {
      expect(PRESET_LEVELS.subtle[k]).toBeLessThanOrEqual(PRESET_LEVELS.balanced[k]);
      expect(PRESET_LEVELS.balanced[k]).toBeLessThanOrEqual(PRESET_LEVELS.immersive[k]);
      expect(PRESET_LEVELS.immersive[k]).toBeLessThanOrEqual(PRESET_LEVELS.cinematic[k]);
    }
  });

  it('custom uses the stored values, clamped', () => {
    const l = resolveBackground(custom('custom', { particles: 0.3, events: 5, music: Number.NaN }), ACCESS);
    expect(l.particles).toBe(0.3);
    expect(l.events).toBe(2);
    expect(l.music).toBe(1);
  });

  it('comfort settings calm motion and cap lighting', () => {
    const l = resolveBackground(custom('cinematic'), { reducedMotion: true, flashReduction: true });
    expect(l.animation).toBeCloseTo(PRESET_LEVELS.cinematic.animation * 0.5);
    expect(l.lighting).toBe(1);
  });

  it('classifies targets by layer type and name', () => {
    expect(classifyTarget('model', 'pace')).toBe('creatures');
    expect(classifyTarget('model', 'brightness')).toBe('light');
    expect(classifyTarget('particles', 'brightness')).toBe('particles');
    expect(classifyTarget('particles', 'turbulence')).toBe('motion');
    expect(classifyTarget('clouds', 'opacity')).toBe('atmosphere');
    expect(classifyTarget('scatter', 'sway')).toBe('motion');
    expect(classifyTarget('sky', 'glow')).toBe('light');
    expect(classifyTarget('sky', 'dusk')).toBe('none');
    expect(classifyTarget('planet', 'phase')).toBe('none');
    expect(classifyTarget('meteors', 'rate')).toBe('events');
    expect(classifyTarget('sky', 'glow', 'none')).toBe('none');
  });

  it('bounds sizes and visible shares', () => {
    const big = PRESET_LEVELS.cinematic;
    expect(baseScale('particles', 'size', big)).toBe(1);
    expect(baseScale('creatures', 'visible', big)).toBe(1);
    expect(baseScale('particles', 'density', big)).toBe(big.particles);
    expect(responseScale('none', big)).toBe(1);
  });
});
