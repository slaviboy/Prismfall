import { LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, TextureLoader, Vector3, type Data3DTexture, type Node, type Texture } from 'three/webgpu';
import { abs, cameraPosition, clamp, dot, exp, float, length, mix, mx_noise_float, normalize, positionWorld, smoothstep, step, texture, uniform, vec3 } from 'three/tsl';
import { z, type EnvironmentContext, type GroundField } from '@prismfall/sdk';
import { cloudNoise } from './noise';

/**
 * State and lighting shared by The Warden's Spire components: where the Warden is and where its
 * beam points (written by the Warden every frame), its glow, the storm's lightning and the lava's
 * heat. Every material in the world lights itself from these uniforms, so the beam reveals the
 * land, the clouds and the architecture without adding lights to the scene.
 *
 * World space: the viewer's eye is at about (0, 1, 30.5) looking towards -Z; the board is at the
 * origin. The citadel stands to the right (about 30 degrees) and 1.25 km away.
 */

export type F = Node<'float'>;
export type V2 = Node<'vec2'>;
export type V3 = Node<'vec3'>;
export type V4 = Node<'vec4'>;

export const EYE: [number, number, number] = [0, 1, 30.5];
export const DEG = Math.PI / 180;

/** The citadel's site: view azimuth (degrees right of the view axis), distance from the eye, plateau height, turn. */
export const zSite = z
  .object({
    azimuth: z.number().default(30),
    distance: z.number().positive().default(1400),
    plateau: z.number().default(-44),
    /** Size of the citadel model (1 = as modelled in Blender). */
    scale: z.number().positive().default(0.8),
    /** Radius of the plateau it stands on (m). */
    radius: z.number().positive().default(300),
    /** Extra turn of the citadel about its axis (degrees; 0 = its gate faces the viewer). */
    yaw: z.number().default(-12),
  })
  .prefault({});
export type Site = z.infer<typeof zSite>;

/** The site's ground centre in world space. */
export function siteCentre(s: Site): [number, number, number] {
  const a = s.azimuth * DEG;
  return [EYE[0] + Math.sin(a) * s.distance, s.plateau, EYE[2] - Math.cos(a) * s.distance];
}

/** Turn (radians about +Y) that faces the citadel's front (Blender -Y = three +Z) towards the eye, plus the extra yaw. */
export function siteYaw(s: Site): number {
  const c = siteCentre(s);
  return Math.atan2(EYE[0] - c[0], EYE[2] - c[2]) + s.yaw * DEG;
}

/** Height of the Warden's cage centre above the plateau (assets/blender/scripts/spire_kit.py WARDEN_Z). */
export const WARDEN_HEIGHT = 395;

/**
 * How the site's tower model holds the Warden, in site units (the site `scale` turns them into
 * metres) in the model's own frame (origin at the centre of its base, gate towards +Z). The
 * citadel component publishes it for the Warden (its layer comes first in stage.json).
 */
export interface TowerFit {
  /** Height of the Warden's cage centre above the plateau. */
  readonly summit: number;
  /** Free radius around that point (the cage is shrunk to fit; Infinity = any size). */
  readonly cageRoom: number;
  /** Top of the tower's mass above a model-space ground point (-Infinity = open ground); for the beam's reach. */
  height(x: number, z: number): number;
}

/** The Blender citadel (spire_kit.py): the Warden in the open lantern, a stepped silhouette. */
export const CITADEL_FIT: TowerFit = {
  summit: WARDEN_HEIGHT,
  cageRoom: Infinity,
  height(x, z) {
    const r = Math.hypot(x, z);
    return r < 40 ? 358 : r < 95 ? 300 : r < 140 ? 96 : r < 230 ? 40 : -Infinity;
  },
};

