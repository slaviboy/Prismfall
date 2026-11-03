import { BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, Vector3, type Texture } from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraPosition,
  cos,
  cross,
  dot,
  exp,
  float,
  fract,
  length,
  max,
  mix,
  mx_noise_float,
  normalize,
  positionGeometry,
  pow,
  select,
  sin,
  smoothstep,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import { colorUniform, floatUniform, noBloom, seeded, z, zColor, zVec3, type ComponentFactory } from '@prismfall/sdk';
import { loadTexture, sampleEnvironment, shadowCasters, shadowTime, skyDirection, windField, windVector, zEnvironment, zSkyDirection, zWind, type F, type V3 } from './env';

/**
 * Coconut palms in the trade wind. Every palm is built once on the CPU: a curved, leaning trunk
 * that tapers from a swollen base, ringed with leaf scars, and a crown of pinnate fronds (a
 * yellow-green rachis carrying a hundred-odd drooping leaflets, young spears upright, old fronds
 * hanging), with a cluster of coconuts. All motion is on the GPU: the trunk bends slowly under
 * the wind, the fronds flex and lift, the leaflets flutter, and gust fronts travel across the
 * grove downwind. Lighting follows the photograph's sun, with sunlight glowing through backlit
 * leaflets and dappled shade inside the crown.
 */

const DEG = Math.PI / 180;
const GOLDEN = 137.508 * DEG;

const palmSchema = z.object({
  /** Base on the ground plane (x, z); the palm stands on the stage's ground height there. */
  at: z.tuple([z.number(), z.number()]),
  /** Trunk length (m). */
  height: z.number().positive().default(18),
  /** Horizontal reach of the trunk top as a fraction of its length, and the direction it leans (degrees, as an azimuth). */
  lean: z.number().min(0).max(0.9).default(0.25),
  toward: z.number().default(0),
  /** How much of the lean happens near the base (1) rather than evenly along the trunk (0). */
  curve: z.number().min(0).max(1).default(0.6),
  fronds: z.number().int().min(6).max(40).optional(),
  frondLength: z.number().positive().optional(),
  seed: z.number().default(1),
});
type PalmSpec = z.infer<typeof palmSchema>;

const groveSchema = z.object({
  center: z.tuple([z.number(), z.number()]),
  /** Half-extents of the grove (m). */
  radius: z.tuple([z.number().positive(), z.number().positive()]),
  count: z.number().int().min(1).max(40),
  height: z.tuple([z.number().positive(), z.number().positive()]).default([12, 20]),
  lean: z.tuple([z.number().min(0), z.number().max(0.9)]).default([0.05, 0.35]),
  /** Lean direction (degrees, as an azimuth); default: down the beach, towards the water. */
  toward: z.number().optional(),
  /** Minimum spacing between trunks (m). */
  spacing: z.number().positive().default(5),
  seed: z.number().default(1),
});

const schema = z.object({
  palms: z.array(palmSchema).max(24).default([]),
  groves: z.array(groveSchema).max(8).default([]),
  /** Water level: grove palms only grow where the ground is this far above it. */
  waterLevel: z.number().default(-12),
  bark: zColor.default('#9d978b'),
  scar: zColor.default('#5a5248'),
  leaf: zColor.default('#55802a'),
  leafUnder: zColor.default('#8fa24c'),
  leafOld: zColor.default('#a99a46'),
  dead: zColor.default('#80643e'),
  rachis: zColor.default('#a4a050'),
  coconut: zColor.default('#7a8a30'),
  environment: zEnvironment,
  sun: zSkyDirection.prefault({ azimuth: 170, elevation: 25 }),
  sunColor: zColor.default('#fff4e6'),
  sunIntensity: z.number().min(0).default(2.4),
  skyLight: z.number().min(0).default(1),
  /** Sunlight passing through the leaflets when they are lit from behind. */
  translucency: z.number().min(0).default(0.7),
  wind: zWind.prefault({}),
  /** Where the viewer stands (for detail levels and the shadows the nearest palms cast). */
  eye: zVec3.default([0, 1, 31]),
});
type Params = z.infer<typeof schema>;

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

interface Palm {
  base: Vector3;
  height: number;
  lean: number;
  toward: number;
  curve: number;
  fronds: number;
  frondLength: number;
  seed: number;
  /** Distance from the viewer (picks the detail level). */
  distance: number;
}

interface Detail {
  rings: number;
  sides: number;
  fronds: number;
  leaflets: number;
  rows: number;
  rachis: number;
  /** Leaflet width as a fraction of its length (wider when fewer, so the crown keeps its density). */
  width: number;
}

