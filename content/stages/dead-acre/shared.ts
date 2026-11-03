import { ClampToEdgeWrapping, DataTexture, LinearFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType, Vector4, type Node } from 'three/webgpu';
import { asin, atan, cameraPosition, clamp, exp, float, int, length, mx_noise_float, positionWorld, select, smoothstep, step, texture, uniformArray, vec2, vec3 } from 'three/tsl';
import { z, type EnvironmentContext, type GroundField } from '@prismfall/sdk';

/**
 * Pieces the Dead Acre components share: the photo backdrop (for fog that matches what is behind a
 * figure, and rim light from the glowing fog behind it), a tiling fog-noise texture, the sodium
 * lamps' live state (positions, colours, flicker) and the height-fog model.
 */

export type F = Node<'float'>;
export type V2 = Node<'vec2'>;
export type V3 = Node<'vec3'>;
export type V4 = Node<'vec4'>;

export const MAX_LAMPS = 4;

/** Where the photo sits: the same numbers as the sky layer's panorama, so fog matches the photo. */
export const zBackdrop = z
  .object({
    src: z.string().default('textures/kloppenheim_04_band.webp'),
    elevation: z.tuple([z.number(), z.number()]).default([-32, 40]),
    offset: z.number().default(0.57),
    exposure: z.number().min(0).default(1),
    /** Panorama exposure at full `dusk` (the sky layer's dusk.exposure). */
    duskExposure: z.number().min(0).default(1),
  })
  .prefault({});

export type BackdropParams = z.infer<typeof zBackdrop>;

/** Height fog: a thin haze everywhere plus a denser layer hugging the ground. */
export const zFog = z
  .object({
    /** Haze extinction per metre at any height. */
    haze: z.number().min(0).default(0.0055),
    /** Extra extinction per metre at ground level, falling off with `height`. */
    ground: z.number().min(0).default(0.016),
    /** Height (m) over which the ground layer thins by 1/e. */
    height: z.number().positive().default(2.0),
  })
  .prefault({});

export type FogParams = z.infer<typeof zFog>;

export interface Shared {
  /** xyz world position of each lamp head, w = current intensity (0 = dark). */
  readonly lampPos: ReturnType<typeof uniformArray>;
  /** rgb linear colour, w = unused. */
  readonly lampCol: ReturnType<typeof uniformArray>;
  readonly lampValues: Vector4[];
  readonly lampColours: Vector4[];
  backdrop: Promise<DataTexture | null> | null;
  noise: DataTexture | null;
  users: number;
  /** When something startled the crows (seconds on the environment clock), and on which side (−1, 1, 0 both). */
  startle: { at: number; side: number };
}

const store = new WeakMap<GroundField, Shared>();

/** One shared state per built environment (each build gets its own ground field). */
export function shared(ctx: EnvironmentContext): Shared {
  let s = store.get(ctx.ground);
  if (!s) {
    const lampValues = Array.from({ length: MAX_LAMPS }, () => new Vector4(0, -1000, 0, 0));
    const lampColours = Array.from({ length: MAX_LAMPS }, () => new Vector4(1, 0.6, 0.3, 0));
    s = { lampPos: uniformArray(lampValues, 'vec4'), lampCol: uniformArray(lampColours, 'vec4'), lampValues, lampColours, backdrop: null, noise: null, users: 0, startle: { at: -1e9, side: 0 } };
    store.set(ctx.ground, s);
  }
  s.users++;
  return s;
}

/** Releases the shared textures when the last component of an environment is disposed. */
export function release(ctx: EnvironmentContext, s: Shared): void {
  s.users--;
  if (s.users > 0) return;
  s.noise?.dispose();
  void s.backdrop?.then((t) => t?.dispose());
  store.delete(ctx.ground);
}

/**
 * A small, blurred copy of the panorama band (512 px around), enough for fog and ambient colour
 * and about 200 kB of video memory. Row 0 is the top of the photo.
 */