/** A tower's fit from its GLB scene extras (`prismfall`, written by scripts/build-spire-tower.ts); null when it has none. */
export function towerFit(extras: unknown): TowerFit | null {
  const e = (extras as { prismfall?: { summit?: unknown; cageRoom?: unknown; heights?: { half?: unknown; n?: unknown; h?: unknown } } } | null)?.prismfall;
  if (!e || typeof e.summit !== 'number') return null;
  const g = e.heights;
  const half = typeof g?.half === 'number' ? g.half : 0;
  const n = typeof g?.n === 'number' ? g.n : 0;
  const h = Array.isArray(g?.h) && g.h.length === n * n ? (g.h as number[]) : null;
  return {
    summit: e.summit,
    cageRoom: typeof e.cageRoom === 'number' ? e.cageRoom : Infinity,
    height(x, z) {
      if (!h || half <= 0) return -Infinity;
      const i = Math.floor(((x + half) / (2 * half)) * n);
      const j = Math.floor(((z + half) / (2 * half)) * n);
      if (i < 0 || j < 0 || i >= n || j >= n) return -Infinity;
      const v = h[j * n + i] ?? 0;
      return v > 0 ? v : -Infinity;
    },
  };
}

/** A point at a view azimuth (degrees) and ground distance from the eye. */
export function polar(azimuth: number, distance: number): [number, number] {
  const a = azimuth * DEG;
  return [EYE[0] + Math.sin(a) * distance, EYE[2] - Math.cos(a) * distance];
}

const _u3 = () => uniform(new Vector3());
const _u1 = () => uniform(0);
type U3 = ReturnType<typeof _u3>;
type U1 = ReturnType<typeof _u1>;

export interface SpireShared {
  readonly u: {
    readonly core: U3;
    readonly beamOrigin: U3;
    readonly beamDir: U3;
    /** Tangent of the beam's half-angle. */
    readonly beamTan: U1;
    /** Beam brightness (0 = off). */
    readonly beamPower: U1;
    /** Distance along the beam to where it meets the land. */
    readonly beamReach: U1;
    /** The core's glow (about 1; higher focusing and awake). */
    readonly coreGlow: U1;
    /** Softening of the core's point light (m^2, about its radius squared): a smaller cage's fire lights what is close to it harder. */
    readonly coreSoft: U1;
    /** 0..1 awakening: the summit and the clouds light up. */
    readonly awaken: U1;
    /** Current lightning flash position and power. */
    readonly boltPos: U3;
    readonly boltPower: U1;
    /** Lava heat multiplier (about 1; brighter during big events). */
    readonly lavaHeat: U1;
  };
  /** CPU copies the Warden publishes for other components (sound, events). */
  readonly state: { heading: number; pitch: number; intensity: number; awaken: number; focus: number };
  /** Big moments (a QUAD, a perfect clear) the world answers: the time they happened. */
  readonly events: { volcano: number; stir: number };
  /** The Warden asks to be woken (QUAD/perfect clear stir it rarely). */
  wake: ((strength: number) => void) | null;
  /** Distance (m) from a ground point to the nearest lava channel's centre (set by the land). */
  riverDistance: ((x: number, z: number) => number) | null;
  /** The lava channels as a texture over the land (distance, flow, half-width) and its extent. */
  river: { tex: Texture; x0: number; z0: number; w: number; h: number } | null;
  noise: Promise<Data3DTexture> | null;
  /** The tower's fit (set by the citadel; the Warden falls back to CITADEL_FIT without one). */
  tower: TowerFit | null;
  readonly textures: Map<string, Promise<Texture | null>>;
  users: number;
}

const store = new WeakMap<GroundField, SpireShared>();