class Builder {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly palm: number[] = [];
  readonly a: number[] = [];
  readonly b: number[] = [];
  readonly c: number[] = [];
  readonly index: number[] = [];
  get count(): number {
    return this.pos.length / 3;
  }
  vertex(p: Vector3, n: Vector3, palm: number[], a: number[], b: number[], c: number[]): number {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.palm.push(...palm);
    this.a.push(...a);
    this.b.push(...b);
    this.c.push(...c);
    return this.count - 1;
  }
  geometry(names: [string, string, string], normals: 'keep' | 'compute'): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('palm', new BufferAttribute(new Float32Array(this.palm), 4));
    g.setAttribute(names[0], new BufferAttribute(new Float32Array(this.a), 4));
    g.setAttribute(names[1], new BufferAttribute(new Float32Array(this.b), 4));
    if (names[2]) g.setAttribute(names[2], new BufferAttribute(new Float32Array(this.c), 4));
    g.setIndex(this.index);
    if (normals === 'compute') g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const UP = new Vector3(0, 1, 0);

function horizontal(azimuth: number): Vector3 {
  const d = skyDirection(azimuth, 0);
  return new Vector3(d[0], 0, d[2]);
}

/** The trunk's spine: a cubic curve that leans out near the base and turns upward towards the crown. */
function spine(pm: Palm, rand: () => number): (t: number) => Vector3 {
  const dir = horizontal(pm.toward);
  const side = new Vector3().crossVectors(UP, dir).normalize();
  const H = pm.height;
  const reach = pm.lean * H;
  const up = Math.sqrt(Math.max(0.2, 1 - pm.lean * pm.lean * 0.6)) * H;
  const k = pm.curve;
  const p1 = pm.base.clone().addScaledVector(dir, reach * (0.35 + 0.35 * k)).addScaledVector(UP, up * (0.33 - 0.12 * k));
  const p2 = pm.base.clone().addScaledVector(dir, reach * (0.75 + 0.2 * k)).addScaledVector(UP, up * 0.68);
  const p3 = pm.base.clone().addScaledVector(dir, reach).addScaledVector(UP, up);
  const w1 = (rand() - 0.5) * 0.06 * H;
  const w2 = (rand() - 0.5) * 0.03 * H;
  return (t: number) => {
    const s = 1 - t;
    const p = pm.base
      .clone()
      .multiplyScalar(s * s * s)
      .addScaledVector(p1, 3 * s * s * t)
      .addScaledVector(p2, 3 * s * t * t)
      .addScaledVector(p3, t * t * t);
    // A slight S-wobble across the lean: no trunk grows perfectly true.
    return p.addScaledVector(side, Math.sin(t * Math.PI) * w1 + Math.sin(t * Math.PI * 2) * w2);
  };
}

function trunkRadius(t: number, r0: number, seed: number): number {
  const flare = 1 + 0.75 * Math.exp(-t * 18) + 0.18 * Math.exp(-t * 4);
  const taper = 1 - 0.3 * t;
  const swell = 1 + 0.035 * Math.sin(t * 23 + seed) + 0.02 * Math.sin(t * 57 + seed * 2);
  return r0 * flare * taper * swell;
}

function buildTrunk(b: Builder, pm: Palm, d: Detail, id: number): Vector3 {
  const rand = seeded(pm.seed * 7717 + 13);
  const at = spine(pm, rand);
  const r0 = 0.19 + pm.height * 0.005;
  const palm = [pm.base.x, pm.base.z, pm.height, pm.seed];
  // Parallel-transported frame along the spine.
  const t0 = at(0.001).sub(at(0)).normalize();
  let normal = new Vector3().crossVectors(t0, horizontal(pm.toward + 90)).normalize();
  if (normal.lengthSq() < 0.5) normal = new Vector3(1, 0, 0);
  let arc = 0;
  let prev = at(0);
  const start = b.count;
  for (let i = 0; i <= d.rings; i++) {
    const t = i / d.rings;
    const p = at(t);
    arc += p.distanceTo(prev);
    prev = p;
    const tan = at(Math.min(1, t + 0.002)).sub(at(Math.max(0, t - 0.002))).normalize();
    // Transport the normal: remove its component along the new tangent.
    normal.addScaledVector(tan, -normal.dot(tan)).normalize();
    const bin = new Vector3().crossVectors(tan, normal).normalize();
    const r = trunkRadius(t, r0, pm.seed);
    for (let k = 0; k <= d.sides; k++) {
      const th = (k / d.sides) * Math.PI * 2;
      const n = normal.clone().multiplyScalar(Math.cos(th)).addScaledVector(bin, Math.sin(th));
      b.vertex(p.clone().addScaledVector(n, r), n, palm, [t, k / d.sides, arc, id], [0, 0, 0, 0], [0, 0, 0, 0]);
    }
  }
  const row = d.sides + 1;
  // Wind the quads so their faces point outward (checked on the first quad).
  const p0 = new Vector3().fromArray(b.pos, (start) * 3);
  const p1 = new Vector3().fromArray(b.pos, (start + 1) * 3);
  const p2 = new Vector3().fromArray(b.pos, (start + row) * 3);
  const n0 = new Vector3().fromArray(b.nor, start * 3);
  const outward = new Vector3().crossVectors(p1.clone().sub(p0), p2.clone().sub(p0)).dot(n0) > 0;
  for (let i = 0; i < d.rings; i++) {
    for (let k = 0; k < d.sides; k++) {
      const a0 = start + i * row + k;
      const a1 = a0 + 1;
      const c0 = a0 + row;
      const c1 = c0 + 1;
      if (outward) b.index.push(a0, a1, c0, a1, c1, c0);
      else b.index.push(a0, c0, a1, a1, c0, c1);
    }
  }
  // The crown sits on the trunk top, nudged up the last tangent.
  const top = at(1);
  const tan = at(1).sub(at(0.98)).normalize();
  return top.addScaledVector(tan, 0.15);
}

function smooth01(x: number): number {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
}

/** One frond: rachis tube plus leaflets on both sides. Writes into the crown builder. */
function buildFrond(cb: Builder, pm: Palm, d: Detail, top: Vector3, f: number, wind: [number, number], rand: () => number): void {
  const n = pm.fronds;
  const age = Math.min(1, f / (n - 1)) * 0.98;
  const dead = f >= n;
  const ageV = dead ? 1.2 : age;
  const spear = f < 2;
  const az = f * GOLDEN + (rand() - 0.5) * 0.35 + pm.seed;
  const dir0 = new Vector3(Math.cos(az), 0, Math.sin(az));
  const L = pm.frondLength * (spear ? 0.34 + 0.16 * f : dead ? 0.85 : 0.82 + 0.18 * Math.sin(Math.PI * Math.min(1, age * 1.15 + 0.12))) * (0.92 + rand() * 0.16);
  const alpha = (spear ? 78 - f * 10 : dead ? -72 : 62 - Math.pow(age, 0.85) * 92) * DEG + (rand() - 0.5) * 10 * DEG;
  const droop = (spear ? 6 : dead ? 15 : 28 + 62 * age) * DEG * (0.85 + rand() * 0.3);
  const curl = (rand() - 0.5) * 24 * DEG;
  const roll = (rand() - 0.5) * 50 * DEG;
  const windBias = dead ? 0.05 : 0.22 + 0.12 * age;
  const windDir = new Vector3(wind[0], 0, wind[1]);
  const base = top.clone().addScaledVector(dir0, 0.1 + age * 0.12).addScaledVector(UP, -0.08 - age * 0.55);
  const segs = d.rachis;
  // Rachis polyline with its frames.
  const pts: Vector3[] = [base.clone()];
  const tans: Vector3[] = [];
  const ups: Vector3[] = [];
  let p = base.clone();
  for (let i = 0; i <= segs; i++) {
    const s = i / segs;
    const pitch = alpha - droop * Math.pow(s, 1.35);
    const yaw = curl * s;
    const h = dir0.clone().applyAxisAngle(UP, yaw);
    const dirS = h.multiplyScalar(Math.cos(pitch)).addScaledVector(UP, Math.sin(pitch));
    dirS.addScaledVector(windDir, windBias * s).normalize();
    tans.push(dirS.clone());
    if (i < segs) {
      p = p.clone().addScaledVector(dirS, L / segs);
      pts.push(p);
    }
  }
  for (let i = 0; i <= segs; i++) {
    const t = tans[i] as Vector3;
    let u = UP.clone().addScaledVector(t, -t.dot(UP));
    if (u.lengthSq() < 1e-4) u = dir0.clone().multiplyScalar(-1).addScaledVector(t, -t.dot(dir0));
    u.normalize().applyAxisAngle(t, roll * (i / segs));
    ups.push(u);
  }
  const palm = [pm.base.x, pm.base.z, pm.height, pm.seed];
  const crown = [top.x, top.y, top.z, az];
  const phase = rand();
  const ao = (q: Vector3) => {
    const rel = q.clone().sub(top);
    const radial = Math.hypot(rel.x, rel.z) / (pm.frondLength * 0.8);
    return Math.min(1, 0.42 + 0.33 * smooth01(radial) + 0.35 * smooth01((rel.y + 2.6) / 3.4));
  };
  const at = (s: number) => {
    const x = s * segs;
    const i = Math.min(segs - 1, Math.floor(x));
    const fr = x - i;
    return {
      p: (pts[i] as Vector3).clone().lerp(pts[i + 1] as Vector3, fr),
      t: (tans[i] as Vector3).clone().lerp(tans[i + 1] as Vector3, fr).normalize(),
      u: (ups[i] as Vector3).clone().lerp(ups[i + 1] as Vector3, fr).normalize(),
    };
  };
  // Rachis: a four-sided tube, broad and brown at the sheathing base, thin at the tip.
  const ring = 4;
  const start = cb.count;
  for (let i = 0; i <= segs; i++) {
    const s = i / segs;
    const fr = at(Math.min(0.999, s));
    const side = new Vector3().crossVectors(fr.t, fr.u).normalize();
    const w = 0.009 + 0.042 * Math.pow(1 - s, 1.4) + 0.1 * Math.exp(-s * 30);
    for (let k = 0; k < ring; k++) {
      const th = (k / ring) * Math.PI * 2;
      const nn = side.clone().multiplyScalar(Math.cos(th)).addScaledVector(fr.u, Math.sin(th));
      const q = fr.p.clone().add(side.clone().multiplyScalar(Math.cos(th) * w)).addScaledVector(fr.u, Math.sin(th) * w * 0.75);
      cb.vertex(q, nn, palm, crown, [s, 0, phase, 0], [ageV, rand(), ao(q), 0]);
    }
  }
  for (let i = 0; i < segs; i++) {
    for (let k = 0; k < ring; k++) {
      const a0 = start + i * ring + k;
      const a1 = start + i * ring + ((k + 1) % ring);
      cb.index.push(a0, a1, a0 + ring, a1, a1 + ring, a0 + ring);
    }
  }
  // Leaflets.
  const s0 = 0.17;
  const perSide = Math.max(6, Math.round(d.leaflets * (spear ? 0.6 : 1)));
  const Lmax = L * 0.21;
  const keel = (spear ? 6 : dead ? 70 : -8 + 58 * age) * DEG;
  for (let side = -1; side <= 1; side += 2) {
    for (let j = 0; j < perSide; j++) {
      if (!spear && rand() < 0.035) continue; // a torn-out leaflet
      const sp = (j + 0.5 + (rand() - 0.5) * 0.5 + (side > 0 ? 0.25 : 0)) / perSide;
      const s = s0 + (0.985 - s0) * Math.min(1, Math.max(0, sp));
      const fr = at(s);
      const sideV = new Vector3().crossVectors(fr.t, fr.u).normalize();
      const profile = (0.42 + 0.58 * Math.sin(Math.PI * Math.min(1, Math.pow(sp, 0.8)))) * (1 - 0.62 * Math.pow(sp, 3));
      const len = Lmax * profile * (rand() < 0.08 ? 0.55 + rand() * 0.3 : 0.9 + rand() * 0.2);
      const beta = spear ? (78 + rand() * 8) * DEG : (38 + 18 * sp + (rand() - 0.5) * 16) * DEG;
      const k = keel + (rand() - 0.5) * 24 * DEG;
      const d0 = sideV.clone().multiplyScalar(side * Math.cos(beta)).addScaledVector(fr.t, Math.sin(beta)).normalize();
      const D = d0.clone().multiplyScalar(Math.cos(k)).addScaledVector(fr.u, -Math.sin(k)).normalize();
      let W = fr.t.clone().addScaledVector(D, -fr.t.dot(D)).normalize();
      let Nq = new Vector3().crossVectors(W, D).normalize();
      if (Nq.dot(fr.u) < 0) {
        W = W.multiplyScalar(-1);
        Nq = Nq.multiplyScalar(-1);
      }
      // Each leaflet turns a little about its own axis, so the blades catch the light differently.
      const twist = (rand() - 0.5) * 50 * DEG;
      W = W.multiplyScalar(Math.cos(twist)).addScaledVector(Nq, Math.sin(twist)).normalize();
      Nq = new Vector3().crossVectors(W, D).normalize();
      const width = len * d.width * (0.85 + rand() * 0.3);
      const sag = len * ((spear ? 0.02 : 0.12) + 0.22 * age);
      const tip = rand() < 0.16 + 0.2 * age ? 0.6 + rand() * 0.4 : 0;
      const lr = rand();
      const rows = d.rows;
      const first = cb.count;
      for (let r = 0; r <= rows; r++) {
        const l = r / rows;
        const w = width * Math.pow(Math.sin(Math.PI * Math.min(1, 0.06 + l * 0.94)), 0.65) * (1 - Math.pow(l, 6)) * 0.5;
        const c = fr.p.clone().addScaledVector(D, len * l).addScaledVector(UP, -sag * l * l);
        const lift = Nq.clone().multiplyScalar(w * 0.45);
        const verts = [c.clone().addScaledVector(W, -w), c.clone().add(lift), c.clone().addScaledVector(W, w)];
        for (const v of verts) cb.vertex(v, Nq, palm, crown, [s, l, phase, 1], [ageV, lr, ao(v), tip]);
      }
      for (let r = 0; r < rows; r++) {
        const a = first + r * 3;
        const c = a + 3;
        cb.index.push(a, a + 1, c, a + 1, c + 1, c);
        cb.index.push(a + 1, a + 2, c + 1, a + 2, c + 2, c + 1);
      }
    }
  }
}

/** A cluster of coconuts tucked under the crown. */
function buildCoconuts(cb: Builder, pm: Palm, top: Vector3, rand: () => number, lat: number, lon: number): void {
  const count = 5 + Math.floor(rand() * 9);
  const palm = [pm.base.x, pm.base.z, pm.height, pm.seed];
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2;
    const r = 0.18 + rand() * 0.22;
    const c = top.clone().add(new Vector3(Math.cos(a) * r, -0.35 - rand() * 0.45, Math.sin(a) * r));
    const rad = 0.13 + rand() * 0.05;
    const ripe = rand();
    const first = cb.count;
    for (let y = 0; y <= lat; y++) {
      const v = (y / lat) * Math.PI;
      for (let x = 0; x <= lon; x++) {
        const h = (x / lon) * Math.PI * 2;
        const n = new Vector3(Math.sin(v) * Math.cos(h), Math.cos(v), Math.sin(v) * Math.sin(h));
        const q = c.clone().add(new Vector3(n.x * rad, n.y * rad * 1.12, n.z * rad));
        cb.vertex(q, n, palm, [top.x, top.y, top.z, a], [0, 0, rand(), 2], [ripe, rand(), 0.55, 0]);
      }
    }
    const row = lon + 1;
    for (let y = 0; y < lat; y++) {
      for (let x = 0; x < lon; x++) {
        const a0 = first + y * row + x;
        cb.index.push(a0, a0 + row, a0 + 1, a0 + 1, a0 + row, a0 + row + 1);
      }
    }
  }
}

