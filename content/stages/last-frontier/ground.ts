import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  TextureLoader,
  UnsignedByteType,
  type Node,
  type Texture,
} from 'three/webgpu';
import {
  asin,
  atan,
  attribute,
  cameraPosition,
  clamp,
  dot,
  float,
  mix,
  mx_noise_float,
  normalize,
  output,
  positionWorld,
  smoothstep,
  texture,
  transformNormalToView,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { floatUniform, z, type ComponentFactory } from '@prismfall/sdk';
import { castWorldShadows, frontier, FrontierMaterial, haze, lampLight, releaseFrontier, tickFrontier, type F, type V3 } from './shared';

const zXZ = z.tuple([z.number(), z.number()]);

const schema = z.object({
  /** Height of the open plain and of the shallow basin the board floats over. */
  plain: z.number().default(-9),
  basin: z
    .object({
      center: zXZ.default([0, -6]),
      y: z.number().default(-12),
      inner: z.number().default(55),
      outer: z.number().default(150),
    })
    .prefault({}),
  /** The town's flat bench: an oriented rectangle (axis = direction of the façade row). */
  town: z
    .object({
      origin: zXZ,
      axis: zXZ,
      s: zXZ,
      q: zXZ,
      y: z.number(),
      margin: z.number().default(12),
    })
    .optional(),
  /** Flattened strips (railway grade), each a polyline at a fixed height. */
  grades: z
    .array(
      z.object({
        points: z.array(zXZ).min(2),
        y: z.number(),
        width: z.number().default(8),
        margin: z.number().default(10),
      }),
    )
    .max(4)
    .default([]),
  /** Rocky knolls (a butte foot that hides the railway's far end). */
  hills: z
    .array(
      z.object({
        center: zXZ,
        radius: z.number(),
        height: z.number(),
        rough: z.number().default(0.25),
      }),
    )
    .max(8)
    .default([]),
  /** Dirt roads and trails (texture only): polylines with a width. */
  roads: z
    .array(z.object({ points: z.array(zXZ).min(2), width: z.number().default(6) }))
    .max(12)
    .default([]),
  /** A dry creek bed: polyline, width and depth. */
  creek: z
    .object({
      points: z.array(zXZ).min(2),
      width: z.number().default(7),
      depth: z.number().default(1.1),
    })
    .optional(),
  /** The far plain rises gently to meet the photograph's horizon. */
  horizon: z
    .object({
      from: z.number().default(900),
      to: z.number().default(2100),
      rise: z.number().default(11),
    })
    .prefault({}),
  textures: z
    .object({
      sand: z.string().default('textures/sandy_gravel_02_diff.webp'),
      sandNormal: z.string().default('textures/sandy_gravel_02_nor.webp'),
      ochre: z.string().default('textures/gravelly_sand_diff.webp'),
      pebbles: z.string().default('textures/dry_ground_rocks_diff.webp'),
      pebblesNormal: z.string().default('textures/dry_ground_rocks_nor.webp'),
      trail: z.string().default('textures/rocky_trail_02_diff.webp'),
      trailNormal: z.string().default('textures/rocky_trail_02_nor.webp'),
      creek: z.string().default('textures/mud_cracked_dry_riverbed_002_diff.webp'),
      crust: z.string().default('textures/dry_ground_01_diff.webp'),
      crustNormal: z.string().default('textures/dry_ground_01_nor.webp'),
      rock: z.string().default('textures/rock_boulder_cracked_diff.webp'),
      rockNormal: z.string().default('textures/rock_boulder_cracked_nor.webp'),
    })
    .prefault({}),
  /** Overall albedo tint (red rock country). */
  tint: z.tuple([z.number(), z.number(), z.number()]).default([1.0, 0.9, 0.82]),
  /** The panorama the far ground melts into (same numbers as the sky layer). */
  photo: z
    .object({
      src: z.string(),
      elevation: zXZ.default([-6, 40]),
      offset: z.number().default(0),
      from: z.number().default(900),
      to: z.number().default(1900),
    })
    .optional(),
  seed: z.number().default(7),
  debug: z.number().int().default(0),
});

type Params = z.infer<typeof schema>;

const smooth01 = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** Distance from p to a polyline, and the share along it. */
function polyDistance(x: number, zz: number, pts: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i]!;
    const [bx, bz] = pts[i + 1]!;
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (zz - az) * dz) / l2));
    const ex = ax + dx * t - x;
    const ez = az + dz * t - zz;
    best = Math.min(best, Math.hypot(ex, ez));
  }
  return best;
}

