import { Vector3, type Data3DTexture, type DataTexture } from 'three/webgpu';
import { cameraPosition, dot, exp, float, floor, fract, int, length, log, max, pow, screenCoordinate, smoothstep, texture3D, uniform, vec2, vec3 } from 'three/tsl';
import { EYE, FLOOR } from './terrain';
import { backdropSampler, cast, MAX_LIGHTS, MAX_POCKETS, moonDirection, type F, type V3, type V4, type VeilShared } from './shared';
import type { ShadowMaps } from './shadow';

/**
 * The Veil's fog: one density field and one lighting model, integrated along view rays.
 *
 * Density is three height layers over a smooth "fog floor" (ground mist hugging the lowland, a
 * dense mid layer from about 40 m out, deep banks from about 200 m out) shaped by a tiling 3D
 * noise volume at two scales that drift with the wind, plus a thin haze; local pockets (thicker or
 * clearer spheres, some stretched into banks) are where the director's events live.
 *
 * Light: the fog's colour in each direction is the photo's own horizon there, so distant fog meets
 * the panorama seamlessly. Part of that light is moonlight, which the creature and tree shadow maps
 * remove where the moonlight is blocked; it is boosted towards the moon (forward scattering), so
 * shadow volumes read most strongly against the bright side of the sky. A few warm local lights
 * add in-scattering halos.
 *
 * Integration is segmented: nested shells around the camera each march the stretch of ray between
 * the previous shell and their own radius (depth-tested against the scene, so trees and ruins cut
 * the fog correctly), and every opaque surface in the world marches the last stretch from the
 * shell inside it to itself. Together they integrate every view ray end to end.
 */

export interface FogQuality {
  readonly shells: number;
  readonly steps: number;
  readonly r0: number;
  readonly growth: number;
  /** Shadow samples in the fog volume. */
  readonly shadows: boolean;
}

export function fogQuality(detail: 'low' | 'medium' | 'high' | 'ultra'): FogQuality {
  switch (detail) {
    case 'low':
      return { shells: 7, steps: 2, r0: 14, growth: 2.05, shadows: false };
    case 'medium':
      return { shells: 9, steps: 2, r0: 13, growth: 1.75, shadows: true };
    case 'high':
      return { shells: 10, steps: 3, r0: 12, growth: 1.66, shadows: true };
    default:
      return { shells: 11, steps: 3, r0: 12, growth: 1.58, shadows: true };
  }
}

export interface FogModel {
  readonly q: FogQuality;
  /** Outer radius of shell i. */
  radius(i: number): number;
  /** Fog colour for a view direction (the photo's horizon there). */
  base(dir: V3): V3;
  density(p: V3): F;
  radiance(p: V3, dir: V3, base: V3): V3;
  /** Integrates [t0, t1] along o + d t: in-scattered colour and transmittance. */
  integrate(o: V3, d: V3, t0: F, t1: F, steps: number, base: V3): { color: V3; trans: F };
  /** Applies the fog between the last shell in front of a surface point and the point. */
  apply(color: V3, world: V3): V3;
  /** Transmittance only (for additive light that should fade into the fog). */
  transmittanceTo(world: V3): F;
}

/** Interleaved gradient noise in 0..1 from the pixel position (a fixed dither for the march). */
function ign(): F {
  return cast<F>(fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))))));
}

