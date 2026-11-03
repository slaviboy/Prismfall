import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Data3DTexture,
  DataTexture,
  DataUtils,
  Group,
  HalfFloatType,
  InstancedBufferAttribute,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  NormalBlending,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  SphereGeometry,
  Sprite,
  SpriteNodeMaterial,
  SRGBColorSpace,
  TextureLoader,
  UnsignedByteType,
  Vector3,
  Vector4,
  type Node,
  type Texture,
} from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  asin,
  atan,
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  acos,
  cos,
  cross,
  dFdx,
  dFdy,
  dot,
  exp,
  float,
  fract,
  instancedBufferAttribute,
  interleavedGradientNoise,
  length,
  max,
  min,
  mix,
  mrt,
  modelWorldMatrixInverse,
  mx_fractal_noise_float,
  mx_noise_float,
  normalize,
  positionGeometry,
  positionLocal,
  positionWorld,
  positionWorldDirection,
  pow,
  screenCoordinate,
  screenSize,
  screenUV,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  texture3D,
  uniform,
  uniformArray,
  uv,
  varyingProperty,
  vec2,
  vec3,
  vec4,
  viewportSharedTexture,
  viewZToPerspectiveDepth,
} from 'three/tsl';
import { colorUniform, defineStage, floatUniform, linear, seeded, z, zColor, zVec3, type ComponentFactory, type EnvironmentComponent, type EnvironmentContext } from '@prismfall/sdk';

/**
 * Ashen Vigil: a dry salt pan at dusk (a real photograph) under a smoke-reddened sky, with distant
 * nuclear detonations on the horizon. Everything goes through the public SDK:
 *
 * - `ashenSky`: the photographic surroundings, seen through a drifting smoke pall that reddens the
 *   sky. It measures the photo's skyline once, so land pixels write depth (3D sky effects pass
 *   behind the real hills), and it carries each detonation's localized horizon glow.
 * - `nuclearDetonations`: the signature. Each detonation is a ray-marched volume (one impostor
 *   quad per cloud) whose shape follows a physically motivated timeline: flash, incandescent
 *   mottled fireball, rising toroidal cap with poloidal circulation and fire burning in its roll
 *   (cooling from the outside in over tens of seconds), fire licking up the dust stem, a ground
 *   dust skirt, sometimes a Wilson condensation veil and a condensation collar, then minutes of
 *   cooling, spreading and drifting. Lit by the dusk sun (the earth's shadow climbs the cloud as
 *   night falls), the sky, and the fire inside it. The shock front shows as a refraction ring
 *   sweeping out from the detonation (a camera-centred shell redrawing the viewport copy, never
 *   inside the board's clear zone), arrives seconds later and shakes the world through
 *   ctx.shakeWorld (the board stays still), then heat shimmer lingers over the horizon.
 * - `smokeDrift`: low smoke layers drifting across the plain in front of the far hills.
 * - `ashfall`: grey ash flakes falling and tumbling; the delayed shock of a detonation stirs them.
 *
 * Flash reduction (frameUniforms.flashLimit < 1) turns every flash into a slow, dim glow; reduced
 * motion slows the circulation, rise and particles and spaces detonations further apart.
 */

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;
type ArrayNode = { element(i: Node<'int'>): V4 };

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
/** Detonations on screen at once (clouds stay for minutes). */
const SLOTS = 5;
/** Horizon flash glows tracked at once. */
const FLASHES = 4;

// ------------------------------------------------------------------------------------------------
// Shared state between this stage's components (keyed by the environment context, so two builds of
// the stage never share it).

interface Shared {
  /** xyz: unit direction from the origin to the fireball; w: glow intensity (0 = off). */
  readonly flashes: ArrayNode;
  readonly flashValues: Vector4[];
  /** Latest shock arrival at the viewer: xz direction it travels, start time, strength. */
  readonly gust: { value: Vector4 };
  /** Skyline of the photo: elevation (degrees) per panorama column, and the panorama turn. */
  skyline: Float32Array | null;
  offset: number;
}

const sharedByContext = new WeakMap<EnvironmentContext, Shared>();

function sharedState(ctx: EnvironmentContext): Shared {
  let s = sharedByContext.get(ctx);
  if (!s) {
    const flashValues = Array.from({ length: FLASHES }, () => new Vector4(0, 0, -1, 0));
    s = {
      flashes: uniformArray(flashValues, 'vec4') as unknown as ArrayNode,
      flashValues,
      gust: uniform(new Vector4(0, 1, -1e4, 0)) as unknown as { value: Vector4 },
      skyline: null,
      offset: 0,
    };
    sharedByContext.set(ctx, s);
  }
  return s;
}

/** Elevation (degrees) of the photo's skyline at an azimuth (degrees, positive to the right). */
export function skylineAt(s: Pick<Shared, 'skyline' | 'offset'>, azDeg: number): number {
  const line = s.skyline;
  if (!line || line.length === 0) return 2;
  const u = (((s.offset + azDeg / 360) % 1) + 1) % 1;
  const x = u * line.length - 0.5;
  const i0 = ((Math.floor(x) % line.length) + line.length) % line.length;
  const i1 = (i0 + 1) % line.length;
  const f = x - Math.floor(x);
  return (line[i0] as number) * (1 - f) + (line[i1] as number) * f;
}

/** Unit direction (x right, y up, -z ahead) for an azimuth and elevation in degrees. */
export function direction(azDeg: number, elDeg: number): [number, number, number] {
  const a = azDeg * DEG;
  const e = elDeg * DEG;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

// ------------------------------------------------------------------------------------------------
// Skyline measurement: the first run of dark rows below the bright horizon sky, per column.

const SRGB_TO_LINEAR = Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});

/** Skyline elevations (degrees) per column of an equirectangular band, or null without a canvas. */
export function measureSkyline(pixels: Uint8ClampedArray, width: number, rows: number, topElevation: number, perDegree: number, threshold: number): Float32Array {
  const out = new Float32Array(width);
  const lum = (x: number, y: number): number => {
    const i = (y * width + x) * 4;
    return 0.2126 * (SRGB_TO_LINEAR[pixels[i] as number] as number) + 0.7152 * (SRGB_TO_LINEAR[pixels[i + 1] as number] as number) + 0.0722 * (SRGB_TO_LINEAR[pixels[i + 2] as number] as number);
  };
  for (let x = 0; x < width; x++) {
    let row = rows - 1;
    for (let y = 1; y < rows - 2; y++) {
      if (lum(x, y) < threshold && lum(x, y + 1) < threshold && lum(x, y + 2) < threshold) {
        row = y;
        break;
      }
    }
    // Sub-pixel crossing between the row above and the first dark row.
    const above = lum(x, Math.max(0, row - 1));
    const at = lum(x, row);
    const frac = Math.min(1, Math.max(0, (above - threshold) / Math.max(above - at, 1e-4)));
    out[x] = topElevation - (row - 1 + frac + 0.5) / perDegree;
  }
  return out;
}

function skylineFromImage(image: unknown, low: number, high: number, threshold: number): Float32Array | null {
  const img = image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!img || !img.width || !img.height) return null;
  const per = img.height / (high - low);
  const topEl = Math.min(high, 16);
  const top = Math.max(0, Math.floor((high - topEl) * per));
  const bottom = Math.min(img.height, Math.ceil((high + 4) * per));
  const rows = bottom - top;
  let g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  if (typeof OffscreenCanvas !== 'undefined') g = new OffscreenCanvas(img.width, rows).getContext('2d', { willReadFrequently: true });
  else if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = rows;
    g = c.getContext('2d', { willReadFrequently: true });
  }
  if (!g) return null;
  g.drawImage(img, 0, top, img.width, rows, 0, 0, img.width, rows);
  const data = g.getImageData(0, 0, img.width, rows).data;
  return measureSkyline(data, img.width, rows, high - top / per, per, threshold);
}

// ------------------------------------------------------------------------------------------------
// Tileable 3D cloud noise (Perlin-Worley base plus Worley detail), built once per session.

const noiseCache = new Map<number, Promise<Data3DTexture>>();

function cloudNoise(size: number): Promise<Data3DTexture> {
  let p = noiseCache.get(size);
  if (!p) {
    p = buildCloudNoise(size);
    noiseCache.set(size, p);
  }
  return p;
}

async function buildCloudNoise(n: number): Promise<Data3DTexture> {
  const rand = seeded(90127);
  const cellCounts = [4, 8, 16, 32];
  const points = cellCounts.map((c) => {
    const a = new Float32Array(c * c * c * 3);
    for (let i = 0; i < a.length; i++) a[i] = rand();
    return a;
  });
  const perm = new Uint8Array(512);
  {
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j] as number, p[i] as number];
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255] as number;
  }
  const worley = (x: number, y: number, zz: number, k: number): number => {
    const c = cellCounts[k] as number;
    const pts = points[k] as Float32Array;
    const px = x * c;
    const py = y * c;
    const pz = zz * c;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const iz = Math.floor(pz);
    let best = 9;
    for (let dz = -1; dz <= 1; dz++) {
      const cz = iz + dz;
      const wz = ((cz % c) + c) % c;
      for (let dy = -1; dy <= 1; dy++) {
        const cy = iy + dy;
        const wy = ((cy % c) + c) % c;
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ix + dx;
          const wx = ((cx % c) + c) % c;
          const idx = ((wz * c + wy) * c + wx) * 3;
          const fx = cx + (pts[idx] as number) - px;
          const fy = cy + (pts[idx + 1] as number) - py;
          const fz = cz + (pts[idx + 2] as number) - pz;
          const d = fx * fx + fy * fy + fz * fz;
          if (d < best) best = d;
        }
      }
    }
    return Math.max(0, 1 - Math.sqrt(best));
  };
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h: number, x: number, y: number, zz: number): number => {
    const g = h & 15;
    const u = g < 8 ? x : y;
    const v = g < 4 ? y : g === 12 || g === 14 ? x : zz;
    return ((g & 1) === 0 ? u : -u) + ((g & 2) === 0 ? v : -v);
  };
  const perlin = (x: number, y: number, zz: number, period: number): number => {
    const px = x * period;
    const py = y * period;
    const pz = zz * period;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const iz = Math.floor(pz);
    const fx = px - ix;
    const fy = py - iy;
    const fz = pz - iz;
    const h = (a: number, b: number, c: number) => perm[(perm[(perm[(a % period) & 255]! + (b % period)) & 511]! + (c % period)) & 511] as number;
    const u = fade(fx);
    const v = fade(fy);
    const w = fade(fz);
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const x0 = lerp(grad(h(ix, iy, iz), fx, fy, fz), grad(h(ix + 1, iy, iz), fx - 1, fy, fz), u);
    const x1 = lerp(grad(h(ix, iy + 1, iz), fx, fy - 1, fz), grad(h(ix + 1, iy + 1, iz), fx - 1, fy - 1, fz), u);
    const x2 = lerp(grad(h(ix, iy, iz + 1), fx, fy, fz - 1), grad(h(ix + 1, iy, iz + 1), fx - 1, fy, fz - 1), u);
    const x3 = lerp(grad(h(ix, iy + 1, iz + 1), fx, fy - 1, fz - 1), grad(h(ix + 1, iy + 1, iz + 1), fx - 1, fy - 1, fz - 1), u);
    return lerp(lerp(x0, x1, v), lerp(x2, x3, v), w);
  };
  const data = new Uint8Array(n * n * n * 4);
  const top = n >= 64 ? 3 : 2;
  for (let zi = 0; zi < n; zi++) {
    for (let yi = 0; yi < n; yi++) {
      for (let xi = 0; xi < n; xi++) {
        const x = (xi + 0.5) / n;
        const y = (yi + 0.5) / n;
        const zz = (zi + 0.5) / n;
        const w4 = worley(x, y, zz, 0);
        const w8 = worley(x, y, zz, 1);
        const w16 = worley(x, y, zz, 2);
        const w32 = top >= 3 ? worley(x, y, zz, 3) : w16;
        const pf = Math.min(1, Math.max(0, (perlin(x, y, zz, 4) * 0.55 + perlin(x, y, zz, 8) * 0.28 + perlin(x, y, zz, 16) * 0.14) * 0.9 + 0.5));
        const wLow = w4 * 0.625 + w8 * 0.25 + w16 * 0.125;
        const pw = Math.min(1, Math.max(0, wLow + pf * (1 - wLow) - 0.35) / 0.65);
        const i = ((zi * n + yi) * n + xi) * 4;
        data[i] = Math.round(pw * 255);
        data[i + 1] = Math.round(Math.min(1, w8 * 0.625 + w16 * 0.25 + w32 * 0.125) * 255);
        data[i + 2] = Math.round(Math.min(1, w16 * 0.625 + w32 * 0.375) * 255);
        data[i + 3] = Math.round(pf * 255);
      }
    }
    // Keep frames flowing while the stage prepares.
    if (zi % 4 === 3) await new Promise<void>((r) => setTimeout(r, 0));
  }
  const tex = new Data3DTexture(data, n, n, n);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.wrapR = RepeatWrapping;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