/** One shared state per built environment (each build has its own ground field). */
export function shared(ctx: EnvironmentContext): SpireShared {
  let s = store.get(ctx.ground);
  if (!s) {
    s = {
      u: {
        core: uniform(new Vector3(625, 355, -1052)),
        beamOrigin: uniform(new Vector3(625, 355, -1052)),
        beamDir: uniform(new Vector3(0.6, -0.3, -0.7).normalize()),
        beamTan: uniform(Math.tan(4 * DEG)),
        beamPower: uniform(0),
        beamReach: uniform(1500),
        coreGlow: uniform(1),
        coreSoft: uniform(900),
        awaken: uniform(0),
        boltPos: uniform(new Vector3(0, 600, -3000)),
        boltPower: uniform(0),
        lavaHeat: uniform(1),
      },
      state: { heading: 0, pitch: 0, intensity: 1, awaken: 0, focus: 0 },
      events: { volcano: -1e9, stir: -1e9 },
      wake: null,
      riverDistance: null,
      river: null,
      noise: null,
      tower: null,
      textures: new Map(),
      users: 0,
    };
    store.set(ctx.ground, s);
  }
  s.users++;
  return s;
}

/** Releases the shared textures when the last component of an environment is disposed. */
export function release(ctx: EnvironmentContext, s: SpireShared): void {
  s.users--;
  if (s.users > 0) return;
  for (const t of s.textures.values()) void t.then((tex) => tex?.dispose());
  s.textures.clear();
  store.delete(ctx.ground);
}

/** The tileable 3D cloud noise (shared). */
export function noise3D(s: SpireShared): Promise<Data3DTexture> {
  s.noise ??= cloudNoise(64);
  return s.noise;
}

/** Loads a stage texture once per environment: colour maps in sRGB, normal maps linear; tiling. */
export function stageTexture(ctx: EnvironmentContext, s: SpireShared, src: string, kind: 'color' | 'data'): Promise<Texture | null> {
  let t = s.textures.get(src);
  if (!t) {
    t = (async () => {
      const url = ctx.assets.url(src);
      if (!url) {
        console.warn(`[wardens-spire] texture ${src} not found`);
        return null;
      }
      const tex = await new TextureLoader().loadAsync(url);
      tex.wrapS = RepeatWrapping;
      tex.wrapT = RepeatWrapping;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.anisotropy = 8;
      if (kind === 'color') tex.colorSpace = SRGBColorSpace;
      return tex;
    })();
    s.textures.set(src, t);
  }
  return t;
}

// ------------------------------------------------------------------------------------------------
// Light
// ------------------------------------------------------------------------------------------------

/** Colours (linear) of the Warden's fire, its beam, the lightning and the lava's glow. */
export const COLORS = {
  core: vec3(1.0, 0.34, 0.08),
  coreHot: vec3(1.0, 0.72, 0.38),
  beam: vec3(1.0, 0.56, 0.26),
  bolt: vec3(0.6, 0.6, 0.88),
  lava: vec3(1.0, 0.22, 0.04),
};

/** 0 inside the clear zone around the board (seen from the eye), 1 outside; soft edge. */
export function clearMask(world: V3, inner = 21, outer = 27): F {
  const d = normalize(world.sub(vec3(...EYE)));
  return float(1).sub(smoothstep(Math.cos(outer * DEG), Math.cos(inner * DEG), d.z.negate())) as F;
}

/** The beam's strength at a world point (cone profile x falloff), before any surface term. */
export function beamField(s: SpireShared, world: V3): F {
  const u = s.u;
  const v = world.sub(u.beamOrigin);
  const along = dot(v, u.beamDir);
  const radial = length(v.sub(u.beamDir.mul(along)));
  const R = along.max(1).mul(u.beamTan).add(2.5);
  const x = radial.div(R);
  // A soft-edged cone with a hotter core; it fades past where it meets the land.
  const profile = exp(x.mul(x).mul(-2.2)).add(exp(x.mul(x).mul(-14)).mul(0.6));
  const reach = smoothstep(u.beamReach.mul(1.08), u.beamReach.mul(0.92), along).mul(step(0, along));
  const a9 = along.max(0).div(900);
  const fall = float(1).div(float(1).add(a9.mul(a9)));
  return profile.mul(reach).mul(fall).mul(u.beamPower) as F;
}

/**
 * Light falling on a surface at `world` with normal `n` from the Warden (its core and its beam)
 * and the lightning; multiply by the albedo. `rim` adds light to edges facing away from the
 * viewer when a flash is behind the surface (lightning outlining the architecture).
 */
