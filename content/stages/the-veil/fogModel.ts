import { Vector3, type Data3DTexture, type DataTexture } from 'three/webgpu';
import { cameraPosition, dot, exp, float, floor, fract, int, length, log, max, mix, pow, screenCoordinate, sin, smoothstep, texture3D, uniform, vec2, vec3 } from 'three/tsl';
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

/** One point of the mist: extinction, how much of it is a thin fringe, and the far veil's share. */
export interface FogSample {
  readonly sigma: F;
  /** 0..1: thin, wispy fringe (where a moon-backlit silver lining shows). */
  readonly edge: F;
  /** 0..1: share of the low far veil (its own, slightly lavender tint). */
  readonly sheet: F;
}

export interface FogModel {
  readonly q: FogQuality;
  /** Outer radius of shell i. */
  radius(i: number): number;
  /** Fog colour for a view direction (the photo's horizon there). */
  base(dir: V3): V3;
  density(p: V3): F;
  sample(p: V3): FogSample;
  /** Light scattered towards the eye at `p`; `t` is the distance along the ray (layer tints). */
  radiance(p: V3, dir: V3, base: V3, edge?: F, t?: F, sheet?: F, lights?: number): V3;
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

/** A per-pixel hash in 0..1: mixed into the dither so its diagonal lines do not show. */
function hash(): F {
  return cast<F>(fract(sin(dot(floor(screenCoordinate.xy), vec2(12.9898, 78.233))).mul(43758.5453)));
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

  /**
   * The mist's structure. Banks and the billows on them come from a 3D noise at two scales; the
   * fine one is domain-warped by the coarse one, so wisps curl and shear past the banks instead of
   * sliding along with them. Layers, from the ground up:
   *  - ground mist hugging the water, its top rolling, flowing in patches that thin and thicken;
   *  - mid-distance banks with soft, billowing tops near eye height (some you see over, some not);
   *  - deep banks further out, taller;
   *  - a low far veil lying over the lowland (seen from above, a layer of its own colour);
   *  - a thin haze, thickening towards the horizon so the panorama's ranges fade softly.
   */
  const sample = (p: V3): FogSample => {
    const h = cast<F>(p.y.sub(fogFloor(p)).max(-2));
    const rel = cast<V3>(p.sub(eye));
    const dist = length(vec2(rel.x, rel.z));
    const a = texture3D(noise, p.add(f.wind).div(260));
    const warp = cast<V3>(vec3(a.b.sub(0.5), a.a.sub(0.5).mul(0.35), a.g.sub(0.5)).mul(40));
    const b = texture3D(noise, p.add(f.windFine).add(warp).div(46));
    const bank = cast<F>(a.r.mul(0.62).add(a.g.mul(0.38)));
    // Fine billows only where the march resolves them: far off they would just be noise.
    const billow = cast<F>(mix(float(0.5), b.b.mul(0.55).add(b.a.mul(0.45)), smoothstep(620, 260, dist)));
    const n = cast<F>(bank.mul(0.62).add(billow.mul(0.38)));
    // Crisp bank edges close by; far off (samples 70-150 m apart) softer, or they alias into grain.
    const far = cast<F>(smoothstep(240, 700, dist));
    const soft = (lo: number, hi: number, loFar: number, hiFar: number, x: F): F => cast<F>(smoothstep(mix(float(lo), float(loFar), far), mix(float(hi), float(hiFar), far), x));
    const patch = cast<F>(a.g.mul(0.5).add(b.r.mul(0.3)).add(bank.mul(0.2)));
    const hg = cast<F>(h.sub(billow.sub(0.5).mul(2.4)).max(0));
    const ground = cast<F>(exp(hg.div(2.8).negate()).mul(0.085).mul(smoothstep(0.42, 0.58, patch)));
    const top = cast<F>(float(3).add(soft(0.4, 0.64, 0.3, 0.75, bank).mul(26)).add(billow.mul(3)));
    const below = cast<F>(smoothstep(top.add(1.5), top.sub(10), h));
    const mid = cast<F>(below.mul(exp(h.max(0).div(40).negate()).mul(0.6).add(0.4)).mul(0.012).mul(soft(0.45, 0.6, 0.32, 0.74, n)).mul(smoothstep(60, 185, dist)));
    const top2 = cast<F>(float(14).add(soft(0.38, 0.64, 0.28, 0.76, bank).mul(56)).add(billow.mul(4)));
    const deep = cast<F>(smoothstep(top2.add(4), top2.sub(22), h).mul(0.0046).mul(soft(0.42, 0.6, 0.28, 0.76, bank).mul(0.88).add(0.12)).mul(smoothstep(170, 640, dist)));
    const hs = cast<F>(float(5).add(bank.sub(0.5).mul(8)));
    const dh = cast<F>(h.sub(hs).div(5.5));
    const sheet = cast<F>(exp(dh.mul(dh).negate()).mul(0.0026).mul(smoothstep(230, 520, dist)).mul(smoothstep(0.22, 0.6, n)));
    const haze = cast<F>(exp(h.max(0).div(150).negate()).mul(0.0011).add(exp(h.max(0).div(240).negate()).mul(0.0017).mul(smoothstep(650, 1500, dist))));
    const k = cast<F>(pocketFactor(p).mul(f.density).mul(coneFactor(p)));
    const body = cast<F>(ground.add(mid).add(deep).add(sheet).mul(k));
    const sigma = cast<F>(body.add(haze.mul(k)));
    // Fringes: thin mist (not the haze) on its way in or out of a bank or billow.
    const edge = cast<F>(smoothstep(0.0001, 0.0016, body).mul(smoothstep(0.012, 0.0025, body)));
    return { sigma, edge, sheet: cast<F>(sheet.mul(k).div(sigma.max(1e-5)).clamp(0, 1)) };
  };
  const density = (p: V3): F => sample(p).sigma;

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
    const thick = cast<F>(smoothstep(0.36, 0.8, bank).mul(exp(h.div(30).negate())).mul(f.density));
    return cast<F>(exp(thick.mul(-2.1)));
  };