const noiseSizeFor = (detail: string): number => (detail === 'low' || detail === 'medium' ? 48 : 64);

// ------------------------------------------------------------------------------------------------
// ashenSky: the photograph seen through a smoke pall, with real-skyline occlusion and flash glows.

const skySchema = z.object({
  panorama: z.object({
    src: z.string(),
    elevation: z.tuple([z.number(), z.number()]).default([-32, 40]),
    offset: z.number().default(0),
    exposure: z.number().min(0).default(0.92),
    fade: z.number().positive().default(8),
    detail: z.object({ src: z.string(), uRange: z.tuple([z.number(), z.number()]) }).optional(),
  }),
  /** Land pixels write depth at this distance, so 3D effects farther away pass behind the hills. */
  occlude: z.number().min(0).default(480),
  /** Linear luminance below which the photo is land (measured column by column from the sky down). */
  landThreshold: z.number().min(0).max(1).default(0.3),
  /** Gradient above the photo band. */
  top: zColor.default('#2b2934'),
  mid: zColor.default('#55474a'),
  horizon: zColor.default('#9a6a50'),
  smoke: z
    .object({
      /** Optical depth of the pall straight up; the horizon sees through many times more. */
      density: z.number().min(0).default(0.3),
      /** Relative extinction per channel: smoke dims blue most and reddens what shows through. */
      extinction: zVec3.default([0.62, 1, 1.55]),
      /** Light scattered by the smoke near the horizon and high up. */
      low: zColor.default('#94583a'),
      high: zColor.default('#2c2830'),
      scale: z.number().default(2.2),
      drift: z.number().default(0.0035),
      /** Stratified smoke layers: [elevation, width, strength] in degrees. */
      bands: z.array(z.tuple([z.number(), z.number(), z.number()])).default([
        [3.2, 1.4, 0.9],
        [7.5, 2.4, 0.5],
        [14, 3.5, 0.3],
      ]),
      /** Smoke over the distant land (aerial perspective of the pall near the ground). */
      ground: z.number().min(0).default(0.32),
    })
    .prefault({}),
  land: z
    .object({
      /** Light on the land: the low sun through smoke (multiplies the photo). */
      tint: zColor.default('#c8b6aa'),
      exposure: z.number().min(0).default(0.95),
      /** 0 grey .. 1 the photo's own colour: the dusk light drains the land's colour. */
      saturation: z.number().min(0).max(1.5).default(0.6),
      /** Smoke over the land (dimmer and less coloured than over the sky). */
      haze: zColor.default('#5a4a46'),
    })
    .prefault({}),
  dusk: z
    .object({
      sky: z.number().min(0).default(0.12),
      land: z.number().min(0).default(0.2),
      smoke: zColor.default('#2e1a12'),
      /** Glow of distant fires low on the horizon, rising as night falls. */
      fire: zColor.default('#ff5a1c'),
      fireStrength: z.number().min(0).default(0.32),
    })
    .prefault({}),
  flash: z
    .object({
      core: zColor.default('#fff1dc'),
      halo: zColor.default('#ff8a40'),
      strength: z.number().min(0).default(2.4),
      /** Angular half-widths (degrees) of the core and the halo along the horizon; heights above it. */
      coreWidth: z.number().positive().default(2.6),
      haloWidth: z.number().positive().default(14),
      coreHeight: z.number().positive().default(1.6),
      haloHeight: z.number().positive().default(6),
      /** Share of the glow that falls on the land in front. */
      land: z.number().min(0).default(0.12),
    })
    .prefault({}),
  seed: z.number().default(1),
});

type SkyParams = z.infer<typeof skySchema>;

const ashenSky: ComponentFactory<SkyParams> = {
  type: 'ashenSky',
  version: 1,
  description: 'Photographic panorama through a drifting smoke pall, with skyline-measured land occlusion and detonation glows.',
  schema: skySchema,
  async create(ctx, p) {
    const shared = sharedState(ctx);
    const pano = p.panorama;
    shared.offset = pano.offset;
    const load = async (src: string, wrap: boolean): Promise<Texture | null> => {
      const url = ctx.assets.url(src);
      if (!url) {
        console.warn(`[ashenSky] ${src} not found`);
        return null;
      }
      const tex = await new TextureLoader().loadAsync(url);
      tex.colorSpace = SRGBColorSpace;
      if (wrap) tex.wrapS = RepeatWrapping;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.anisotropy = 8;
      return tex;
    };
    const photo = await load(pano.src, true);
    const detailTex = pano.detail && ctx.quality.detail !== 'low' ? await load(pano.detail.src, false) : null;
    const [low, high] = pano.elevation;

    // Measure the skyline once from the band (column by column), for depth and for placement.
    let line: Float32Array | null = null;
    try {
      line = photo ? skylineFromImage(photo.image, low, high, p.landThreshold) : null;
    } catch (err) {
      console.warn('[ashenSky] skyline measurement failed', err);
    }
    if (!line) line = new Float32Array(1024).fill(2);
    shared.skyline = line;
    const half = new Uint16Array(line.length);
    for (let i = 0; i < line.length; i++) half[i] = DataUtils.toHalfFloat(line[i] as number);
    const skyTex = new DataTexture(half, line.length, 1, RedFormat, HalfFloatType);
    skyTex.wrapS = RepeatWrapping;
    skyTex.minFilter = LinearFilter;
    skyTex.magFilter = LinearFilter;
    skyTex.generateMipmaps = false;
    skyTex.needsUpdate = true;

    const u = {
      presence: floatUniform(1),
      dusk: floatUniform(0),
      glow: floatUniform(p.flash.strength),
      fire: floatUniform(p.dusk.fireStrength),
      smoke: floatUniform(p.smoke.density),
    };
    const time = ctx.uniforms.time;
    // The panorama turns with the world root (it trembles with the world); depth uses world space.
    const dir = normalize(positionLocal);
    const worldDir = normalize(positionWorldDirection);
    const y = dir.y;
    const elev = asin(clamp(y, -1, 1)).mul(1 / DEG);
    const turn = atan(dir.x, dir.z.negate()).div(TAU).add(pano.offset);
    const v = elev.sub(low).div(high - low);

    // Photo (band everywhere, the high-resolution crop where the camera looks).
    let base: V3 = vec3(0.3, 0.3, 0.32);
    if (photo) {
      base = texture(photo, vec2(turn, v)).rgb as V3;
      if (detailTex && pano.detail) {
        const [u0, u1] = pano.detail.uRange;
        const du = fract(turn).sub(u0).div(u1 - u0);
        const inDetail = smoothstep(0, 0.012, du).mul(smoothstep(1, 0.988, du));
        base = mix(base, texture(detailTex, vec2(du.clamp(0, 1), v)).rgb, inDetail) as V3;
      }
    }
    const skylineEl = texture(skyTex, vec2(turn, 0.5)).r as F;
    const aboveLine = elev.sub(skylineEl);
    const landSoft = smoothstep(0.04, -0.04, aboveLine);
    const inBand = smoothstep(high, high - pano.fade, elev).mul(step(low, elev));

    // Gradient above the band (smoke-filtered colours).
    const gradient = mix(mix(colorUniform(p.horizon), colorUniform(p.mid), smoothstep(0, 0.35, y)), colorUniform(p.top), smoothstep(0.35, 0.95, y)) as V3;

    // The smoke pall: optical depth grows with airmass toward the horizon, structured by drifting
    // plumes and stratified layers; it dims blue most and scatters the dusk light back.
    const t = time.mul(p.smoke.drift);
    const q = vec3(dir.x.mul(p.smoke.scale), dir.y.mul(p.smoke.scale * 3.2), dir.z.mul(p.smoke.scale)).add(vec3(t, t.mul(0.15), t.mul(0.6)).add(p.seed * 1.37));
    const plumes = mx_fractal_noise_float(q, 4, 2.0, 0.55).mul(0.5).add(0.5) as F;
    const fine = mx_fractal_noise_float(q.mul(3.1).add(vec3(5.2, 1.3, 2.1)), 3, 2.0, 0.5).mul(0.5).add(0.5) as F;
    const structure = smoothstep(0.32, 0.82, plumes).mul(0.8).add(fine.mul(0.35)).add(0.25) as F;
    let layers: F = float(0);
    for (const [e0, w, s] of p.smoke.bands) {
      const wob = sin(turn.mul(TAU * 3).add(time.mul(0.01)).add(e0)).mul(w * 0.35);
      layers = layers.add(exp(elev.sub(e0).add(wob).div(w).pow(2).negate()).mul(s).mul(fine.mul(0.8).add(0.4))) as F;
    }
    const sinE = max(sin(max(elev, 0).mul(DEG)), 0);
    const airmass = float(1).div(sinE.add(0.075));
    const tau = u.smoke.mul(structure.mul(pow(airmass, 0.78)).add(layers.mul(2.2))) as F;
    const ext = vec3(...p.smoke.extinction);
    const transmit = exp(ext.mul(tau).negate()) as V3;
    const scatterW = float(1).sub(exp(tau.negate()));
    const horizonness = exp(max(elev, 0).div(9).negate());
    const smokeLit = mix(mix(colorUniform(p.smoke.high), colorUniform(p.smoke.low), horizonness), colorUniform(p.dusk.smoke), u.dusk) as V3;
    const skyExposure = mix(float(pano.exposure), float(pano.exposure * p.dusk.sky), u.dusk);
    const photoSky = mix(gradient, base.mul(skyExposure), inBand) as V3;
    let sky: V3 = photoSky.mul(transmit).add(smokeLit.mul(scatterW).mul(mix(float(1), float(0.45), u.dusk))) as V3;

    // Distant fires: a low, patchy orange glow on the smoke just above the skyline.
    const firePatch = mx_fractal_noise_float(vec3(turn.mul(38), time.mul(0.02), p.seed), 3, 2, 0.5).mul(0.5).add(0.5);
    const fireGlow = colorUniform(p.dusk.fire)
      .mul(smoothstep(0.35, 0.8, firePatch))
      .mul(exp(max(aboveLine, 0).div(1.3).negate()))
      .mul(u.fire)
      .mul(u.dusk.mul(0.8).add(0.2))
      .mul(structure.mul(0.6).add(0.5));
    sky = sky.add(fireGlow) as V3;

    // Land: the photo lit by the low sun through smoke, darkening at dusk; the far land is seen
    // through the low smoke.
    const landExposure = mix(float(p.land.exposure), float(p.land.exposure * p.dusk.land), u.dusk);
    const grey = dot(base, vec3(0.2126, 0.7152, 0.0722));
    const landBase = mix(vec3(grey, grey, grey), base, p.land.saturation).mul(colorUniform(p.land.tint)).mul(landExposure);
    const farness = smoothstep(-7, 0.5, elev);
    const tauLand = u.smoke.mul(p.smoke.ground / Math.max(p.smoke.density, 1e-3)).mul(farness).mul(structure.mul(0.7).add(0.5)) as F;
    const landHaze = mix(colorUniform(p.land.haze), colorUniform(p.dusk.smoke), u.dusk);
    let land: V3 = landBase.mul(exp(ext.mul(tauLand).negate())).add(landHaze.mul(float(1).sub(exp(tauLand.negate()))).mul(mix(float(0.8), float(0.4), u.dusk))) as V3;
    land = mix(land, landBase, step(elev, low)) as V3;

    // Detonation glows: light scattered in the air around each fireball, hugging the horizon.
    let glow: V3 = vec3(0, 0, 0);
    let glowLand: F = float(0);
    const horiz = normalize(vec2(dir.x, dir.z).add(vec2(1e-5, 0)));
    for (let k = 0; k < FLASHES; k++) {
      const f = shared.flashes.element(float(k).toInt() as Node<'int'>);
      const fh = normalize(vec2(f.x, f.z).add(vec2(1e-5, 0)));
      const dh = length(horiz.sub(fh)).mul(1 / DEG);
      const fEl = asin(clamp(f.y, -1, 1)).mul(1 / DEG);
      const dv = elev.sub(fEl);
      const up = max(dv, 0);
      const core = exp(dh.div(p.flash.coreWidth).pow(2).add(dv.div(p.flash.coreHeight).pow(2)).negate());
      const halo = exp(dh.div(p.flash.haloWidth).pow(2).add(up.div(p.flash.haloHeight).pow(2)).add(min(dv, 0).div(1.2).pow(2)).negate());
      const w = max(f.w, 0);
      glow = glow.add(colorUniform(p.flash.core).mul(core.mul(w))).add(colorUniform(p.flash.halo).mul(halo.mul(w).mul(0.42).mul(structure.mul(0.5).add(0.6)))) as V3;
      glowLand = glowLand.add(halo.mul(w)) as F;
    }
    glow = glow.mul(u.glow) as V3;
    sky = sky.add(glow) as V3;
    land = land.add(colorUniform(p.flash.halo).mul(glowLand.mul(u.glow).mul(p.flash.land).mul(smoothstep(-6, 0, elev)))) as V3;

    const color = mix(sky, land, landSoft);
    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec4(color.mul(u.presence), 1);
    material.side = BackSide;
    material.fog = false;
    material.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
    if (p.occlude > 0) {
      const land01 = step(aboveLine, 0);
      const viewZ = cameraViewMatrix.mul(vec4(cameraPosition.add(worldDir.mul(p.occlude)), 1)).z;
      material.depthWrite = true;
      material.depthNode = mix(float(1), viewZToPerspectiveDepth(viewZ, cameraNear, cameraFar), land01);
    } else material.depthWrite = false;
    const mesh = new Mesh(new SphereGeometry(900, 96, 48), material);
    mesh.renderOrder = -20;
    mesh.frustumCulled = false;
    return {
      object: mesh,
      reactive: { dusk: u.dusk, glow: u.glow, fire: u.fire, smoke: u.smoke },
      setPresence(value) {
        u.presence.value = value;
      },
      dispose() {
        mesh.geometry.dispose();
        material.dispose();
        photo?.dispose();
        detailTex?.dispose();
        skyTex.dispose();
      },
    } satisfies EnvironmentComponent;
  },
};

