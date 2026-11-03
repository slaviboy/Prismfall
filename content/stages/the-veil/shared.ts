import { ClampToEdgeWrapping, Data3DTexture, DataTexture, LinearFilter, RedFormat, RepeatWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType, Vector3, Vector4, type Node } from 'three/webgpu';
import { asin, atan, clamp, float, texture, uniform, uniformArray, vec2, vec3 } from 'three/tsl';
import { type EnvironmentContext, type GroundField } from '@prismfall/sdk';
import type { Director } from './director';
import type { ShadowMaps } from './shadow';

/**
 * State the Veil components share within one built environment: noise volumes, the photo's
 * horizon colours (fog matches what is behind it), the creature shadow maps, the fog's live
 * parameters (driven by the event director and the music) and the director itself.
 */

export type F = Node<'float'>;
export type V2 = Node<'vec2'>;
export type V3 = Node<'vec3'>;
export type V4 = Node<'vec4'>;

export const cast = <T>(n: unknown): T => n as T;

/** Panorama placement (the same numbers as the sky layer). */
export const PANO = { src: 'textures/kloofendal_28d_misty_band.webp', elevation: [-18, 32] as const, offset: 0.689 };
/** The moon: the photo's veiled sun, graded cold (azimuth from the board direction, elevation). */
export const MOON = { azimuth: -40, elevation: 15 };

export const MAX_POCKETS = 9;
export const MAX_LIGHTS = 4;

export function moonDirection(): Vector3 {
  const a = (MOON.azimuth * Math.PI) / 180;
  const e = (MOON.elevation * Math.PI) / 180;
  return new Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
}

const numU = (v: number) => uniform(v);
const vecU = (v: Vector3) => uniform(v);
export type NumUniform = ReturnType<typeof numU>;
export type VecUniform = ReturnType<typeof vecU>;

/** Live fog parameters, written each frame on the CPU (director, music, comfort settings). */
export interface FogUniforms {
  /** Global density multiplier (comfort, director "closing"/"clearing"). */
  readonly density: NumUniform;
  /** Accumulated wind offset (metres): banks drift along it; speed follows the bass. */
  readonly wind: VecUniform;
  readonly windFine: VecUniform;
  /** Local pockets: xyz centre, w radius; and x amount (+ thicker, − clearer), y softness, z stretch along x. */
  readonly pocketPos: ReturnType<typeof uniformArray>;
  readonly pocketAmt: ReturnType<typeof uniformArray>;
  readonly pocketValues: Vector4[];
  readonly pocketAmounts: Vector4[];
  /** Fog lights: xyz position, w intensity; rgb colour. */
  readonly lightPos: ReturnType<typeof uniformArray>;
  readonly lightCol: ReturnType<typeof uniformArray>;
  readonly lightValues: Vector4[];
  readonly lightColours: Vector4[];
  /** Moonlight share in the fog (shadows remove it) and the deep backlight glow. */
  readonly moon: NumUniform;
  readonly backlight: NumUniform;
  /** 0..1: the QUAD's distant illumination (soft, flash-limited). */
  readonly flare: NumUniform;
  /** Fine mist motion (the treble). */
  readonly shimmer: NumUniform;
  /** Development aid: 1 shows the moon-shadow term on surfaces (red). */
  readonly debug: NumUniform;
}

export interface VeilShared {
  readonly fog: FogUniforms;
  noise3: Data3DTexture | null;
  noise2: DataTexture | null;
  backdrop: Promise<DataTexture | null> | null;
  shadows: ShadowMaps | null;
  director: Director | null;
  /** Development aid: speeds up the director and the creatures (captures). */
  timeScale: number;
  users: number;
}

const store = new WeakMap<GroundField, VeilShared>();

