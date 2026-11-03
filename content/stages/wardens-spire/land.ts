import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  DataUtils,
  Group,
  HalfFloatType,
  InstancedBufferAttribute,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  RGBAFormat,
  SpriteNodeMaterial,
  Sprite,
  Vector4,
  type Material,
  type Object3D,
  type Texture,
} from 'three/webgpu';
import {
  asin,
  atan,
  attribute,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  fract,
  instancedBufferAttribute,
  int,
  length,
  mix,
  mrt,
  mx_noise_float,
  mx_worley_noise_vec2,
  normalWorldGeometry,
  normalize,
  positionWorld,
  sin,
  smoothstep,
  texture,
  texture3D,
  uniform,
  uniformArray,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { additiveFog, colorUniform, seeded, z, zColor, type ComponentFactory, type EnvironmentContext } from '@prismfall/sdk';
import {
  COLORS,
  duskLight,
  DEG,
  EYE,
  clearMask,
  duoplanar,
  lavaUplight,
  macro,
  noise3D,
  polar,
  release,
  revealMask,
  shared,
  siteCentre,
  spireLight,
  stageTexture,
  triplanar,
  triplanarNormal,
  zSite,
  type F,
  type V3,
} from './shared';

/**
 * The volcanic land around the Warden's Spire: a heightfield built once on the CPU (ridged
 * plains, far mountains, the citadel's plateau with its scarp), lava rivers carved into real
 * channels with banks (one runs in a deep ravine), and ruins placed on the ground: broken towers
 * and walls, a fallen bridge over the ravine, some of them burning. Textured with photographed
 * rock (Poly Haven), lit by the Warden's beam, the lightning and the lava itself.
 */

const zRiver = z.object({
  /** Points as [view azimuth (deg), distance from the eye (m)]. */
  points: z.array(z.tuple([z.number(), z.number()])).min(2),
  /** Width of the molten channel (m) at the first and the last point. */
  width: z.tuple([z.number(), z.number()]).default([14, 24]),
  /** Bank width (m): how far the channel walls reach. */
  bank: z.number().default(9),
  /** Extra depth (m) below the surrounding land (a ravine when large). */
  depth: z.number().default(6),
  /** Where the ravine (extra `canyon` depth and wide walls) runs, as 0..1 along the river. */
  canyon: z.tuple([z.number(), z.number()]).optional(),
  canyonDepth: z.number().default(30),
  canyonWidth: z.number().default(38),
});

const zRuin = z.object({
  piece: z.enum(['ruin_tower_a', 'ruin_tower_b', 'ruin_wall_a', 'ruin_wall_b', 'ruin_spire', 'ruin_gate']),
  at: z.tuple([z.number(), z.number()]),
  yaw: z.number().default(0),
  scale: z.number().default(1),
  sink: z.number().default(2),
  burning: z.boolean().default(false),
});

const schema = z.object({
  seed: z.number().default(17),
  site: zSite,
  /** Base level of the plains (m). */
  base: z.number().default(-58),
  /** Ground level near the board (m). */
  near: z.number().default(-17),
  rivers: z.array(zRiver).default([]),
  ruins: z.array(zRuin).default([]),
  /** The fallen bridge across a river: river index and position along it (0..1). */
  bridge: z.object({ river: z.number().int().min(0), at: z.number().min(0).max(1), scale: z.number().default(1.4) }).optional(),
  /** Far mountains: [azimuth from, azimuth to, height (m), distance from (m)]. */
  mountains: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])).default([]),
  mesh: z
    .object({ near: z.number().default(16), far: z.number().default(1950), rows: z.number().int().default(380), front: z.number().default(62), frontStep: z.number().default(0.24), backStep: z.number().default(1.6) })
    .prefault({}),
  textures: z
    .object({
      ground: z.string().default('textures/quarry_wall_diff.webp'),
      groundNormal: z.string().default('textures/quarry_wall_normal.webp'),
      rock: z.string().default('textures/dark_rock_02_diff.webp'),
      rockNormal: z.string().default('textures/dark_rock_02_normal.webp'),
    })
    .prefault({}),
  /** Ground colour grade: multiplier on the photographed albedo, and a tint. */
  albedo: z.number().default(1.3),
  tint: z.tuple([z.number(), z.number(), z.number()]).default([1.0, 0.9, 0.86]),
  lava: z.object({ strength: z.number().default(1), speed: z.number().default(0.6), bloom: z.number().default(0.35) }).prefault({}),
  fissures: z.number().default(1),
  /** Glow of the cracks in the cooled crust across the plain. */
  crustGlow: z.number().default(1),
  /** The sky photo the far land dissolves into (same numbers as the sky layer's panorama). */
  horizon: z
    .object({ src: z.string().default('textures/toposcope_sunset_band.webp'), elevation: z.tuple([z.number(), z.number()]).default([-10, 24]), offset: z.number().default(0.45), exposure: z.number().default(0.85), from: z.number().default(1150), to: z.number().default(1900) })
    .prefault({}),
  /** The scene fog's colour (the land fogs itself so its far edge can meet the photo). */
  fogColor: zColor.default('#2e1410'),
});

type Params = z.infer<typeof schema>;

// ------------------------------------------------------------------------------------------------
// CPU noise
// ------------------------------------------------------------------------------------------------

function perlin2(seed: number): (x: number, y: number) => number {
  const rand = seeded(seed);
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]!;
  // The eight gradient directions (k·45°), looked up: the terrain samples this millions of times.
  const gx = Float64Array.from({ length: 8 }, (_, k) => Math.cos(k * (Math.PI / 4)));
  const gy = Float64Array.from({ length: 8 }, (_, k) => Math.sin(k * (Math.PI / 4)));
  const grad = (h: number, x: number, y: number) => gx[h & 7]! * x + gy[h & 7]! * y;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const X = Math.floor(x);
    const Y = Math.floor(y);
    const fx = x - X;
    const fy = y - Y;
    const xi = X & 255;
    const yi = Y & 255;
    const u = fade(fx);
    const v = fade(fy);
    const aa = perm[perm[xi]! + yi]!;
    const ab = perm[perm[xi]! + yi + 1]!;
    const ba = perm[perm[xi + 1]! + yi]!;
    const bb = perm[perm[xi + 1]! + yi + 1]!;
    const gaa = grad(aa, fx, fy);
    const gab = grad(ab, fx, fy - 1);
    const l1 = gaa + (grad(ba, fx - 1, fy) - gaa) * u;
    const l2 = gab + (grad(bb, fx - 1, fy - 1) - gab) * u;
    return (l1 + (l2 - l1) * v) * 1.41;
  };
}