// ------------------------------------------------------------------------------------------------
// Detonation timeline (pure, CPU): the cloud's shape parameters at a given age. Units are the
// cloud's final height S (local units); times are seconds scaled by the cloud's own timescale.

export interface Detonation {
  /** Game-clock time of the flash. */
  start: number;
  azimuth: number;
  distance: number;
  /** Final height of the cloud top in world units. */
  size: number;
  /** Ground zero in world space. */
  ground: [number, number, number];
  /** 0 surface burst (fireball touching the ground) .. 1 air burst (dust column rises to meet it). */
  air: number;
  wilson: boolean;
  collar: boolean;
  /** Height (local) of the condensation collar, and the timeline time the cap passes it. */
  collarHeight: number;
  collarPass: number | null;
  seed: number;
  /** Seconds until the shock front reaches the viewer (compressed: a few seconds). */
  shock: number;
  /** Seconds the whole cloud lives. */
  life: number;
  /** Seconds per unit of the standard timeline (bigger clouds evolve more slowly). */
  timescale: number;
  /** Time a recycled slot started fading early, if any. */
  retire: number | null;
}

export interface CloudShape {
  /** Cap: torus centre height, ring radius, tube radius, density. */
  hc: number;
  ringR: number;
  tubeR: number;
  capA: number;
  /** Cap flattening as it spreads at the tropopause (0..1). */
  flat: number;
  /** Stem: top, radius, density. */
  stemTop: number;
  stemR: number;
  stemA: number;
  /** Ground dust skirt: ring radius, tube radius, density. */
  skirtR: number;
  skirtTube: number;
  skirtA: number;
  /** Wilson condensation shell: radius, density; collar: height, outer radius, density. */
  wilsonR: number;
  wilsonA: number;
  collarH: number;
  collarR: number;
  collarA: number;
  /** Fireball: surface emission (HDR), colour temperature (0 dark red .. 1 white), interior fire. */
  emission: number;
  temperature: number;
  core: number;
  /** Hot region radius (in tube radii), fire colour temperature, fire in the stem. */
  heatR: number;
  fireTemp: number;
  stemFire: number;
  /** Burst height (local) and the albedo blend from early red-brown to ash grey. */
  burstH: number;
  age01: number;
  /** Wind drift of the top (local units) along the wind. */
  drift: number;
  /** Overall fade (end of life, recycled slot). */
  fade: number;
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** The cloud's shape at `age` seconds after the flash (real seconds; scaled by the timescale). */
export function cloudShape(d: Detonation, age: number, now: number): CloudShape {
  const ta = age / d.timescale;
  const rf0 = 0.058;
  const rf = rf0 * Math.sqrt(1 - Math.exp(-Math.max(ta, 0) / 0.32));
  const burstH = rf0 * (0.55 + d.air * 1.9);
  // Buoyant rise: zero slope at the start, then a long exponential approach to the stable height.
  const x = Math.max(ta - 0.6, 0);
  const rise = (1 - Math.exp(-x / 30)) * (1 - Math.exp(-x / 1.6));
  const late = Math.max(ta - 45, 0);
  const spread = 1 - Math.exp(-late / 110);
  const hc = burstH + (0.72 - burstH) * rise;
  const ringR = 0.165 * (1 - Math.exp(-x / 11)) + 0.09 * spread;
  const tubeR = rf + (0.112 - rf0) * (1 - Math.exp(-x / 13)) + 0.045 * spread;
  const lifeFade = 1 - smooth(d.life * 0.72, d.life, age);
  const retire = d.retire === null ? 1 : 1 - smooth(d.retire, d.retire + 14, now);
  const fade = lifeFade * retire;
  const capA = (1 - 0.45 * smooth(60, 230, ta)) * fade;
  const flat = 0.75 * smooth(40, 200, ta);
  // The dust column chases the fireball up and joins the cap's underside.
  const capBottom = hc - tubeR * 0.55;
  const stemTop = Math.min(capBottom, 0.075 * Math.pow(Math.max(ta - 0.25, 0), 0.92) + d.air * -0.02);
  const stemR = 0.03 + 0.02 * (1 - Math.exp(-x / 18)) + 0.022 * smooth(60, 220, ta);
  const stemA = 0.62 * smooth(0.4, 5, ta) * (1 - 0.7 * smooth(80, 230, ta)) * fade;
  // Base surge: a dust wall racing out along the ground, then lingering as a low haze.
  const skirtR = 0.52 * (1 - Math.exp(-ta / 3.2)) + 0.05 * spread;
  const skirtTube = 0.012 + 0.04 * (1 - Math.exp(-ta / 5));
  const skirtA = smooth(0.25, 1.2, ta) * (0.75 * Math.exp(-Math.max(ta - 4, 0) / 26) + 0.25 * (1 - smooth(50, 140, ta))) * fade;
  // Wilson cloud: a condensation shell in the shock's wake, gone within seconds.
  const wilsonR = rf0 * 1.6 + 0.17 * (1 - Math.exp(-ta / 0.8));
  const wilsonA = d.wilson ? smooth(0.15, 0.55, ta) * (1 - smooth(1.1, 2.6, ta)) : 0;
  // Condensation collar on the stem once the cap has climbed through the humid layer.
  let collarA = 0;
  let collarR = 0;
  if (d.collar) {
    const tPass = d.collarPass;
    if (tPass !== null) {
      const since = ta - tPass;
      collarA = smooth(0, 1.6, since) * (1 - smooth(5, 13, since)) * 0.9;
      collarR = stemR + 0.05 + 0.1 * (1 - Math.exp(-Math.max(since, 0) / 3.5));
    }
  }
  const emission = 34 * Math.exp(-ta / 0.75) + 3.2 * Math.exp(-ta / 4.5) + 0.35 * Math.exp(-ta / 14);
  const temperature = 0.18 + 0.82 * Math.exp(-ta / 2.4);
  // Fire inside the cloud: strong for tens of seconds, embers glowing for a minute or two; the hot
  // region shrinks (outside in), and its colour cools from yellow-orange to deep red.
  const core = (1.3 * Math.exp(-ta / 42) + 0.3 * Math.exp(-ta / 110)) * smooth(0.6, 3, ta) * fade;
  const heatR = 0.95 + 0.95 * Math.exp(-ta / 42);
  const fireTemp = 0.62 + 0.38 * Math.exp(-ta / 35);
  const stemFire = 1.1 * smooth(1.5, 5, ta) * Math.exp(-ta / 38) * fade;
  return {
    hc,
    ringR,
    tubeR,
    capA,
    flat,
    stemTop,
    stemR,
    stemA,
    skirtR,
    skirtTube,
    skirtA,
    wilsonR,
    wilsonA,
    collarH: d.collarHeight,
    collarR,
    collarA,
    emission,
    temperature,
    core,
    heatR,
    fireTemp,
    stemFire,
    burstH,
    age01: smooth(12, 80, ta),
    drift: 0.0017 * Math.max(ta - 15, 0),
    fade,
  };
}

/** Timeline time at which the cap's underside first passes height h (null if it never does). */
export function timeCapPasses(d: Pick<Detonation, 'air'>, h: number): number | null {
  for (let t = 0; t < 120; t += 0.25) {
    const s = cloudShapeBare(d, t);
    if (s.hc - s.tubeR > h) return t;
  }
  return null;
}

function cloudShapeBare(d: Pick<Detonation, 'air'>, ta: number): { hc: number; tubeR: number } {
  const rf0 = 0.058;
  const rf = rf0 * Math.sqrt(1 - Math.exp(-Math.max(ta, 0) / 0.32));
  const burstH = rf0 * (0.55 + d.air * 1.9);
  const x = Math.max(ta - 0.6, 0);
  const rise = (1 - Math.exp(-x / 30)) * (1 - Math.exp(-x / 1.6));
  return { hc: burstH + (0.74 - burstH) * rise, tubeR: rf + (0.112 - rf0) * (1 - Math.exp(-x / 13)) };
}

/**
 * Brightness of a detonation's horizon glow `age` seconds after the flash (0..1 at the peak).
 * Normal: a fast rise (tens of milliseconds) and a decay over seconds. Flash reduction: a slow
 * swell over a second and a half to a third of the brightness: never a sudden change.
 */
export function flashEnvelope(age: number, reduced: boolean): number {
  if (age < 0) return 0;
  if (reduced) return 0.3 * smooth(0, 1.6, age) * Math.exp(-Math.max(age - 1.6, 0) / 4.5);
  return (1 - Math.exp(-age / 0.045)) * (0.82 * Math.exp(-age / 0.5) + 0.18 * Math.exp(-age / 4));
}

/** Mean seconds between detonations at a given run progress (0..1). */
export function detonationInterval(progress: number, reducedMotion: boolean): number {
  const p = Math.min(1, Math.max(0, progress));
  return (72 - 52 * Math.pow(p, 0.85)) * (reducedMotion ? 1.5 : 1);
}

export interface Placement {
  azimuth: number;
  distance: number;
  size: number;
}

/**
 * Where the next detonation goes: one side or the other, outside the board's clear zone (the cap's
 * full width included), away from the clouds already standing.
 */
export function placeDetonation(rand: () => number, standing: readonly { azimuth: number }[], clearZone = 21): Placement {
  let best: Placement | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 10; i++) {
    const distance = 560 + rand() * 330;
    const topElevation = 9.5 + rand() * 8.5;
    const size = distance * Math.tan(topElevation * DEG);
    // Half-width of the cap at its widest (local 0.4 of the height, after spreading).
    const halfWidth = Math.atan((size * 0.42) / distance) / DEG;
    const side = rand() < 0.5 ? -1 : 1;
    // Mostly just outside the clear zone (visible on 16:9 screens too), now and then further out.
    const az = side * (clearZone + halfWidth + 0.5 + Math.pow(rand(), 2.2) * 24);
    const nearest = standing.reduce((m, s) => Math.min(m, Math.abs(s.azimuth - az)), 90);
    const score = Math.min(nearest, 14) + rand() * 4 - Math.abs(az) * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = { azimuth: az, distance, size };
    }
  }
  return best as Placement;
}