export function shared(ctx: EnvironmentContext): VeilShared {
  let s = store.get(ctx.ground);
  if (!s) {
    const pocketValues = Array.from({ length: MAX_POCKETS }, () => new Vector4(0, -9999, 0, 1));
    const pocketAmounts = Array.from({ length: MAX_POCKETS }, () => new Vector4(0, 0.5, 1, 0));
    const lightValues = Array.from({ length: MAX_LIGHTS }, () => new Vector4(0, -9999, 0, 0));
    const lightColours = Array.from({ length: MAX_LIGHTS }, () => new Vector4(1, 0.7, 0.4, 0));
    s = {
      fog: {
        density: numU(1),
        wind: vecU(new Vector3()),
        windFine: vecU(new Vector3()),
        pocketPos: uniformArray(pocketValues, 'vec4'),
        pocketAmt: uniformArray(pocketAmounts, 'vec4'),
        pocketValues,
        pocketAmounts,
        lightPos: uniformArray(lightValues, 'vec4'),
        lightCol: uniformArray(lightColours, 'vec4'),
        lightValues,
        lightColours,
        moon: numU(0.55),
        backlight: numU(1),
        flare: numU(0),
        shimmer: numU(0),
        debug: numU(0),
      },
      noise3: null,
      noise2: null,
      backdrop: null,
      shadows: null,
      director: null,
      timeScale: 1,
      users: 0,
    };
    store.set(ctx.ground, s);
  }
  s.users++;
  return s;
}

export function release(ctx: EnvironmentContext, s: VeilShared): void {
  s.users--;
  if (s.users > 0) return;
  s.noise3?.dispose();
  s.noise2?.dispose();
  s.shadows?.dispose();
  void s.backdrop?.then((t) => t?.dispose());
  store.delete(ctx.ground);
}

/** Deterministic mulberry32. */
export function rng(seed: number): () => number {
  let st = seed >>> 0 || 1;
  return () => {
    st = (st + 0x6d2b79f5) >>> 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A tiling 3D noise volume (N³ RGBA8): four fBm sets of increasing frequency, the alpha channel an
 * inverted cellular noise (billows). The fog samples it at two scales.
 */
export function noiseVolume(s: VeilShared, N = 64): Data3DTexture {
  if (s.noise3) return s.noise3;
  const data = new Uint8Array(N * N * N * 4);
  const rnd = rng(77);
  const acc = new Float32Array(N * N * N);
  const fbmChannel = (c: number, periods: number[]) => {
    acc.fill(0);
    let amp = 1;
    let total = 0;
    for (const P of periods) {
      const lat = new Float32Array(P * P * P);
      for (let i = 0; i < lat.length; i++) lat[i] = rnd();
      const cell = N / P;
      for (let z = 0; z < N; z++) {
        const fz = z / cell;
        const z0 = Math.floor(fz);
        let tz = fz - z0;
        tz = tz * tz * (3 - 2 * tz);
        const za = (z0 % P) * P * P;
        const zb = ((z0 + 1) % P) * P * P;
        for (let y = 0; y < N; y++) {
          const fy = y / cell;
          const y0 = Math.floor(fy);
          let ty = fy - y0;
          ty = ty * ty * (3 - 2 * ty);
          const ya = (y0 % P) * P;
          const yb = ((y0 + 1) % P) * P;
          for (let x = 0; x < N; x++) {
            const fx = x / cell;
            const x0 = Math.floor(fx);
            let tx = fx - x0;
            tx = tx * tx * (3 - 2 * tx);
            const xa = x0 % P;
            const xb = (x0 + 1) % P;
            const c00 = lat[za + ya + xa]! + (lat[za + ya + xb]! - lat[za + ya + xa]!) * tx;
            const c10 = lat[za + yb + xa]! + (lat[za + yb + xb]! - lat[za + yb + xa]!) * tx;
            const c01 = lat[zb + ya + xa]! + (lat[zb + ya + xb]! - lat[zb + ya + xa]!) * tx;
            const c11 = lat[zb + yb + xa]! + (lat[zb + yb + xb]! - lat[zb + yb + xa]!) * tx;
            const a = c00 + (c10 - c00) * ty;
            const b = c01 + (c11 - c01) * ty;
            acc[(z * N + y) * N + x]! += (a + (b - a) * tz) * amp;
          }
        }
      }
      total += amp;
      amp *= 0.5;
    }
    for (let i = 0; i < acc.length; i++) data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(((acc[i]! / total - 0.5) * 1.6 + 0.5) * 255)));
  };
  fbmChannel(0, [4, 8, 16]);
  fbmChannel(1, [8, 16, 32]);
  fbmChannel(2, [16, 32]);
  // Billows: inverted distance to scattered points (tiling cellular noise).
  const P = 6;
  const pts: number[] = [];
  for (let i = 0; i < P * P * P; i++) pts.push(rnd(), rnd(), rnd());
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const px = (x / N) * P;
        const py = (y / N) * P;
        const pz = (z / N) * P;
        const cx = Math.floor(px);
        const cy = Math.floor(py);
        const cz = Math.floor(pz);
        let best = 9;
        for (let k = -1; k <= 1; k++) {
          for (let j = -1; j <= 1; j++) {
            for (let i = -1; i <= 1; i++) {
              const gx = (cx + i + P) % P;
              const gy = (cy + j + P) % P;
              const gz = (cz + k + P) % P;
              const o = (gz * P * P + gy * P + gx) * 3;
              const qx = cx + i + pts[o]!;
              const qy = cy + j + pts[o + 1]!;
              const qz = cz + k + pts[o + 2]!;
              const d = (qx - px) ** 2 + (qy - py) ** 2 + (qz - pz) ** 2;
              if (d < best) best = d;
            }
          }
        }
        data[((z * N + y) * N + x) * 4 + 3] = Math.round(Math.max(0, 1 - Math.sqrt(best) * 1.1) * 255);
      }
    }
  }
  const tex = new Data3DTexture(data, N, N, N);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.wrapR = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  s.noise3 = tex;
  return tex;
}