function fbm(n: (x: number, y: number) => number, x: number, y: number, octaves: number): number {
  let a = 0.5;
  let f = 1;
  let s = 0;
  for (let i = 0; i < octaves; i++) {
    s += a * n(x * f + i * 17.1, y * f - i * 9.3);
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}

function ridged(n: (x: number, y: number) => number, x: number, y: number, octaves: number): number {
  let a = 0.5;
  let f = 1;
  let s = 0;
  let w = 1;
  for (let i = 0; i < octaves; i++) {
    let v = 1 - Math.abs(n(x * f + i * 31.7, y * f + i * 11.9));
    v *= v;
    v *= w;
    w = Math.min(1, Math.max(0, v * 1.6));
    s += v * a;
    f *= 2.1;
    a *= 0.5;
  }
  return s;
}

/** Cellular noise: distances to the nearest and second-nearest jittered cell points, and a cell id (0..1). */
function voronoi(seed: number): (x: number, y: number) => { f1: number; f2: number; id: number } {
  const h = (i: number, j: number, k: number) => {
    let t = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k + seed, 1442695041)) | 0;
    t = Math.imul(t ^ (t >>> 13), 1274126177);
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  };
  return (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    let f1 = 9;
    let f2 = 9;
    let id = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const cx = ix + i;
        const cy = iy + j;
        const px = cx + 0.1 + 0.8 * h(cx, cy, 1);
        const py = cy + 0.1 + 0.8 * h(cx, cy, 2);
        const d = Math.hypot(px - x, py - y);
        if (d < f1) {
          f2 = f1;
          f1 = d;
          id = h(cx, cy, 3);
        } else if (d < f2) f2 = d;
      }
    }
    return { f1, f2, id };
  };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------------------------------------
// Rivers
// ------------------------------------------------------------------------------------------------

interface RiverSample {
  x: number;
  z: number;
  tx: number;
  tz: number;
  width: number;
  t: number;
  bed: number;
  canyon: number;
}

/** Catmull-Rom through the polar points, resampled every few metres. */
function riverSamples(r: z.infer<typeof zRiver>): RiverSample[] {
  const pts = r.points.map(([a, d]) => polar(a, d));
  const out: RiverSample[] = [];
  const seg = pts.length - 1;
  const at = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))]!;
  for (let i = 0; i < seg; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(2, Math.ceil(len / 4));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: cr(p0[0], p1[0], p2[0], p3[0]), z: cr(p0[1], p1[1], p2[1], p3[1]), tx: 0, tz: 0, width: 0, t: 0, bed: 0, canyon: 0 });
    }
  }
  const last = pts[pts.length - 1]!;
  out.push({ x: last[0], z: last[1], tx: 0, tz: 0, width: 0, t: 0, bed: 0, canyon: 0 });
  for (let i = 0; i < out.length; i++) {
    const a = out[Math.max(0, i - 1)]!;
    const b = out[Math.min(out.length - 1, i + 1)]!;
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const s = out[i]!;
    s.tx = (b.x - a.x) / l;
    s.tz = (b.z - a.z) / l;
    s.t = i / (out.length - 1);
    s.width = r.width[0] + (r.width[1] - r.width[0]) * s.t;
    s.canyon = r.canyon ? smooth(r.canyon[0] - 0.06, r.canyon[0] + 0.04, s.t) * (1 - smooth(r.canyon[1] - 0.04, r.canyon[1] + 0.06, s.t)) : 0;
  }
  return out;
}

/** Per-cell nearest-river data over the land (and a GPU copy: distance, flow, width). */
interface RiverField {
  readonly x0: number;
  readonly z0: number;
  readonly cell: number;
  readonly nx: number;
  readonly nz: number;
  readonly dist: Float32Array;
  readonly width: Float32Array;
  readonly bed: Float32Array;
  readonly bank: Float32Array;
  readonly canyon: Float32Array;
  readonly canyonWidth: Float32Array;
  readonly flowX: Float32Array;
  readonly flowZ: Float32Array;
}

const FAR_DIST = 90;

function buildRiverField(rivers: { def: z.infer<typeof zRiver>; samples: RiverSample[] }[], x0: number, z0: number, x1: number, z1: number, cell: number): RiverField {
  const nx = Math.ceil((x1 - x0) / cell);
  const nz = Math.ceil((z1 - z0) / cell);
  const n = nx * nz;
  const f: RiverField = {
    x0,
    z0,
    cell,
    nx,
    nz,
    dist: new Float32Array(n).fill(FAR_DIST),
    width: new Float32Array(n),
    bed: new Float32Array(n),
    bank: new Float32Array(n),
    canyon: new Float32Array(n),
    canyonWidth: new Float32Array(n),
    flowX: new Float32Array(n),
    flowZ: new Float32Array(n),
  };
  // Stamp each segment into the cells around it (nearest wins).
  for (const { def, samples } of rivers) {
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i]!;
      const b = samples[i + 1]!;
      const reach = a.width / 2 + def.bank + (a.canyon > 0 ? def.canyonWidth : 0) + 30;
      const minX = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - x0) / cell));
      const maxX = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x) + reach - x0) / cell));
      const minZ = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach - z0) / cell));
      const maxZ = Math.min(nz - 1, Math.ceil((Math.max(a.z, b.z) + reach - z0) / cell));
      const ex = b.x - a.x;
      const ez = b.z - a.z;
      const el = ex * ex + ez * ez || 1;
      for (let j = minZ; j <= maxZ; j++) {
        const pz = z0 + (j + 0.5) * cell;
        for (let k = minX; k <= maxX; k++) {
          const px = x0 + (k + 0.5) * cell;
          const t = Math.max(0, Math.min(1, ((px - a.x) * ex + (pz - a.z) * ez) / el));
          const qx = a.x + ex * t - px;
          const qz = a.z + ez * t - pz;
          const d = Math.sqrt(qx * qx + qz * qz);
          const idx = j * nx + k;
          if (d < f.dist[idx]!) {
            f.dist[idx] = d;
            f.width[idx] = a.width + (b.width - a.width) * t;
            f.bed[idx] = a.bed + (b.bed - a.bed) * t;
            f.bank[idx] = def.bank;
            f.canyon[idx] = (a.canyon + (b.canyon - a.canyon) * t) * def.canyonDepth;
            f.canyonWidth[idx] = def.canyonWidth;
            f.flowX[idx] = a.tx;
            f.flowZ[idx] = a.tz;
          }
        }
      }
    }
  }
  return f;
}

