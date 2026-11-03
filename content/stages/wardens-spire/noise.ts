import { Data3DTexture, LinearFilter, RGBAFormat, RepeatWrapping, UnsignedByteType } from 'three/webgpu';

/**
 * Tileable 3D noise for the storm clouds and the beam's drifting smoke, built once on the CPU:
 * R = Perlin-Worley billows (low frequency), G and B = Worley fBm at two higher frequencies (for
 * eroding cloud edges), A = Perlin fBm (smoke and dust). Every channel repeats over the cube.
 */

function mulberry(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Periodic gradient noise with `period` lattice cells across the unit cube. */
function perlin(period: number, rand: () => number): (x: number, y: number, z: number) => number {
  const grads = new Float32Array(period * period * period * 3);
  for (let i = 0; i < period * period * period; i++) {
    const u = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    grads[i * 3] = r * Math.cos(a);
    grads[i * 3 + 1] = r * Math.sin(a);
    grads[i * 3 + 2] = u;
  }
  const g = (ix: number, iy: number, iz: number, fx: number, fy: number, fz: number) => {
    const i = (((ix % period) + period) % period) + ((((iy % period) + period) % period) + (((iz % period) + period) % period) * period) * period;
    return grads[i * 3]! * fx + grads[i * 3 + 1]! * fy + grads[i * 3 + 2]! * fz;
  };
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y, z) => {
    const px = x * period;
    const py = y * period;
    const pz = z * period;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const iz = Math.floor(pz);
    const fx = px - ix;
    const fy = py - iy;
    const fz = pz - iz;
    const u = fade(fx);
    const v = fade(fy);
    const w = fade(fz);
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(
      l(l(g(ix, iy, iz, fx, fy, fz), g(ix + 1, iy, iz, fx - 1, fy, fz), u), l(g(ix, iy + 1, iz, fx, fy - 1, fz), g(ix + 1, iy + 1, iz, fx - 1, fy - 1, fz), u), v),
      l(l(g(ix, iy, iz + 1, fx, fy, fz - 1), g(ix + 1, iy, iz + 1, fx - 1, fy, fz - 1), u), l(g(ix, iy + 1, iz + 1, fx, fy - 1, fz - 1), g(ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1), u), v),
      w,
    );
  };
}

/** Periodic Worley (F1) noise, inverted so cell centres are 1 and borders 0. */
function worley(period: number, rand: () => number): (x: number, y: number, z: number) => number {
  const pts = new Float32Array(period * period * period * 3);
  for (let i = 0; i < pts.length; i++) pts[i] = rand();
  return (x, y, z) => {
    const px = x * period;
    const py = y * period;
    const pz = z * period;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const iz = Math.floor(pz);
    let best = 9;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ix + dx;
          const cy = iy + dy;
          const cz = iz + dz;
          const i = (((cx % period) + period) % period) + ((((cy % period) + period) % period) + (((cz % period) + period) % period) * period) * period;
          const ox = cx + pts[i * 3]! - px;
          const oy = cy + pts[i * 3 + 1]! - py;
          const oz = cz + pts[i * 3 + 2]! - pz;
          const d = ox * ox + oy * oy + oz * oz;
          if (d < best) best = d;
        }
      }
    }
    return 1 - Math.min(1, Math.sqrt(best));
  };
}

const cache = new Map<number, Promise<Data3DTexture>>();

/** The shared noise cube (n³ texels, RGBA8, repeating, linear filtered). */
export function cloudNoise(n: number): Promise<Data3DTexture> {
  let p = cache.get(n);
  if (!p) {
    p = build(n);
    cache.set(n, p);
  }
  return p;
}

async function build(n: number): Promise<Data3DTexture> {
  const rand = mulberry(9157);
  const p4 = perlin(4, rand);
  const p8 = perlin(8, rand);
  const p16 = perlin(16, rand);
  const p32 = perlin(32, rand);
  const w4 = worley(4, rand);
  const w8 = worley(8, rand);
  const w16 = worley(16, rand);
  const w32 = worley(32, rand);
  const data = new Uint8Array(n * n * n * 4);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let k = 0; k < n; k++) {
    // Yield now and then so a slow device does not freeze while the world builds.
    if (k % 8 === 7) await new Promise((r) => setTimeout(r, 0));
    const z = k / n;
    for (let j = 0; j < n; j++) {
      const y = j / n;
      for (let i = 0; i < n; i++) {
        const x = i / n;
        const pf = p4(x, y, z) * 0.62 + p8(x, y, z) * 0.26 + p16(x, y, z) * 0.12;
        const perl = Math.min(1, Math.max(0, pf * 0.75 + 0.5));
        const wf = w4(x, y, z) * 0.62 + w8(x, y, z) * 0.26 + w16(x, y, z) * 0.12;
        // Perlin-Worley: billowy Perlin, remapped by the Worley fBm.
        const pw = Math.min(1, Math.max(0, (perl - (1 - wf)) / Math.max(1e-3, 1 - (1 - wf)) * 0.6 + perl * 0.4));
        const g = w8(x, y, z) * 0.62 + w16(x, y, z) * 0.26 + w32(x, y, z) * 0.12;
        const b = w16(x, y, z) * 0.62 + w32(x, y, z) * 0.38;
        const a = Math.min(1, Math.max(0, (p8(x, y, z) * 0.55 + p16(x, y, z) * 0.3 + p32(x, y, z) * 0.15) * 0.8 + 0.5));
        const o = (i + (j + k * n) * n) * 4;
        data[o] = clamp(pw);
        data[o + 1] = clamp(g);
        data[o + 2] = clamp(b);
        data[o + 3] = clamp(a);
      }
    }
  }
  const tex = new Data3DTexture(data, n, n, n);
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
  return tex;
}