// ------------------------------------------------------------------------------------------------
// nuclearDetonations: the ray-marched clouds.

const detSchema = z.object({
  /** Low sun behind the viewer (azimuth, elevation in degrees) at the start; it sets with dusk. */
  sun: z.object({ azimuth: z.number().default(104), elevation: z.number().default(4) }).prefault({}),
  sunColor: zColor.default('#ffd2b0'),
  sunsetColor: zColor.default('#f08a62'),
  sky: zColor.default('#56617a'),
  ground: zColor.default('#5a3a28'),
  /** Albedo: early red-brown gas, mature ash, dust, condensation. */
  gas: zColor.default('#6e3826'),
  ash: zColor.default('#c6c0ba'),
  dust: zColor.default('#8a7666'),
  vapour: zColor.default('#f4f2ee'),
  /** Fraction of the scene fog over the clouds' distance (they sit far out in the haze). */
  haze: z.number().min(0).max(2).default(0.65),
  hazeColor: zColor.default('#7a5c50'),
  /** Mean seconds between detonations at the start and at the end of a run. */
  interval: z.tuple([z.number().positive(), z.number().positive()]).default([72, 20]),
  /** QUADs and perfect clears set one off after a short, irregular delay. */
  clears: z.boolean().default(true),
  /** Share of the fireball's light sent to bloom (restrained). */
  bloom: z.number().min(0).default(0.12),
  seed: z.number().default(1),
});

type DetParams = z.infer<typeof detSchema>;

interface SlotGpu {
  readonly a: Vector4; // ground xyz, size S
  readonly b: Vector4; // hc, ringR, tubeR, capA
  readonly c: Vector4; // stemTop, stemR, stemA, flat
  readonly d: Vector4; // skirtR, skirtTube, skirtA, burstH
  readonly e: Vector4; // wilsonR, wilsonA, collarH, collarR
  readonly f: Vector4; // collarA, emission, temperature, core
  readonly g: Vector4; // rotA, rotB, mixB, age01
  readonly h: Vector4; // driftX, driftZ, seed, flashLight
  readonly lo: Vector4; // local box min (xyz), haze transmittance
  readonly hi: Vector4; // local box max (xyz), 1 = active
  readonly k: Vector4; // bounding sphere centre (world), radius
  readonly m: Vector4; // fire: hot radius (x tube), stem fire, fire temperature, -
  readonly r: Vector4; // heat wave: ring angle (deg), ring amplitude, ring width (deg), shimmer amplitude
  readonly w: Vector4; // heat wave: skyline elevation, cap-base elevation, half-width (deg), -
}

