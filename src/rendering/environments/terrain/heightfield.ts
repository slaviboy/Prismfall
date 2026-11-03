import { z } from 'zod';

/**
 * Terrain height functions (pure TS). Terrain meshes are built on the CPU from these, and the same
 * functions answer ground-height queries, so creatures and props stand exactly on the surface.
 */

const band = z
  .object({
    /** Distance from the board plane (−z) where the layer starts, reaches full strength, and ends. */
    near: z.number().default(0),
    ramp: z.number().positive().default(40),
    far: z.number().default(1e6),
  })
  .optional();

const common = {
  amplitude: z.number().default(4),
  band,
  offset: z.tuple([z.number(), z.number()]).default([0, 0]),
};

export const heightLayerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('dunes'),
    ...common,
    /** Crest-to-crest distance. */
    wavelength: z.number().positive().default(46),
    /** Wind direction in degrees (crests run perpendicular to it). */
    direction: z.number().default(20),
    /** Where the crest sits in each wave (0.5 symmetric, 0.8 long windward slope and steep slip face). */
    crest: z.number().min(0.5).max(0.95).default(0.78),
    /** Crest line meander (fraction of wavelength). */
    warp: z.number().min(0).default(0.45),
    /** Amplitude variation along the crests (0 = uniform). */
    variation: z.number().min(0).max(1).default(0.5),
  }),
  z.object({ type: z.literal('ridged'), ...common, scale: z.number().positive().default(120), octaves: z.number().int().min(1).max(8).default(5), sharpness: z.number().min(1).default(2) }),
  z.object({ type: z.literal('fbm'), ...common, scale: z.number().positive().default(80), octaves: z.number().int().min(1).max(8).default(4) }),
  /** A volcano: concave cone with a crater (amplitude = height above base). */
  z.object({ type: z.literal('cone'), ...common, center: z.tuple([z.number(), z.number()]), radius: z.number().positive().default(160), crater: z.number().min(0).default(0.18), roughness: z.number().min(0).default(0.12) }),
  /** Flat-topped buttes with steep sides (desert mesas, terraces). */
  z.object({ type: z.literal('terraces'), ...common, scale: z.number().positive().default(140), steps: z.number().int().min(1).max(12).default(3), threshold: z.number().min(0).max(1).default(0.55) }),
]);

export type HeightLayer = z.infer<typeof heightLayerSchema>;

export const heightfieldSchema = z.object({
  /** Base ground level (world y). */
  base: z.number().default(-14),
  seed: z.number().default(1),
  layers: z.array(heightLayerSchema).default([]),
  /** Optional lowest height above `base` (valleys flatten into meadows); clearings may still go below. */
  floor: z.number().optional(),
  /** Keeps the area under and around the board low and calm. */
  clearing: z
    .object({ center: z.tuple([z.number(), z.number()]).default([0, 0]), radius: z.number().default(30), falloff: z.number().default(40), depth: z.number().default(0) })
    .optional(),
});

export type HeightfieldParams = z.infer<typeof heightfieldSchema>;

/** Seeded 2D gradient noise (Perlin-style, range about −1..1). */
export class Noise2 {
  private readonly perm = new Uint8Array(512);
  private readonly gx = new Float32Array(256);
  private readonly gy = new Float32Array(256);

  constructor(seed: number) {
    let s = (seed * 2654435761) >>> 0 || 1;
    const rnd = (): number => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [p[i], p[j]] = [p[j]!, p[i]!];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]!;
    for (let i = 0; i < 256; i++) {
      const a = rnd() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }

  get(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
    const u = fade(xf);
    const v = fade(yf);
    const g = (ix: number, iy: number, dx: number, dy: number): number => {
      const h = this.perm[ix + this.perm[iy]!]!;
      return this.gx[h]! * dx + this.gy[h]! * dy;
    };
    const n00 = g(X, Y, xf, yf);
    const n10 = g(X + 1, Y, xf - 1, yf);
    const n01 = g(X, Y + 1, xf, yf - 1);
    const n11 = g(X + 1, Y + 1, xf - 1, yf - 1);
    const a = n00 + (n10 - n00) * u;
    const b = n01 + (n11 - n01) * u;
    return (a + (b - a) * v) * 1.4;
  }

  fbm(x: number, y: number, octaves: number): number {
    let sum = 0;
    let amp = 0.5;
    let f = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.get(x * f + i * 17.3, y * f - i * 9.1) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / norm;
  }
}

