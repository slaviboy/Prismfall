import type { NodeMaterial, Vector3 } from 'three/webgpu';
import { mrt, uniform, vec4 } from 'three/tsl';

const _floatU = (v: number) => uniform(v);
/** Colour uniforms use vec3 (linear RGB) — composes cleanly in TSL. */
const _colorU = (c: Vector3) => uniform(c);
export type FloatUniform = ReturnType<typeof _floatU>;
export type ColorUniform = ReturnType<typeof _colorU>;

/**
 * Per-frame uniforms shared by every material. Updated once per frame by the RenderSystem;
 * shaders read them directly so no buffers are uploaded for animation.
 */
export const frameUniforms = {
  /** Seconds, same clock as performance.now()/1000 (event timestamps use it too). */
  time: uniform(0),
  /** Smoothed music features (0..1) published by the audio analysis (stub until M5). */
  bass: uniform(0),
  mid: uniform(0),
  treble: uniform(0),
  energy: uniform(0),
  flux: uniform(0),
  /** 1 on a beat, decaying. */
  beatPulse: uniform(0),
  barPulse: uniform(0),
  beatPhase: uniform(0),
  sectionIntensity: uniform(0.5),
  /** Gameplay-driven pulses (0..1+). */
  clearPulse: uniform(0),
  comboLevel: uniform(0),
  danger: uniform(0),
  /** Global multipliers from settings / accessibility. */
  effectsIntensity: uniform(1),
  flashLimit: uniform(1),
  reactivity: uniform(1),
};

export type FrameUniforms = typeof frameUniforms;

/** Excludes a material from the emissive bloom target (backdrops, plates, translucent helpers). */
export function noBloom<T extends NodeMaterial>(material: T): T {
  material.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
  return material;
}