const nuclearDetonations: ComponentFactory<DetParams> = {
  type: 'nuclearDetonations',
  version: 1,
  description: 'Distant nuclear detonations: flash, rising fireball, toroidal cap with circulation, dust stem and skirt, condensation, minutes of drift. Ray-marched.',
  schema: detSchema,
  async create(ctx, p) {
    const shared = sharedState(ctx);
    const reduced = ctx.quality.reducedMotion;
    const detail = ctx.quality.detail;
    // Coarse steps across the bounds, and the iteration budget (refined steps inside the cloud).
    const steps = detail === 'low' ? 26 : detail === 'medium' ? 32 : detail === 'high' ? 40 : 52;
    const iterations = Math.round(steps * 2.2);
    const probeDetail = detail === 'high' || detail === 'ultra';
    const noise = await cloudNoise(noiseSizeFor(detail));
    const time = ctx.uniforms.time;

    const slots: SlotGpu[] = Array.from({ length: SLOTS }, () => ({
      a: new Vector4(),
      b: new Vector4(),
      c: new Vector4(),
      d: new Vector4(),
      e: new Vector4(),
      f: new Vector4(),
      g: new Vector4(),
      h: new Vector4(),
      lo: new Vector4(),
      hi: new Vector4(),
      k: new Vector4(0, -1e4, 0, 0),
      m: new Vector4(),
      r: new Vector4(),
      w: new Vector4(),
    }));
    // One uniform array for all slot data (WebGPU allows only 12 uniform buffers per stage).
    const FIELDS: (keyof SlotGpu)[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'lo', 'hi', 'k', 'm', 'r', 'w'];
    const DATA = uniformArray(slots.flatMap((sl) => FIELDS.map((f) => sl[f])), 'vec4') as unknown as ArrayNode;
    const arr = (key: keyof SlotGpu): ArrayNode => {
      const index = FIELDS.indexOf(key);
      return { element: (i: Node<'int'>) => DATA.element(i.mul(FIELDS.length).add(index) as Node<'int'>) };
    };
    const A = arr('a');
    const B = arr('b');
    const C = arr('c');
    const D = arr('d');
    const E = arr('e');
    const Fa = arr('f');
    const G = arr('g');
    const H = arr('h');
    const LO = arr('lo');
    const HI = arr('hi');
    const K = arr('k');
    const M = arr('m');
    const R = arr('r');
    const W = arr('w');

    const u = {
      presence: floatUniform(1),
      dusk: floatUniform(0),
      sunDir: uniform(new Vector3(...direction(p.sun.azimuth, p.sun.elevation))),
      sunColor: uniform(linear(p.sunColor)),
      shadowLine: floatUniform(-0.2),
      skyLight: floatUniform(1),
      fireCap: floatUniform(1),
    };
    const fogDensity = ctx.uniforms.fogDensity;

    // One camera-facing quad per slot, sized to the cloud's bounding sphere.
    const corners = new Float32Array(SLOTS * 4 * 3);
    const index: number[] = [];
    for (let s = 0; s < SLOTS; s++) {
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].forEach(([cx, cy], j) => corners.set([cx as number, cy as number, s], (s * 4 + j) * 3));
      const o = s * 4;
      index.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(corners, 3));
    geo.setIndex(index);
    const corner = attribute<'vec3'>('position', 'vec3');
    const vSlot = varyingProperty('float', 'vCloudSlot');
    // The camera in the world root's frame: clouds tremble with the world when it shakes.
    const camLocal = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
    const quadPosition = Fn(() => {
      const slot = corner.z.toInt() as Node<'int'>;
      const k = K.element(slot);
      const toCam = normalize(camLocal.sub(k.xyz));
      const right = normalize(cross(vec3(0, 1, 0), toCam));
      const up = cross(toCam, right);
      const dist = length(camLocal.sub(k.xyz));
      // A sphere seen from `dist` covers a slightly larger angle than its radius at the centre.
      const grow = dist.div(sqrt(max(dist.mul(dist).sub(k.w.mul(k.w)), 1))).mul(1.04);
      vSlot.assign(corner.z);
      return k.xyz.add(right.mul(corner.x).add(up.mul(corner.y)).mul(k.w.mul(grow)));
    })();

    // ---- Density of the cloud at local point p (units of S, origin at ground zero).
    type Slot = {
      size: F;
      hc: F;
      ringR: F;
      tubeR: F;
      capA: F;
      stemTop: F;
      stemR: F;
      stemA: F;
      flat: F;
      skirtR: F;
      skirtTube: F;
      skirtA: F;
      burstH: F;
      wilsonR: F;
      wilsonA: F;
      collarH: F;
      collarR: F;
      collarA: F;
      emission: F;
      temperature: F;
      core: F;
      rotA: F;
      rotB: F;
      mixB: F;
      age01: F;
      drift: V2;
      seed: F;
      flashLight: F;
      haze: F;
      heatR: F;
      stemFire: F;
      fireTemp: F;
    };
    const noiseAt = (pp: V3, scale: number): V4 => texture3D(noise, pp.mul(scale)).level(float(0)) as unknown as V4;
    /** Shear: the wind carries the top of the cloud further than the base. */
    const sheared = (pp: V3, s: Slot): V3 => pp.sub(vec3(s.drift.x, 0, s.drift.y).mul(clamp(pp.y, 0, 1.2))) as V3;
    /** Coarse shape: signed distances of the cap and stem, before noise. */
    const capDistance = (q: V3, s: Slot): F => {
      const c = q.sub(vec3(0, s.hc, 0));
      const rho = length(c.xz);
      const tube = length(vec2(rho.sub(s.ringR), c.y.mul(s.flat.mul(0.7).add(1)))).sub(s.tubeR);
      // The dome only rises over the ring once the vortex has formed (a round fireball before).
      const formed = clamp(s.ringR.div(s.tubeR), 0, 1);
      const rh = max(s.ringR.add(s.tubeR.mul(0.3)), s.tubeR);
      const rv = s.tubeR.mul(float(0.95).sub(s.flat.mul(0.4)));
      const dc = c.sub(vec3(0, s.tubeR.mul(0.55).mul(formed), 0));
      const dome = length(vec3(dc.x.div(rh), dc.y.div(rv), dc.z.div(rh))).sub(1).mul(min(rh, rv));
      // Smooth union (polynomial smin).
      const kk = s.tubeR.mul(0.45);
      const hh = clamp(float(0.5).add(dome.sub(tube).mul(0.5).div(kk)), 0, 1);
      return mix(dome, tube, hh).sub(kk.mul(hh).mul(float(1).sub(hh))) as F;
    };
    const stemRadius = (yy: F, s: Slot): F =>
      s.stemR
        .mul(float(1).add(exp(yy.div(0.03).negate()).mul(1.5)))
        .mul(smoothstep(0, s.hc, yy).mul(0.3).add(0.85))
        .add(s.tubeR.mul(0.55).mul(smoothstep(s.stemTop.sub(s.tubeR.mul(1.3)), s.stemTop, yy))) as F;
    /**
     * Full density with noise; returns (density, cap share, emission weight, condensation share).
     * `cheap` skips the detail octave (shadow and ambient probes).
     */
    interface Sample {
      d: F;
      cap: F;
      hot: F;
      vap: F;
      mottle: F;
      /** Fire inside the cap (turbulent glowing gas) and its heat (colour), and in the stem. */
      fire: F;
      heat: F;
      stemFire: F;
      stem: F;
    }
    /**
     * Density at local point pp. `probe` is the cheap version for the light probes (large lobes
     * only). Each part fetches its noise only near its own coarse shape.
     */
    const density = (pp: V3, s: Slot, probe: boolean): Sample => {
      const q = sheared(pp, s);
      const c = q.sub(vec3(0, s.hc, 0));
      const rho = max(length(c.xz), 1e-4);
      const pu = rho.sub(s.ringR);
      const pv = c.y;
      const coreDist = length(vec2(pu, pv));
      const seedOff = vec3(s.seed.mul(0.173), s.seed.mul(0.311), s.seed.mul(0.097));
      const cap = float(0).toVar();
      const mottle = float(0).toVar();
      const billowV = float(0.5).toVar();
      const fire = float(0).toVar();
      const heatV = float(0).toVar();
      const dCoarse = capDistance(q, s);
      If(dCoarse.lessThan(s.tubeR.mul(0.75)), () => {
        // Poloidal circulation: rotate the noise lookup about the cap's core circle (two phases
        // blended, so the rolling never winds up).
        const swirlW = exp(coreDist.div(s.tubeR.mul(1.7)).pow(2).negate());
        const rhat = c.xz.div(rho);
        const rot = (ang: F): V3 => {
          const a = ang.mul(swirlW);
          const ca = cos(a);
          const sa = sin(a);
          const u2 = pu.mul(ca).sub(pv.mul(sa));
          const v2 = pu.mul(sa).add(pv.mul(ca));
          return vec3(rhat.x.mul(s.ringR.add(u2)), s.hc.add(v2), rhat.y.mul(s.ringR.add(u2))).add(seedOff) as V3;
        };
        const pa = rot(s.rotA);
        const pb = rot(s.rotB);
        // Cauliflower lobes at two scales (Perlin-Worley) and a fine Worley octave.
        const lobes = mix(noiseAt(pa, 1.45).x, noiseAt(pb, 1.45).x, s.mixB);
        // Light probes on lower settings see only the large lobes.
        const billow = probe && !probeDetail ? float(0.45) : mix(noiseAt(pa, 3.4).x, noiseAt(pb, 3.4).x, s.mixB);
        let relief: F = lobes.sub(0.45).mul(1.35).add(billow.sub(0.45).mul(0.55)) as F;
        if (!probe) {
          const fineN = mix(noiseAt(pa, 8.6).y, noiseAt(pb, 8.6).y, s.mixB);
          relief = relief.add(fineN.sub(0.5).mul(0.28)) as F;
          billowV.assign(billow);
          // Incandescent patches shrink as soot forms over the fireball (mottling).
          const threshold = mix(float(1.15), float(-0.35), smoothstep(0.22, 0.85, s.temperature));
          mottle.assign(smoothstep(threshold.sub(0.1), threshold.add(0.1), billow.mul(0.7).add(lobes.mul(0.3)).add(0.05)));
          // Fire in the rolling interior: hottest near the core circle, cooling from the outside
          // in (the top first, the underside and the roll last), broken into turbulent tongues
          // that the circulation carries round.
          const upward = pv.div(s.tubeR);
          const dEff = coreDist.div(s.tubeR).mul(float(1).add(smoothstep(-0.2, 0.9, upward).mul(0.7)));
          const heat = smoothstep(s.heatR, s.heatR.mul(0.35), dEff);
          const tongues = smoothstep(0.52, 0.86, billow.mul(0.45).add(fineN.mul(0.55)).add(heat.mul(0.12)));
          fire.assign(heat.mul(tongues));
          heatV.assign(heat);
        }
        const dCap = dCoarse.sub(s.tubeR.mul(relief));
        const edge = max(s.tubeR.mul(0.055), 0.005);
        cap.assign(smoothstep(edge.mul(0.3), edge.mul(-1), dCap).mul(s.capA));
      });
      // Stem: dust drawn up in streaks (noise advected upward, stretched vertically), its axis
      // wandering a little.
      const stem = float(0).toVar();
      const stemFireW = float(0).toVar();
      const yy = q.y;
      const wander = vec2(sin(yy.mul(11).add(s.seed)), cos(yy.mul(8.5).add(s.seed.mul(1.7)))).mul(s.stemR.mul(0.35));
      const dStem0 = length(q.xz.sub(wander)).sub(stemRadius(yy, s));
      If(dStem0.lessThan(s.stemR.mul(0.9)).and(yy.lessThan(s.stemTop.add(s.tubeR.mul(0.2)))).and(s.stemA.greaterThan(0.001)), () => {
        const sp = vec3(q.x, q.y.mul(0.4).sub(time.mul(0.01)), q.z).add(seedOff);
        let sn: F = noiseAt(sp, 3.6).x as F;
        if (!probe) sn = sn.mul(0.7).add(noiseAt(sp, 9.1).y.mul(0.3)) as F;
        const dStem = dStem0.sub(s.stemR.mul(sn.sub(0.45).mul(1.5)));
        const stemTopFade = smoothstep(s.stemTop.add(s.tubeR.mul(0.1)), s.stemTop.sub(s.tubeR.mul(0.6)), yy);
        stem.assign(smoothstep(s.stemR.mul(0.08), s.stemR.mul(-0.25), dStem).mul(s.stemA).mul(stemTopFade).mul(step(0, yy)));
        // Fire licking up the stem into the cap, in streaks.
        if (!probe) stemFireW.assign(smoothstep(s.stemTop.sub(0.24), s.stemTop.sub(0.02), yy).mul(smoothstep(0.42, 0.78, sn)).mul(s.stemFire));
      });
      // Ground skirt (no wind shear near the ground).
      const skirt = float(0).toVar();
      const rho0 = length(pp.xz);
      const dSk0 = length(vec2(rho0.sub(s.skirtR), pp.y.mul(1.7))).sub(s.skirtTube);
      If(s.skirtA.greaterThan(0.001).and(dSk0.lessThan(s.skirtTube.mul(0.8)).or(rho0.lessThan(s.skirtR).and(pp.y.lessThan(s.skirtTube)))), () => {
        const skN = noiseAt(vec3(pp.x, pp.y.mul(2), pp.z).add(seedOff), 4.1).x;
        const dSk = dSk0.sub(s.skirtTube.mul(skN.sub(0.45).mul(1.4)));
        const fill = smoothstep(s.skirtTube.mul(0.9), 0, pp.y).mul(step(rho0, s.skirtR)).mul(0.22);
        skirt.assign(smoothstep(s.skirtTube.mul(0.2), s.skirtTube.mul(-0.4), dSk).add(fill.mul(skN)).mul(s.skirtA).mul(step(-0.01, pp.y)));
      });
      // Wilson cloud: a misty dome of condensation around the fireball, lit from inside, gone in
      // seconds; denser towards its rim, broken into patches.
      const vapour = float(0).toVar();
      If(s.wilsonA.greaterThan(0.001), () => {
        const wn = noiseAt(pp.add(seedOff), 3.1).x;
        const wn2 = noiseAt(pp.add(seedOff).mul(vec3(1, 2.6, 1)), 7.3).y;
        const rr = length(pp.sub(vec3(0, s.burstH, 0)).mul(vec3(1, 1.3, 1)));
        // A veil, densest near its rim, in layers (condensation forms in the humid strata), torn.
        const shell = smoothstep(s.wilsonR, s.wilsonR.mul(0.9), rr.add(wn.sub(0.5).mul(0.06))).mul(smoothstep(s.wilsonR.mul(0.55), s.wilsonR.mul(0.95), rr));
        const strata = smoothstep(0.25, 0.75, sin(pp.y.mul(140).add(wn.mul(5))).mul(0.5).add(0.5)).mul(0.6).add(0.4);
        const torn = smoothstep(0.35, 0.7, wn.mul(0.6).add(wn2.mul(0.4)));
        vapour.addAssign(shell.mul(strata).mul(torn).mul(s.wilsonA).mul(0.55).mul(step(0, pp.y)));
      });
      // Condensation collar: a thin disc around the stem.
      If(s.collarA.greaterThan(0.001), () => {
        const cn = noiseAt(q.add(seedOff), 3.4).x;
        const cd = abs(q.y.sub(s.collarH)).sub(0.008).sub(cn.sub(0.5).mul(0.012));
        const rq = length(q.xz);
        vapour.addAssign(
          smoothstep(0.01, -0.004, cd)
            .mul(smoothstep(s.stemR.mul(1.05), s.stemR.mul(1.6), rq))
            .mul(smoothstep(s.collarR, s.collarR.mul(0.6), rq))
            .mul(s.collarA)
            .mul(0.8),
        );
      });
      void billowV;
      const total = cap.add(stem).add(skirt).add(vapour);
      const inv = float(1).div(max(total, 1e-4));
      const hot = exp(coreDist.div(s.tubeR.mul(0.75)).pow(2).negate());
      return { d: total, cap: cap.mul(inv), hot, vap: vapour.mul(inv), mottle, fire, heat: heatV, stemFire: stemFireW, stem: stem.mul(inv) };
    };

    const blackbody = (tt: F): V3 => {
      const red = vec3(0.85, 0.11, 0.02);
      const orange = vec3(1, 0.4, 0.07);
      const yellow = vec3(1, 0.76, 0.4);
      const white = vec3(1, 0.95, 0.88);
      return mix(mix(mix(red, orange, smoothstep(0.15, 0.4, tt)), yellow, smoothstep(0.4, 0.68, tt)), white, smoothstep(0.68, 0.95, tt)) as V3;
    };

    const albedoGas = colorUniform(p.gas);
    const albedoAsh = colorUniform(p.ash);
    const albedoDust = colorUniform(p.dust);
    const albedoVapour = colorUniform(p.vapour);
    const skyC = colorUniform(p.sky);
    const groundC = colorUniform(p.ground);
    const hazeC = colorUniform(p.hazeColor);
    const SIGMA = 42;

    const shade = Fn(() => {
      const slot = vSlot.add(0.5).toInt() as Node<'int'>;
      const a = A.element(slot);
      const b = B.element(slot);
      const c = C.element(slot);
      const d = D.element(slot);
      const e = E.element(slot);
      const f = Fa.element(slot);
      const g = G.element(slot);
      const h = H.element(slot);
      const lo = LO.element(slot);
      const hi = HI.element(slot);
      const s: Slot = {
        size: a.w.toVar() as F,
        hc: b.x.toVar() as F,
        ringR: b.y.toVar() as F,
        tubeR: b.z.toVar() as F,
        capA: b.w.toVar() as F,
        stemTop: c.x.toVar() as F,
        stemR: c.y.toVar() as F,
        stemA: c.z.toVar() as F,
        flat: c.w.toVar() as F,
        skirtR: d.x.toVar() as F,
        skirtTube: d.y.toVar() as F,
        skirtA: d.z.toVar() as F,
        burstH: d.w.toVar() as F,
        wilsonR: e.x.toVar() as F,
        wilsonA: e.y.toVar() as F,
        collarH: e.z.toVar() as F,
        collarR: e.w.toVar() as F,
        collarA: f.x.toVar() as F,
        emission: f.y.toVar() as F,
        temperature: f.z.toVar() as F,
        core: f.w.toVar() as F,
        rotA: g.x.toVar() as F,
        rotB: g.y.toVar() as F,
        mixB: g.z.toVar() as F,
        age01: g.w.toVar() as F,
        drift: vec2(h.x, h.y).toVar() as V2,
        seed: h.z.toVar() as F,
        flashLight: h.w.toVar() as F,
        haze: lo.w.toVar() as F,
        heatR: M.element(slot).x.toVar() as F,
        stemFire: M.element(slot).y.toVar() as F,
        fireTemp: M.element(slot).z.toVar() as F,
      };
      const ground = a.xyz;
      const ro = camLocal.sub(ground).div(s.size).toVar();
      const rdRaw = normalize(modelWorldMatrixInverse.mul(vec4(positionWorld.sub(cameraPosition), 0)).xyz);
      const rd = vec3(
        select(abs(rdRaw.x).lessThan(1e-5), float(1e-5), rdRaw.x),
        select(abs(rdRaw.y).lessThan(1e-5), float(1e-5), rdRaw.y),
        select(abs(rdRaw.z).lessThan(1e-5), float(1e-5), rdRaw.z),
      ).toVar();
      const inv = vec3(1).div(rd);
      const t0 = lo.xyz.sub(ro).mul(inv);
      const t1 = hi.xyz.sub(ro).mul(inv);
      const tn = min(t0, t1);
      const tf = max(t0, t1);
      const tNear = max(max(max(tn.x, tn.y), tn.z), 0).toVar();
      const tFar = min(min(tf.x, tf.y), tf.z).toVar();
      const alive = hi.w.mul(u.presence);
      const T = float(1).toVar();
      const col = vec3(0, 0, 0).toVar();
      If(tFar.greaterThan(tNear).and(alive.greaterThan(0.001)), () => {
        const dt = tFar.sub(tNear).div(steps).toVar();
        const jitter = interleavedGradientNoise(screenCoordinate.xy);
        const L = u.sunDir;
        // Earth's shadow: as the sun sets, only the higher parts of the cloud stay sunlit.
        const sunCol = u.sunColor;
        const fireHue = blackbody(s.temperature);
        const albedoCap = mix(albedoGas, albedoAsh, s.age01);
        // Coarse steps through empty space; at first contact, back up and refine (4x finer) so the
        // surface is found at the same depth for every pixel (no dithering pattern).
        const dtS = dt.mul(0.25);
        const tt = tNear.add(jitter.mul(dt)).toVar();
        const fine = float(0).toVar();
        const empty = float(0).toVar();
        Loop(iterations, () => {
          If(tt.greaterThan(tFar), () => {
            Break();
          });
          const pp = ro.add(rd.mul(tt));
          const dd = density(pp, s, false);
          const dens = dd.d;
          If(dens.greaterThan(0.003), () => {
            If(fine.lessThan(0.5), () => {
              fine.assign(1);
              tt.subAssign(dt.mul(0.95));
            }).Else(() => {
              empty.assign(0);
              const capShare = dd.cap;
              const vapShare = dd.vap;
              const dustShare = float(1).sub(capShare).sub(vapShare).max(0);
              const albedo = albedoCap.mul(capShare).add(albedoDust.mul(dustShare)).add(albedoVapour.mul(vapShare));
              // Sun: two probes toward the light for self-shadowing, plus a softer multiple-
              // scattering octave so shadows are never black.
              const d1 = density(pp.add(L.mul(0.035)), s, true).d;
              const d2 = density(pp.add(L.mul(0.11)), s, true).d;
              const od = d1.mul(0.035).add(d2.mul(0.075));
              const sunT = exp(od.mul(-SIGMA * 0.75));
              const msT = exp(od.mul(-SIGMA * 0.18));
              const lit = smoothstep(u.shadowLine.sub(0.07), u.shadowLine.add(0.07), pp.y);
              const powder = float(1).sub(exp(dens.mul(-SIGMA * 0.08))).mul(0.4).add(0.6);
              const sun = sunCol.mul(sunT.mul(powder).mul(3.3).add(msT.mul(0.26)).mul(lit));
              // Sky from above, ground bounce from below.
              const da = density(pp.add(vec3(0, 0.07, 0)), s, true).d;
              const ambOcc = exp(da.mul(-SIGMA * 0.07 * 0.5));
              const heightT = clamp(pp.y.sub(s.hc.sub(s.tubeR)).div(s.tubeR.mul(2.5)), 0, 1);
              const amb = skyC.mul(ambOcc.mul(heightT.mul(0.55).add(0.45))).mul(u.skyLight).mul(0.5).add(groundC.mul(float(1).sub(heightT)).mul(0.1));
              // The fire lights the smoke around it from inside: the cap's underside and the top of
              // the stem glow warm.
              const nearCore = exp(length(vec2(length(pp.xz), pp.y.sub(s.hc))).div(s.tubeR.mul(2.2)).negate());
              const below = smoothstep(s.hc.add(s.tubeR.mul(0.2)), s.hc.sub(s.tubeR.mul(1.6)), pp.y);
              // (and through the Wilson dome while it lasts)
              const domeLit = s.wilsonA.mul(exp(length(pp.sub(vec3(0, s.burstH, 0))).div(s.wilsonR.mul(0.6)).negate())).mul(s.emission.mul(u.fireCap).mul(0.05).min(2.5));
              const fireLight = blackbody(s.fireTemp.mul(0.55));
              const coreLit = fireLight.mul(s.core.mul(dd.hot.mul(0.9).add(nearCore.mul(0.45)).add(below.mul(nearCore).mul(1.4))).mul(0.6)).add(fireHue.mul(domeLit.mul(vapShare)));
              const flashLit = vec3(1, 0.78, 0.55).mul(s.flashLight).mul(ambOcc.mul(0.6).add(0.2));
              const scattered = albedo.mul(sun.add(amb).add(coreLit).add(flashLit));
              // Incandescence: the fireball's mottled surface early; then fire in the rolling
              // interior (yellow where hottest, red at its edges) and licking up the stem.
              const fireCol = blackbody(mix(float(0.12), float(0.62), dd.heat.mul(dd.heat)).mul(s.fireTemp));
              const glowE = fireHue
                .mul(capShare.mul(s.emission.mul(u.fireCap).mul(dd.mottle)))
                .add(fireCol.mul(capShare.mul(dd.fire).mul(s.core).mul(1.7)))
                .add(blackbody(s.fireTemp.mul(0.5)).mul(dd.stem.mul(dd.stemFire)));
              const aStep = float(1).sub(exp(dens.mul(dtS).mul(-SIGMA)));
              col.addAssign(T.mul(aStep).mul(scattered.add(glowE)));
              T.mulAssign(float(1).sub(aStep));
              tt.addAssign(dtS);
            });
          }).Else(() => {
            empty.addAssign(1);
            If(empty.greaterThan(5), () => {
              fine.assign(0);
            });
            tt.addAssign(select(fine.greaterThan(0.5), dtS, dt));
          });
          If(T.lessThan(0.012), () => {
            Break();
          });
        });
      });
      const alpha = float(1).sub(T).mul(alive);
      // Aerial perspective: the clouds sit tens of kilometres out in a dusty haze.
      const outC = col.mul(alive).mul(s.haze).add(hazeC.mul(alpha).mul(float(1).sub(s.haze)).mul(u.skyLight.mul(0.7).add(0.3)));
      return vec4(outC, alpha);
    })();

    const material = new MeshBasicNodeMaterial();
    material.positionNode = quadPosition;
    material.colorNode = shade;
    material.transparent = true;
    material.premultipliedAlpha = true;
    material.blending = NormalBlending;
    material.depthWrite = false;
    material.depthTest = true;
    material.fog = false;
    // Only the over-bright incandescence reaches bloom, and only a small share of it: no halos.
    material.mrtNode = mrt({ emissive: vec4(max(shade.xyz.sub(0.9), 0).mul(p.bloom), shade.w) });
    const mesh = new Mesh(geo, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -15;

    // ---------------------------------------------------------------- Heat wave (refraction).
    // A shell kept 440 units around the camera: in front of the photo's land depth (480), behind
    // the board, whose opaque blocks hide it and whose plate draws over it. It redraws what is
    // behind it from the viewport copy, displaced by a refraction ring sweeping out from each
    // detonation as its shock front expands towards the viewer, and by a lingering heat shimmer
    // over the horizon and the fire-lit cloud base. Nothing inside the board's clear zone moves.
    const heatGeo = new SphereGeometry(1, 64, 32);
    const heatMat = new MeshBasicNodeMaterial();
    heatMat.positionNode = camLocal.add(positionGeometry.mul(440));
    // The shell is centred on the camera, so its own vertex direction is the view direction (in
    // the world root's frame); this also holds on the WebGL 2 backend.
    const viewL = normalize(positionGeometry);
    const elevL = asin(clamp(viewL.y, -1, 1)).mul(1 / DEG);
    const azL = atan(viewL.x, viewL.z.negate()).mul(1 / DEG);
    let offsetPx: V2 = vec2(0, 0);
    for (let k = 0; k < SLOTS; k++) {
      const ik = float(k).toInt() as Node<'int'>;
      const ga = A.element(ik);
      const ring = R.element(ik);
      const where = W.element(ik);
      const toward = normalize(ga.xyz.sub(camLocal));
      const psi = acos(clamp(dot(viewL, toward), -1, 1)).mul(1 / DEG);
      // The front's limb: a lens-like displacement across a narrow ring, radial on screen.
      const x = psi.sub(ring.x).div(max(ring.z, 0.1));
      const lens = x.mul(exp(x.mul(x).negate())).mul(ring.y);
      const grad = vec2(dFdx(psi), dFdy(psi));
      const radial = grad.div(max(length(grad), 1e-6));
      offsetPx = offsetPx.add(radial.mul(lens)) as V2;
      // Heat shimmer rising over the horizon and the burning cloud base.
      const faz = atan(toward.x, toward.z.negate()).mul(1 / DEG);
      const region = smoothstep(where.z, where.z.mul(0.45), abs(azL.sub(faz)))
        .mul(smoothstep(where.x.sub(0.7), where.x.add(0.15), elevL))
        .mul(smoothstep(where.y, where.y.sub(2.5), elevL));
      const n1 = mx_noise_float(vec3(azL.mul(1.6), elevL.mul(3.1).sub(time.mul(2.1)), time.mul(0.45).add(k * 7.3)));
      const n2 = mx_noise_float(vec3(azL.mul(4.3), elevL.mul(7.4).sub(time.mul(3.3)), time.mul(0.8).add(k * 3.1)));
      offsetPx = offsetPx.add(vec2(n2.mul(0.35), n1.mul(0.75).add(n2.mul(0.4))).mul(region).mul(ring.w)) as V2;
    }
    const clearMask = smoothstep(19, 24, abs(azL));
    const shownPx = offsetPx.mul(clearMask).mul(ctx.uniforms.screenEffects).mul(u.presence);
    const refracted = viewportSharedTexture(screenUV.add(shownPx.div(screenSize))).rgb;
    heatMat.colorNode = vec4(refracted, smoothstep(0.02, 0.2, length(shownPx)));
    // Leave the bloom target as it is.
    heatMat.mrtNode = mrt({ emissive: vec4(0, 0, 0, 0) });
    heatMat.transparent = true;
    heatMat.depthWrite = false;
    heatMat.depthTest = true;
    heatMat.side = BackSide;
    heatMat.fog = false;
    const heatMesh = new Mesh(heatGeo, heatMat);
    heatMesh.frustumCulled = false;
    heatMesh.renderOrder = -9;
    heatMesh.visible = false;
    const group = new Group();
    group.add(mesh, heatMesh);

    // ---------------------------------------------------------------- Timing and state (CPU).
    const rand = seeded(p.seed * 7919 + 13);
    const dets: (Detonation | null)[] = Array.from({ length: SLOTS }, () => null);
    let lastStart = -1e9;
    let nextAt = Number.NaN;
    let pending: number | null = null;
    let initialised = false;
    let wind = new Vector3(0.3, 0, -1).normalize();

    const create = (now: number, place: Placement, opts: { air?: number; wilson?: boolean; collar?: boolean } = {}): Detonation => {
      const sl = skylineAt(shared, place.azimuth);
      // Ground zero sits a little below the skyline: the base is hidden by the curve of the earth
      // and the far hills, as it would be tens of kilometres out.
      const camY = -1.2;
      const groundEl = sl - 0.35 - rand() * 0.5;
      const dir = direction(place.azimuth, 0);
      const gy = camY + Math.tan(groundEl * DEG) * (place.distance + 35 * Math.cos(place.azimuth * DEG));
      const air = opts.air ?? (rand() < 0.4 ? 0.6 + rand() * 0.4 : rand() * 0.2);
      const collarHeight = 0.4 + rand() * 0.14;
      return {
        start: now,
        azimuth: place.azimuth,
        distance: place.distance,
        size: place.size,
        ground: [dir[0] * place.distance, gy, dir[2] * place.distance],
        air,
        wilson: opts.wilson ?? rand() < 0.45,
        collar: opts.collar ?? rand() < 0.5,
        collarHeight,
        collarPass: timeCapPasses({ air }, collarHeight),
        seed: Math.floor(rand() * 997),
        shock: 5 + place.distance / 110,
        life: 250 + rand() * 60,
        timescale: Math.sqrt(place.size / 170) * (reduced ? 1.35 : 1),
        retire: null,
      };
    };
    const freeSlot = (now: number): number => {
      const empty = dets.findIndex((x) => x === null);
      if (empty >= 0) return empty;
      // Recycle the oldest: it fades out over the next seconds while the new one forms elsewhere.
      let oldest = 0;
      dets.forEach((x, i) => {
        if (x && (dets[oldest] as Detonation).start > x.start) oldest = i;
      });
      const o = dets[oldest] as Detonation;
      if (o.retire === null) o.retire = now;
      return -1;
    };
    const detonate = (now: number, opts: { azimuth?: number; distance?: number; size?: number; air?: number; wilson?: boolean; collar?: boolean; age?: number } = {}): boolean => {
      const slot = freeSlot(now);
      if (slot < 0) return false;
      const standing = dets.filter((x): x is Detonation => x !== null);
      const place = placeDetonation(rand, standing);
      if (opts.azimuth !== undefined) place.azimuth = opts.azimuth;
      if (opts.distance !== undefined) place.distance = opts.distance;
      if (opts.size !== undefined) place.size = opts.size * place.distance * Math.tan(15 * DEG);
      const det = create(now - (opts.age ?? 0), place, opts);
      dets[slot] = det;
      if (!opts.age) {
        lastStart = now;
        // The shock reaches the viewer some seconds later: the world trembles, dust and ash stir.
        const delay = det.shock;
        const dx = -det.ground[0];
        const dz = 35 - det.ground[2];
        const len = Math.hypot(dx, dz) || 1;
        gustQueue.push({ at: now + delay, x: dx / len, z: dz / len, strength: Math.min(1.4, det.size / 160) * (reduced ? 0.25 : 1), shake: Math.min(1, det.size / (det.distance * 0.27)) * 0.85 });
      }
      return true;
    };
    const gustQueue: { at: number; x: number; z: number; strength: number; shake: number }[] = [];

    const update = (now: number, dt: number, progress: number, level: number): void => {
      if (!initialised) {
        initialised = true;
        // The world never opens empty: one cloud long settled, one still climbing.
        detonate(now, { age: 95, azimuth: -(29 + rand() * 3) });
        detonate(now, { age: 26, azimuth: 29 + rand() * 3, wilson: false, collar: true });
        nextAt = now + 14 + rand() * 14;
      }
      const eff = Math.max(progress, Math.min(0.6, Math.max(0, level - 1) / 20));
      if (now >= nextAt) {
        if (detonate(now)) {
          const [i0, i1] = p.interval;
          const mean = (i0 + (i1 - i0) * Math.pow(Math.min(1, eff), 0.85)) * (reduced ? 1.5 : 1);
          nextAt = now + mean * (0.6 + rand() * 0.8);
        } else nextAt = now + 1;
      }
      if (pending !== null && now >= pending) {
        if (now - lastStart > 10 && detonate(now)) pending = null;
        else if (now - lastStart <= 10) pending = lastStart + 10 + rand() * 3;
        else pending = now + 1;
      }
      // Gusts: the latest arrival drives the ash and the low smoke.
      while (gustQueue.length > 0 && (gustQueue[0] as { at: number }).at <= now) {
        const gq = gustQueue.shift() as { at: number; x: number; z: number; strength: number; shake: number };
        shared.gust.value.set(gq.x, gq.z, gq.at, gq.strength);
        // The host keeps the board still and skips this under reduced motion and in VR.
        ctx.shakeWorld?.(gq.shake, 2.8);
      }
      // The sun sets with dusk: the shadow line climbs the clouds and the light reddens.
      const dusk = Math.min(1, Math.max(0, u.dusk.value));
      const sunEl = p.sun.elevation - dusk * 9;
      const sd = direction(p.sun.azimuth, Math.max(sunEl, 1));
      u.sunDir.value.set(sd[0], sd[1], sd[2]).normalize();
      u.shadowLine.value = -0.25 + dusk * 1.35;
      const sc = linear(p.sunColor).lerp(linear(p.sunsetColor), Math.min(1, dusk * 1.4)).multiplyScalar(1 - 0.85 * smooth(0.35, 1, dusk));
      u.sunColor.value.copy(sc);
      u.skyLight.value = 1 - 0.78 * dusk;
      const flashReduced = ctx.uniforms.flashLimit.value < 0.99;
      u.fireCap.value = flashReduced ? 0.22 : 1;
      wind = wind.set(0.3, 0, -1).normalize();

      // Flashes for the sky (strongest four).
      const flashes: { w: number; d: [number, number, number] }[] = [];
      let heatActive = false;
      dets.forEach((det, i) => {
        const gpu = slots[i] as SlotGpu;
        if (!det) {
          gpu.hi.w = 0;
          gpu.k.set(0, -1e4, 0, 0);
          gpu.r.set(0, 0, 1, 0);
          return;
        }
        const age = now - det.start;
        if (age > det.life || (det.retire !== null && now > det.retire + 14)) {
          dets[i] = null;
          gpu.hi.w = 0;
          gpu.k.set(0, -1e4, 0, 0);
          gpu.r.set(0, 0, 1, 0);
          return;
        }
        const sh = cloudShape(det, Math.max(age, 0), now);
        const S = det.size;
        // Circulation phase: fast while the fireball is young, slowing as the cloud stabilises.
        const ta = Math.max(age, 0) / det.timescale;
        const omega = reduced ? 0.35 : 1;
        const phase = omega * (0.6 * 34 * (1 - Math.exp(-ta / 34)) + 0.07 * ta);
        const P = 1.5;
        const fa = (((phase / P) % 1) + 1) % 1;
        const fb = (fa + 0.5) % 1;
        const mixB = 1 - (1 - Math.abs(2 * fb - 1));
        gpu.a.set(det.ground[0], det.ground[1], det.ground[2], S);
        gpu.b.set(sh.hc, sh.ringR, sh.tubeR, sh.capA);
        gpu.c.set(sh.stemTop, sh.stemR, sh.stemA, sh.flat);
        gpu.d.set(sh.skirtR, sh.skirtTube, sh.skirtA, sh.burstH);
        gpu.e.set(sh.wilsonR, sh.wilsonA, sh.collarH, sh.collarR);
        const emission = sh.emission * (flashReduced ? Math.min(1, smooth(0, 1.4, age)) : 1);
        gpu.f.set(sh.collarA, emission, sh.temperature, sh.core * (flashReduced ? 0.75 : 1));
        gpu.m.set(sh.heatR, sh.stemFire, sh.fireTemp, 0);
        // Heat wave: the shock front's apparent radius grows to 90 degrees as it reaches us.
        const tr = Math.max(age, 0) / det.shock;
        const strength = Math.min(1.2, S / (det.distance * 0.27));
        const ringOn = tr > 0 && tr < 1.05 ? 1 : 0;
        const ringAngle = (Math.asin(Math.min(1, tr)) * 180) / Math.PI;
        const ringAmp = ringOn * 6 * strength * (0.35 + 0.65 * Math.exp(-2 * tr)) * smooth(0, 0.04, tr) * (1 - smooth(0.9, 1.05, tr));
        const shimmer = 1.5 * strength * smooth(3, 9, age) * Math.exp(-Math.max(age - 9, 0) / 50) * sh.fade;
        gpu.r.set(ringAngle, reduced ? 0 : ringAmp, 0.7 + ringAngle * 0.035, reduced ? 0 : shimmer);
        const capBase = det.ground[1] + (sh.hc - sh.tubeR) * S;
        const capBaseEl = (Math.atan2(capBase + 1.2, det.distance) * 180) / Math.PI;
        const half = (Math.atan2((sh.ringR + sh.tubeR) * S, det.distance) * 180) / Math.PI + 1;
        gpu.w.set(skylineAt(shared, det.azimuth), Math.max(capBaseEl, skylineAt(shared, det.azimuth) + 1.5), half, 0);
        heatActive = heatActive || gpu.r.y > 0.01 || gpu.r.w > 0.01;
        gpu.g.set((fa - 0.5) * P, (fb - 0.5) * P, 1 - mixB, sh.age01);
        gpu.h.set(wind.x * sh.drift, wind.z * sh.drift, det.seed, 0);
        // Local bounds: the cap (spread and sheared), the skirt.
        const capW = sh.ringR + sh.tubeR * 1.75 + 0.03;
        const wide = Math.max(capW, sh.skirtR + sh.skirtTube * 1.6, sh.wilsonA > 0 ? sh.wilsonR + 0.03 : 0, sh.collarA > 0 ? sh.collarR + 0.02 : 0) + 0.04;
        const topY = Math.max(sh.hc + sh.tubeR * 1.45 + 0.05, sh.wilsonA > 0 ? sh.burstH + sh.wilsonR + 0.03 : 0, sh.collarA > 0 ? sh.collarH + 0.03 : 0);
        const dX = wind.x * sh.drift * Math.min(topY, 1.2);
        const dZ = wind.z * sh.drift * Math.min(topY, 1.2);
        gpu.lo.set(-wide + Math.min(dX, 0), -0.02, -wide + Math.min(dZ, 0), 1);
        gpu.hi.set(wide + Math.max(dX, 0), topY, wide + Math.max(dZ, 0), 1);
        const cx = (gpu.lo.x + gpu.hi.x) / 2;
        const cy = (gpu.lo.y + gpu.hi.y) / 2;
        const cz = (gpu.lo.z + gpu.hi.z) / 2;
        const rad = Math.hypot(gpu.hi.x - gpu.lo.x, gpu.hi.y - gpu.lo.y, gpu.hi.z - gpu.lo.z) / 2;
        gpu.k.set(det.ground[0] + cx * S, det.ground[1] + cy * S, det.ground[2] + cz * S, rad * S);
        // Haze transmittance over the distance (a share of the scene fog).
        const fd = fogDensity.value * det.distance * p.haze;
        gpu.lo.w = Math.exp(-fd * fd);
        const fl = flashEnvelope(age, flashReduced) * Math.min(1.25, S / (det.distance * 0.27));
        if (fl > 0.002) {
          const fy = det.ground[1] + sh.burstH * S;
          const len = Math.hypot(det.ground[0], fy, det.ground[2]);
          flashes.push({ w: fl, d: [det.ground[0] / len, fy / len, det.ground[2] / len] });
        }
      });
      // Light from a fresh flash on the clouds already standing nearby.
      dets.forEach((det, i) => {
        if (!det) return;
        let light = 0;
        dets.forEach((o) => {
          if (!o || o === det) return;
          const age = now - o.start;
          const fl = flashEnvelope(age, flashReduced);
          if (fl <= 0.002) return;
          const dd = Math.hypot(o.ground[0] - det.ground[0], o.ground[2] - det.ground[2]) / det.size;
          light += fl * 2.2 * Math.exp(-dd / 1.5);
        });
        (slots[i] as SlotGpu).h.w = light;
      });
      heatMesh.visible = heatActive && !reduced && ctx.uniforms.screenEffects.value > 0.01;
      flashes.sort((x, y) => y.w - x.w);
      shared.flashValues.forEach((fv, k) => {
        const fl = flashes[k];
        if (fl) fv.set(fl.d[0], fl.d[1], fl.d[2], fl.w);
        else fv.w = 0;
      });
      void dt;
    };

    return {
      object: group,
      reactive: { dusk: u.dusk },
      update(frame) {
        update(frame.time, frame.dt, frame.game.progress, frame.game.level);
      },
      onGameEvent(event) {
        if (!p.clears || event.kind !== 'clear') return;
        if (event.lines >= 4 || event.perfectClear) {
          // An irregular delay: never placed on the beat.
          const now = time.value;
          const at = now + 1.4 + rand() * 2.8;
          if (pending === null) pending = at;
        }
      },
      setPresence(value) {
        u.presence.value = value;
      },
      dispose() {
        geo.dispose();
        material.dispose();
        heatGeo.dispose();
        heatMat.dispose();
        for (const fv of shared.flashValues) fv.w = 0;
      },
      // Previews and captures: set off a detonation now (optionally one that went off `age` seconds
      // ago), or clear the sky.
      trigger(opts: { azimuth?: number; distance?: number; size?: number; air?: number; wilson?: boolean; collar?: boolean; age?: number } = {}) {
        initialised = true;
        if (Number.isNaN(nextAt)) nextAt = time.value + 20;
        return detonate(time.value, opts);
      },
      clear() {
        dets.fill(null);
        initialised = true;
        nextAt = time.value + 30;
      },
    } satisfies EnvironmentComponent & { trigger(opts?: object): boolean; clear(): void };
  },
};