export function createFogModel(s: VeilShared, noise: Data3DTexture, backdropTex: DataTexture | null, exposure: number, shadows: ShadowMaps | null, q: FogQuality): FogModel {
  const f = s.fog;
  const moon = moonDirection();
  const moonU = uniform(moon);
  const eye = vec3(EYE.x, EYE.y, EYE.z);
  const board = new Vector3(0, 0, 0).sub(new Vector3(EYE.x, EYE.y, EYE.z)).normalize();
  const boardDir = vec3(board.x, board.y, board.z);
  const backdrop = backdropSampler(backdropTex, exposure);
  const radius = (i: number) => q.r0 * Math.pow(q.growth, i);

  const fogFloor = (p: V3): F => {
    const dxz = cast<V3>(p.sub(eye));
    const d = length(vec2(dxz.x, dxz.z));
    return cast<F>(float(FLOOR).add(exp(d.div(26).pow(2).negate()).mul(13.9)));
  };

  const pocketFactor = (p: V3): F => {
    let sum: F = cast<F>(float(0));
    for (let i = 0; i < MAX_POCKETS; i++) {
      const c = cast<V4>(f.pocketPos.element(int(i)));
      const a = cast<V4>(f.pocketAmt.element(int(i)));
      const rel = cast<V3>(p.sub(c.xyz));
      const stretched = vec3(rel.x.div(a.z), rel.y.mul(1.6), rel.z);
      const d = length(stretched);
      const fall = smoothstep(c.w, c.w.mul(a.y), d);
      sum = cast<F>(sum.add(a.x.mul(fall)));
    }
    return cast<F>(max(float(0), float(1).add(sum)));
  };

  /** Keeps the fog off the playfield: none in front of the board, thinner just behind it. */
  const coneFactor = (p: V3): F => {
    const rel = cast<V3>(p.sub(eye));
    const dist = length(rel);
    const cosA = dot(rel.div(dist.max(0.001)), boardDir);
    const inside = smoothstep(0.92, 0.955, cosA);
    const near = smoothstep(52, 34, dist).mul(0.8);
    return cast<F>(float(1).sub(inside.mul(near)).mul(float(1).sub(inside.mul(0.3))));
  };

  const density = (p: V3): F => {
    const h = cast<F>(p.y.sub(fogFloor(p)).max(-2));
    const rel = cast<V3>(p.sub(eye));
    const dist = length(vec2(rel.x, rel.z));
    const a = texture3D(noise, p.add(f.wind).div(260));
    const b = texture3D(noise, p.add(f.windFine).div(46));
    const bank = cast<F>(a.r.mul(0.62).add(a.g.mul(0.38)));
    const billow = cast<F>(b.b.mul(0.55).add(b.a.mul(0.45)));
    const n = cast<F>(bank.mul(0.62).add(billow.mul(0.38)));
    const ground = cast<F>(exp(h.max(0).div(2.8).negate()).mul(0.07).mul(smoothstep(0.3, 0.68, n.mul(0.85).add(0.15))));
    const mid = cast<F>(exp(h.max(0).div(22).negate()).mul(0.0062).mul(smoothstep(0.4, 0.78, n)).mul(smoothstep(65, 190, dist)));
    const deep = cast<F>(exp(h.max(0).div(80).negate()).mul(0.0036).mul(smoothstep(0.28, 0.78, bank).mul(0.8).add(0.2)).mul(smoothstep(170, 640, dist)));
    const haze = cast<F>(exp(h.max(0).div(150).negate()).mul(0.0011).add(exp(h.max(0).div(240).negate()).mul(0.0017).mul(smoothstep(650, 1500, dist))));
    return cast<F>(ground.add(mid).add(deep).add(haze).mul(pocketFactor(p)).mul(f.density).mul(coneFactor(p)));
  };

  const lightsAt = (p: V3): V3 => {
    let sum: V3 = cast<V3>(vec3(0, 0, 0));
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const lp = cast<V4>(f.lightPos.element(int(i)));
      const lc = cast<V4>(f.lightCol.element(int(i)));
      const d = cast<V3>(lp.xyz.sub(p));
      sum = cast<V3>(sum.add(lc.rgb.mul(lp.w).mul(0.5).div(dot(d, d).add(9))));
    }
    return sum;
  };

  /** Light reaching a point through the banks between it and the moon (lit tops, dim undersides). */
  const bankLight = (p: V3): F => {
    if (!q.shadows || q.steps < 3) return cast<F>(float(1));
    const probe = cast<V3>(p.add(moonU.mul(35)));
    const a = texture3D(noise, probe.add(f.wind).div(260));
    const bank = cast<F>(a.r.mul(0.62).add(a.g.mul(0.38)));
    const h = cast<F>(probe.y.sub(fogFloor(probe)).max(0));
    const thick = cast<F>(smoothstep(0.38, 0.8, bank).mul(exp(h.div(30).negate())).mul(f.density));
    return cast<F>(exp(thick.mul(-1.6)));
  };

  const radiance = (p: V3, dir: V3, base: V3): V3 => {
    const cosT = dot(dir, moonU);
    // Forward scattering towards the moon: the shadowed part of the light is strongest there.
    const fwd = cast<F>(pow(max(cosT, 0), 5).mul(0.9).add(pow(max(cosT, 0), 40).mul(1.4)));
    const shade = shadows && q.shadows ? shadows.sample(p, 1.6, 0.6) : cast<F>(float(0));
    const moonPart = cast<F>(f.moon.mul(float(1).sub(shade)).mul(bankLight(p)).mul(float(0.75).add(fwd.mul(f.backlight))));
    const amb = cast<F>(float(1).sub(f.moon));
    const lit = cast<V3>(base.mul(amb.add(moonPart)));
    return cast<V3>(lit.add(lightsAt(p)).add(base.mul(f.flare.mul(0.6))));
  };

  const integrate = (o: V3, d: V3, t0: F, t1: F, steps: number, base: V3): { color: V3; trans: F } => {
    const len = cast<F>(t1.sub(t0).max(0));
    const dt = cast<F>(len.div(steps));
    const jitter = ign();
    let color: V3 = cast<V3>(vec3(0, 0, 0));
    let trans: F = cast<F>(float(1));
    for (let i = 0; i < steps; i++) {
      const t = cast<F>(t0.add(dt.mul(float(i).add(jitter))));
      const p = cast<V3>(o.add(d.mul(t)));
      const sigma = density(p);
      const ti = cast<F>(exp(sigma.mul(dt).negate()));
      color = cast<V3>(color.add(radiance(p, d, base).mul(trans.mul(float(1).sub(ti)))));
      trans = cast<F>(trans.mul(ti));
    }
    return { color, trans };
  };

  const base = (dir: V3): V3 => {
    const elev = cast<F>(dir.y.clamp(-1, 1).asin().mul(180 / Math.PI).clamp(0.6, 14));
    return backdrop.at(backdrop.turnOf(dir), elev);
  };

  /** Radius of the last shell boundary in front of a point at distance `dist` from the camera. */
  const innerRadius = (dist: F): F => {
    const k = cast<F>(floor(log(dist.div(q.r0)).div(Math.log(q.growth))).clamp(-1, q.shells - 1));
    return cast<F>(k.lessThan(0).select(float(0), float(q.r0).mul(pow(float(q.growth), k))));
  };

  const apply = (color: V3, world: V3): V3 => {
    const rel = cast<V3>(world.sub(cameraPosition));
    const dist = cast<F>(length(rel));
    const dir = cast<V3>(rel.div(dist.max(1e-3)));
    const t0 = innerRadius(dist);
    const seg = integrate(cameraPosition as unknown as V3, dir, t0, dist, Math.max(2, q.steps - 1), base(dir));
    return cast<V3>(color.mul(seg.trans).add(seg.color));
  };

  const transmittanceTo = (world: V3): F => {
    // Cheap estimate: the haze and mid layers along the straight path (no marching).
    const rel = cast<V3>(world.sub(cameraPosition));
    const dist = length(rel);
    return cast<F>(exp(dist.mul(0.0042).mul(f.density).negate()));
  };

  return { q, radius, base, density, radiance, integrate, apply, transmittanceTo };
}