function fieldAt(f: RiverField, arr: Float32Array, x: number, z: number): number {
  const fx = (x - f.x0) / f.cell - 0.5;
  const fz = (z - f.z0) / f.cell - 0.5;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const get = (i: number, j: number) => {
    const a = Math.max(0, Math.min(f.nx - 1, i));
    const b = Math.max(0, Math.min(f.nz - 1, j));
    return arr[b * f.nx + a]!;
  };
  if (ix < -1 || iz < -1 || ix > f.nx || iz > f.nz) return arr === f.dist ? FAR_DIST : 0;
  const a = get(ix, iz) + (get(ix + 1, iz) - get(ix, iz)) * tx;
  const b = get(ix, iz + 1) + (get(ix + 1, iz + 1) - get(ix, iz + 1)) * tx;
  return a + (b - a) * tz;
}

/** Nearest-cell lookup (for values that must not blend between rivers). */
function fieldNearest(f: RiverField, arr: Float32Array, x: number, z: number): number {
  const i = Math.max(0, Math.min(f.nx - 1, Math.floor((x - f.x0) / f.cell)));
  const j = Math.max(0, Math.min(f.nz - 1, Math.floor((z - f.z0) / f.cell)));
  return arr[j * f.nx + i]!;
}

// ------------------------------------------------------------------------------------------------
// Component
// ------------------------------------------------------------------------------------------------