function detailFor(distance: number, quality: 'low' | 'medium' | 'high' | 'ultra'): Detail {
  const q = quality === 'low' ? 0.5 : quality === 'medium' ? 0.75 : quality === 'high' ? 1 : 1.2;
  if (distance < 90) return { rings: 72, sides: 16, fronds: 30, leaflets: Math.round(76 * q), rows: q < 0.7 ? 3 : 4, rachis: 28, width: 0.062 / Math.min(1, q) };
  if (distance < 220) return { rings: 40, sides: 10, fronds: 26, leaflets: Math.round(36 * q), rows: 2, rachis: 14, width: 0.12 / Math.min(1, q) };
  return { rings: 20, sides: 6, fronds: 18, leaflets: Math.round(15 * q), rows: 2, rachis: 8, width: 0.24 / Math.min(1, q) };
}

// ---------------------------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------------------------

export const coconutPalms: ComponentFactory<Params> = {
  type: 'coconutPalms',
  version: 1,
  description: 'Coconut palms swaying in the trade wind: curved ringed trunks, drooping pinnate fronds, GPU wind with travelling gusts.',
  schema,
  async create(ctx, p) {
    const reduced = ctx.quality.reducedMotion;
    const env = await loadTexture(ctx, p.environment.src, 'color');
    const eye = new Vector3(...p.eye);
    const wind = windVector(p.wind);

    // Explicit palms, then grove palms placed on dry ground, spaced apart.
    const palms: Palm[] = [];
    const place = (spec: PalmSpec) => {
      const y = ctx.ground.height(spec.at[0], spec.at[1]);
      const base = new Vector3(spec.at[0], y - 0.15, spec.at[1]);
      const frondLength = spec.frondLength ?? 3.6 + spec.height * 0.12;
      palms.push({ base, height: spec.height, lean: spec.lean, toward: spec.toward, curve: spec.curve, fronds: spec.fronds ?? 26, frondLength, seed: spec.seed, distance: base.distanceTo(eye) });
    };
    for (const spec of p.palms) place(spec);
    for (const g of p.groves) {
      const rand = seeded(g.seed * 4099 + 7);
      let made = 0;
      for (let tries = 0; made < g.count && tries < g.count * 40; tries++) {
        const x = g.center[0] + (rand() * 2 - 1) * g.radius[0];
        const zz = g.center[1] + (rand() * 2 - 1) * g.radius[1];
        const y = ctx.ground.height(x, zz);
        if (y < p.waterLevel + 0.45) continue;
        if (palms.some((o) => Math.hypot(o.base.x - x, o.base.z - zz) < g.spacing)) continue;
        // Default lean: downhill, towards the water and the open light.
        const e = 1.5;
        const gx = ctx.ground.height(x + e, zz) - ctx.ground.height(x - e, zz);
        const gz = ctx.ground.height(x, zz + e) - ctx.ground.height(x, zz - e);
        const downhill = Math.atan2(-gx, gz) / DEG;
        const toward = g.toward ?? downhill + (rand() - 0.5) * 50;
        const height = g.height[0] + (g.height[1] - g.height[0]) * Math.pow(rand(), 0.8);
        place({ at: [x, zz], height, lean: g.lean[0] + (g.lean[1] - g.lean[0]) * rand(), toward, curve: 0.3 + rand() * 0.6, seed: g.seed * 100 + made + rand(), fronds: undefined, frondLength: undefined });
        made++;
      }
    }

    const trunkB = new Builder();
    const crownB = new Builder();
    palms.forEach((pm, id) => {
      const d = detailFor(pm.distance, ctx.quality.detail);
      pm.fronds = Math.min(pm.fronds, d.fronds);
      const top = buildTrunk(trunkB, pm, d, id);
      const rand = seeded(pm.seed * 1931 + 5);
      // Living fronds, then one or two dead ones hanging under the crown on some palms.
      const deadCount = rand() < 0.55 ? 1 + Math.floor(rand() * 2) : 0;
      for (let f = 0; f < pm.fronds + deadCount; f++) buildFrond(crownB, pm, d, top, f, wind, rand);
      buildCoconuts(crownB, pm, top, rand, pm.distance < 90 ? 7 : 4, pm.distance < 90 ? 9 : 5);
      (pm as Palm & { top: Vector3 }).top = top;
    });
    const trunkGeo = trunkB.geometry(['trunk', 'unused', ''], 'keep');
    trunkGeo.deleteAttribute('unused');
    const crownGeo = crownB.geometry(['crown', 'leaf', 'tint'], 'compute');

    // ---- Wind (vertex) ----
    const u = {
      presence: floatUniform(1),
      wind: floatUniform(p.wind.strength),
      clock: floatUniform(0),
    };
    const motion = reduced ? 0.3 : 1;
    const time = u.clock;
    const palmA = attribute<'vec4'>('palm', 'vec4');
    const windV = vec3(wind[0], 0, wind[1]);
    const crossV = vec3(-wind[1], 0, wind[0]);
    /** The trunk top's displacement for this palm (m). */
    const swayTop = (): { D: V3; S: F } => {
      const S = windField(palmA.xy, time, p.wind, u.wind);
      const seed = palmA.w;
      const f = fract(seed.mul(7.13)).mul(0.1).add(0.24);
      const osc = sin(time.mul(f).mul(Math.PI * 2).add(seed.mul(6.28)));
      const push = S.mul(S).mul(0.011).add(S.mul(osc).mul(0.0065));
      const crossOsc = sin(time.mul(f).mul(Math.PI * 2 * 1.37).add(seed.mul(3.1))).mul(S).mul(0.0035);
      const D = windV.mul(push).add(crossV.mul(crossOsc)).mul(palmA.z).mul(motion) as V3;
      return { D, S };
    };
    const rotate = (v: V3, axis: V3, ang: F): V3 => {
      const c = cos(ang);
      const s = sin(ang);
      return v.mul(c).add(cross(axis, v).mul(s)).add(axis.mul(dot(axis, v).mul(float(1).sub(c)))) as V3;
    };
    const crownTilt = (D: V3): { axis: V3; ang: F } => {
      const len = length(D);
      const axis = vec3(D.z, 0, D.x.negate()).div(len.max(1e-5)) as V3;
      return { axis, ang: len.mul(1.5).div(palmA.z) as F };
    };

    const vTrunkN = varyingProperty('vec3', 'vPalmTrunkN');
    const vTrunkW = varyingProperty('vec3', 'vPalmTrunkW');
    const trunkA = attribute<'vec4'>('trunk', 'vec4');
    const normalA = attribute<'vec3'>('normal', 'vec3');
    const trunkPosition = Fn(() => {
      const { D } = swayTop();
      const t = trunkA.x;
      const bend = t.mul(t).mul(float(3).sub(t)).mul(0.5);
      const { axis, ang } = crownTilt(D);
      const world = positionGeometry.add(D.mul(bend));
      vTrunkN.assign(rotate(normalA, axis, ang.mul(t)));
      vTrunkW.assign(world);
      return world;
    })();

    const crownA = attribute<'vec4'>('crown', 'vec4');
    const leafA = attribute<'vec4'>('leaf', 'vec4');
    const tintA = attribute<'vec4'>('tint', 'vec4');
    const vLeafN = varyingProperty('vec3', 'vPalmLeafN');
    const vLeafW = varyingProperty('vec3', 'vPalmLeafW');
    const crownPosition = Fn(() => {
      const { D, S } = swayTop();
      const pivot = crownA.xyz;
      const local = positionGeometry.sub(pivot);
      const s = leafA.x;
      const l = leafA.y;
      const ph = leafA.z;
      const kind = leafA.w;
      const isFrond = select(kind.lessThan(1.5), float(1), float(0));
      // Fronds facing into the wind are lifted and pushed more than those streaming downwind.
      const facing = cos(crownA.w).mul(windV.x).add(sin(crownA.w).mul(windV.z));
      const flexAmp = s.mul(s).mul(S.mul(0.11).add(0.05)).mul(float(1).sub(facing.mul(0.4))).mul(isFrond).mul(motion);
      const ff = ph.mul(0.25).add(0.55);
      const wave = sin(time.mul(ff).mul(Math.PI * 2).add(ph.mul(6.28)).add(s.mul(2.2)));
      const sway = sin(time.mul(ff).mul(Math.PI * 2 * 0.63).add(ph.mul(9.1)));
      let flex: V3 = windV.mul(flexAmp.mul(sway.mul(0.4).add(0.6))).add(vec3(0, 1, 0).mul(flexAmp.mul(wave).mul(0.55))).mul(3) as V3;
      if (!reduced) {
        // Leaflets flutter: fast, small, out of phase along the frond.
        const flutter = sin(time.mul(Math.PI * 2 * 3.1).add(ph.mul(40)).add(s.mul(31)).add(l.mul(2.5)))
          .add(sin(time.mul(Math.PI * 2 * 4.7).add(ph.mul(17)).add(s.mul(47))).mul(0.5));
        const amp = l.mul(S.mul(0.05).add(0.012)).mul(select(kind.equal(1), float(1), float(0)));
        flex = flex.add(normalA.mul(flutter.mul(amp))) as V3;
      }
      const { axis, ang } = crownTilt(D);
      const bent = rotate(local.add(flex) as V3, axis, ang);
      const world = bent.add(pivot).add(D);
      vLeafN.assign(rotate(normalA, axis, ang));
      vLeafW.assign(world);
      return world;
    })();

    // ---- Shading ----
    const sunV = skyDirection(p.sun.azimuth, p.sun.elevation);
    const L = vec3(...sunV);
    const sunLight = colorUniform(p.sunColor, p.sunIntensity);
    const sky = (n: V3): V3 => (env ? sampleEnvironment(env, n, p.environment, 6).mul(p.skyLight) : vec3(0.3, 0.4, 0.55).mul(p.skyLight)) as V3;

    // Fronds: two-sided leaflets, glossy above, paler beneath, glowing when backlit.
    const view = normalize(cameraPosition.sub(vLeafW));
    const nRaw = normalize(vLeafN);
    const facing = dot(nRaw, view);
    const nF = select(facing.lessThan(0), nRaw.negate(), nRaw) as V3;
    const kind = leafA.w;
    const age = tintA.x;
    const rnd = tintA.y;
    const ao = tintA.z;
    const isLeaflet = select(kind.equal(1), float(1), float(0));
    const topSide = facing.greaterThan(0);
    const leafBase = mix(colorUniform(p.leaf), colorUniform(p.leafOld), smoothstep(0.55, 1.0, age).mul(0.65));
    const jitter = rnd.sub(0.5);
    const leafTop = leafBase.mul(float(0.88).add(jitter.mul(0.3))).add(vec3(0.02, 0.015, -0.01).mul(jitter));
    const leafUnder = mix(colorUniform(p.leafUnder), colorUniform(p.leafOld), smoothstep(0.55, 1.0, age).mul(0.5)).mul(float(0.92).add(jitter.mul(0.2)));
    let albedo: V3 = select(topSide, leafTop, leafUnder) as V3;
    // Dry, browned leaflet tips on some leaflets; whole dead fronds hang brown.
    const brownTip = smoothstep(float(1).sub(tintA.w.mul(0.16)), float(1.04).sub(tintA.w.mul(0.1)), leafA.y).mul(tintA.w).mul(0.8);
    albedo = mix(albedo, colorUniform(p.dead).mul(1.15), brownTip) as V3;
    const rachisCol = mix(colorUniform(p.dead), colorUniform(p.rachis), smoothstep(0.02, 0.12, leafA.x));
    albedo = select(kind.lessThan(0.5), rachisCol, albedo) as V3;
    const nutCol = mix(colorUniform(p.coconut), colorUniform(p.dead).mul(0.8), smoothstep(0.65, 0.95, age)).mul(float(0.85).add(rnd.mul(0.3)));
    albedo = select(kind.greaterThan(1.5), nutCol, albedo) as V3;
    albedo = mix(albedo, colorUniform(p.dead).mul(float(0.85).add(rnd.mul(0.3))), smoothstep(1.05, 1.15, age)) as V3;
    // Shade inside the crown: deeper fronds sit in a dappled shadow that shifts as they move.
    const dapple = smoothstep(0.42, 0.62, mx_noise_float(vec3(vLeafW.mul(1.6)).add(vec3(time.mul(0.35), 0, time.mul(0.2)))).mul(0.5).add(0.5));
    const inner = float(1).sub(smoothstep(0.6, 0.95, ao));
    const sunVis = mix(float(1), dapple.mul(0.75).add(0.08), inner);
    const ndl = dot(nF, L);
    const direct = sunLight.mul(max(ndl, 0)).mul(sunVis);
    const transCol = albedo.mul(vec3(1.25, 1.35, 0.55)).add(vec3(0.03, 0.04, 0.0));
    const trans = transCol.mul(sunLight).mul(max(ndl.negate(), 0).mul(p.translucency).mul(sunVis).mul(isLeaflet.mul(0.85).add(0.15)));
    const ambient = sky(nF).mul(ao.mul(0.8).add(0.2));
    const H = normalize(L.add(view));
    const gloss = pow(max(dot(nF, H), 0), 40).mul(0.32).mul(select(topSide, float(1), float(0.25))).mul(isLeaflet.mul(0.8).add(0.2));
    const frondColor = albedo.mul(direct.add(ambient)).add(trans).add(sunLight.mul(gloss).mul(sunVis));

    // Trunks: grey-brown bark ringed with leaf scars, fine vertical fissures, a darker foot.
    const tView = normalize(cameraPosition.sub(vTrunkW));
    const tN = normalize(vTrunkN);
    const tDist = length(cameraPosition.sub(vTrunkW));
    const arc = trunkA.z;
    const around = trunkA.y;
    const tt = trunkA.x;
    const seedT = palmA.w;
    const ringPhase = arc.div(0.15).add(mx_noise_float(vec3(arc.mul(0.35), seedT, 0.5)).mul(1.2));
    const fr = fract(ringPhase).sub(0.5);
    const g0 = fr.div(0.09);
    const groove = exp(g0.mul(g0).negate());
    const r0 = fr.sub(0.16).div(0.07);
    const ridge = exp(r0.mul(r0).negate());
    const fine = smoothstep(90, 20, tDist);
    const fissure = smoothstep(0.25, 0.75, mx_noise_float(vec3(around.mul(26), arc.mul(0.5), seedT.mul(3))).mul(0.5).add(0.5));
    const patch = mx_noise_float(vec3(around.mul(4), arc.mul(0.18), seedT.mul(5))).mul(0.5).add(0.5);
    let bark: V3 = colorUniform(p.bark).mul(float(0.82).add(patch.mul(0.3))) as V3;
    bark = mix(bark, colorUniform(p.scar), groove.mul(0.42).mul(fine).add(groove.mul(0.12).mul(float(1).sub(fine)))) as V3;
    bark = bark.mul(float(1).add(ridge.mul(0.12).mul(fine))).mul(float(1).sub(fissure.mul(0.12).mul(fine))) as V3;
    bark = mix(bark, colorUniform(p.scar).mul(0.9), smoothstep(1.6, 0.0, arc).mul(0.45)) as V3;
    // Scar grooves tilt the surface up and down the trunk.
    const bump = fr.mul(groove).mul(1.6).mul(fine);
    const tNb = normalize(tN.add(vec3(0, 1, 0).mul(bump)));
    const tFacing = select(dot(tNb, tView).lessThan(-0.2), tNb.negate(), tNb) as V3;
    const crownShade = mix(float(1), float(0.32), smoothstep(0.86, 0.985, tt));
    const tDirect = sunLight.mul(max(dot(tFacing, L).mul(0.85).add(0.15), 0)).mul(crownShade);
    const tAmb = sky(tFacing).mul(mix(float(0.55), float(1), smoothstep(0, 0.05, tt)));
    const trunkColor = bark.mul(tDirect.add(tAmb));

    const trunkMat = new MeshBasicNodeMaterial();
    trunkMat.positionNode = trunkPosition;
    trunkMat.colorNode = vec4(trunkColor.mul(u.presence), 1);
    noBloom(trunkMat);
    const crownMat = new MeshBasicNodeMaterial();
    crownMat.positionNode = crownPosition;
    crownMat.colorNode = vec4(frondColor.mul(u.presence), 1);
    crownMat.side = DoubleSide;
    noBloom(crownMat);

    const group = new Group();
    const trunks = new Mesh(trunkGeo, trunkMat);
    const crowns = new Mesh(crownGeo, crownMat);
    trunks.frustumCulled = false;
    crowns.frustumCulled = false;
    trunks.name = 'palm-trunks';
    crowns.name = 'palm-crowns';
    group.add(trunks, crowns);
    // Inspection aid (review captures): where each palm's crown is.
    group.userData.palms = palms.map((pm) => ({ base: pm.base.toArray(), top: (pm as Palm & { top: Vector3 }).top.toArray(), height: pm.height }));

    // The nearest palms throw their shadows on the shore and the lagoon floor.
    const nearest = [...palms].sort((a, b) => a.distance - b.distance).slice(0, shadowCasters.length);
    shadowCasters.forEach((c, i) => {
      const pm = nearest[i];
      if (!pm) {
        c.crown.value.set(0, -1000, 0, 0);
        c.base.value.set(0, -1000, 0, 0);
        return;
      }
      const top = (pm as Palm & { top: Vector3 }).top;
      c.crown.value.set(top.x, top.y - 0.9, top.z, pm.frondLength * 0.85);
      c.base.value.set(pm.base.x, pm.base.y, pm.base.z, 0.2 + pm.height * 0.004);
    });
    const textures: (Texture | null)[] = [env];
    return {
      object: group,
      reactive: { wind: u.wind },
      update(frame) {
        u.clock.value += Math.min(0.1, frame.dt) * (reduced ? 0.5 : 1);
        shadowTime.value = u.clock.value;
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        for (const c of shadowCasters) {
          c.crown.value.set(0, -1000, 0, 0);
          c.base.value.set(0, -1000, 0, 0);
        }
        trunkGeo.dispose();
        crownGeo.dispose();
        trunkMat.dispose();
        crownMat.dispose();
        for (const tex of textures) tex?.dispose();
      },
    };
  },
};