/** Deterministic value noise (CPU) for the height field. */
function makeNoise(seed: number): (x: number, z: number) => number {
  const hash = (i: number, j: number): number => {
    let h = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  return (x, zz) => {
    const i = Math.floor(x);
    const j = Math.floor(zz);
    const fx = x - i;
    const fz = zz - j;
    const u = fx * fx * (3 - 2 * fx);
    const v = fz * fz * (3 - 2 * fz);
    const a = hash(i, j);
    const b = hash(i + 1, j);
    const c = hash(i, j + 1);
    const d = hash(i + 1, j + 1);
    return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
  };
}

/** The world's ground height: open plain, the shallow basin, the town bench, the grades, knolls and a creek. */
export function makeHeight(p: Params): (x: number, z: number) => number {
  const n = makeNoise(p.seed);
  const fbm = (x: number, zz: number, scale: number, oct: number): number => {
    let a = 0;
    let amp = 1;
    let f = 1 / scale;
    let norm = 0;
    for (let o = 0; o < oct; o++) {
      a += n(x * f + o * 17.3, zz * f - o * 9.1) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return a / norm;
  };
  const t = p.town;
  const ax = t ? t.axis[0] / Math.hypot(t.axis[0], t.axis[1]) : 1;
  const az = t ? t.axis[1] / Math.hypot(t.axis[0], t.axis[1]) : 0;
  return (x, zz) => {
    const camD = Math.hypot(x - 0, zz - 30);
    let y = p.plain + fbm(x, zz, 170, 4) * 0.65 + fbm(x, zz, 28, 3) * 0.4 + fbm(x, zz, 7, 2) * 0.12;
    // Micro-relief the low sun can rake: ridged rills and runnels, fine lumps, and low benches
    // (breaks in slope a few decimetres high) where the old surface has been cut back.
    const rill = 1 - Math.abs(fbm(x * 0.7 + zz * 0.3, zz, 13, 3));
    y += (rill * rill * rill - 0.35) * 0.62 + fbm(x, zz, 3.2, 2) * 0.14;
    const bench = fbm(x, zz, 85, 2) * 3.2;
    y += (Math.floor(bench) + smooth01((bench - Math.floor(bench) - 0.72) / 0.28)) * 0.45;
    // The plain rises far away to meet the photo's horizon line.
    y += smooth01((camD - p.horizon.from) / (p.horizon.to - p.horizon.from)) * p.horizon.rise;
    // Shallow basin under and around the board.
    const bd = Math.hypot(x - p.basin.center[0], zz - p.basin.center[1]);
    const inBasin = 1 - smooth01((bd - p.basin.inner) / (p.basin.outer - p.basin.inner));
    y += (p.basin.y + fbm(x, zz, 22, 3) * 0.4 - y) * inBasin;
    for (const h of p.hills) {
      const d = Math.hypot(x - h.center[0], zz - h.center[1]) / h.radius;
      if (d < 1.6) {
        const shape = Math.exp(-d * d * 2.2) * (1 + fbm(x, zz, h.radius * 0.35, 3) * h.rough);
        y += shape * h.height;
      }
    }
    for (const g of p.grades) {
      const d = polyDistance(x, zz, g.points as [number, number][]);
      const k = 1 - smooth01((d - g.width / 2) / g.margin);
      y += (g.y - y) * k;
    }
    if (t) {
      const dx = x - t.origin[0];
      const dz = zz - t.origin[1];
      const s = dx * ax + dz * az;
      // q grows away from the viewer (behind the façades).
      const q = dx * az - dz * ax;
      const ds = Math.max(t.s[0] - s, s - t.s[1], 0);
      const dq = Math.max(t.q[0] - q, q - t.q[1], 0);
      const k = 1 - smooth01(Math.hypot(ds, dq) / t.margin);
      y += (t.y + fbm(x, zz, 40, 2) * 0.08 - y) * k;
    }
    if (p.creek) {
      const d = polyDistance(x, zz, p.creek.points as [number, number][]);
      const k = 1 - smooth01((d - p.creek.width * 0.3) / (p.creek.width * 0.7));
      y -= k * p.creek.depth;
    }
    return y;
  };
}

/**
 * The desert floor: a large radial mesh around the viewer carrying the stage's ground height (the
 * town bench, the railway grade, a knoll, a dry creek), shaded with photographed Poly Haven ground
 * textures blended by noise, slope and a painted road/creek mask, lit and shadowed by the world's sun.
 */
export const frontierGround: ComponentFactory<Params> = {
  type: 'frontierGround',
  version: 1,
  description: 'Textured desert terrain with the town bench, railway grade, knolls, roads and a dry creek; provides the ground height.',
  schema,
  async create(ctx, p) {
    const s = frontier(ctx);
    const height = makeHeight(p);
    ctx.ground.provide(height);

    // Radial mesh: geometric ring spacing (dense near the viewer, coarse far away).
    const rings = ctx.quality.detail === 'low' ? 110 : ctx.quality.detail === 'medium' ? 160 : 200;
    const segs = ctx.quality.detail === 'low' ? 256 : ctx.quality.detail === 'medium' ? 420 : 600;
    const r0 = 4;
    const r1 = 2150;
    const q = Math.pow(r1 / r0, 1 / (rings - 1));
    const cx = 0;
    const cz = 30;
    const pos = new Float32Array(rings * segs * 3);
    for (let i = 0; i < rings; i++) {
      const r = r0 * Math.pow(q, i);
      for (let j = 0; j < segs; j++) {
        const a = (j / segs) * Math.PI * 2;
        const x = cx + Math.sin(a) * r;
        const zz = cz - Math.cos(a) * r;
        const k = (i * segs + j) * 3;
        pos[k] = x;
        pos[k + 1] = height(x, zz);
        pos[k + 2] = zz;
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < rings - 1; i++) {
      for (let j = 0; j < segs; j++) {
        const a = i * segs + j;
        const b = i * segs + ((j + 1) % segs);
        const c = (i + 1) * segs + ((j + 1) % segs);
        const d = (i + 1) * segs + j;
        idx.push(a, b, c, a, c, d);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(pos, 3));
    geometry.setIndex(idx);
    geometry.computeVertexNormals();

    // Painted mask (0.25 m per pixel over 512 m): R road and town street, G creek, B grade gravel,
    // A wheel ruts (two worn tracks 1.6 m apart down every road).
    const MS = ctx.quality.detail === 'low' ? 1024 : 2048;
    const area = { x0: -256, z0: -400, size: 512 };
    const mask = new Uint8Array(MS * MS * 4);
    const px = area.size / MS;
    const strips: { pts: [number, number][]; w: number; ch: number }[] = [
      ...p.roads.map((r) => ({ pts: r.points as [number, number][], w: r.width, ch: 0 })),
      ...(p.creek ? [{ pts: p.creek.points as [number, number][], w: p.creek.width, ch: 1 }] : []),
      ...p.grades.map((g) => ({ pts: g.points as [number, number][], w: g.width, ch: 2 })),
    ];
    for (const st of strips) {
      for (let i = 0; i < st.pts.length - 1; i++) {
        const [ax0, az0] = st.pts[i]!;
        const [bx0, bz0] = st.pts[i + 1]!;
        const reach = st.w;
        const i0 = Math.max(0, Math.floor((Math.min(ax0, bx0) - reach - area.x0) / px));
        const i1 = Math.min(MS - 1, Math.ceil((Math.max(ax0, bx0) + reach - area.x0) / px));
        const j0 = Math.max(0, Math.floor((Math.min(az0, bz0) - reach - area.z0) / px));
        const j1 = Math.min(MS - 1, Math.ceil((Math.max(az0, bz0) + reach - area.z0) / px));
        const dx = bx0 - ax0;
        const dz = bz0 - az0;
        const l2 = dx * dx + dz * dz || 1;
        for (let pj = j0; pj <= j1; pj++) {
          const zz = area.z0 + (pj + 0.5) * px;
          for (let pi = i0; pi <= i1; pi++) {
            const x = area.x0 + (pi + 0.5) * px;
            const t = Math.min(1, Math.max(0, ((x - ax0) * dx + (zz - az0) * dz) / l2));
            const d = Math.hypot(ax0 + dx * t - x, az0 + dz * t - zz);
            const o = (pj * MS + pi) * 4;
            const v = 1 - smooth01((d - st.w * 0.35) / (st.w * 0.3));
            if (v > 0) mask[o + st.ch] = Math.max(mask[o + st.ch]!, Math.round(v * 255));
            if (st.ch === 0 && st.w >= 3.5) {
              const rut = Math.exp(-Math.pow((d - 0.8) / 0.2, 2)) * (0.75 + 0.25 * Math.sin(x * 0.37 + zz * 0.21));
              if (rut > 0.02) mask[o + 3] = Math.max(mask[o + 3]!, Math.round(rut * 255));
            }
          }
        }
      }
    }
    if (p.town) {
      const t = p.town;
      const l = Math.hypot(t.axis[0], t.axis[1]);
      const ax = t.axis[0] / l;
      const az = t.axis[1] / l;
      for (let pj = 0; pj < MS; pj++) {
        const zz = area.z0 + (pj + 0.5) * px;
        for (let pi = 0; pi < MS; pi++) {
          const x = area.x0 + (pi + 0.5) * px;
          const dx = x - t.origin[0];
          const dz = zz - t.origin[1];
          const sv = dx * ax + dz * az;
          const qv = dx * az - dz * ax;
          const ds = Math.max(t.s[0] - sv, sv - t.s[1], 0);
          const dq = Math.max(t.q[0] - qv, qv - t.q[1], 0);
          const v = 1 - smooth01(Math.hypot(ds, dq) / 6);
          if (v > 0) {
            const o = (pj * MS + pi) * 4;
            mask[o] = Math.max(mask[o]!, Math.round(v * 0.9 * 255));
          }
        }
      }
    }
    const maskTex = new DataTexture(mask, MS, MS, RGBAFormat, UnsignedByteType);
    maskTex.wrapS = maskTex.wrapT = ClampToEdgeWrapping;
    maskTex.magFilter = LinearFilter;
    maskTex.minFilter = LinearMipmapLinearFilter;
    maskTex.generateMipmaps = true;
    maskTex.needsUpdate = true;

    const loader = new TextureLoader();
    const loaded: Texture[] = [maskTex];
    const load = async (src: string, srgb: boolean): Promise<Texture> => {
      const url = ctx.assets.url(src);
      const tex = url ? await loader.loadAsync(url) : new DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
      tex.wrapS = tex.wrapT = RepeatWrapping;
      tex.anisotropy = 8;
      tex.minFilter = LinearMipmapLinearFilter;
      if (srgb) tex.colorSpace = SRGBColorSpace;
      tex.needsUpdate = true;
      loaded.push(tex);
      return tex;
    };
    const T = p.textures;
    const [sand, sandN, ochre, pebbles, pebblesN, trail, trailN, creek, rock, rockN, crust, crustN] = await Promise.all([
      load(T.sand, true),
      load(T.sandNormal, false),
      load(T.ochre, true),
      load(T.pebbles, true),
      load(T.pebblesNormal, false),
      load(T.trail, true),
      load(T.trailNormal, false),
      load(T.creek, true),
      load(T.rock, true),
      load(T.rockNormal, false),
      load(T.crust, true),
      load(T.crustNormal, false),
    ]);

    const presence = floatUniform(1);
    const wp = positionWorld;
    const xz = vec2(wp.x, wp.z);
    const nGeo = normalize(varying(attribute<'vec3'>('normal', 'vec3'), 'vGroundNormal')) as V3;
    const slope = float(1).sub(nGeo.y) as F;
    const dist = wp.sub(vec3(0, 1, 30)).length();
    // Large-scale patchiness (no visible tiling): noise at 60 m and 14 m.
    const n1 = mx_noise_float(vec3(xz.mul(1 / 60), 0.3))
      .mul(0.5)
      .add(0.5) as F;
    const n2 = mx_noise_float(vec3(xz.mul(1 / 14), 1.7))
      .mul(0.5)
      .add(0.5) as F;
    const n3 = mx_noise_float(vec3(xz.mul(1 / 230), 4.1))
      .mul(0.5)
      .add(0.5) as F;
    const twoScale = (tex: Texture, size: number): V3 => {
      const a = texture(tex, xz.div(size)).rgb;
      const b = texture(tex, xz.div(size * 3.7).add(vec2(0.37, 0.61))).rgb;
      return mix(a, b, n2.mul(0.6).add(0.2)) as V3;
    };
    const sandC = twoScale(sand, 2.53);
    const ochreC = twoScale(ochre, 2.48);
    const pebC = twoScale(pebbles, 4.0);
    const trailC = twoScale(trail, 2.0);
    const creekC = texture(creek, xz.div(2.0)).rgb as V3;
    const rockC = twoScale(rock, 2.8).mul(vec3(1.0, 0.82, 0.7)) as V3;
    const m = texture(maskTex, xz.sub(vec2(area.x0, area.z0)).div(area.size));
    let albedo: V3 = mix(sandC, ochreC, smoothstep(0.35, 0.7, n1)) as V3;
    albedo = mix(albedo, pebC, smoothstep(0.55, 0.8, n3.mul(0.6).add(n2.mul(0.4))).mul(0.75)) as V3;
    // Cracked clay pans and pale crusted flats in patches with fairly crisp edges (they read from afar).
    const crustC = texture(crust, xz.div(4.0)).rgb.mul(vec3(1.05, 0.88, 0.72)) as V3;
    const pan = smoothstep(0.58, 0.66, mx_noise_float(vec3(xz.mul(1 / 38), 7.3)).mul(0.5).add(0.5)) as F;
    const flat = smoothstep(0.6, 0.68, mx_noise_float(vec3(xz.mul(1 / 24), 3.9)).mul(0.5).add(0.5)) as F;
    albedo = mix(albedo, creekC.mul(vec3(1.0, 0.92, 0.82)), pan.mul(0.85)) as V3;
    albedo = mix(albedo, crustC, flat.mul(0.7)) as V3;
    // Roads: pale, dusty and compacted, with two darker worn wheel ruts.
    albedo = mix(albedo, trailC.mul(vec3(1.12, 1.05, 0.98)), clamp(m.r, 0, 1)) as V3;
    albedo = albedo.mul(float(1).sub(m.a.mul(0.5))) as V3;
    albedo = mix(albedo, pebC.mul(0.78), m.b.mul(0.9)) as V3;
    albedo = mix(albedo, creekC, m.g.mul(0.85)) as V3;
    // Scrub and gravel read from afar as fine dark speckle, caliche as pale patches.
    const speck = smoothstep(
      0.62,
      0.86,
      mx_noise_float(vec3(xz.mul(0.55), 2.3))
        .mul(0.5)
        .add(0.5),
    ).mul(smoothstep(0.3, 0.7, n1.mul(0.5).add(n3.mul(0.5))));
    const fine = mx_noise_float(vec3(xz.mul(2.1), 5.1))
      .mul(0.5)
      .add(0.5);
    const caliche = smoothstep(
      0.6,
      0.85,
      mx_noise_float(vec3(xz.mul(1 / 32), 9.7))
        .mul(0.5)
        .add(0.5),
    );
    albedo = albedo
      .mul(
        float(1)
          .sub(speck.mul(0.42))
          .mul(float(0.9).add(fine.mul(0.2))),
      )
      .add(vec3(0.07, 0.06, 0.05).mul(caliche)) as V3;
    const rocky = smoothstep(0.07, 0.2, slope) as F;
    albedo = mix(albedo, rockC, rocky) as V3;
    // Far away the textures average out: keep the colour but drop the contrast.
    albedo = albedo.mul(vec3(...p.tint)) as V3;
    const distFade = smoothstep(250, 900, dist);
    albedo = mix(albedo, albedo.mul(0.7).add(vec3(0.3, 0.22, 0.15).mul(0.3)), distFade.mul(0.3)) as V3;

    // Normal: the textures' detail, faded with distance, bent onto the terrain normal.
    const nmap = (tex: Texture, size: number): V3 => texture(tex, xz.div(size)).rgb.mul(2).sub(1) as V3;
    let nt: V3 = mix(nmap(sandN, 2.53), nmap(pebblesN, 4.0), smoothstep(0.55, 0.8, n3.mul(0.6).add(n2.mul(0.4)))) as V3;
    nt = mix(nt, nmap(crustN, 4.0), flat.mul(0.8)) as V3;
    nt = mix(nt, nmap(trailN, 2.0), clamp(m.r, 0, 1)) as V3;
    nt = mix(nt, nmap(rockN, 2.8), rocky) as V3;
    const strength = smoothstep(220, 30, dist).mul(0.9).add(0.1);
    // Tangent frame for a mostly horizontal surface: x → +X, y → −Z (texture v), z → normal.
    const tangent = normalize(vec3(nGeo.y, nGeo.x.negate(), 0));
    const bitangent = normalize(vec3(0, nGeo.z, nGeo.y.negate()));
    // Procedural micro-relief (pebbles, clods, little scarps), as a height gradient by finite differences.
    const bumpH = (q: Node<'vec2'>): F =>
      mx_noise_float(vec3(q.mul(1.4), 0.7)).mul(0.5).add(mx_noise_float(vec3(q.mul(4.3), 2.9)).mul(0.25)).add(mx_noise_float(vec3(q.mul(0.33), 5.3)).mul(1.2)) as F;
    const e = 0.08;
    const h0 = bumpH(xz);
    const gx = bumpH(xz.add(vec2(e, 0))).sub(h0).div(e);
    const gz = bumpH(xz.add(vec2(0, e))).sub(h0).div(e);
    const bumpK = smoothstep(200, 25, dist).mul(0.085).mul(float(1).sub(m.r.mul(0.6))).mul(float(1).sub(rocky.mul(0.5)));
    const nGeoB = normalize(nGeo.sub(vec3(gx, 0, gz).mul(bumpK))) as V3;
    const nWorld = normalize(
      tangent
        .mul(nt.x.mul(strength))
        .add(bitangent.mul(nt.y.mul(strength)))
        .add(nGeoB.mul(nt.z)),
    ) as V3;

    const material = new FrontierMaterial();
    material.colorNode = p.debug === 1 ? vec3(0.8, 0.2, 0.1) : albedo;
    if (p.debug === 0) material.normalNode = transformNormalToView(nWorld);
    material.roughness = 0.96;
    material.metalness = 0;
    material.fog = false;
    material.lightsNode = s.lightsNode;
    let finalColor: V3 = haze(s, (output.rgb as unknown as V3).add(lampLight(s, wp as unknown as V3, nWorld).mul(albedo)) as V3);
    if (p.photo) {
      // Far away the ground becomes the photograph itself (graded like the sky), so it meets the
      // photo's own plain and mountain foot without a seam.
      const url = ctx.assets.url(p.photo.src);
      if (url) {
        const photoTex = await loader.loadAsync(url);
        photoTex.colorSpace = SRGBColorSpace;
        photoTex.wrapS = RepeatWrapping;
        photoTex.minFilter = LinearMipmapLinearFilter;
        loaded.push(photoTex);
        const vdir = normalize(wp.sub(cameraPosition));
        const turn = atan(vdir.x, vdir.z.negate())
          .div(Math.PI * 2)
          .add(p.photo.offset);
        const elev = asin(clamp(vdir.y, -1, 1)).mul(180 / Math.PI);
        const pv = elev.sub(p.photo.elevation[0]).div(p.photo.elevation[1] - p.photo.elevation[0]);
        const raw = texture(photoTex, vec2(turn, pv)).rgb;
        const luma = dot(raw, vec3(0.2126, 0.7152, 0.0722));
        const dusk = smoothstep(0.42, 0.66, s.u.tod);
        const graded = mix(raw, vec3(luma, luma, luma).mul(vec3(0.85, 0.92, 1.1)), s.u.night.mul(0.55).add(dusk.mul(0.35)).min(0.85))
          .mul(s.u.photoTint)
          .mul(s.u.photoExposure)
          .mul(mix(float(1), float(0.42), dusk))
          .mul(mix(float(1), float(0.6), s.u.night));
        finalColor = mix(finalColor, graded, smoothstep(p.photo.from, p.photo.to, dist)) as V3;
      }
    }
    material.outputNode = vec4(finalColor.mul(presence), 1);
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -5;
    castWorldShadows(mesh, false);
    mesh.name = 'frontier-ground';

    return {
      object: mesh,
      update(frame) {
        tickFrontier(s, frame);
      },
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        ctx.ground.provide(null);
        geometry.dispose();
        material.dispose();
        for (const t of loaded) t.dispose();
        releaseFrontier(ctx, s);
      },
    };
  },
};