// ------------------------------------------------------------------------------------------------
// smokeDrift: low smoke layers drifting across the plain in front of the far hills.

const smokeSchema = z.object({
  count: z.number().int().min(0).max(40).default(14),
  /** Distance range of the layers and their elevation range (degrees). */
  distance: z.tuple([z.number(), z.number()]).default([220, 450]),
  elevation: z.tuple([z.number(), z.number()]).default([-1.2, 1.6]),
  width: z.tuple([z.number(), z.number()]).default([90, 220]),
  height: z.tuple([z.number(), z.number()]).default([7, 18]),
  /** Sky-lit smoke (lighter than the dark land it drifts over), and its fire-lit underside. */
  color: zColor.default('#8e7a70'),
  lit: zColor.default('#c27a4e'),
  opacity: z.number().min(0).max(1).default(0.34),
  /** Lateral drift in world units per second. */
  speed: z.number().default(1.1),
  /** Layers thin out inside this many degrees of the board. */
  clear: z.number().default(18),
  seed: z.number().default(1),
});

type SmokeParams = z.infer<typeof smokeSchema>;

const smokeDrift: ComponentFactory<SmokeParams> = {
  type: 'smokeDrift',
  version: 1,
  description: 'Low smoke layers drifting across the plain in front of the far hills, stirred by shock waves.',
  schema: smokeSchema,
  async create(ctx, p) {
    const shared = sharedState(ctx);
    const noise = await cloudNoise(noiseSizeFor(ctx.quality.detail));
    const rand = seeded(p.seed * 4513 + 9);
    const n = Math.max(1, Math.round(p.count * (ctx.quality.detail === 'low' ? 0.6 : 1)));
    // Per layer: azimuth (deg), distance, elevation (deg), seed; and width, height, speed, phase.
    const la = new Float32Array(n * 4);
    const lb = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const az = side * (6 + rand() * 70);
      la.set([az, p.distance[0] + rand() * (p.distance[1] - p.distance[0]), p.elevation[0] + rand() * (p.elevation[1] - p.elevation[0]), rand() * 100], i * 4);
      lb.set([p.width[0] + rand() * (p.width[1] - p.width[0]), p.height[0] + rand() * (p.height[1] - p.height[0]), (0.6 + rand() * 0.8) * (rand() < 0.75 ? 1 : -0.6), rand()], i * 4);
    }
    const iA = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(la, 4), 'vec4');
    const iB = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(lb, 4), 'vec4');
    const u = { presence: floatUniform(1), dusk: floatUniform(0), opacity: floatUniform(p.opacity) };
    const time = ctx.uniforms.time;
    const speed = ctx.quality.reducedMotion ? p.speed * 0.4 : p.speed;
    const gust = shared.gust;
    const gustAge = time.sub((gust as unknown as V4).z);
    const gustEnv = smoothstep(0, 1.5, gustAge).mul(exp(gustAge.div(-9).max(-30))).mul((gust as unknown as V4).w);
    // Lateral drift along the arc, wrapping within +-80 degrees.
    const arcDeg = iA.x.add(time.mul(speed).mul(iB.z).div(iA.y).mul(1 / DEG));
    const wrapped = fract(arcDeg.add(80).div(160)).mul(160).sub(80);
    const az = wrapped.mul(DEG);
    const el = iA.z.mul(DEG);
    const centre = vec3(sin(az).mul(cos(el)), sin(el), cos(az).mul(cos(el)).negate()).mul(iA.y).add(vec3(0, 2, 0));
    const edgeFade = smoothstep(80, 66, abs(wrapped));
    const clearFade = smoothstep(p.clear * 0.5, p.clear, abs(wrapped)).mul(0.8).add(0.2);
    const q = uv().sub(0.5);
    const lookup = vec3(q.x.mul(iB.x.div(iB.y)).mul(0.08).add(iA.w), q.y.mul(0.18), time.mul(0.004).add(iB.w.mul(7)));
    const n1 = texture3D(noise, lookup).level(float(0)) as unknown as V4;
    const n2 = texture3D(noise, lookup.mul(2.7).add(vec3(0.3, 0.1, time.mul(0.006)))).level(float(0)) as unknown as V4;
    const wisps = n1.w.mul(0.65).add(n2.x.mul(0.45));
    const shape = smoothstep(0.5, 0.18, abs(q.y).add(n1.x.mul(0.18))).mul(smoothstep(0.5, 0.3, abs(q.x)));
    const dens = smoothstep(0.38, 0.9, wisps).mul(shape);
    const alpha = dens.mul(u.opacity).mul(edgeFade).mul(clearFade).mul(gustEnv.mul(0.8).add(1)).mul(u.presence).clamp(0, 1);
    // Lit by the dusk from above and the fire glow from the horizon below; flashes light them.
    let flashLight: F = float(0);
    for (let k = 0; k < FLASHES; k++) {
      const f = shared.flashes.element(float(k).toInt() as Node<'int'>);
      const fh = normalize(vec2(f.x, f.z).add(vec2(1e-5, 0)));
      const ch = normalize(vec2(centre.x, centre.z));
      flashLight = flashLight.add(max(f.w, 0).mul(exp(length(ch.sub(fh)).div(0.25).pow(2).negate()))) as F;
    }
    const base = colorUniform(p.color).mul(mix(float(1), float(0.22), u.dusk));
    const lit = colorUniform(p.lit).mul(smoothstep(0.1, -0.5, q.y).mul(0.35).mul(u.dusk.mul(0.6).add(0.4)).add(flashLight.mul(0.9)));
    const color = base.add(lit).mul(n2.y.mul(0.4).add(0.8));
    const material = new SpriteNodeMaterial();
    material.positionNode = centre;
    material.scaleNode = vec2(iB.x, iB.y.mul(gustEnv.mul(0.3).add(1)));
    material.colorNode = vec4(color, alpha);
    material.mrtNode = mrt({ emissive: vec4(0, 0, 0, alpha) });
    material.transparent = true;
    material.depthWrite = false;
    material.blending = NormalBlending;
    material.fog = false;
    const sprite = new Sprite(material);
    sprite.count = n;
    sprite.frustumCulled = false;
    sprite.renderOrder = -12;
    return {
      object: sprite,
      reactive: { dusk: u.dusk, opacity: u.opacity },
      setPresence(value) {
        u.presence.value = value;
      },
      dispose() {
        material.dispose();
        sprite.geometry.dispose();
      },
    } satisfies EnvironmentComponent;
  },
};

