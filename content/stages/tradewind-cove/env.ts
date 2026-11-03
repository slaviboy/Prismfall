import { LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, TextureLoader, Vector4, type Node, type Texture } from 'three/webgpu';
import { asin, atan, clamp, float, max, mix, mx_noise_float, sin, smoothstep, texture, uniform, vec2, vec3 } from 'three/tsl';
import { z, type EnvironmentContext } from '@prismfall/sdk';

/**
 * Shared pieces of Tradewind Cove: the photograph's sun, the photographic environment map used for
 * water reflections and sky light, the trade-wind field that moves the palms and ruffles the
 * lagoon, and the palm shadows the shore receives. Everything is world space; the viewer stands at
 * about (0, 1, 30) looking towards -Z.
 */

export type F = Node<'float'>;
export type V2 = Node<'vec2'>;
export type V3 = Node<'vec3'>;
export type Vec3 = [number, number, number];

const DEG = Math.PI / 180;

/** A direction as the player sees it: degrees right of the view axis (-Z) and degrees up. */
export const zSkyDirection = z.object({ azimuth: z.number(), elevation: z.number() });

/** Unit vector for an azimuth (degrees right of -Z) and an elevation (degrees up). */
export function skyDirection(azimuth: number, elevation: number): Vec3 {
  const a = azimuth * DEG;
  const e = elevation * DEG;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

/** The equirectangular photo the sky shows, as a full-sphere environment (same turn as the sky's panorama). */
export const zEnvironment = z.object({
  /** Full-sphere copy of the panorama (elevations -90..90), small: reflections and sky light only. */
  src: z.string(),
  /** The sky panorama's `offset` (fraction of a turn that faces the board). */
  offset: z.number().default(0),
  exposure: z.number().min(0).default(1),
});
export type Environment = z.infer<typeof zEnvironment>;

/** Loads a stage texture: colour images in sRGB, data (normal maps) linear; both tile horizontally. */
export async function loadTexture(ctx: EnvironmentContext, src: string, kind: 'color' | 'data'): Promise<Texture | null> {
  const url = ctx.assets.url(src);
  if (!url) {
    console.warn(`[tradewind-cove] texture ${src} not found`);
    return null;
  }
  const tex = await new TextureLoader().loadAsync(url);
  tex.minFilter = LinearMipmapLinearFilter;
  tex.anisotropy = 8;
  tex.wrapS = RepeatWrapping;
  if (kind === 'data') tex.wrapT = RepeatWrapping;
  else tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Samples the environment photo in a world direction; `level` picks a blurrier mip (sky light). */
export function sampleEnvironment(tex: Texture, dir: V3, env: Environment, level: number | null = null): V3 {
  const d = dir.normalize();
  const turn = atan(d.x, d.z.negate()).div(Math.PI * 2).add(env.offset);
  const v = asin(clamp(d.y, -1, 1)).div(Math.PI).add(0.5);
  const node = texture(tex, vec2(turn, v));
  return (level === null ? node : node.level(float(level))).rgb.mul(env.exposure) as V3;
}

/** As sampleEnvironment, with a mip level computed in the shader (blur that grows with distance). */
export function sampleEnvironmentLevel(tex: Texture, dir: V3, env: Environment, level: number | F): V3 {
  const d = dir.normalize();
  const turn = atan(d.x, d.z.negate()).div(Math.PI * 2).add(env.offset);
  const v = asin(clamp(d.y, -1, 1)).div(Math.PI).add(0.5);
  return texture(tex, vec2(turn, v)).level(typeof level === 'number' ? float(level) : level).rgb.mul(env.exposure) as V3;
}

/** The trade wind: a steady breeze with gusts that travel across the cove downwind. */
export const zWind = z.object({
  /** Where the wind blows towards, in degrees (as `azimuth`: 0 = away from the viewer, 90 = to the right). */
  toward: z.number().default(-120),
  /** Overall strength (0 calm .. 1 a fresh trade wind). Bindable as `wind`. */
  strength: z.number().min(0).max(2).default(0.6),
  /** How much stronger the wind gets inside a gust front. */
  gust: z.number().min(0).max(2).default(0.7),
  /** Speed of the gust fronts (m/s) and the distance between them (m). */
  gustSpeed: z.number().positive().default(9),
  gustSpacing: z.number().positive().default(70),
});
export type Wind = z.infer<typeof zWind>;

/** Horizontal unit vector the wind blows towards. */
export function windVector(w: Wind): [number, number] {
  const d = skyDirection(w.toward, 0);
  return [d[0], d[2]];
}

/**
 * Wind strength at a point and time: a steady part plus gust fronts that sweep downwind, broken
 * up across the wind so neighbouring palms catch each gust at slightly different moments.
 */
export function windField(xz: V2, time: F, w: Wind, strength: F): F {
  const [wx, wz] = windVector(w);
  const along = xz.x.mul(wx).add(xz.y.mul(wz));
  const across = xz.x.mul(-wz).add(xz.y.mul(wx));
  const k = (Math.PI * 2) / w.gustSpacing;
  const front = along.sub(time.mul(w.gustSpeed)).mul(k).add(mx_noise_float(vec3(across.mul(0.012), time.mul(0.05), 3.7)).mul(2.2));
  const gust = smoothstep(0.25, 0.95, sin(front).mul(0.5).add(0.5)).mul(sin(time.mul(0.071).add(1.3)).mul(0.3).add(0.7));
  return strength.mul(float(1).add(gust.mul(w.gust)));
}

/**
 * Palm shadows on the shore and the lagoon floor. The palms publish their nearest trunks and
 * crowns here when they are built; the shore and the lagoon read them. One Tradewind Cove exists
 * at a time, so module-level uniforms are enough.
 */
export const SHADOW_CASTERS = 8;
export const shadowCasters = Array.from({ length: SHADOW_CASTERS }, () => ({
  /** Crown centre (xyz) and radius (w; 0 = unused). */
  crown: uniform(new Vector4(0, -1000, 0, 0)),
  /** Trunk base (xyz) and trunk radius (w). */
  base: uniform(new Vector4(0, -1000, 0, 0)),
}));
export const shadowTime = uniform(0);

/**
 * How much sunlight reaches a point (1 = full sun) under the published palms: each crown throws a
 * ragged, rayed shadow (fronds with gaps between the leaflets) and each trunk a narrow band.
 */
export function palmShade(p: V3, sun: Vec3): F {
  const lx = sun[0] / sun[1];
  const lz = sun[2] / sun[1];
  let light: F = float(1);
  for (const c of shadowCasters) {
    const cr = c.crown;
    const b = c.base;
    // Crown: project the point up the sun ray to the crown's height and compare with the crown.
    const rise = cr.y.sub(p.y);
    const q = vec2(p.x.add(rise.mul(lx)), p.z.add(rise.mul(lz))).sub(vec2(cr.x, cr.z));
    const d = q.length();
    const ang = atan(q.y, q.x);
    // About a dozen fronds radiate from a dense core; light gets through between the leaflets
    // towards the frond tips.
    const radial = d.div(cr.w.max(0.01));
    const rays = sin(ang.mul(13).add(sin(ang.mul(5).add(cr.w)).mul(1.6)).add(shadowTime.mul(0.15))).mul(0.5).add(0.5);
    const rays2 = sin(ang.mul(7).add(cr.w.mul(2.3)).sub(shadowTime.mul(0.1))).mul(0.5).add(0.5);
    const frondMask = smoothstep(0.42, 0.6, max(rays, rays2.mul(0.85)));
    const gaps = sin(q.x.mul(5.1).add(sin(q.y.mul(3.7)).mul(1.3))).mul(sin(q.y.mul(4.3).add(sin(q.x.mul(2.9)).mul(1.3)))).mul(0.5).add(0.5);
    const leafy = mix(float(1), smoothstep(0.2, 0.55, gaps), smoothstep(0.3, 0.85, radial));
    const core = smoothstep(0.24, 0.1, radial);
    const fronds = frondMask.mul(smoothstep(1, 0.72, radial)).mul(leafy);
    const crown = clamp(core.add(fronds), 0, 1).mul(0.74).mul(cr.w.greaterThan(0).select(float(1), float(0)));
    // Trunk: distance to the segment between the base's and the crown's shadows on this plane
    // (a point X casts its shadow at X.xz - L.xz / L.y * (X.y - p.y)).
    const b0 = vec2(b.x, b.z).sub(vec2(lx, lz).mul(b.y.sub(p.y)));
    const t0 = vec2(cr.x, cr.z).sub(vec2(lx, lz).mul(rise));
    const seg = t0.sub(b0);
    const h = clamp(vec2(p.x, p.z).sub(b0).dot(seg).div(seg.dot(seg).max(1e-4)), 0, 0.92);
    const dt = vec2(p.x, p.z).sub(b0.add(seg.mul(h))).length();
    const trunk = smoothstep(b.w.mul(1.3), b.w.mul(0.8), dt).mul(0.6).mul(b.w.greaterThan(0).select(float(1), float(0)));
    light = light.mul(float(1).sub(crown.max(trunk)));
  }
  return light;
}
