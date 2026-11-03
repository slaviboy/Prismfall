import { cameraPosition, dot, float, int, length, max, mix, normalize, pow, reflect, uniform, vec3 } from 'three/tsl';
import { linear, z } from '@prismfall/sdk';
import type { FogModel } from './fogModel';
import { cast, MAX_LIGHTS, moonDirection, type F, type V3, type V4, type VeilShared } from './shared';

/**
 * Lighting shared by every Veil surface (ground, water's banks, trees, ruins, creatures): cold
 * moonlight with the creatures' and trees' shadows, a hemisphere of fog light, the warm fog
 * lights, a wet sheen that reflects the fog, a backlit rim where a silhouette stands against bright
 * fog, and finally the fog between the surface and the camera.
 */

export const zLighting = z
  .object({
    moon: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#a8b8d0'),
    moonIntensity: z.number().min(0).default(1.5),
    sky: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#7c8ca2'),
    ground: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#34383a'),
    ambient: z.number().min(0).default(1.05),
  })
  .prefault({});

export type LightingParams = z.infer<typeof zLighting>;

export interface SurfaceInput {
  albedo: V3;
  normal: V3;
  world: V3;
  roughness?: F;
  ao?: F;
  /** 0..1 wet sheen. */
  wet?: F;
  /** Rim light from bright fog behind the surface (creatures). */
  rim?: number;
  /** Translucency: moonlight seen through thin parts (wings, quills). */
  translucent?: F;
  /** Skip fog (surfaces that fog themselves later). */
  noFog?: boolean;
  /** Fill from the luminous fog around the surface (the photo's light in the normal's direction). */
  fill?: number;
}

export interface Lighting {
  readonly moonDir: V3;
  shade(i: SurfaceInput): V3;
}

export function createLighting(s: VeilShared, fog: FogModel, p: LightingParams): Lighting {
  const md = moonDirection();
  const moonDir = cast<V3>(uniform(md));
  const moonC = cast<V3>(uniform(linear(p.moon, p.moonIntensity)));
  const skyC = cast<V3>(uniform(linear(p.sky, p.ambient)));
  const groundC = cast<V3>(uniform(linear(p.ground, p.ambient)));
  const shadows = s.shadows;
  const lamps = (world: V3, n: V3): V3 => {
    let sum: V3 = cast<V3>(vec3(0, 0, 0));
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const lp = cast<V4>(s.fog.lightPos.element(int(i)));
      const lc = cast<V4>(s.fog.lightCol.element(int(i)));
      const d = cast<V3>(lp.xyz.sub(world));
      const d2 = dot(d, d);
      const l = d.div(d2.sqrt().max(1e-3));
      sum = cast<V3>(sum.add(lc.rgb.mul(lp.w).mul(0.06).mul(dot(n, l).add(0.2).div(1.2).clamp(0, 1)).div(d2.add(2))));
    }
    return sum;
  };
  const shade = (i: SurfaceInput): V3 => {
    const n = i.normal;
    const v = cast<V3>(normalize(cameraPosition.sub(i.world)));
    const ndl = cast<F>(dot(n, moonDir).add(0.12).div(1.12).max(0));
    // Normal-offset lookup: casters never shadow their own lit faces.
    const camDist = cast<F>(length(cameraPosition.sub(i.world)));
    const offset = cast<V3>(i.world.add(n.mul(camDist.mul(0.004).add(0.35))).add(moonDir.mul(0.4)));
    const sh = shadows ? shadows.sample(offset, 0.4, 1.8, 0.6) : cast<F>(float(0));
    const lit = cast<F>(float(1).sub(sh));
    const ao = i.ao ?? cast<F>(float(1));
    // Fill light: the sky term, plus the fog and photo around the surface in its normal's direction
    // (image-based, so a trunk turned from the moon still shows its bark against the bright fog).
    const around = i.fill ? cast<V3>(fog.base(n).mul(i.fill)) : cast<V3>(vec3(0, 0, 0));
    const hemi = cast<V3>(mix(groundC, skyC.add(around), n.y.mul(0.35).add(0.65)).mul(ao));
    const moon = cast<V3>(moonC.mul(ndl).mul(lit));
    let color: V3 = cast<V3>(i.albedo.mul(hemi.add(moon).add(lamps(i.world, n))));
    if (i.translucent) {
      const back = cast<F>(max(dot(v.negate(), moonDir), 0).pow(3));
      color = cast<V3>(color.add(i.albedo.mul(moonC).mul(back.mul(i.translucent).mul(lit).mul(1.6))));
    }
    const rough = i.roughness ?? cast<F>(float(0.8));
    const ndv = cast<F>(max(dot(n, v), 0));
    const fres = cast<F>(float(0.04).add(float(0.96).mul(pow(float(1).sub(ndv), 5))));
    const r = cast<V3>(reflect(v.negate(), n));
    const gloss = cast<F>(float(1).sub(rough).pow(2));
    const wet = i.wet ?? cast<F>(float(0));
    const env = fog.base(r);
    color = cast<V3>(color.add(env.mul(fres).mul(gloss.mul(0.7).add(wet.mul(0.6))).mul(ao)));
    const specMoon = cast<F>(pow(max(dot(r, moonDir), 0), gloss.mul(120).add(8)).mul(gloss.add(wet.mul(0.5))).mul(lit));
    color = cast<V3>(color.add(moonC.mul(specMoon).mul(0.8)));
    if (i.rim) {
      // Bright fog behind the silhouette wraps round its edges (back-lighting).
      const behind = fog.base(v.negate());
      const rim = cast<F>(pow(float(1).sub(ndv), 3).mul(i.rim));
      const toMoon = cast<F>(max(dot(v.negate(), moonDir), 0).pow(2).mul(1.5).add(0.5));
      color = cast<V3>(color.add(behind.mul(rim).mul(toMoon).mul(0.5)));
    }
    // Development views: 1 = moon shadow in red, 2 = clay (shape only).
    const clay = cast<V3>(vec3(0.55, 0.55, 0.58).mul(dot(n, normalize(vec3(-0.4, 0.8, 0.45))).max(0).mul(0.75).add(0.2)));
    color = cast<V3>(mix(color, vec3(sh, 0.02, 0.02), s.fog.debug.clamp(0, 1).mul(float(1).sub(s.fog.debug.sub(1).clamp(0, 1)))));
    color = cast<V3>(mix(color, clay, s.fog.debug.sub(1).clamp(0, 1)));
    if (i.noFog) return color;
    return fog.apply(color, i.world);
  };
  return { moonDir, shade };
}
