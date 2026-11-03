import {
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  DirectionalLight,
  HemisphereLight,
  EquirectangularReflectionMapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardNodeMaterial,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  TextureLoader,
  UnsignedByteType,
  Vector3,
  Vector4,
  type Node,
  type Texture,
} from 'three/webgpu';
import {
  abs,
  asin,
  atan,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  dot,
  exp,
  float,
  int,
  length,
  lights,
  mix,
  mrt,
  mx_noise_float,
  normalize,
  output,
  positionWorld,
  pow,
  select,
  smoothstep,
  step,
  texture,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { floatUniform, linear, z, type EnvironmentContext, type GroundField } from '@prismfall/sdk';

export type F = Node<'float'>;
export type V2 = Node<'vec2'>;
export type V3 = Node<'vec3'>;
export type V4 = Node<'vec4'>;

/** Where the viewer stands: the camera looks at the board from about 30 m, eyes 1.6 m above the yard. */
export const GROUND_Y = -1.05;
export const VIEWER = new Vector3(0, 0.55, 30.4);
export const TAU = Math.PI * 2;

/** The photo's placement: the same numbers as the sky layer's panorama. */
export const PANO = { src: 'textures/freight_station_band.webp', elevation: [-32, 40] as [number, number], offset: 0.585 };

export const zHaze = z
  .object({
    /** Extinction per metre at any height (smoke haze over the whole city). */
    haze: z.number().min(0).default(0.0007),
    /** Extra extinction per metre at ground level, thinning with height over `height` metres. */
    ground: z.number().min(0).default(0.0014),
    height: z.number().positive().default(24),
  })
  .prefault({});
export type Haze = z.infer<typeof zHaze>;

export const MAX_LIGHTS = 8;

/** One per built environment: shared textures, local lights and things machines can notice. */
export interface World {
  readonly ctx: EnvironmentContext;
  users: number;
  env: Promise<Texture | null> | null;
  backdrop: Promise<DataTexture | null> | null;
  textures: Map<string, Promise<Texture | null>>;
  /** Local point lights: xyz + intensity; rgb colour + range. Slots are claimed by components. */
  readonly lightPos: ReturnType<typeof uniformArray>;
  readonly lightCol: ReturnType<typeof uniformArray>;
  readonly lightValues: Vector4[];
  readonly lightColours: Vector4[];
  nextLight: number;
  /** Recent events (explosions, sparks) sensors may turn towards: world position and time. */
  readonly events: { x: number; y: number; z: number; t: number; weight: number }[];
  /** Sky illumination by the latest explosion: direction (unit) and strength. */
  readonly flashDir: ReturnType<typeof uniform>;
  readonly flash: ReturnType<typeof floatUniform>;
  /** Environment clock (seconds), advanced by the first component each frame. */
  time: number;
  /**
   * The world's own light (never the board's): a low red sun behind the city and a smoky sky
   * fill. These lights are not in the scene graph, so they light only Red Horizon materials.
   */
  readonly lightsNode: ReturnType<typeof lights>;
  /** The same without the sun (flat ground: the low sun behind would paint a glare streak). */
  readonly lightsNoSun: ReturnType<typeof lights>;
  readonly sun: DirectionalLight;
  /** Cool fill from the clearer sky opposite the sunset (behind the viewer). */
  readonly fill: DirectionalLight;
  readonly sky: HemisphereLight;
}

const store = new WeakMap<GroundField, World>();

export function world(ctx: EnvironmentContext): World {
  let w = store.get(ctx.ground);
  if (!w) {
    const lightValues = Array.from({ length: MAX_LIGHTS }, () => new Vector4(0, -1000, 0, 0));
    const lightColours = Array.from({ length: MAX_LIGHTS }, () => new Vector4(1, 0.4, 0.15, 60));
    const sun = new DirectionalLight(new Color('#e89a78'), 5.0);
    // The photo's sun sits just right of straight ahead (behind the board), a few degrees up.
    const az = (5.4 * Math.PI) / 180;
    const el = (6 * Math.PI) / 180;
    sun.position.set(Math.sin(az) * Math.cos(el) * 600, Math.sin(el) * 600, VIEWER.z - Math.cos(az) * Math.cos(el) * 600);
    sun.target.position.set(0, 0, VIEWER.z);
    sun.updateMatrixWorld(true);
    sun.target.updateMatrixWorld(true);
    const sky = new HemisphereLight(new Color('#8a6a60'), new Color('#241c1a'), 3.8);
    const fill = new DirectionalLight(new Color('#7c8496'), 1.1);
    fill.position.set(-200, 160, VIEWER.z + 500);
    fill.target.position.set(0, 0, 0);
    fill.updateMatrixWorld(true);
    fill.target.updateMatrixWorld(true);
    sky.position.set(0, 1, 0);
    sky.updateMatrixWorld(true);
    w = {
      ctx,
      users: 0,
      env: null,
      backdrop: null,
      textures: new Map(),
      lightPos: uniformArray(lightValues, 'vec4'),
      lightCol: uniformArray(lightColours, 'vec4'),
      lightValues,
      lightColours,
      nextLight: 0,
      events: [],
      flashDir: uniform(new Vector3(0, 0.2, -1).normalize()),
      flash: floatUniform(0),
      time: 0,
      lightsNode: lights([sun, sky, fill]),
      lightsNoSun: lights([sky, fill]),
      sun,
      fill,
      sky,
    };
    store.set(ctx.ground, w);
  }
  w.users++;
  return w;
}

export function release(w: World): void {
  w.users--;
  if (w.users > 0) return;
  void w.env?.then((t) => t?.dispose());
  void w.backdrop?.then((t) => t?.dispose());
  for (const t of w.textures.values()) void t.then((x) => x?.dispose());
  store.delete(w.ctx.ground);
}

/** Claims a local light slot (or -1 when all are taken). */
export function claimLight(w: World): number {
  return w.nextLight < MAX_LIGHTS ? w.nextLight++ : -1;
}

export function setLight(w: World, slot: number, x: number, y: number, zz: number, intensity: number, r: number, g: number, b: number, range: number): void {
  if (slot < 0) return;
  w.lightValues[slot]!.set(x, y, zz, intensity);
  w.lightColours[slot]!.set(r, g, b, range);
}

/** Reports something loud or bright at a world point; nearby sensors may turn to look. */
export function notice(w: World, x: number, y: number, zz: number, weight: number): void {
  w.events.push({ x, y, z: zz, t: w.time, weight });
  if (w.events.length > 8) w.events.shift();
}

async function loadTexture(ctx: EnvironmentContext, src: string, srgb: boolean, repeat: boolean): Promise<Texture | null> {
  const url = ctx.assets.url(src);
  if (!url) {
    console.warn(`[red-horizon] texture ${src} not found`);
    return null;
  }
  const tex = await new TextureLoader().loadAsync(url);
  tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  if (repeat) {
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
  }
  tex.minFilter = LinearMipmapLinearFilter;
  tex.anisotropy = 8;
  return tex;
}

/** A stage texture, loaded once per environment. */
export function stageTexture(w: World, src: string, srgb = true, repeat = true): Promise<Texture | null> {
  let t = w.textures.get(src);
  if (!t) {
    t = loadTexture(w.ctx, src, srgb, repeat);
    w.textures.set(src, t);
  }
  return t;
}

/** The graded full-sphere photo used for metal reflections (PMREM-filtered by the renderer). */
export function envTexture(w: World): Promise<Texture | null> {
  if (!w.env) {
    w.env = loadTexture(w.ctx, 'textures/red_horizon_env.webp', true, false).then((t) => {
      if (t) {
        t.mapping = EquirectangularReflectionMapping;
        t.generateMipmaps = false;
        t.minFilter = LinearFilter;
      }
      return t;
    });
  }
  return w.env;
}

/** A small blurred copy of the graded panorama band: fog and ambient colour by direction. */
export function backdropTexture(w: World): Promise<DataTexture | null> {
  if (w.backdrop) return w.backdrop;
  w.backdrop = (async () => {
    const url = w.ctx.assets.url(PANO.src);
    if (!url || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
    try {
      const blob = await (await fetch(url)).blob();
      const W = 512;
      const H = 104;
      const bmp = await createImageBitmap(blob, { resizeWidth: W, resizeHeight: H, resizeQuality: 'high', premultiplyAlpha: 'none' });
      const canvas = new OffscreenCanvas(W, H);
      const g = canvas.getContext('2d');
      if (!g) return null;
      g.filter = 'blur(3px)';
      g.drawImage(bmp, -W, 0);
      g.drawImage(bmp, 0, 0);
      g.drawImage(bmp, W, 0);
      bmp.close();
      const data = new Uint8Array(g.getImageData(0, 0, W, H).data.buffer);
      // The band's alpha is the land mask; colour only here.
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
      const tex = new DataTexture(data, W, H, RGBAFormat, UnsignedByteType);
      tex.colorSpace = SRGBColorSpace;
      tex.wrapS = RepeatWrapping;
      tex.wrapT = ClampToEdgeWrapping;
      tex.magFilter = LinearFilter;
      tex.minFilter = LinearFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      return tex;
    } catch (err) {
      console.warn('[red-horizon] backdrop colour unavailable', err);
      return null;
    }
  })();
  return w.backdrop;
}

/** The graded panorama band itself, loaded once: the sky draws it and the puddles reflect it. */
export function bandTexture(w: World): Promise<Texture | null> {
  const key = '#band';
  let t = w.textures.get(key);
  if (!t) {
    t = (async () => {
      const url = w.ctx.assets.url(PANO.src);
      if (!url) return null;
      const tex = await new TextureLoader().loadAsync(url);
      tex.colorSpace = SRGBColorSpace;
      tex.wrapS = RepeatWrapping;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.anisotropy = 8;
      return tex;
    })();
    w.textures.set(key, t);
  }
  return t;
}

/** Colour of the sharp band in a world direction (the sky's own mapping; land silhouettes included). */
export function bandDir(tex: Texture | null, d: V3): V3 {
  if (!tex) return vec3(0.09, 0.035, 0.025) as V3;
  const [lo, hi] = PANO.elevation;
  const turn = atan(d.x, d.z.negate()).div(TAU).add(PANO.offset);
  const elev = asin(clamp(d.y, -1, 1)).mul(180 / Math.PI);
  const v = elev.sub(lo).div(hi - lo).clamp(0.002, 0.998);
  return texture(tex, vec2(turn, v)).rgb as V3;
}

/** Colour of the photo (blurred) in a world direction. */
export function backdropDir(tex: DataTexture | null, d: V3): V3 {
  if (!tex) return vec3(0.09, 0.035, 0.025) as V3;
  const [lo, hi] = PANO.elevation;
  const turn = atan(d.x, d.z.negate()).div(TAU).add(PANO.offset);
  const elev = asin(clamp(d.y, -1, 1)).mul(180 / Math.PI);
  const v = float(hi).sub(elev).div(hi - lo).clamp(0.01, 0.99);
  return texture(tex, vec2(turn, v)).rgb as V3;
}

/** Optical depth of the smoke haze between the camera and a world point (height fog, exact). */
export function hazeDepth(p: V3, h: Haze): F {
  const toP = p.sub(cameraPosition);
  const L = length(toP);
  const yc = cameraPosition.y.sub(GROUND_Y).max(0);
  const yp = p.y.sub(GROUND_Y).max(0);
  const dy = yp.sub(yc);
  const ec = exp(yc.div(h.height).negate());
  const ep = exp(yp.div(h.height).negate());
  const avg = select(abs(dy).greaterThan(0.05), ec.sub(ep).mul(h.height).div(abs(dy).max(0.05)).mul(dy.sign()), ep);
  return L.mul(float(h.haze).add(avg.max(0).mul(h.ground))) as F;
}

/** Fog towards the photo's own colour behind the point; far scenery melts into the horizon. */
export function fogged(color: V3, p: V3, backdrop: DataTexture | null, h: Haze, extra: F = float(1) as F): V3 {
  const tau = hazeDepth(p, h).mul(extra);
  const dir = normalize(p.sub(cameraPosition)) as V3;
  return mix(backdropDir(backdrop, dir), color, exp(tau.negate())) as V3;
}

/** The world appears outward from the viewer during crossfades (opaque parts, alphaTest 0.5). */
export function revealMask(presence: F, reach = 1600): F {
  const dist = length(positionWorld.sub(cameraPosition));
  const edge = mx_noise_float(positionWorld.mul(0.045)).mul(0.08);
  const front = smoothstep(0, 1, presence).mul(1.12);
  return step(dist.div(reach).add(edge).add(float(0.02)), front) as F;
}

/** Diffuse light from the shared local lights (fires, explosions, the factory) at a point. */
export function localLight(w: World, p: V3, n: V3, wrap = 0.25): V3 {
  let sum: V3 = vec3(0, 0, 0) as V3;
  for (let i = 0; i < MAX_LIGHTS; i++) {
    const lp = w.lightPos.element(int(i)) as unknown as V4;
    const lc = w.lightCol.element(int(i)) as unknown as V4;
    const d = lp.xyz.sub(p);
    const d2 = dot(d, d);
    const l = d.div(d2.sqrt().max(1e-3));
    const lambert = dot(n, l).add(wrap).div(1 + wrap).clamp(0, 1);
    // Smooth range cut-off so far lights cost nothing visually.
    const fall = float(1).sub(d2.div(lc.w.mul(lc.w))).clamp(0, 1).pow(2);
    sum = sum.add(lc.rgb.mul(lp.w).mul(lambert).mul(fall).div(d2.add(25))) as V3;
  }
  return sum;
}

/**
 * A sustained world voice (machine hum) through the host's optional drone hook; silent on hosts
 * without it. `pan` from the source's bearing, level from its distance.
 */
export function hum(ctx: EnvironmentContext, id: string, x: number, zz: number, level: number, hz: number, brightness: number): void {
  const sounds = ctx.sounds as unknown as { drone?: (id: string, level: number, hz: number, brightness?: number, pan?: number) => void };
  if (!sounds.drone) return;
  const az = Math.atan2(x - VIEWER.x, VIEWER.z - zz);
  sounds.drone(id, Math.max(0, Math.min(1, level)), hz, brightness, Math.max(-1, Math.min(1, Math.sin(az) * 1.3)));
}

/** Cheap hash of a float seed into 0..1 (per-instance variety in shaders). */
export function hash(seed: F, k: number): F {
  return seed.mul(k).add(k * 0.618).sin().mul(43758.5453).fract() as F;
}

/** Triplanar sample of an albedo map and a packed normal(XY)+roughness map. */
export function triplanar(albedo: Texture | null, nr: Texture | null, p: V3, n: V3, scale: number): { albedo: V3; normal: V3; rough: F } {
  const q = p.mul(scale);
  const an = abs(n);
  const wts = pow(an, vec3(4, 4, 4));
  const wsum = wts.x.add(wts.y).add(wts.z).max(1e-4);
  const wx = wts.x.div(wsum);
  const wy = wts.y.div(wsum);
  const wz = wts.z.div(wsum);
  const uvX = vec2(q.z, q.y);
  const uvY = vec2(q.x, q.z);
  const uvZ = vec2(q.x, q.y);
  const col = albedo
    ? (texture(albedo, uvX).rgb.mul(wx).add(texture(albedo, uvY).rgb.mul(wy)).add(texture(albedo, uvZ).rgb.mul(wz)) as V3)
    : (vec3(0.4, 0.4, 0.4) as V3);
  if (!nr) return { albedo: col, normal: n, rough: float(0.7) as F };
  const sx = texture(nr, uvX);
  const sy = texture(nr, uvY);
  const sz = texture(nr, uvZ);
  // Whiteout-style blend of tangent normals swizzled onto each axis.
  const tx = sx.xy.mul(2).sub(1);
  const ty = sy.xy.mul(2).sub(1);
  const tz = sz.xy.mul(2).sub(1);
  const sgn = n.sign();
  const nX = vec3(n.x, n.y.add(tx.y), n.z.add(tx.x.mul(sgn.x)));
  const nY = vec3(n.x.add(ty.x), n.y, n.z.add(ty.y.mul(sgn.y)));
  const nZ = vec3(n.x.add(tz.x.mul(sgn.z)), n.y.add(tz.y), n.z);
  const normal = normalize(nX.mul(wx).add(nY.mul(wy)).add(nZ.mul(wz))) as V3;
  const rough = sx.z.mul(wx).add(sy.z.mul(wy)).add(sz.z.mul(wz)) as F;
  return { albedo: col, normal, rough };
}

export interface ShadeOptions {
  albedo: V3;
  roughness: F;
  metalness: F;
  /** World-space shading normal (perturbed) and world position of the fragment (default positionWorld). */
  normal: V3;
  world?: V3;
  /** Custom vertex position (skinned machines). */
  position?: V3;
  /** Self-illumination (lens glow, hot metal): added to the image and, scaled by `bloom`, to bloom. */
  glow?: V3;
  bloom?: number;
  presence: F;
  haze: Haze;
  backdrop: DataTexture | null;
  env: Texture | null;
  envIntensity?: number;
  /** Strength of the shared local lights on this material. */
  local?: number | F;
  /** Fog multiplier (1 = the stage haze). */
  fog?: F;
  /** Back-light from the glowing horizon behind the surface, on grazing edges (silhouette rims). */
  rim?: number;
  /** Leave out the sun (flat ground). */
  noSun?: boolean;
}

/**
 * The PBR material every Red Horizon surface uses: the stage's key, rim and ambient lights, the
 * graded photo as its reflection environment (so metal mirrors the burning sky), the shared local
 * lights (fires, explosions, the factory), fog towards the photo behind it, and the crossfade
 * reveal mask.
 */
export function shadeMaterial(w: World, o: ShadeOptions): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.lightsNode = o.noSun ? w.lightsNoSun : w.lightsNode;
  const wp = (o.world ?? positionWorld) as V3;
  if (o.position) m.positionNode = o.position;
  m.colorNode = vec4(o.albedo, 1);
  m.roughnessNode = o.roughness;
  m.metalnessNode = o.metalness;
  m.normalNode = normalize(cameraViewMatrix.mul(vec4(o.normal, 0)).xyz);
  if (o.env) {
    m.envMap = o.env;
    m.envMapIntensity = o.envIntensity ?? 1;
  }
  // Local light on the surface: diffuse on the dielectric part, a broad sheen on metal.
  const lit = localLight(w, wp, o.normal).mul(o.local ?? 1);
  const diffuseShare = float(1).sub(o.metalness.mul(0.8));
  // Metal shows nearby fire as a broad warm sheen (its diffuse is tiny), so machines catch the fires.
  const localTerm = o.albedo.mul(diffuseShare).add(o.albedo.mul(o.metalness).mul(0.6)).add(o.metalness.mul(0.07).add(0.02)).mul(lit);
  const glow = o.glow ?? (vec3(0, 0, 0) as V3);
  // Grazing edges catch the bright smoke behind the object (the photo in that direction).
  const toCam = normalize(cameraPosition.sub(wp));
  const ndv = abs(dot(o.normal, toCam));
  // Rim light from the glowing skyline behind the object (the horizon in that bearing), so dark
  // metal separates from the dark yard even when the photo directly behind it is ground.
  const toP = wp.sub(cameraPosition);
  const behind = backdropDir(o.backdrop, normalize(vec3(toP.x, length(toP).mul(0.04), toP.z)) as V3);
  const rimTerm = behind.mul(pow(float(1).sub(ndv).clamp(0, 1), 3)).mul(o.rim ?? 0.7).mul(mix(float(0.35), float(1), o.metalness));
  m.emissiveNode = localTerm.add(glow).add(rimTerm);
  m.fog = false;
  const tau = hazeDepth(wp, o.haze).mul(o.fog ?? float(1));
  const dir = normalize(wp.sub(cameraPosition)) as V3;
  const fogCol = backdropDir(o.backdrop, dir);
  const keep = exp(tau.negate());
  m.outputNode = vec4(mix(fogCol, output.rgb, keep), output.a);
  m.mrtNode = mrt({ emissive: vec4(glow.mul((o.bloom ?? 0) * 1).mul(keep), 1) });
  m.opacityNode = revealMask(o.presence);
  m.alphaTest = 0.5;
  return m;
}

/** Linear-space colour constant. */
export function lin(hex: string, k = 1): V3 {
  const c = linear(hex, k);
  return vec3(c.x, c.y, c.z) as V3;
}

/** Mixes between per-instance tones with a hash. */
export function tone(seed: F, k: number, a: V3, b: V3): V3 {
  return mix(a, b, hash(seed, k)) as V3;
}