export function backdropTexture(ctx: EnvironmentContext, s: Shared, src: string): Promise<DataTexture | null> {
  if (s.backdrop) return s.backdrop;
  s.backdrop = (async () => {
    const url = ctx.assets.url(src);
    if (!url || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
    try {
      const blob = await (await fetch(url)).blob();
      const W = 512;
      const H = 104;
      const bmp = await createImageBitmap(blob, { resizeWidth: W, resizeHeight: H, resizeQuality: 'high' });
      const canvas = new OffscreenCanvas(W, H);
      const g = canvas.getContext('2d');
      if (!g) return null;
      g.filter = 'blur(2px)';
      // Draw three copies side by side so the blur wraps around the seam.
      g.drawImage(bmp, -W, 0);
      g.drawImage(bmp, 0, 0);
      g.drawImage(bmp, W, 0);
      bmp.close();
      const data = new Uint8Array(g.getImageData(0, 0, W, H).data.buffer);
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
      console.warn('[dead-acre] backdrop colour unavailable', err);
      return null;
    }
  })();
  return s.backdrop;
}

/** Tiling value-noise fBm, four independent octave sets in RGBA (128 × 128, repeats seamlessly). */
export function noiseTexture(s: Shared, seed = 7): DataTexture {
  if (s.noise) return s.noise;
  const N = 128;
  const data = new Uint8Array(N * N * 4);
  let st = seed >>> 0 || 1;
  const rnd = () => {
    st = (st + 0x6d2b79f5) >>> 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const field = new Float32Array(N * N);
  for (let c = 0; c < 4; c++) {
    field.fill(0);
    let amp = 1;
    let total = 0;
    for (const period of [4, 8, 16, 32]) {
      const lattice = Array.from({ length: period * period }, rnd);
      const cell = N / period;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const fx = x / cell;
          const fy = y / cell;
          const x0 = Math.floor(fx);
          const y0 = Math.floor(fy);
          const tx = fx - x0;
          const ty = fy - y0;
          const sx = tx * tx * (3 - 2 * tx);
          const sy = ty * ty * (3 - 2 * ty);
          const at = (i: number, j: number) => lattice[((j % period) * period + (i % period)) % lattice.length]!;
          const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
          const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
          field[y * N + x]! += (a + (b - a) * sy) * amp;
        }
      }
      total += amp;
      amp *= 0.5;
    }
    for (let i = 0; i < N * N; i++) data[i * 4 + c] = Math.round((field[i]! / total) * 255);
  }
  const tex = new DataTexture(data, N, N, RGBAFormat, UnsignedByteType);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  s.noise = tex;
  return tex;
}

/**
 * Samples the blurred photo by direction (azimuth turn, elevation in degrees), darkened like the
 * sky layer. Falls back to a dim fog grey when the photo could not be read.
 */
export function backdropSampler(tex: DataTexture | null, p: BackdropParams, dusk: F): { dir(d: V3): V3; at(turn: F, elevDeg: F): V3; turnOf(d: V3): F } {
  const [lo, hi] = p.elevation;
  const gain = float(p.exposure).mul(float(1).add(float(p.duskExposure - 1).mul(dusk.clamp(0, 1))));
  const turnOf = (d: V3): F => atan(d.x, d.z.negate()).div(Math.PI * 2).add(p.offset) as F;
  const at = (turn: F, elevDeg: F): V3 => {
    if (!tex) return vec3(0.05, 0.055, 0.06).mul(gain) as V3;
    const v = float(hi).sub(elevDeg).div(hi - lo).clamp(0.01, 0.99);
    return texture(tex, vec2(turn, v)).rgb.mul(gain) as V3;
  };
  const dir = (d: V3): V3 => at(turnOf(d), asin(clamp(d.y, -1, 1)).mul(180 / Math.PI) as F);
  return { dir, at, turnOf };
}

/**
 * Optical depth of the height fog between the camera and a world point: haze × L plus the ground
 * layer integrated exactly along the ray (exponential in height).
 */
export function fogDepth(world: V3, groundY: number, fog: FogParams, thickness: F): F {
  const toP = world.sub(cameraPosition);
  const L = length(toP);
  const yc = cameraPosition.y.sub(groundY).max(0);
  const yp = world.y.sub(groundY).max(0);
  const dy = yp.sub(yc);
  const ec = exp(yc.div(fog.height).negate());
  const ep = exp(yp.div(fog.height).negate());
  const avg = select(dy.abs().greaterThan(0.02), ec.sub(ep).mul(fog.height).div(dy.abs().max(0.02)).mul(dy.sign()), ep);
  return L.mul(float(fog.haze).add(avg.max(0).mul(fog.ground))).mul(thickness) as F;
}

/** The world appears outward from the viewer during crossfades (opaque parts, alphaTest 0.5). */
export function revealMask(presence: F, reach = 1400): F {
  const dist = length(positionWorld.sub(cameraPosition));
  const edge = mx_noise_float(positionWorld.mul(0.045)).mul(0.08);
  const front = smoothstep(0, 1, presence).mul(1.12);
  return step(dist.div(reach).add(edge).add(float(0.02)), front) as F;
}

/** Diffuse light from the shared sodium lamps at a world point with normal n (wrap lighting). */
export function lampLight(s: Shared, world: V3, n: V3 | null, wrap = 0.3): V3 {
  let sum: V3 = vec3(0, 0, 0) as V3;
  for (let i = 0; i < MAX_LAMPS; i++) {
    const lp = s.lampPos.element(int(i)) as unknown as V4;
    const lc = s.lampCol.element(int(i)) as unknown as V4;
    const d = lp.xyz.sub(world);
    const d2 = d.dot(d);
    const l = d.div(d2.sqrt().max(1e-3));
    const lambert = n ? n.dot(l).add(wrap).div(1 + wrap).clamp(0, 1) : float(1);
    sum = sum.add(lc.rgb.mul(lp.w).mul(lambert).div(d2.add(4))) as V3;
  }
  return sum;
}

/** Cheap hash of a float seed into 0..1 (per-instance variety in shaders). */
export function hash(seed: F, k: number): F {
  return seed.mul(k).add(k * 0.618).sin().mul(43758.5453).fract() as F;
}

export const ORIGIN_Z = 32;