  /** Layered veils: cool and blue close by, the photo's own grey in the middle, silvered far off. */
  const tint = (t: F, sheet: F): V3 => {
    const nearFar = cast<V3>(mix(vec3(0.94, 0.985, 1.05), vec3(1, 1, 1), smoothstep(30, 220, t)));
    const far = cast<V3>(mix(nearFar, vec3(1.035, 0.995, 1.03), smoothstep(380, 1100, t)));
    return cast<V3>(mix(far, vec3(1.02, 0.975, 1.09), sheet));
  };

  const radiance = (p: V3, dir: V3, base: V3, edge?: F, t?: F, sheet?: F, lights = 1): V3 => {
    const cosT = dot(dir, moonU);
    const c = cast<F>(max(cosT, 0));
    // Forward scattering towards the moon: the shadowed part of the light is strongest there.
    const fwd = cast<F>(pow(c, 6).mul(1.0).add(pow(c, 48).mul(1.7)));
    const shade = shadows && q.shadows ? shadows.sampleFog(p) : cast<F>(float(0));
    let moonPart = cast<F>(f.moon.mul(float(1).sub(shade)).mul(bankLight(p)).mul(float(0.72).add(fwd.mul(f.backlight))));
    // Silver lining: thin fringes lit from behind by the moon glow brighter than the cores.
    if (edge) moonPart = cast<F>(moonPart.mul(float(1).add(edge.mul(pow(c, 3).mul(0.55).add(pow(c, 16).mul(0.6))).mul(f.silver))));
    const amb = cast<F>(float(1).sub(f.moon));
    const col = t ? cast<V3>(base.mul(tint(t, sheet ?? cast<F>(float(0))))) : base;
    const lit = cast<V3>(col.mul(amb.add(moonPart)));
    return cast<V3>(lit.add(lights === 1 ? lightsAt(p) : lightsAt(p).mul(lights)).add(col.mul(f.flare.mul(0.6))));
  };

  const integrate = (o: V3, d: V3, t0: F, t1: F, steps: number, base: V3): { color: V3; trans: F } => {
    const len = cast<F>(t1.sub(t0).max(0));
    const dt = cast<F>(len.div(steps));
    // The dither differs per shell (by its start radius), so shells do not line up into hatching.
    const jitter = cast<F>(fract(ign().add(hash().mul(0.22)).add(t0.mul(0.0137))));
    let color: V3 = cast<V3>(vec3(0, 0, 0));
    let trans: F = cast<F>(float(1));
    for (let i = 0; i < steps; i++) {
      const t = cast<F>(t0.add(dt.mul(float(i).add(jitter))));
      const p = cast<V3>(o.add(d.mul(t)));
      const m = sample(p);
      const ti = cast<F>(exp(m.sigma.mul(dt).negate()));
      color = cast<V3>(color.add(radiance(p, d, base, m.edge, t, m.sheet).mul(trans.mul(float(1).sub(ti)))));
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

  return { q, radius, base, density, sample, radiance, integrate, apply, transmittanceTo };
}
