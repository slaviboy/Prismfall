import { uniform } from 'three/tsl';

/**
 * Environment-only per-frame uniforms (SDK 1.7), set once per frame by the EnvironmentHost:
 *
 * - `music.*`: the Environment Music Director's drives (0..1), already scaled by the Background
 *   intensity music level, so a shader multiplies them straight into its response;
 * - `level.*`: the Background intensity levels themselves (1 = as authored), for custom shaders
 *   that animate, light, thicken or populate something the reactive targets do not cover.
 *
 * Board, block, light-rig and post code never read these, and the protected `frameUniforms` keep
 * their meaning (PROTECTED_PLAYFIELD.md), so nothing here can change how the playfield looks.
 */
export const environmentUniforms = {
  music: {
    body: uniform(0),
    swell: uniform(0),
    motion: uniform(0),
    detail: uniform(0),
    shimmer: uniform(0),
    flux: uniform(0),
    energy: uniform(0),
    intensity: uniform(0),
    tension: uniform(0),
    release: uniform(0),
    calm: uniform(1),
    accent: uniform(0),
    beat: uniform(0),
    downbeat: uniform(0),
    phrase: uniform(0),
  },
  level: {
    animation: uniform(1),
    music: uniform(1),
    particles: uniform(1),
    lighting: uniform(1),
    events: uniform(1),
    creatures: uniform(1),
    atmosphere: uniform(1),
  },
};

export type EnvironmentUniforms = typeof environmentUniforms;
