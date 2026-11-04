/**
 * Background intensity (brief §40.12): how much the world around the board does, independently of
 * the game. A preset (Subtle, Balanced, Immersive, Cinematic) or custom levels scale seven aspects
 * of every world: ambient animation, music reactivity, particles, lighting, event frequency,
 * creature activity and atmospheric density. Balanced is every world as authored (all 1).
 *
 * The levels never reach the board: they scale environment reactive targets (by class, below), the
 * event director's rates and the environment-only uniforms. Pure TypeScript.
 */
import { TARGET_CLASSES, type TargetClass } from '../../../stages/living';

export const BACKGROUND_PRESETS = ['subtle', 'balanced', 'immersive', 'cinematic', 'custom'] as const;
export type BackgroundPreset = (typeof BACKGROUND_PRESETS)[number];

export const BACKGROUND_KNOBS = ['animation', 'music', 'particles', 'lighting', 'events', 'creatures', 'atmosphere'] as const;
export type BackgroundKnob = (typeof BACKGROUND_KNOBS)[number];
export type BackgroundLevels = Readonly<Record<BackgroundKnob, number>>;

export const NEUTRAL_LEVELS: BackgroundLevels = { animation: 1, music: 1, particles: 1, lighting: 1, events: 1, creatures: 1, atmosphere: 1 };

export const PRESET_LEVELS: Readonly<Record<Exclude<BackgroundPreset, 'custom'>, BackgroundLevels>> = {
  subtle: { animation: 0.6, music: 0.45, particles: 0.7, lighting: 0.85, events: 0.4, creatures: 0.6, atmosphere: 0.85 },
  balanced: NEUTRAL_LEVELS,
  immersive: { animation: 1.15, music: 1.3, particles: 1.15, lighting: 1.1, events: 1.4, creatures: 1.2, atmosphere: 1.05 },
  cinematic: { animation: 1.25, music: 1.55, particles: 1.3, lighting: 1.2, events: 1.8, creatures: 1.35, atmosphere: 1.1 },
};

/** The persisted setting (Settings → World). */
export interface BackgroundSettings extends Record<BackgroundKnob, number> {
  readonly preset: BackgroundPreset;
}

export interface BackgroundAccess {
  readonly reducedMotion: boolean;
  readonly flashReduction: boolean;
}

/**
 * Effective levels: the preset's (or the custom values), then the comfort settings. Reduced motion
 * halves ambient animation and calms creatures and music-driven motion; Reduce flashing caps the
 * lighting at its authored strength.
 */
export function resolveBackground(s: BackgroundSettings, access: BackgroundAccess): BackgroundLevels {
  const base: BackgroundLevels = s.preset === 'custom' ? { animation: s.animation, music: s.music, particles: s.particles, lighting: s.lighting, events: s.events, creatures: s.creatures, atmosphere: s.atmosphere } : PRESET_LEVELS[s.preset];
  const out: Record<BackgroundKnob, number> = { ...base };
  for (const k of BACKGROUND_KNOBS) out[k] = Math.max(0, Math.min(2, Number.isFinite(out[k]) ? out[k] : 1));
  if (access.reducedMotion) {
    out.animation *= 0.5;
    out.creatures *= 0.7;
    out.music *= 0.8;
  }
  if (access.flashReduction) out.lighting = Math.min(out.lighting, 1);
  return out;
}

/**
 * What a reactive target is, for the levels (TARGET_CLASSES): its base value and every response on
 * it are scaled by the matching knob. `none` is left alone (a time of day, a sun angle, a size).
 */
export { TARGET_CLASSES, type TargetClass };

/** The knob each class follows. */
export const CLASS_KNOB: Readonly<Record<Exclude<TargetClass, 'none'>, BackgroundKnob>> = {
  motion: 'animation',
  light: 'lighting',
  particles: 'particles',
  atmosphere: 'atmosphere',
  creatures: 'creatures',
  events: 'events',
};

const CREATURE_TYPES = new Set(['model', 'creatureHerd', 'swarm', 'fishSchool', 'birdFlock', 'glowSchool', 'jellyfish', 'fireflies', 'dragonflies']);
const PARTICLE_TYPES = new Set(['particles', 'emitter', 'particleShapes']);
const MOTION = /^(speed|spin|sway|turbulence|amplitude|drift|flow|jitter|stir|chop|ripple|swell|wind|gust|wave|tempo|pace)$/i;
const LIGHT = /^(glow|emissive|brightness|intensity|stars|disc|nebula|windows|neon|lamps|heat|flash|surf|atmosphere|sparkle|glint|sheen|light|lights|beam|beams|shimmer|aurora|fire|embers|lava)$/i;
const ATMOSPHERE = /^(opacity|fog|haze|mist|murk|plume|smoke|veil|density|thickness)$/i;
const CREATURE = /^(pace|tempo|visible|activity|agitation)$/i;

/**
 * Class of `target` on a layer of `type`: an explicit override from the world's living.json wins;
 * otherwise creature layers' pace, visibility and activity are `creatures`, particle layers' density,
 * amount and brightness are `particles`, and target names decide the rest.
 */
export function classifyTarget(type: string, target: string, override?: TargetClass): TargetClass {
  if (override) return override;
  if (CREATURE_TYPES.has(type) && CREATURE.test(target)) return 'creatures';
  if (PARTICLE_TYPES.has(type) && /^(density|amount|brightness|size)$/i.test(target)) return 'particles';
  if (type === 'meteors' && target === 'rate') return 'events';
  if (ATMOSPHERE.test(target)) return 'atmosphere';
  if (MOTION.test(target)) return 'motion';
  if (LIGHT.test(target)) return 'light';
  return 'none';
}

/**
 * How a level scales a target's base value. Sizes and shares are bounded: a particle layer's size
 * does not grow with the level, and a creature layer's visible share never exceeds all of them.
 */
export function baseScale(cls: TargetClass, target: string, levels: BackgroundLevels): number {
  if (cls === 'none') return 1;
  const level = levels[CLASS_KNOB[cls]];
  if (cls === 'particles' && /^size$/i.test(target)) return 1;
  if (cls === 'creatures' && /^visible$/i.test(target)) return Math.min(1, level);
  return level;
}

/** How a level scales the responses (bindings, section states, pulses) on a target. */
export function responseScale(cls: TargetClass, levels: BackgroundLevels): number {
  return cls === 'none' ? 1 : levels[CLASS_KNOB[cls]];
}