export function spireLight(s: SpireShared, world: V3, n: V3, opts: { core?: number; beam?: number; bolt?: number; rim?: number } = {}): V3 {
  const u = s.u;
  const kc = opts.core ?? 1;
  const kb = opts.beam ?? 1;
  const kl = opts.bolt ?? 1;
  // Core: a point light (wrap lighting so the cage's inside faces glow), stronger when awake.
  const lc = u.core.sub(world);
  const dc2 = dot(lc, lc);
  const wc = clamp(dot(n, normalize(lc)).add(0.3).div(1.3), 0, 1);
  const coreAmount = u.coreGlow.mul(float(1).add(u.awaken.mul(1.6))).mul(9000 * kc).div(dc2.add(u.coreSoft));
  let light: V3 = COLORS.core.mul(coreAmount.mul(wc)) as V3;
  // Beam: a searchlight cone.
  const toOrigin = normalize(u.beamOrigin.sub(world));
  const wb = clamp(dot(n, toOrigin), 0, 1);
  light = light.add(COLORS.beam.mul(beamField(s, world).mul(wb).mul(3.2 * kb)).mul(clearMask(world))) as V3;
  // Lightning: a distant flash in the clouds.
  const lb = u.boltPos.sub(world);
  const db2 = dot(lb, lb);
  const ldir = normalize(lb);
  const wl = clamp(dot(n, ldir).add(0.5).div(1.5), 0, 1);
  let boltAmount = u.boltPower.mul(2.6e6 * kl).div(db2.add(2.5e5)).mul(wl);
  if (opts.rim) {
    const view = normalize(world.sub(cameraPosition));
    const behind = clamp(dot(ldir, view), 0, 1);
    const edge = float(1).sub(abs(dot(n, view.negate()))).pow(2);
    boltAmount = boltAmount.add(u.boltPower.mul(2.6e6 * kl * opts.rim).div(db2.add(2.5e5)).mul(edge).mul(behind));
  }
  return light.add(COLORS.bolt.mul(boltAmount)) as V3;
}

/** Where the last dusk glow lies: low on the horizon, a little right of the view axis. */
export const HORIZON_DIR = vec3(0.15, 0.07, -1).normalize();

/**
 * The world's own light (it does not use the scene's key light, which is for the board): a dim
 * red sky from the storm deck above, red bounce from the lava-lit ground below, the dusk glow on
 * the horizon behind everything (rim light on crests and edges), and glints of it in glassy rock.
 */
export function duskLight(world: V3, n: V3, opts: { k?: number; glint?: F | number; back?: number } = {}): V3 {
  const k = opts.k ?? 1;
  const up = n.y.mul(0.5).add(0.5);
  const sky = vec3(0.2, 0.11, 0.1).mul(up);
  const ground = vec3(0.13, 0.045, 0.02).mul(float(1).sub(up));
  const back = clamp(dot(n, HORIZON_DIR).add(0.2).div(1.2), 0, 1).pow(1.6).mul(1.3 * (opts.back ?? 1));
  let light: V3 = sky.add(ground).add(vec3(1.0, 0.45, 0.22).mul(back)) as V3;
  if (opts.glint) {
    const view = normalize(world.sub(cameraPosition));
    const r = view.sub(n.mul(dot(view, n).mul(2)));
    const g = clamp(dot(r, HORIZON_DIR), 0, 1).pow(24).mul(opts.glint);
    light = light.add(vec3(1.0, 0.5, 0.25).mul(g.mul(6))) as V3;
  }
  return light.mul(k) as V3;
}

/** Red light from the lava-lit land below: strongest on faces turned down, fading with height. */
export function lavaUplight(s: SpireShared, world: V3, n: V3, ground: number, strength = 1): V3 {
  const down = clamp(n.y.negate(), 0, 1).mul(0.6).add(0.4);
  const height = exp(world.y.sub(ground).max(0).div(-220));
  return COLORS.lava.mul(down.mul(height).mul(s.u.lavaHeat).mul(0.09 * strength)) as V3;
}