/** A tiling 2D value-noise fBm (256², single channel) for ground detail and water ripples. */
export function noisePlane(s: VeilShared, N = 256): DataTexture {
  if (s.noise2) return s.noise2;
  const data = new Uint8Array(N * N);
  const rnd = rng(19);
  const acc = new Float32Array(N * N);
  let amp = 1;
  let total = 0;
  for (const P of [8, 16, 32, 64]) {
    const lat = Array.from({ length: P * P }, rnd);
    const cell = N / P;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const fx = x / cell;
        const fy = y / cell;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = (fx - x0) * (fx - x0) * (3 - 2 * (fx - x0));
        const ty = (fy - y0) * (fy - y0) * (3 - 2 * (fy - y0));
        const at = (i: number, j: number) => lat[(j % P) * P + (i % P)]!;
        const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
        const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
        acc[y * N + x]! += (a + (b - a) * ty) * amp;
      }
    }
    total += amp;
    amp *= 0.55;
  }
  for (let i = 0; i < acc.length; i++) data[i] = Math.round((acc[i]! / total) * 255);
  const tex = new DataTexture(data, N, N, RedFormat, UnsignedByteType);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  s.noise2 = tex;
  return tex;
}

/**
 * A small blurred copy of the panorama band (512 px around): the fog's colour in each direction,
 * so fog in front of the photo matches it exactly. Row 0 is the top of the band.
 */
export function backdropTexture(ctx: EnvironmentContext, s: VeilShared): Promise<DataTexture | null> {
  if (s.backdrop) return s.backdrop;
  s.backdrop = (async () => {
    const url = ctx.assets.url(PANO.src);
    if (!url || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
    try {
      const blob = await (await fetch(url)).blob();
      const W = 512;
      const H = 72;
      const bmp = await createImageBitmap(blob, { resizeWidth: W, resizeHeight: H, resizeQuality: 'high' });
      const canvas = new OffscreenCanvas(W, H);
      const g = canvas.getContext('2d');
      if (!g) return null;
      g.filter = 'blur(3px)';
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
      console.warn('[the-veil] backdrop colour unavailable', err);
      return null;
    }
  })();
  return s.backdrop;
}

/** Samples the blurred photo by direction, scaled by the sky layer's exposure. */
export function backdropSampler(tex: DataTexture | null, exposure: number): { dir(d: V3): V3; at(turn: F, elevDeg: F): V3; turnOf(d: V3): F } {
  const [lo, hi] = PANO.elevation;
  const turnOf = (d: V3): F => cast<F>(atan(d.x, d.z.negate()).div(Math.PI * 2).add(PANO.offset));
  const at = (turn: F, elevDeg: F): V3 => {
    if (!tex) return cast<V3>(vec3(0.16, 0.18, 0.21).mul(exposure));
    const v = float(hi).sub(elevDeg).div(hi - lo).clamp(0.01, 0.99);
    return cast<V3>(texture(tex, vec2(turn, v)).rgb.mul(exposure));
  };
  const dir = (d: V3): V3 => at(turnOf(d), cast<F>(asin(clamp(d.y, -1, 1)).mul(180 / Math.PI)));
  return { dir, at, turnOf };
}

/** Cheap hash of a float seed into 0..1. */
export function hash(seed: F, k: number): F {
  return cast<F>(seed.mul(k).add(k * 0.618).sin().mul(43758.5453).fract());
}
