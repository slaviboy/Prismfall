import { Color, Vector3 } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { z } from 'zod';

/** "#rrggbb" colour parameter (sRGB in manifests, converted to linear for shaders). */
export const zColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const zVec3 = z.tuple([z.number(), z.number(), z.number()]);

export function linear(hex: string, scale = 1): Vector3 {
  const c = new Color(hex).convertSRGBToLinear();
  return new Vector3(c.r * scale, c.g * scale, c.b * scale);
}

export const colorUniform = (hex: string, scale = 1) => uniform(linear(hex, scale));
export const floatUniform = (v: number) => uniform(v);

/** Deterministic pseudo-random sequence for procedural placement (stable layouts per stage). */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Particle counts scale with quality: detail level × user density. */
export function scaledCount(base: number, detail: 'low' | 'medium' | 'high' | 'ultra', density: number): number {
  const d = detail === 'low' ? 0.35 : detail === 'medium' ? 0.65 : detail === 'high' ? 1 : 1.4;
  return Math.max(0, Math.round(base * d * density));
}