const smooth = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/** Builds the height function for a heightfield description. */
export function createHeightfield(params: HeightfieldParams): (x: number, z: number) => number {
  const noises = params.layers.map((_, i) => new Noise2(params.seed * 131 + i * 977));
  const layers = params.layers.map((layer, i) => {
    const n = noises[i]!;
    const [ox, oz] = layer.offset;
    const weight = (z: number): number => {
      if (!layer.band) return 1;
      const d = -z;
      const rampIn = smooth((d - layer.band.near) / layer.band.ramp);
      const rampOut = 1 - smooth((d - layer.band.far) / layer.band.ramp);
      return rampIn * rampOut;
    };
    switch (layer.type) {
      case 'dunes': {
        const a = (layer.direction * Math.PI) / 180;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const w = layer.wavelength;
        return (x: number, z: number): number => {
          const px = x + ox;
          const pz = z + oz;
          const u = px * ca + pz * sa;
          const v = -px * sa + pz * ca;
          const meander = n.get(v / (w * 2.2), 3.7) * layer.warp * w + n.get(v / (w * 0.9), u / (w * 4)) * layer.warp * 0.35 * w;
          const phase = (u + meander) / w;
          const s = phase - Math.floor(phase);
          const c = layer.crest;
          const profile = s < c ? smooth(s / c) : smooth((1 - s) / (1 - c));
          // Slightly rounded troughs, sharp crests.
          const shaped = Math.pow(profile, 1.25);
          const vary = 1 - layer.variation * 0.5 * (1 + n.get(v / (w * 3.1) + 11.3, u / (w * 5)));
          // Smaller cross dunes break up the regularity.
          const cross = n.get(px / (w * 0.6), pz / (w * 0.6)) * 0.16;
          return (shaped * vary + cross) * layer.amplitude * weight(z);
        };
      }
      case 'ridged':
        return (x: number, z: number): number => {
          let sum = 0;
          let amp = 0.5;
          let f = 1 / layer.scale;
          let prev = 1;
          for (let o = 0; o < layer.octaves; o++) {
            const r = 1 - Math.abs(n.get((x + ox) * f + o * 13.1, (z + oz) * f - o * 7.7));
            const ridge = Math.pow(r, layer.sharpness) * prev;
            sum += ridge * amp;
            prev = ridge;
            amp *= 0.5;
            f *= 2.1;
          }
          return sum * layer.amplitude * weight(z);
        };
      case 'fbm':
        return (x: number, z: number): number => n.fbm((x + ox) / layer.scale, (z + oz) / layer.scale, layer.octaves) * layer.amplitude * weight(z);
      case 'cone':
        return (x: number, z: number): number => {
          const d = Math.hypot(x - layer.center[0], z - layer.center[1]) / layer.radius;
          if (d >= 1) return 0;
          // Concave flanks rising to a rim, then a crater bowl inside.
          const flank = Math.pow(1 - d, 2.2);
          const rimAt = layer.crater;
          const bowl = d < rimAt ? 1 - Math.pow(1 - d / rimAt, 2) * 0.35 : 1;
          const rough = 1 + n.fbm(x / 40, z / 40, 3) * layer.roughness * (1 - d);
          return flank * bowl * rough * layer.amplitude * weight(z);
        };
      case 'terraces':
        return (x: number, z: number): number => {
          const v = n.fbm((x + ox) / layer.scale, (z + oz) / layer.scale, 3) * 0.5 + 0.5;
          const t = Math.max(0, (v - layer.threshold) / (1 - layer.threshold));
          const stepped = t * layer.steps;
          const k = Math.floor(stepped);
          const f = stepped - k;
          // Steep risers between flat treads.
          const riser = smooth((f - 0.75) / 0.25);
          return ((k + riser) / layer.steps) * layer.amplitude * weight(z);
        };
    }
  });
  const clearing = params.clearing;
  return (x: number, z: number): number => {
    let h = 0;
    for (const f of layers) h += f(x, z);
    if (params.floor !== undefined && h < params.floor) {
      // Soft floor: valleys ease into flats instead of cutting off sharply.
      const d = params.floor - h;
      h = params.floor - d / (1 + d);
    }
    if (clearing) {
      const d = Math.hypot(x - clearing.center[0], z - clearing.center[1]);
      const k = smooth((d - clearing.radius) / clearing.falloff);
      h = h * k + clearing.depth * (1 - k);
    }
    return params.base + h;
  };
}

/** Surface normal by central differences. */
export function heightNormal(height: (x: number, z: number) => number, x: number, z: number, eps = 0.5): [number, number, number] {
  const dx = (height(x + eps, z) - height(x - eps, z)) / (2 * eps);
  const dz = (height(x, z + eps) - height(x, z - eps)) / (2 * eps);
  const l = Math.hypot(dx, 1, dz);
  return [-dx / l, 1 / l, -dz / l];
}
