import { Vector3, Vector4, type Node, type NodeMaterial } from 'three/webgpu';
import { cameraPosition, exp, length, mrt, positionWorld, uniform, vec4 } from 'three/tsl';

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
  /** Current combo, 0 (none) .. 1 (eight or more). */
  comboLevel: uniform(0),
  danger: uniform(0),
  /** Heat of the run 0..1 (since SDK 1.5; see GameSignals.heat). */
  heat: uniform(0),
  /** Long-release clear signal 0..1 (since SDK 1.5; see GameSignals.clearWave). */
  clearWave: uniform(0),
  /** The active piece across the board, -1 (left wall) .. 1 (right wall), smoothed (since SDK 1.5). */
  pieceX: uniform(0),
  /** Stack height 0..1, smoothed (since SDK 1.5). */
  stackHeight: uniform(0),
  /**
   * World clear fronts (since SDK 1.5; read them through `clearFront()`): the board's world
   * position, four slots of (start time, strength, reach, width), the travel shape (near, 1 / ln
   * (far / near), 1 / travel seconds) and the accessibility-scaled multipliers for light and motion.
   */
  waveOrigin: uniform(new Vector3()),
  wave0: uniform(new Vector4(-1000, 0, 0, 0.05)),
  wave1: uniform(new Vector4(-1000, 0, 0, 0.05)),
  wave2: uniform(new Vector4(-1000, 0, 0, 0.05)),
  wave3: uniform(new Vector4(-1000, 0, 0, 0.05)),
  waveShape: uniform(new Vector3(6, 1 / Math.log(150), 1 / 3.2)),
  waveLight: uniform(1),
  waveMotion: uniform(1),
  /** Global multipliers from settings / accessibility. */
  effectsIntensity: uniform(1),
  flashLimit: uniform(1),
  /** Accessibility screen-effects intensity (0..1); 0 while VR is presenting. */
  screenEffects: uniform(1),
  /** Accessibility world events: 1 full, 0.5 calm, 0 off (creatures and sudden world events). */
  worldEvents: uniform(1),
  reactivity: uniform(1),
  /** Current scene fog density (FogExp2), for materials that fog themselves. */
  fogDensity: uniform(0),
};

/**
 * Fog for additive materials. Built-in fog mixes towards the fog colour, which on an additive quad
 * adds that colour across the whole quad (visible rectangles under bright fog). Additive light
 * should instead fade with distance: multiply by the fog transmittance and set `material.fog = false`.
 */
export function additiveFog<T extends Node<'vec3'>>(color: T): T {
  const d = length(positionWorld.sub(cameraPosition)).mul(frameUniforms.fogDensity);
  return color.mul(exp(d.mul(d).negate())) as unknown as T;
}

export type FrameUniforms = typeof frameUniforms;

/** Excludes a material from the emissive bloom target (backdrops, plates, translucent helpers). */
export function noBloom<T extends NodeMaterial>(material: T): T {
  material.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
  return material;
}