export const landComponent: ComponentFactory<Params> = {
  type: 'wardenSpireLand',
  version: 1,
  description: 'The volcanic land of the Warden’s Spire: ridged plains, the citadel’s plateau, lava rivers carved into channels and a ravine, ruins (some burning) and a fallen bridge.',
  schema,
  async create(ctx: EnvironmentContext, p: Params) {
    const s = shared(ctx);
    const group = new Group();
    group.name = 'wardens-spire-land';
    const n1 = perlin2(p.seed);
    const n2 = perlin2(p.seed + 101);
    const n3 = perlin2(p.seed + 202);
    const site = siteCentre(p.site);
    const cells = voronoi(p.seed * 7 + 1);
    const cellsFine = voronoi(p.seed * 7 + 2);

    /**
     * Cooled lava crust: polygonal plates (each at its own height, a little tilted), split by
     * cracks. Returns the height offset, the crack strength (0..1) and the plate's tone.
     */
    const plateCrust = (x: number, zz: number, r: number) => {
      const field = smooth(0.0, 0.35, fbm(n3, x / 620 + 11.3, zz / 620 - 4.1, 2) + 0.12);
      const near = 1 - smooth(650, 1050, r);
      const k = field * near;
      if (k <= 0.001) return { dh: 0, crack: 0, tone: 0.5, k: 0 };
      const c = cells(x / 26, zz / 26);
      const edge = c.f2 - c.f1;
      const crack = 1 - smooth(0.0, 0.08, edge);
      let dh = (c.id - 0.5) * 2.6 - crack * 1.6 + (fbm(n1, x / 9, zz / 9, 2) * 0.35);
      if (r < 320) {
        const f = cellsFine(x / 7.5, zz / 7.5);
        const fc = 1 - smooth(0.0, 0.1, f.f2 - f.f1);
        dh += (f.id - 0.5) * 0.55 - fc * 0.45;
      }
      return { dh: dh * k, crack: crack * k, tone: c.id, k };
    };

    // --- Uncarved height.
    const raw = (x: number, zz: number): number => {
      const dx = x - EYE[0];
      const dz = zz - EYE[2];
      const r = Math.hypot(dx, dz);
      const az = Math.atan2(dx, -dz) / DEG;
      let h = p.base;
      // Broad ridged country, then old lava flows: stacked lobes with steep, broken fronts.
      let large = (ridged(n1, x / 760, zz / 760, 5) - 0.35) * 52;
      large += fbm(n2, x / 190, zz / 190, 4) * 12;
      const lobe = (fbm(n2, x / 420 + 3.7, zz / 420 - 1.9, 3) + 0.5) * 3.4 + fbm(n3, x / 90, zz / 90, 2) * 0.35;
      const step = Math.floor(lobe);
      large += (step + smooth(0.86, 0.97, lobe - step)) * 7.5;
      // Crags: sharp-crested ridges of broken basalt in places.
      const crag = Math.pow(Math.max(0, ridged(n3, x / 150 + 4.2, zz / 150 - 7.7, 4) - 0.45), 1.6) * 34 * smooth(0.1, 0.45, fbm(n1, x / 900, zz / 900, 2) + 0.2);
      large += crag;
      // Rough rock at every scale (kept near the board too).
      let fine = (ridged(n3, x / 52, zz / 52, 3) - 0.3) * 5.5;
      fine += fbm(n1, x / 13, zz / 13, 3) * 1.4;
      fine += fbm(n2, x / 3.5, zz / 3.5, 2) * 0.28;
      // Far mountains.
      for (const [a0, a1, height, from] of p.mountains) {
        const inAz = smooth(a0 - 6, a0 + 4, az) * (1 - smooth(a1 - 4, a1 + 6, az));
        if (inAz <= 0) continue;
        const rise = smooth(from, from + 420, r);
        const m = ridged(n2, x / 340 + 7.3, zz / 340 - 3.1, 5);
        h += inAz * rise * (m * 0.85 + 0.15) * height;
      }
      h += large;
      // The rise the viewer stands on, around the board (its large forms flattened, the rock kept).
      const nearK = smooth(300, 70, r);
      h = h + (p.near + fbm(n3, x / 40, zz / 40, 3) * 5 - h) * nearK * 0.9;
      h += fine;
      h += plateCrust(x, zz, r).dh;
      // The citadel's plateau and its scarp.
      const ds = Math.hypot(x - site[0], zz - site[2]);
      const rim = p.site.radius + fbm(n2, x / 60, zz / 60, 3) * 40;
      const plateau = 1 - smooth(rim, rim + 60, ds);
      h = h + (p.site.plateau + fbm(n3, x / 30, zz / 30, 2) * 1.5 - h) * plateau;
      return h;
    };

    // --- Rivers: beds follow the smoothed land along them, minus their depth.
    const rivers = p.rivers.map((def) => ({ def, samples: riverSamples(def) }));
    for (const { def, samples } of rivers) {
      const lows = samples.map((q) => {
        let m = Infinity;
        for (let k = -1; k <= 1; k++) for (let l = -1; l <= 1; l++) m = Math.min(m, raw(q.x + k * q.width * 0.5, q.z + l * q.width * 0.5));
        return m;
      });
      // Low-pass along the river, then never above the land minus the depth.
      const smoothLows = lows.map((_, i) => {
        let sum = 0;
        let w = 0;
        for (let k = -12; k <= 12; k++) {
          const j = Math.max(0, Math.min(lows.length - 1, i + k));
          const ww = 1 - Math.abs(k) / 13;
          sum += lows[j]! * ww;
          w += ww;
        }
        return sum / w;
      });
      samples.forEach((q, i) => {
        q.bed = Math.min(smoothLows[i]!, lows[i]! + 1) - def.depth - q.canyon * def.canyonDepth;
      });
    }
    const field = buildRiverField(rivers, -1900, -2000, 1900, 200, 3.2);

    const height = (x: number, zz: number): number => {
      let h = raw(x, zz);
      const d = fieldAt(field, field.dist, x, zz);
      if (d < FAR_DIST - 1) {
        const w = fieldNearest(field, field.width, x, zz) / 2;
        const bed = fieldAt(field, field.bed, x, zz);
        const bank = fieldNearest(field, field.bank, x, zz);
        const canyon = fieldAt(field, field.canyon, x, zz);
        const cw = fieldNearest(field, field.canyonWidth, x, zz);
        // Channel walls (steep), widened into a ravine where the canyon runs.
        const wall = w + bank + (canyon > 0.5 ? cw * Math.min(1, canyon / 10) : 0);
        const k = smooth(w * 0.85, wall, d);
        const carved = bed + (h - bed) * Math.pow(k, canyon > 0.5 ? 1.6 : 0.8);
        h = Math.min(h, carved);
      }
      return h;
    };
    ctx.ground.provide(height);
    s.riverDistance = (x: number, zz: number) => fieldAt(field, field.dist, x, zz) - fieldNearest(field, field.width, x, zz) / 2;

    // --- Mesh: a polar grid around the eye, fine in front, coarse behind (VR).
    const q = ctx.quality.detail;
    const detailK = q === 'low' ? 0.5 : q === 'medium' ? 0.75 : q === 'high' ? 1 : 1.25;
    const rows = Math.round(p.mesh.rows * detailK);
    const angles: number[] = [];
    {
      const fs = p.mesh.frontStep / detailK;
      const bs = p.mesh.backStep / Math.sqrt(detailK);
      let a = -180;
      while (a < 180) {
        angles.push(a);
        const inFront = Math.abs(a) < p.mesh.front;
        const nearFront = Math.abs(a) < p.mesh.front + 10;
        a += inFront ? fs : nearFront ? (fs + bs) / 2 : bs;
      }
    }
    const cols = angles.length;
    const radii: number[] = [];
    for (let i = 0; i < rows; i++) radii.push(p.mesh.near * Math.pow(p.mesh.far / p.mesh.near, i / (rows - 1)));
    const pos = new Float32Array(rows * cols * 3);
    const crustAttr = new Float32Array(rows * cols * 3);
    const nor = new Float32Array(rows * cols * 3);
    // The height field is costly (dozens of noise octaves per point): each vertex samples it
    // once, normals come from the neighbouring vertices, and the browser gets a turn every few
    // rows so loading never freezes the page.
    const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    let vi = 0;
    for (let i = 0; i < rows; i++) {
      if (i % 16 === 15) await breathe();
      const r = radii[i]!;
      for (let j = 0; j < cols; j++) {
        const a = angles[j]! * DEG;
        const x = EYE[0] + Math.sin(a) * r;
        const zz = EYE[2] - Math.cos(a) * r;
        pos[vi * 3] = x;
        pos[vi * 3 + 1] = height(x, zz);
        pos[vi * 3 + 2] = zz;
        const cr = plateCrust(x, zz, r);
        // Lava channels and their banks carry no crust cracks.
        const inRiver = fieldAt(field, field.dist, x, zz) < fieldNearest(field, field.width, x, zz) / 2 + 6 ? 0 : 1;
        crustAttr[vi * 3] = cr.crack * inRiver;
        crustAttr[vi * 3 + 1] = cr.k * inRiver;
        crustAttr[vi * 3 + 2] = cr.tone;
        vi++;
      }
    }
    // Normals: the cross product of the grid's radial and angular tangents (angles wrap round).
    for (let i = 0; i < rows; i++) {
      const i0 = Math.max(0, i - 1) * cols;
      const i1 = Math.min(rows - 1, i + 1) * cols;
      for (let j = 0; j < cols; j++) {
        const v = i * cols + j;
        const jl = i * cols + ((j + cols - 1) % cols);
        const jr = i * cols + ((j + 1) % cols);
        const rx = pos[(i1 + j) * 3]! - pos[(i0 + j) * 3]!;
        const ry = pos[(i1 + j) * 3 + 1]! - pos[(i0 + j) * 3 + 1]!;
        const rz = pos[(i1 + j) * 3 + 2]! - pos[(i0 + j) * 3 + 2]!;
        const ax = pos[jr * 3]! - pos[jl * 3]!;
        const ay = pos[jr * 3 + 1]! - pos[jl * 3 + 1]!;
        const az = pos[jr * 3 + 2]! - pos[jl * 3 + 2]!;
        let nx = ry * az - rz * ay;
        let ny = rz * ax - rx * az;
        let nz = rx * ay - ry * ax;
        if (ny < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        const nl = Math.hypot(nx, ny, nz) || 1;
        nor[v * 3] = nx / nl;
        nor[v * 3 + 1] = ny / nl;
        nor[v * 3 + 2] = nz / nl;
      }
    }
    const index = new Uint32Array((rows - 1) * cols * 6);
    let ii = 0;
    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < cols; j++) {
        const j1 = (j + 1) % cols;
        const a = i * cols + j;
        const b = i * cols + j1;
        const c = (i + 1) * cols + j;
        const d = (i + 1) * cols + j1;
        // Counter-clockwise seen from above (front faces up).
        index[ii++] = a;
        index[ii++] = b;
        index[ii++] = c;
        index[ii++] = b;
        index[ii++] = d;
        index[ii++] = c;
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new BufferAttribute(nor, 3));
    geometry.setAttribute('crust', new BufferAttribute(crustAttr, 3));
    geometry.setIndex(new BufferAttribute(index, 1));
    geometry.computeBoundingSphere();

    // --- River texture for the shader: distance (m), flow direction, channel half-width.
    const tdata = new Uint16Array(field.nx * field.nz * 4);
    for (let i = 0; i < field.nx * field.nz; i++) {
      tdata[i * 4] = DataUtils.toHalfFloat(field.dist[i]!);
      tdata[i * 4 + 1] = DataUtils.toHalfFloat(field.flowX[i]!);
      tdata[i * 4 + 2] = DataUtils.toHalfFloat(field.flowZ[i]!);
      tdata[i * 4 + 3] = DataUtils.toHalfFloat(field.width[i]! / 2);
    }
    const riverTex = new DataTexture(tdata, field.nx, field.nz, RGBAFormat, HalfFloatType);
    riverTex.wrapS = ClampToEdgeWrapping;
    riverTex.wrapT = ClampToEdgeWrapping;
    riverTex.magFilter = LinearFilter;
    riverTex.minFilter = LinearFilter;
    riverTex.generateMipmaps = false;
    riverTex.needsUpdate = true;
    s.river = { tex: riverTex, x0: field.x0, z0: field.z0, w: field.nx * field.cell, h: field.nz * field.cell };

    const [ground, groundN, rock, rockN, noise, photo] = await Promise.all([
      stageTexture(ctx, s, p.textures.ground, 'color'),
      stageTexture(ctx, s, p.textures.groundNormal, 'data'),
      stageTexture(ctx, s, p.textures.rock, 'color'),
      stageTexture(ctx, s, p.textures.rockNormal, 'data'),
      noise3D(s),
      stageTexture(ctx, s, p.horizon.src, 'color'),
    ]);

    const u = { presence: uniform(1), music: uniform(0) };
    const time = ctx.uniforms.time;
    const wp = positionWorld;
    const camDist = length(wp.sub(cameraPosition));
    const ng = normalWorldGeometry;
    const fieldUv = vec2(wp.x.sub(field.x0).div(field.nx * field.cell), wp.z.sub(field.z0).div(field.nz * field.cell));
    const rv = texture(riverTex, fieldUv);
    const rDist = rv.x;
    const flow = vec2(rv.y, rv.z);
    const halfW = rv.w;
    const lavaMask = smoothstep(halfW.add(0.6), halfW.sub(1.4), rDist).mul(smoothstep(FAR_DIST - 2, FAR_DIST - 6, rDist));
    const nearLava = exp(rDist.sub(halfW).max(0).div(-16)).mul(float(1).sub(lavaMask));
    // The lava's light spilling over the land around it (wider, softer).
    const spill = exp(rDist.sub(halfW).max(0).div(-55)).mul(float(1).sub(lavaMask)).mul(smoothstep(FAR_DIST - 2, FAR_DIST - 30, rDist));
    const low = ctx.quality.detail === 'low';

    // Photographed rock: ground texture on flat land, dark rock on slopes, two scales to hide tiling.
    const slope = float(1).sub(ng.y.clamp(0, 1));
    const rocky = smoothstep(0.18, 0.42, slope.add(mx_noise_float(wp.mul(0.03)).mul(0.08)));
    const tex = (t: Texture | null, sc: number) => (t ? (low ? duoplanar(t, wp, ng, sc) : triplanar(t, wp, ng, sc)) : vec3(0.3, 0.29, 0.28));
    const basalt = mix(tex(rock, 1 / 5.5), tex(rock, 1 / 37), smoothstep(60, 380, camDist).mul(0.6).add(0.2));
    const stoneVar = smoothstep(0.35, 0.75, mx_noise_float(wp.mul(0.0045).add(vec3(7.1, 0, 1.3))).mul(0.5).add(0.5));
    const groundCol = mix(basalt, tex(ground, 1 / 9).mul(0.75), stoneVar.mul(0.45));
    const rockCol = mix(tex(rock, 1 / 13), tex(rock, 1 / 71), smoothstep(120, 600, camDist).mul(0.5).add(0.25));
    const tint = vec3(...p.tint);
    // Desaturate towards a basalt grey, keep a little warmth, then darken (volcanic, ashen).
    const rawCol = mix(groundCol, rockCol, rocky);
    const grey = dot(rawCol, vec3(0.3, 0.55, 0.15));
    const ash = smoothstep(0.55, 0.8, mx_noise_float(wp.mul(0.008).add(vec3(2.1, 0, 4.3))).mul(0.5).add(0.5)).mul(float(1).sub(rocky)).mul(0.35);
    // Contrast: deepen the darks of the photographed rock (black basalt, pale ash in hollows).
    const deep = grey.mul(grey).mul(1.6).add(grey.mul(0.72));
    let albedo: V3 = mix(vec3(deep, deep, deep), rawCol.mul(deep.div(grey.max(0.02))), 0.3).mul(tint).mul(p.albedo).mul(macro(wp, 0.0035)) as V3;
    albedo = mix(albedo, vec3(0.085, 0.08, 0.078), ash) as V3;
    // Cooled crust: every plate its own tone; scree and ash on the slopes, finer and paler.
    const crustA = attribute<'vec3'>('crust', 'vec3');
    albedo = albedo.mul(mix(float(1), crustA.z.mul(0.5).add(0.72), crustA.y)) as V3;
    const scree = smoothstep(0.22, 0.36, slope).mul(smoothstep(0.62, 0.46, slope)).mul(smoothstep(0.35, 0.7, mx_noise_float(wp.mul(0.05).add(vec3(1.3, 0, 8.2))).mul(0.5).add(0.5)));
    const grit = mx_noise_float(wp.mul(1.7)).mul(0.5).add(0.5);
    albedo = mix(albedo, vec3(0.1, 0.092, 0.088).mul(grit.mul(0.5).add(0.75)), scree.mul(0.7).mul(float(1).sub(lavaMask))) as V3;
    albedo = albedo.mul(float(1).sub(crustA.x.mul(0.55))) as V3;
    // Scorched dark rims along the lava, the molten surface itself near black under its glow.
    albedo = albedo.mul(float(1).sub(nearLava.mul(0.45))).mul(mix(float(1), float(0.12), lavaMask)) as V3;

    let nWorld: V3 = ng as unknown as V3;
    if (groundN && rockN && !low) {
      const nG = triplanarNormal(rockN, wp, ng, 1 / 5.5, 1.1);
      const nR = triplanarNormal(groundN, wp, ng, 1 / 13, 1.0);
      nWorld = normalize(mix(mix(nG, nR, rocky), ng, smoothstep(250, 900, camDist).mul(0.7).add(lavaMask))) as V3;
    }

    // Lava: crust plates carried along the flow (two-phase flow map so it never resets visibly),
    // bright seams between them, hottest along the middle of the channel.
    const speed = p.lava.speed;
    const ph0 = fract(time.mul(0.035 * speed));
    const ph1 = fract(time.mul(0.035 * speed).add(0.5));
    const flowUv = wp.xz.div(26);
    const crustAt = (ph: F, off: number) => {
      const q2 = flowUv.sub(flow.mul(ph.mul(3.2))).add(off);
      const c = texture3D(noise, vec3(q2.x.mul(0.25), q2.y.mul(0.25), time.mul(0.004 * speed).add(off))).g;
      const c2 = texture3D(noise, vec3(q2.x.mul(0.61).add(0.3), q2.y.mul(0.61), time.mul(0.007 * speed).add(off * 1.7))).b;
      return c.mul(0.65).add(c2.mul(0.35));
    };
    const wgt = float(1).sub(ph0.sub(0.5).abs().mul(2));
    const crust = mix(crustAt(ph1, 0.37), crustAt(ph0, 0), wgt);
    const center = float(1).sub(rDist.div(halfW.max(1)).clamp(0, 1));
    const seams = smoothstep(0.44, 0.24, crust).mul(center.mul(0.7).add(0.3));
    const hot = smoothstep(0.55, 1.0, center).mul(smoothstep(0.5, 0.3, crust)).mul(0.8);
    const heat = s.u.lavaHeat.mul(float(1).add(u.music.mul(0.18)));
    const lavaCol = mix(COLORS.lava.mul(0.55), vec3(1.0, 0.45, 0.1), seams).add(vec3(1.0, 0.75, 0.35).mul(hot));
    // Crust glows dull red where thin, almost black where thick.
    const crustGlow = smoothstep(0.75, 0.35, crust).mul(0.22).add(0.04);
    const lavaGlow = lavaCol.mul(seams.mul(1.5).add(hot.mul(2.0)).add(crustGlow)).mul(lavaMask).mul(heat).mul(p.lava.strength);

    // Fissures: thin glowing cracks in the ground, mostly near the lava and the plateau.
    const site3 = vec3(site[0], 0, site[2]);
    const nearSite = exp(length(wp.xz.sub(site3.xz)).sub(240).max(0).div(-180));
    const fissZone = nearLava.mul(nearLava).mul(0.9).add(nearSite.mul(0.25)).clamp(0, 1);
    const fis = texture3D(noise, vec3(wp.x.div(90), wp.z.div(90), 0.31)).g;
    const fis2 = texture3D(noise, vec3(wp.x.div(31), wp.z.div(31), 0.77)).g;
    const crack = smoothstep(0.02, 0.0, fis.sub(0.5).abs()).mul(smoothstep(0.55, 0.85, fis2)).mul(fissZone).mul(float(1).sub(rocky.mul(0.6))).mul(float(1).sub(lavaMask));
    const fissGlow = COLORS.lava.mul(crack.mul(1.3 * p.fissures)).mul(heat).mul(smoothstep(900, 150, camDist).mul(0.7).add(0.3));
    // Cracks in the cooled crust across the plain: faint heat seen through the network (the
    // geometry's own cracks, plus a finer network drawn in the shader), dimmer far away.
    const fineCells = mx_worley_noise_vec2(wp.xz.div(6.5));
    const fineCrack = smoothstep(0.05, 0.0, fineCells.y.sub(fineCells.x)).mul(smoothstep(260, 60, camDist));
    const crustPulse = mx_noise_float(vec3(wp.x.mul(0.01), time.mul(0.08), wp.z.mul(0.01))).mul(0.35).add(0.75);
    const crustCrack = crustA.x.pow(3).add(fineCrack.mul(0.35).mul(crustA.y));
    const crustHeat = COLORS.lava.mul(crustCrack.mul(crustPulse).mul(0.3 * p.crustGlow)).mul(heat).mul(smoothstep(1100, 300, camDist).mul(0.8).add(0.2));
    // Banks lit red by the lava beside them.
    const bankLight = COLORS.lava.mul(nearLava.mul(nearLava).mul(0.9).add(spill.mul(0.35))).mul(heat);

    // Glassy basalt catches the red light in places; ash and dust stay matt.
    const glassy = smoothstep(0.6, 0.85, mx_noise_float(wp.mul(0.02).add(vec3(4.4, 0, 9.1))).mul(0.5).add(0.5));
    const mask = clearMask(wp);
    // Behind the board the land stays darker and calmer.
    const calm = clearMask(wp, 13, 25).mul(0.5).add(0.5);
    const lit = spireLight(s, wp, nWorld, { core: 0.25, beam: 1, bolt: 0.6 });
    // Storm light from above and the horizon's glow on crests (rim), so the forms separate.
    const dusk = duskLight(wp, nWorld, { glint: glassy.mul(float(1).sub(ash)).mul(float(1).sub(lavaMask)), back: 1.25, k: 1.3 });
    let col: V3 = albedo
      .mul(lit.add(bankLight).add(dusk).mul(calm))
      .add(lavaGlow.add(fissGlow).add(crustHeat.mul(calm)).mul(mask.mul(0.85).add(0.15))) as V3;
    // The land fogs itself (as the scene fog would), then dissolves into the photo's own far
    // land towards its edge, so it never ends at a hard line.
    const fogT = exp(camDist.mul(ctx.uniforms.fogDensity).pow(2).negate());
    col = mix(colorUniform(p.fogColor), col, fogT) as V3;
    if (photo) {
      const vdir = normalize(wp.sub(cameraPosition));
      const turn = atan(vdir.x, vdir.z.negate()).div(Math.PI * 2).add(p.horizon.offset);
      const elev = asin(vdir.y.clamp(-1, 1)).mul(180 / Math.PI);
      const pv = elev.sub(p.horizon.elevation[0]).div(p.horizon.elevation[1] - p.horizon.elevation[0]);
      const photoCol = texture(photo, vec2(turn, pv)).rgb.mul(p.horizon.exposure);
      col = mix(col, photoCol, smoothstep(p.horizon.from, p.horizon.to, camDist).mul(0.92)) as V3;
    }

    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec4(col.mul(u.presence), 1);
    material.mrtNode = mrt({ emissive: vec4(lavaGlow.mul(p.lava.bloom).mul(mask), 1) });
    material.fog = false;
    material.opacityNode = revealMask(u.presence);
    material.alphaTest = 0.5;
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -8;
    mesh.name = 'land';
    group.add(mesh);

    // --- Ruins (and the fallen bridge), snapped to the land.
    const disposables: { dispose(): void }[] = [geometry, material, riverTex];
    const fires: [number, number, number][] = [];
    let gltfLoaded = false;
    try {
      const gltf = await ctx.assets.loadGLTF('models/ruins.glb');
      gltfLoaded = true;
      const pieces = new Map<string, Object3D>();
      for (const child of gltf.scene.children) pieces.set(child.name, child);
      const fireU = uniformArray(Array.from({ length: 4 }, () => new Vector4(0, -1000, 0, 0)), 'vec4');
      const ruinMat = (glow: boolean): Material => {
        const m = new MeshBasicNodeMaterial();
        const n = normalWorldGeometry;
        const col = rock ? triplanar(rock, positionWorld, n, 1 / 9) : vec3(0.3, 0.29, 0.28);
        const g2 = dot(col, vec3(0.3, 0.55, 0.15));
        const alb = mix(vec3(g2, g2, g2), col, 0.3).mul(0.6).mul(macro(positionWorld, 0.02));
        // The lava's light from the channels beside them.
        const rvR = texture(riverTex, vec2(positionWorld.x.sub(field.x0).div(field.nx * field.cell), positionWorld.z.sub(field.z0).div(field.nz * field.cell)));
        const spillR = exp(rvR.x.sub(rvR.w).max(0).div(-45)).mul(smoothstep(FAR_DIST - 2, FAR_DIST - 30, rvR.x)).mul(clamp(n.y.negate().mul(0.5).add(0.6), 0, 1));
        // Firelight from the burning ruins nearby (flickering).
        let fire: V3 = vec3(0, 0, 0) as V3;
        for (let i = 0; i < 4; i++) {
          const f = fireU.element(int(i)) as unknown as ReturnType<typeof vec4>;
          const lv = f.xyz.sub(positionWorld);
          const d2 = dot(lv, lv);
          const flick = sin(ctx.uniforms.time.mul(7.3 + i).add(i * 2.1)).mul(0.12).add(sin(ctx.uniforms.time.mul(13.1 + i)).mul(0.08)).add(0.8);
          fire = fire.add(COLORS.lava.mul(f.w.mul(flick).mul(clamp(dot(n, normalize(lv)).add(0.4), 0, 1)).mul(2600).div(d2.add(60)))) as V3;
        }
        const light = spireLight(s, positionWorld, n, { core: 0.2, beam: 1, bolt: 0.8, rim: 0.8 })
          .add(lavaUplight(s, positionWorld, n, p.base, 1.5))
          .add(fire)
          .add(COLORS.lava.mul(spillR.mul(0.9)).mul(s.u.lavaHeat))
          .add(duskLight(positionWorld, n, { back: 1.8 }));
        let em: V3 = alb.mul(light) as V3;
        if (glow) {
          const flick = mx_noise_float(vec3(positionWorld.x.mul(0.2), ctx.uniforms.time.mul(1.3), positionWorld.z.mul(0.2))).mul(0.35).add(0.75);
          em = vec3(1.0, 0.32, 0.07).mul(flick.mul(1.4)) as V3;
          m.mrtNode = mrt({ emissive: vec4(em.mul(0.3), 1) });
        }
        m.colorNode = vec4(em.mul(u.presence), 1);
        m.fog = true;
        m.opacityNode = revealMask(u.presence);
        m.alphaTest = 0.5;
        disposables.push(m);
        return m;
      };
      const stoneM = ruinMat(false);
      const glowM = ruinMat(true);
      const dark = new MeshBasicNodeMaterial({ color: new Color(0x050404) });
      disposables.push(dark);
      const place = (name: string, x: number, zz: number, yaw: number, scale: number, y: number | null, sink: number) => {
        const src = pieces.get(name);
        if (!src) return null;
        const obj = src.clone(true);
        obj.position.set(x, (y ?? height(x, zz)) - sink, zz);
        obj.rotation.y = yaw;
        obj.scale.multiplyScalar(scale);
        obj.traverse((o) => {
          if (o instanceof Mesh) {
            const nm = (o.material as Material).name;
            o.material = nm === 'ruinGlow' ? glowM : nm === 'ruinStone' ? stoneM : dark;
            o.frustumCulled = true;
          }
        });
        group.add(obj);
        return obj;
      };
      for (const r of p.ruins) {
        const [x, zz] = polar(r.at[0], r.at[1]);
        // Rest on the lowest corner of the footprint so nothing floats on slopes.
        const f = 12 * r.scale;
        const y = Math.min(height(x, zz), height(x + f, zz), height(x - f, zz), height(x, zz + f), height(x, zz - f));
        place(r.piece, x, zz, r.yaw * DEG, r.scale, y, r.sink);
        if (r.burning && fires.length < 4) fires.push([x, y + 14 * r.scale, zz]);
      }
      if (p.bridge && rivers[p.bridge.river]) {
        const smp = rivers[p.bridge.river]!.samples;
        const sm = smp[Math.round(p.bridge.at * (smp.length - 1))]!;
        // Deck at the lower bank's height, spanning across the channel.
        const span = 46 * p.bridge.scale;
        const ax = sm.x - sm.tz * span;
        const az = sm.z + sm.tx * span;
        const bx = sm.x + sm.tz * span;
        const bz = sm.z - sm.tx * span;
        const deck = Math.min(height(ax, az), height(bx, bz)) - 1.5;
        const yaw = Math.atan2(-sm.tz, sm.tx);
        place('ruin_bridge', sm.x, sm.z, yaw + Math.PI / 2 - Math.PI / 2, p.bridge.scale, deck, 0);
      }
      fires.forEach((f, i) => {
        (fireU.array as Vector4[])[i]!.set(f[0], f[1], f[2], 1);
      });
    } catch (err) {
      if (!gltfLoaded) console.warn('[wardens-spire] ruins unavailable', err);
      else throw err;
    }

    // --- Smoke from the burning ruins: many small, soft, eroded puffs that rise, slow and are
    // sheared downwind, so each fire trails one bending plume (never a column of discs).
    const smokeParts: Sprite[] = [];
    if (fires.length > 0) {
      const per = Math.max(16, Math.round(56 * Math.min(1.5, ctx.quality.particles) * detailK));
      const count = per * fires.length;
      const seedA = new Float32Array(count * 4);
      const origin = new Float32Array(count * 4);
      const rand = seeded(p.seed * 77);
      for (let i = 0; i < count; i++) {
        const f = fires[Math.floor(i / per)]!;
        origin[i * 4] = f[0] + (rand() - 0.5) * 6;
        origin[i * 4 + 1] = f[1] - 6;
        origin[i * 4 + 2] = f[2] + (rand() - 0.5) * 6;
        origin[i * 4 + 3] = rand();
        seedA[i * 4] = rand();
        seedA[i * 4 + 1] = rand();
        seedA[i * 4 + 2] = rand();
        seedA[i * 4 + 3] = 0.6 + rand() * 0.8;
      }
      const aO = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(origin, 4), 'vec4');
      const aS = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(seedA, 4), 'vec4');
      const life = 36;
      const age = fract(time.div(life).add(aO.w));
      // Rises fast, then slows; the wind carries it further the higher it gets.
      const rise = float(1).sub(exp(age.mul(-2.6))).mul(150).mul(aS.w);
      const shear = age.mul(age).mul(170).mul(aS.w.mul(0.4).add(0.8));
      const wind = vec3(0.83, 0, -0.55);
      const wob = vec3(sin(time.mul(0.21).add(aS.x.mul(20))).mul(5).mul(age), sin(time.mul(0.17).add(aS.z.mul(9))).mul(3).mul(age), sin(time.mul(0.19).add(aS.y.mul(20))).mul(5).mul(age));
      const pos3 = aO.xyz.add(vec3(0, rise, 0)).add(wind.mul(shear)).add(wob);
      const size = float(6).add(age.mul(30)).mul(aS.w.mul(0.45).add(0.7));
      const sp = uv().sub(0.5).mul(2);
      const radial = smoothstep(1, 0, length(sp)).pow(1.8);
      const billow = texture3D(noise, vec3(uv().mul(0.8).add(aS.xy.mul(7)), age.mul(0.5).add(aS.z))).r;
      const wisp = texture3D(noise, vec3(uv().mul(1.9).add(aS.yx.mul(5)), age.mul(0.8).add(aS.w))).g;
      const shape = smoothstep(0.32, 0.85, billow.mul(0.75).add(wisp.mul(0.3)).add(radial.mul(0.45)).sub(0.2)).mul(radial);
      const fade = smoothstep(0, 0.1, age).mul(smoothstep(1, 0.35, age));
      const lowLit = exp(age.mul(-7));
      const smokeCol = vec3(0.014, 0.009, 0.007).add(COLORS.lava.mul(lowLit.mul(0.22).mul(s.u.lavaHeat)));
      const sm = new SpriteNodeMaterial();
      sm.positionNode = pos3;
      sm.scaleNode = size;
      sm.rotationNode = aS.x.mul(6.283).add(age.mul(0.4));
      sm.colorNode = vec4(smokeCol, shape.mul(fade).mul(0.34).mul(u.presence));
      sm.transparent = true;
      sm.depthWrite = false;
      sm.fog = true;
      sm.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
      const sprite = new Sprite(sm);
      sprite.count = count;
      sprite.frustumCulled = false;
      sprite.renderOrder = 2;
      group.add(sprite);
      smokeParts.push(sprite);
      disposables.push(sm);

      // Embers over the fires (additive).
      const ecount = Math.round(per * 1.6) * fires.length;
      const eo = new Float32Array(ecount * 4);
      for (let i = 0; i < ecount; i++) {
        const f = fires[i % fires.length]!;
        eo[i * 4] = f[0] + (rand() - 0.5) * 10;
        eo[i * 4 + 1] = f[1];
        eo[i * 4 + 2] = f[2] + (rand() - 0.5) * 10;
        eo[i * 4 + 3] = rand();
      }
      const aE = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(eo, 4), 'vec4');
      const eAge = fract(time.div(7).add(aE.w));
      const ePos = aE.xyz.add(vec3(sin(aE.w.mul(40).add(time.mul(0.9))).mul(eAge.mul(10)), eAge.mul(60), sin(aE.w.mul(31).add(time.mul(0.7))).mul(eAge.mul(10)).add(eAge.mul(eAge).mul(-20))));
      const em = new SpriteNodeMaterial();
      em.positionNode = ePos;
      em.scaleNode = float(1.1).mul(float(1).sub(eAge.mul(0.7)));
      const eShape = smoothstep(1, 0, length(uv().sub(0.5).mul(2))).pow(2);
      const eCol = vec3(1.0, 0.42, 0.1).mul(eShape.mul(float(1).sub(eAge)).mul(2.2)).mul(u.presence);
      em.colorNode = vec4(additiveFog(eCol), 1);
      em.blending = AdditiveBlending;
      em.transparent = true;
      em.depthWrite = false;
      em.fog = false;
      em.mrtNode = mrt({ emissive: vec4(eCol.mul(0.3), 1) });
      const es = new Sprite(em);
      es.count = ecount;
      es.frustumCulled = false;
      es.renderOrder = 3;
      group.add(es);
      disposables.push(em);
    }

    return {
      object: group,
      reactive: { heat: s.u.lavaHeat },
      update(frame) {
        u.music.value = frame.audio.bass * 0.7 + frame.audio.subBass * 0.3;
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        ctx.ground.provide(null);
        for (const d of disposables) d.dispose();
        if (gltfLoaded) ctx.assets.release('models/ruins.glb');
        release(ctx, s);
      },
    };
  },
};