// ------------------------------------------------------------------------------------------------
// ashfall: grey flakes falling and tumbling, stirred by the shock of each detonation.

const ashSchema = z.object({
  count: z.number().int().min(0).max(20000).default(1300),
  center: zVec3.default([0, 6, -14]),
  size: zVec3.default([110, 46, 90]),
  flake: z.tuple([z.number(), z.number()]).default([0.035, 0.1]),
  color: zColor.default('#b6aea8'),
  dark: zColor.default('#6e6662'),
  fall: z.number().default(0.55),
  wind: zVec3.default([0.35, 0, -0.1]),
  turbulence: z.number().default(0.6),
  opacity: z.number().min(0).max(1).default(0.5),
  seed: z.number().default(1),
});

type AshParams = z.infer<typeof ashSchema>;

const ashfall: ComponentFactory<AshParams> = {
  type: 'ashfall',
  version: 1,
  description: 'Falling ash flakes that tumble and drift; the delayed shock of a detonation stirs them.',
  schema: ashSchema,
  create(ctx, p) {
    const shared = sharedState(ctx);
    const reduced = ctx.quality.reducedMotion;
    const d = ctx.quality.detail === 'low' ? 0.35 : ctx.quality.detail === 'medium' ? 0.65 : ctx.quality.detail === 'high' ? 1 : 1.3;
    const n = Math.max(1, Math.round(p.count * d * ctx.quality.particles));
    const rand = seeded(p.seed * 7717 + 5);
    const data = new Float32Array(n * 4);
    const extra = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      data.set([rand(), rand(), rand(), p.flake[0] + Math.pow(rand(), 2) * (p.flake[1] - p.flake[0])], i * 4);
      extra.set([rand() * TAU, 0.6 + rand() * 1.4, rand(), rand()], i * 4);
    }
    const iA = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(data, 4), 'vec4');
    const iB = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(extra, 4), 'vec4');
    const u = { presence: floatUniform(1), dusk: floatUniform(0), opacity: floatUniform(p.opacity) };
    const time = ctx.uniforms.time;
    const motion = reduced ? 0.45 : 1;
    const t = time.mul(motion);
    const gust = shared.gust as unknown as V4;
    const gustAge = time.sub(gust.z);
    // Shock: a push along its direction that eases in and out (a displacement, no state).
    const push = smoothstep(0, 4.5, gustAge).mul(gust.w).mul(reduced ? 3 : 9);
    const swirl = smoothstep(0, 0.8, gustAge).mul(exp(gustAge.div(-5).max(-30))).mul(gust.w);
    const vel = vec3(p.wind[0], -p.fall, p.wind[2]).mul(iB.y.mul(0.4).add(0.8));
    const wobble = vec3(sin(t.mul(0.7).add(iB.x)), sin(t.mul(0.53).add(iB.x.mul(1.7))).mul(0.4), cos(t.mul(0.61).add(iB.x.mul(2.3)))).mul(p.turbulence).mul(swirl.mul(2).add(1));
    const size = vec3(...p.size);
    const origin = vec3(p.center[0] - p.size[0] / 2, p.center[1] - p.size[1] / 2, p.center[2] - p.size[2] / 2);
    const raw = iA.xyz.mul(size).add(vel.mul(t)).add(wobble).add(vec3(gust.x, 0, gust.y).mul(push));
    const local = vec3(fract(raw.x.div(size.x)), fract(raw.y.div(size.y)), fract(raw.z.div(size.z)));
    const pos = origin.add(local.mul(size));
    // Fade near the volume's faces so wrapping never pops.
    const edge = smoothstep(0, 0.06, local).mul(smoothstep(1, 0.94, local));
    const fadeEdges = edge.x.mul(edge.y).mul(edge.z);
    const spin = t.mul(iB.y.mul(1.6)).add(iB.x).add(swirl.mul(6));
    const flip = abs(cos(spin)).mul(0.75).add(0.25);
    const q = uv().sub(0.5);
    const ragged = sin(atan(q.y, q.x).mul(5).add(iB.z.mul(20))).mul(0.06).add(sin(atan(q.y, q.x).mul(9).add(iB.w.mul(30))).mul(0.04));
    const flakeShape = smoothstep(0.5, 0.18, length(q).add(ragged));
    // Grey ash, catching a little warm light from the horizon; darker as night falls.
    const glow = shared.flashValues.length > 0 ? max(shared.flashes.element(float(0).toInt() as Node<'int'>).w, 0) : float(0);
    const tone = mix(colorUniform(p.color), colorUniform(p.dark), iB.z.mul(0.6)).mul(mix(float(1), float(0.3), u.dusk)).add(vec3(1, 0.6, 0.35).mul(glow.mul(0.25)));
    const alpha = flakeShape.mul(u.opacity).mul(fadeEdges).mul(u.presence);
    const material = new SpriteNodeMaterial();
    material.positionNode = pos;
    material.scaleNode = vec2(iA.w.mul(flip), iA.w);
    material.rotationNode = iB.x.add(t.mul(iB.w.sub(0.5)));
    material.colorNode = vec4(tone, alpha);
    material.mrtNode = mrt({ emissive: vec4(0, 0, 0, alpha) });
    material.transparent = true;
    material.depthWrite = false;
    material.blending = NormalBlending;
    material.fog = false;
    const sprite = new Sprite(material);
    sprite.count = n;
    sprite.frustumCulled = false;
    sprite.renderOrder = -5;
    const group = new Group();
    group.add(sprite);
    return {
      object: group,
      reactive: { dusk: u.dusk, opacity: u.opacity },
      setPresence(value) {
        u.presence.value = value;
      },
      dispose() {
        material.dispose();
        sprite.geometry.dispose();
      },
    } satisfies EnvironmentComponent;
  },
};

export default defineStage({
  // 1.3: frameUniforms.screenEffects (heat-wave refraction) and ctx.shakeWorld (the shock).
  sdkVersion: '1.3.0',
  register(sdk) {
    sdk.components.register(ashenSky as unknown as ComponentFactory);
    sdk.components.register(nuclearDetonations as unknown as ComponentFactory);
    sdk.components.register(smokeDrift as unknown as ComponentFactory);
    sdk.components.register(ashfall as unknown as ComponentFactory);
  },
});