// ------------------------------------------------------------------------------------------------
// Texturing
// ------------------------------------------------------------------------------------------------

/** Blend weights for triplanar mapping (sharpened). */
function triWeights(n: V3): V3 {
  const a = abs(n).pow(vec3(4, 4, 4));
  return a.div(a.x.add(a.y).add(a.z).max(1e-4)) as V3;
}

/** Triplanar colour from a tiling texture (`scale` = repeats per metre). */
export function triplanar(tex: Texture, p: V3, n: V3, scale: number | F): V3 {
  const w = triWeights(n);
  const sc = typeof scale === 'number' ? float(scale) : scale;
  const x = texture(tex, p.zy.mul(sc)).rgb;
  const y = texture(tex, p.xz.mul(sc)).rgb;
  const zz = texture(tex, p.xy.mul(sc)).rgb;
  return x.mul(w.x).add(y.mul(w.y)).add(zz.mul(w.z)) as V3;
}

/** Biplanar-cheap variant: top-down and the dominant side only (low detail settings). */
export function duoplanar(tex: Texture, p: V3, n: V3, scale: number): V3 {
  const side = step(abs(n.z), abs(n.x));
  const top = smoothstep(0.45, 0.75, abs(n.y));
  const s = mix(texture(tex, p.xy.mul(scale)).rgb, texture(tex, p.zy.mul(scale)).rgb, side);
  return mix(s, texture(tex, p.xz.mul(scale)).rgb, top) as V3;
}

/** Triplanar normal mapping (whiteout blend) of an OpenGL normal map; returns a world normal. */
export function triplanarNormal(tex: Texture, p: V3, n: V3, scale: number | F, strength = 1): V3 {
  const w = triWeights(n);
  const sc = typeof scale === 'number' ? float(scale) : scale;
  const k = float(strength);
  const tx = texture(tex, p.zy.mul(sc)).rgb.mul(2).sub(1);
  const ty = texture(tex, p.xz.mul(sc)).rgb.mul(2).sub(1);
  const tz = texture(tex, p.xy.mul(sc)).rgb.mul(2).sub(1);
  const nx = vec3(tx.x.mul(k).add(n.z), tx.y.mul(k).add(n.y), abs(tx.z).mul(n.x));
  const ny = vec3(ty.x.mul(k).add(n.x), ty.y.mul(k).add(n.z), abs(ty.z).mul(n.y));
  const nz = vec3(tz.x.mul(k).add(n.x), tz.y.mul(k).add(n.y), abs(tz.z).mul(n.z));
  return normalize(vec3(nx.z, nx.y, nx.x).mul(w.x).add(vec3(ny.x, ny.z, ny.y).mul(w.y)).add(nz.mul(w.z))) as V3;
}

/** Large-scale value variation that breaks up texture tiling (0.6..1.25). */
export function macro(p: V3, scale = 0.004): F {
  const a = mx_noise_float(p.mul(scale)).mul(0.5).add(0.5);
  const b = mx_noise_float(p.mul(scale * 3.7).add(vec3(3.1, 1.7, 5.3))).mul(0.5).add(0.5);
  return float(0.6).add(a.mul(0.45)).add(b.mul(0.2)) as F;
}

/** The world appears outward from the viewer during crossfades (opaque parts, alphaTest 0.5). */
export function revealMask(presence: F, reach = 2200): F {
  const dist = length(positionWorld.sub(cameraPosition));
  const edge = mx_noise_float(positionWorld.mul(0.02)).mul(0.08);
  const front = smoothstep(0, 1, presence).mul(1.12);
  return step(dist.div(reach).add(edge).add(float(0.02)), front) as F;
}

/** Cheap hash of a float into 0..1. */
export function hash(seed: F, k: number): F {
  return seed.mul(k).add(k * 0.618).sin().mul(43758.5453).fract() as F;
}

export function lum(c: V3): F {
  return dot(c, vec3(0.2126, 0.7152, 0.0722)) as F;
}

