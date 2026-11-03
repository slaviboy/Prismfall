import { LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, TextureLoader, type Node, type Texture } from 'three/webgpu';
import { clamp, float, mx_noise_float, texture, uniform, vec2, vec3 } from 'three/tsl';
import { z, type EnvironmentContext } from '@prismfall/sdk';

/**
 * Shared pieces of The Lost Kingdom. Everything is world space; the player's eye is at about
 * (0, 1, 30) looking towards -Z, the plaza floor is at y = -13.
 *
 * The sun is the photograph's (Poly Haven rainforest_trail): it comes through the canopy, and the
 * canopy is a mask (textures/canopy_dapple.webp) on a horizontal plane above the city. The Blender
 * bake (assets/blender/scripts/lost_kingdom.py) shadowed the stone with the same mask, so plants,
 * water and light shafts sample it here and receive the same sun patches.
 */

export type F = Node<'float'>;
export type V2 = Node<'vec2'>;
export type V3 = Node<'vec3'>;
export type Vec3 = [number, number, number];

/** The canopy plane and the sun, exactly as baked (lost_kingdom.meta.json). */
export const zCanopy = z.object({
  src: z.string().default('textures/canopy_dapple.webp'),
  /** Height of the mask plane (world y). */
  y: z.number().default(42),
  /** Covered rectangle in Blender coordinates: x0, y0, x1, y1 (Blender y = -world z). */
  rect: z.tuple([z.number(), z.number(), z.number(), z.number()]).default([-180, -120, 220, 280]),
});
export type Canopy = z.infer<typeof zCanopy>;

export const zSun = z.object({
  /** Direction towards the sun (world). */
  direction: z.tuple([z.number(), z.number(), z.number()]).default([0, 0.788, 0.6157]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#fff2d6'),
  /** Irradiance scale of a fully sunlit, sun-facing surface (the bake's sunEff). */
  intensity: z.number().min(0).default(4.1),
});
export type Sun = z.infer<typeof zSun>;

/** Loads a stage texture; colour images are sRGB. */
export async function loadTexture(ctx: EnvironmentContext, src: string, kind: 'color' | 'data', repeat = false): Promise<Texture | null> {
  const url = ctx.assets.url(src);
  if (!url) {
    console.warn(`[lost-kingdom] texture ${src} not found`);
    return null;
  }
  const tex = await new TextureLoader().loadAsync(url);
  tex.minFilter = LinearMipmapLinearFilter;
  tex.anisotropy = 8;
  if (repeat) tex.wrapS = tex.wrapT = RepeatWrapping;
  if (kind === 'color') tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Shared clock for the canopy's slow movement (one Lost Kingdom exists at a time). */
export const canopyTime = uniform(0);

/**
 * Sunlight reaching a world point through the canopy (0 = leaf shade, 1 = full sun), with the
 * leaves drifting a little in the breeze. `sway` 0..1 scales that drift.
 */
export function canopyLight(mask: Texture, c: Canopy, sun: Sun, p: V3, sway: F | number = 1): F {
  const [lx, ly, lz] = sun.direction;
  const rise = float(c.y).sub(p.y);
  // Blender plane coordinates: X = x, Y = -z (world), shifted along the sun ray up to the plane.
  const bx = p.x.add(rise.mul(lx / ly));
  const by = p.z.negate().add(rise.mul(-lz / ly));
  const [x0, y0, x1, y1] = c.rect;
  const wob = mx_noise_float(vec3(p.x.mul(0.05), p.z.mul(0.05), canopyTime.mul(0.06))).mul(0.6).mul(sway);
  const u = bx.add(wob).sub(x0).div(x1 - x0);
  const v = by.add(wob.mul(0.7)).sub(y0).div(y1 - y0);
  return clamp(texture(mask, vec2(u, v)).r, 0, 1) as F;
}

/** A slow, broad flicker of the sun patches (leaves moving high above), 1 on average. */
export function leafFlicker(p: V3, amount: number): F {
  const n = mx_noise_float(vec3(p.x.mul(0.18), p.z.mul(0.18), canopyTime.mul(0.35)));
  return float(1).add(n.mul(amount)) as F;
}
