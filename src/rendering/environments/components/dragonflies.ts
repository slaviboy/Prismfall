import { BufferAttribute, BufferGeometry, DoubleSide, Group, InstancedBufferAttribute, Mesh, MeshBasicNodeMaterial, NormalBlending, type Node } from 'three/webgpu';
import {
  Fn,
  abs,
  atan,
  attribute,
  cameraPosition,
  cos,
  cross,
  dot,
  float,
  floor,
  fract,
  fwidth,
  hash,
  instancedBufferAttribute,
  length,
  max,
  min,
  mix,
  mrt,
  mx_noise_float,
  mx_worley_noise_vec2,
  normalGeometry,
  normalize,
  positionGeometry,
  pow,
  reflect,
  select,
  sin,
  smoothstep,
  sqrt,
  uint,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { colorUniform, floatUniform, seeded, zColor, zVec3 } from './common';
import { revealMask } from './reveal';

const schema = z.object({
  count: z.number().int().min(1).max(16).default(5),
  /**
   * Where the dragonflies keep their beats: a box whose x range is mirrored either side of the view
   * axis. Every beat (hover points, glides, darts) stays outside |x| < clearance × (viewZ − z).
   */
  area: z
    .object({
      center: zVec3.default([0, -3, -2]),
      size: zVec3.default([100, 7, 30]),
      clearance: z.number().min(0).default(0.38),
      viewZ: z.number().default(30.5),
      /** Beats are centred inside |x| < edge × (viewZ − z) where they fit (0.66: on screen at 16:9). */
      edge: z.number().positive().default(0.66),
    })
    .prefault({}),
  /** Half-size of a beat (world units); its width shrinks for near dragonflies (at most 0.1 × distance). */
  beat: zVec3.default([5, 1, 2.5]),
  /** Body length range (world units). */
  length: z.tuple([z.number().positive(), z.number().positive()]).default([1.5, 1.8]),
  /** Body colours: a mature male red darter (akatombo). */
  abdomen: zColor.default('#b8291b'),
  thorax: zColor.default('#7c3a22'),
  eye: zColor.default('#8a3a26'),
  /** Wings: venation, the pterostigma, the amber flush at the base and the thin-film sheen. */
  venation: zColor.default('#2a1a12'),
  stigma: zColor.default('#80301c'),
  amber: zColor.default('#d8962e'),
  iridescence: z.number().min(0).max(1).default(0.18),
  /** Light to match the photograph: sky and ground bounce, and the sun (direction towards it). */
  sky: zColor.default('#e8ecd8'),
  ground: zColor.default('#3c4428'),
  sun: z
    .object({
      direction: zVec3.default([0.05, 0.55, -0.83]),
      color: zColor.default('#fff0d2'),
      intensity: z.number().min(0).default(1.7),
    })
    .prefault({}),
  ambient: z.number().min(0).default(0.7),
  /** Seconds per hover-and-dart (warped per dragonfly, so hovers last about 1.5 to 7 s). */
  slot: z.number().positive().default(3.2),
  /** Share of a slot spent darting to the next hover point. */
  dart: z.number().min(0.05).max(0.4).default(0.14),
  /** Chance that a hover turns into a short glide on still wings (the rest pose). */
  glide: z.number().min(0).max(1).default(0.3),
  /** Wing beats per second and the motion-blur copies drawn per wing. */
  wingbeat: z.number().positive().default(32),
  blur: z.number().int().min(1).max(12).default(10),
  bloom: z.number().min(0).default(0.04),
  seed: z.number().default(1),
});

type Params = z.infer<typeof schema>;
type F = Node<'float'>;
type V3 = Node<'vec3'>;

const TAU = Math.PI * 2;
/** Body-length units: wing lengths and roots (fore, hind). */
const WING_LENGTH = [0.72, 0.69] as const;
const WING_ROOT: readonly [number, number, number][] = [
  [0.02, 0.064, -0.148],
  [0.02, 0.06, -0.082],
];
/** Glide length (body lengths), hover drift and jitter (world units, body lengths). */
const GLIDE = 0.5;
const DRIFT = 0.25;
const JITTER = 0.035;
/** Height of the hop in the middle of a dart (world units, at most). */
const HOP = 0.6;
/** Slot clock offset so cycle indices k − 2 stay positive (they seed the per-slot hashes). */
const K0 = 1000;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Minimum-jerk position profile: leaves and arrives at rest, the shape of a quick insect dart. */
export function minJerk(s: number): number {
  const x = Math.min(1, Math.max(0, s));
  return x * x * x * (10 - 15 * x + 6 * x * x);
}

/** Warped slot clock: integer crossings are the darts; the rate wanders so hovers vary in length. */
export function slotClock(t: number, slot: number, seed: number): number {
  return t / slot + 0.15 * Math.sin((TAU * t) / (3.7 * slot) + seed * 17) + 0.1 * Math.sin((TAU * t) / (2.3 * slot) + seed * 5) + K0;
}

/** Rate of the slot clock (slots per second); always positive. */
export function slotRate(t: number, slot: number, seed: number): number {
  return (1 + ((0.15 * TAU) / 3.7) * Math.cos((TAU * t) / (3.7 * slot) + seed * 17) + ((0.1 * TAU) / 2.3) * Math.cos((TAU * t) / (2.3 * slot) + seed * 5)) / slot;
}

/** Wing outline in wing-length units: leading-edge offset and chord at span u (0 root .. 1 tip). */
export function wingOutline(u: number, hind: boolean): { le: number; chord: number } {
  const tip = Math.sqrt(Math.max(0, 1 - Math.max(0, (u - 0.78) / 0.22) ** 2));
  const chord = hind
    ? 0.06 + 0.23 * smooth(0, 0.12, u) - 0.1 * smooth(0.12, 0.55, u) - 0.02 * smooth(0.55, 0.85, u)
    : 0.055 + 0.135 * smooth(0, 0.3, u) - 0.03 * smooth(0.45, 0.85, u);
  return { le: -0.015 * Math.sin(u * 2.8), chord: chord * (u > 1 ? 0 : tip) };
}

export interface Territory {
  x: number;
  y: number;
  z: number;
  /** Half-size of the box the hover points are drawn from. */
  hx: number;
  hy: number;
  hz: number;
  len: number;
  seed: number;
  slot: number;
  phase: number;
}

/** How far a dragonfly can stray outside its hover-point box (glide, drift, jitter, hop). */
export function territoryMargin(len: number): { xz: number; y: number } {
  return { xz: GLIDE * len + DRIFT * 1.3 + JITTER * len * 2, y: HOP + DRIFT * 0.6 + JITTER * len * 2 };
}

/**
 * Deterministic beats, alternating sides, outside the clear cone (glides and drift included) and
 * spread apart on screen.
 */
export function placeTerritories(p: Params, count: number, rand: () => number): Territory[] {
  const [cx, cy, cz] = p.area.center;
  const [sx, sy, sz] = p.area.size;
  const { clearance, viewZ } = p.area;
  const out: Territory[] = [];
  const firstSide = rand() < 0.5 ? -1 : 1;
  for (let i = 0; i < count; i++) {
    const side = i % 2 === 0 ? firstSide : -firstSide;
    const len = p.length[0] + (p.length[1] - p.length[0]) * rand();
    const m = territoryMargin(len);
    let best: Territory | null = null;
    let bestGap = -Infinity;
    for (let attempt = 0; attempt < 48; attempt++) {
      const z = cz + (rand() - 0.5) * sz;
      const y = cy + (rand() - 0.5) * sy;
      const dist = Math.max(1, viewZ - z);
      const hx = Math.min(p.beat[0], 0.1 * dist) * (0.85 + rand() * 0.3);
      const hz = p.beat[2] * (0.85 + rand() * 0.3);
      // The far edge of the beat is where the cone is widest.
      const minX = clearance * (viewZ - z + hz + m.xz) + hx + m.xz + 0.25;
      const maxX = Math.max(minX, Math.min(Math.abs(cx) + sx * 0.5, p.area.edge * dist - hx * 0.3));
      const x = side * (minX + (maxX - minX) * rand());
      const sxv = x / dist;
      const syv = y / dist;
      const gap = out.reduce((g, o) => Math.min(g, Math.hypot(o.x / (viewZ - o.z) - sxv, o.y / (viewZ - o.z) - syv)), Infinity);
      if (gap > bestGap) {
        bestGap = gap;
        best = { x, y, z, hx, hy: p.beat[1], hz, len, seed: 0, slot: 0, phase: 0 };
      }
      if (gap > 0.12) break;
    }
    const t = best as Territory;
    t.seed = rand();
    t.slot = p.slot * (0.8 + rand() * 0.4);
    t.phase = rand();
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Geometry (body-length units, facing −Z, +Y up).
// ---------------------------------------------------------------------------------------------

const ABDOMEN: [number, number][] = [
  [0, 0.03],
  [0.03, 0.037],
  [0.09, 0.039],
  [0.15, 0.03],
  [0.2, 0.024],
  [0.3, 0.026],
  [0.45, 0.029],
  [0.6, 0.032],
  [0.72, 0.033],
  [0.82, 0.03],
  [0.9, 0.025],
  [0.95, 0.019],
  [0.985, 0.011],
  [1, 0.0],
];
/** Segment joints along the abdomen (fraction of its length). */
export const ABDOMEN_JOINTS = [0.04, 0.13, 0.245, 0.36, 0.475, 0.59, 0.7, 0.79, 0.87, 0.935] as const;
const THORAX_FRONT = -0.255;
const THORAX_BACK = -0.02;
const ABDOMEN_FRONT = -0.035;
const ABDOMEN_TIP = 0.67;

function catmull(points: [number, number][], a: number): number {
  const n = points.length;
  let i = 0;
  while (i < n - 2 && a > points[i + 1]![0]) i++;
  const p0 = points[Math.max(0, i - 1)]!;
  const p1 = points[i]!;
  const p2 = points[i + 1]!;
  const p3 = points[Math.min(n - 1, i + 2)]!;
  const t = Math.min(1, Math.max(0, (a - p1[0]) / (p2[0] - p1[0])));
  const v0 = p0[1], v1 = p1[1], v2 = p2[1], v3 = p3[1];
  return 0.5 * (2 * v1 + (-v0 + v2) * t + (2 * v0 - 5 * v1 + 4 * v2 - v3) * t * t + (-v0 + 3 * v1 - 3 * v2 + v3) * t * t * t);
}

/** Body tube profile at z: half width, half height, centre height. */
function tubeProfile(z: number): [number, number, number] {
  const t = (z - THORAX_FRONT) / (THORAX_BACK - THORAX_FRONT);
  const th = t >= 0 && t <= 1 ? Math.sqrt(Math.max(0, 1 - ((t - 0.46) / 0.54) ** 2)) : 0;
  const thorax: [number, number, number] = [0.062 * th, 0.082 * th, 0.006 + 0.012 * t];
  const a = (z - ABDOMEN_FRONT) / (ABDOMEN_TIP - ABDOMEN_FRONT);
  let w = a >= 0 && a <= 1 ? Math.max(0, catmull(ABDOMEN, a)) : 0;
  for (const j of ABDOMEN_JOINTS) w *= 1 - 0.1 * Math.exp(-(((a - j) / 0.007) ** 2));
  const abdomen: [number, number, number] = [w, w * (a < 0.14 ? 1.18 : 1.08), 0.022 - 0.014 * a];
  return thorax[0] >= abdomen[0] ? thorax : abdomen;
}

/**
 * One red darter, one unit long, facing −Z. Vertex attribute `part` = (part, along, height, 0):
 * part 0 thorax and abdomen, 1 eyes, 2 face, 3 legs and appendages; along 0 head .. 1 tip;
 * height −1 ventral .. 1 dorsal.
 */
export function dragonflyBodyGeometry(): BufferGeometry {
  const pos: number[] = [];
  const part: number[] = [];
  const idx: number[] = [];
  const along = (zz: number) => (zz + 0.33) / 1.03;
  const AROUND = 12;
  // Tube: rings bunched at the segment joints and the waist.
  const zs: number[] = [];
  for (let i = 0; i <= 20; i++) zs.push(THORAX_FRONT + 0.004 + ((THORAX_BACK - 0.03 - THORAX_FRONT) * i) / 20);
  for (let i = 0; i <= 84; i++) zs.push(ABDOMEN_FRONT + 0.02 + (ABDOMEN_TIP - 0.004 - ABDOMEN_FRONT - 0.02) * (i / 84));
  zs.sort((a, b) => a - b);
  const tubeStart = pos.length / 3;
  pos.push(0, tubeProfile(zs[0]!)[2], zs[0]! - 0.004);
  part.push(0, along(zs[0]!), 0, 0);
  for (const zz of zs) {
    const [hw, hh, yc] = tubeProfile(zz);
    for (let j = 0; j < AROUND; j++) {
      const phi = (j / AROUND) * TAU;
      const s = Math.sin(phi);
      // A slightly keeled back (dorsal carina) on the abdomen.
      const keel = zz > ABDOMEN_FRONT && s > 0 ? 1 + 0.12 * Math.pow(s, 6) : 1;
      pos.push(Math.cos(phi) * hw, yc + s * hh * keel, zz);
      part.push(0, along(zz), s, 0);
    }
  }
  const tipZ = ABDOMEN_TIP;
  pos.push(0, tubeProfile(tipZ - 0.004)[2], tipZ);
  part.push(0, 1, 0, 0);
  const ringsN = zs.length;
  for (let j = 0; j < AROUND; j++) idx.push(tubeStart, tubeStart + 1 + ((j + 1) % AROUND), tubeStart + 1 + j);
  for (let i = 0; i < ringsN - 1; i++) {
    for (let j = 0; j < AROUND; j++) {
      const a = tubeStart + 1 + i * AROUND + j;
      const b = tubeStart + 1 + i * AROUND + ((j + 1) % AROUND);
      idx.push(a, b, b + AROUND, a, b + AROUND, a + AROUND);
    }
  }
  const tipIndex = tubeStart + 1 + ringsN * AROUND;
  const lastRing = tubeStart + 1 + (ringsN - 1) * AROUND;
  for (let j = 0; j < AROUND; j++) idx.push(tipIndex, lastRing + j, lastRing + ((j + 1) % AROUND));

  /** Ellipsoid (UV sphere) for the head parts. */
  const ellipsoid = (c: [number, number, number], r: [number, number, number], kind: number, rings = 10, segs = 14, shape?: (nx: number, ny: number, nz: number) => number) => {
    const start = pos.length / 3;
    for (let i = 0; i <= rings; i++) {
      const th = (i / rings) * Math.PI;
      for (let j = 0; j <= segs; j++) {
        const ph = (j / segs) * TAU;
        const nx = Math.sin(th) * Math.cos(ph);
        const ny = Math.cos(th);
        const nz = Math.sin(th) * Math.sin(ph);
        const k = shape ? shape(nx, ny, nz) : 1;
        pos.push(c[0] + nx * r[0] * k, c[1] + ny * r[1] * k, c[2] + nz * r[2] * k);
        part.push(kind, along(c[2] + nz * r[2]), ny, 0);
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segs; j++) {
        const a = start + i * (segs + 1) + j;
        const b = a + segs + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  };
  // Head: one wide, short capsule. The two compound eyes cover its top and sides and meet along a
  // shallow seam on top; the face (frons, mouthparts) is the flattened front below them. The
  // fragment shader tells eye from face by the surface direction.
  ellipsoid([0, 0.012, -0.29], [0.076, 0.056, 0.043], 1, 18, 28, (nx, ny, nz) => {
    const seam = Math.exp(-((nx / 0.14) ** 2)) * Math.max(0, ny + 0.3) * 0.14;
    const lobes = 1 + 0.08 * Math.abs(nx) * Math.max(0, 1 - Math.abs(ny));
    const face = nz < 0 && ny < 0.35 ? 1 - 0.1 * Math.min(1, -nz * 1.4) * Math.min(1, (0.35 - ny) * 2) : 1;
    return (lobes - seam) * face;
  });

  /** A thin tapered prism between two points (legs, appendages). */
  const strut = (a: [number, number, number], b: [number, number, number], ra: number, rb: number) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
    const t = [d[0]! / l, d[1]! / l, d[2]! / l];
    const ref = Math.abs(t[1]!) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u1 = [t[1]! * ref[2]! - t[2]! * ref[1]!, t[2]! * ref[0]! - t[0]! * ref[2]!, t[0]! * ref[1]! - t[1]! * ref[0]!];
    const ul = Math.hypot(u1[0]!, u1[1]!, u1[2]!) || 1;
    const e1 = u1.map((v) => v / ul);
    const e2 = [t[1]! * e1[2]! - t[2]! * e1[1]!, t[2]! * e1[0]! - t[0]! * e1[2]!, t[0]! * e1[1]! - t[1]! * e1[0]!];
    const start = pos.length / 3;
    const SIDES = 5;
    for (const [c, r] of [
      [a, ra],
      [b, rb],
    ] as const) {
      for (let k = 0; k < SIDES; k++) {
        const ang = (k / SIDES) * TAU;
        const cs = Math.cos(ang) * r;
        const sn = Math.sin(ang) * r;
        pos.push(c[0] + e1[0]! * cs + e2[0]! * sn, c[1] + e1[1]! * cs + e2[1]! * sn, c[2] + e1[2]! * cs + e2[2]! * sn);
        part.push(3, along(c[2]), 0, 0);
      }
    }
    for (let k = 0; k < SIDES; k++) {
      const k1 = (k + 1) % SIDES;
      idx.push(start + k, start + k1, start + SIDES + k1, start + k, start + SIDES + k1, start + SIDES + k);
    }
  };
  // Legs folded under the thorax in flight: femur forward and down, tibia back along the body.
  const legs: [number, number][] = [
    [-0.215, 0.95],
    [-0.17, 1.0],
    [-0.122, 1.1],
  ];
  for (const [lz, k] of legs) {
    for (const sgn of [-1, 1]) {
      const hip: [number, number, number] = [sgn * 0.022, -0.055, lz];
      const knee: [number, number, number] = [sgn * 0.045, -0.088 * k, lz - 0.045 * k];
      const foot: [number, number, number] = [sgn * 0.026, -0.092 * k, lz + 0.055 * k];
      strut(hip, knee, 0.0052, 0.0038);
      strut(knee, foot, 0.0034, 0.0018);
    }
  }
  // Superior appendages (cerci) at the abdomen tip.
  for (const sgn of [-1, 1]) strut([sgn * 0.006, tubeProfile(0.66)[2] + 0.004, 0.66], [sgn * 0.01, tubeProfile(0.66)[2] + 0.002, 0.705], 0.006, 0.0015);

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('part', new BufferAttribute(new Float32Array(part), 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

/**
 * Four wings × `copies` motion-blur copies. Each wing is a grid fitted to its outline (a small pad
 * around it; the fragment shader cuts the exact edge). Position = (span, 0, chord) in body-length
 * units from the wing root; attribute `wing` = (wing 0..3: left fore, right fore, left hind,
 * right hind; copy index; wing length; 0).
 */
export function dragonflyWingGeometry(copies: number): BufferGeometry {
  const pos: number[] = [];
  const wing: number[] = [];
  const idx: number[] = [];
  const SPAN = 14;
  const CHORD = 4;
  for (let w = 0; w < 4; w++) {
    const hind = w >= 2;
    const L = WING_LENGTH[hind ? 1 : 0];
    for (let c = 0; c < copies; c++) {
      const base = pos.length / 3;
      for (let i = 0; i <= SPAN; i++) {
        // Denser towards the rounded tip.
        const u = Math.min(1, Math.sin(((i / SPAN) * Math.PI) / 2) * 1.004);
        const o = wingOutline(Math.min(u, 0.999), hind);
        const pad = 0.012;
        for (let j = 0; j <= CHORD; j++) {
          const v = o.le - pad + ((o.chord + 2 * pad) * j) / CHORD;
          pos.push(u * L, 0, v * L);
          wing.push(w, c, L, 0);
        }
      }
      for (let i = 0; i < SPAN; i++) {
        for (let j = 0; j < CHORD; j++) {
          const a = base + i * (CHORD + 1) + j;
          const b = a + CHORD + 1;
          idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('wing', new BufferAttribute(new Float32Array(wing), 4));
  g.setIndex(idx);
  return g;
}

/**
 * Red darter dragonflies (Sympetrum, the Japanese akatombo). A slender body lofted from a real
 * profile: big touching compound eyes, a robust thorax, a ten-segment abdomen with a waist at
 * segment three and ringed joints, folded legs and cerci; glossy red cuticle that glows where the
 * sun shines through it. Four transparent wings cut analytically in the fragment shader with
 * real venation (costa, subcosta, radius, nodus, cross-veins, a cellular posterior field), a dark
 * pterostigma, an amber flush at the base and a thin-film sheen in their reflections.
 *
 * Flight is the real hover-and-dart pattern: each dragonfly keeps a beat, hovers at a point
 * (holding still, scanning a little), turns, darts to the next point on a minimum-jerk profile
 * (pitching into the acceleration, a small hop), and hovers again. Hover lengths wander, so some
 * are long pauses; some hovers become short glides on still wings (the rest pose). Wings beat at
 * about 30 Hz with hind wings leading, drawn as several semi-transparent copies spread over the
 * stroke so they read as a blur with the pterostigmata smeared into arcs.
 *
 * Everything runs in the vertex shader from a clock and per-dragonfly data (hover points are
 * hashed per slot): two draw calls (bodies, wings), no per-frame CPU work beyond the clock.
 */
export const dragonfliesComponent: ComponentFactory<Params> = {
  type: 'dragonflies',
  version: 1,
  description: 'Red darter dragonflies: segmented bodies, four veined iridescent wings with motion blur, hover-dart-hover flight and glides on still wings.',
  schema,
  create(ctx, p) {
    const detail = ctx.quality.detail === 'low' ? 0.6 : ctx.quality.detail === 'medium' ? 0.8 : ctx.quality.detail === 'ultra' ? 1.2 : 1;
    const count = Math.max(1, Math.round(p.count * detail));
    const copies = ctx.quality.detail === 'low' ? Math.min(4, p.blur) : p.blur;
    const rand = seeded(p.seed * 7411 + 5);
    const beats = placeTerritories(p, count, rand);
    const body = dragonflyBodyGeometry();
    const wings = dragonflyWingGeometry(copies);
    // Per dragonfly: beat centre + seed; hover-box half-size + length; slot, phase, wingbeat.
    const a = new Float32Array(count * 4);
    const b = new Float32Array(count * 4);
    const c = new Float32Array(count * 4);
    beats.forEach((t, i) => {
      a.set([t.x, t.y, t.z, t.seed], i * 4);
      b.set([t.hx, t.hy, t.hz, t.len], i * 4);
      c.set([t.slot, t.phase, p.wingbeat * (0.9 + t.seed * 0.2), 0], i * 4);
    });
    const ia = new InstancedBufferAttribute(a, 4);
    const ib = new InstancedBufferAttribute(b, 4);
    const ic = new InstancedBufferAttribute(c, 4);

    const u = { time: floatUniform(0), presence: floatUniform(1) };
    const motionRate = ctx.quality.reducedMotion ? 0.5 : 1;
    const sunDir = (() => {
      const d = p.sun.direction;
      const l = Math.hypot(d[0], d[1], d[2]) || 1;
      return vec3(d[0] / l, d[1] / l, d[2] / l);
    })();
    const skyC = colorUniform(p.sky);
    const groundC = colorUniform(p.ground);
    const sunC = colorUniform(p.sun.color, p.sun.intensity);

    /** The flight state for the current instance, built once per material (vertex stage). */
    const flight = () => {
      const A = instancedBufferAttribute<'vec4'>(ia, 'vec4');
      const B = instancedBufferAttribute<'vec4'>(ib, 'vec4');
      const C = instancedBufferAttribute<'vec4'>(ic, 'vec4');
      const seed = A.w;
      const len = B.w;
      const slot = C.x;
      const t = (u.time as unknown as F).mul(motionRate) as F;
      const seedU = seed.mul(1e6).toUint();
      const h = (k: F, n: number): F => hash(k.toUint().mul(uint(1664525)).add(seedU).add(uint((n * 1013904223) >>> 0))) as F;
      const station = (k: F): V3 => A.xyz.add(vec3(h(k, 0), h(k, 1), h(k, 2)).mul(2).sub(1).mul(B.xyz)) as V3;
      const flat = (v: V3): V3 => normalize(vec3(v.x, 0, v.z).add(vec3(1e-4, 0, 0))) as V3;
      const glides = (k: F): F => select(h(k, 3).lessThan(p.glide), float(1), float(0)) as F;
      const yawOf = (v: V3): F => atan(v.x, v.z.negate()) as F;
      const angDiff = (target: F, from: F): F => atan(sin(target.sub(from)), cos(target.sub(from))) as F;
      // Warped slot clock (see slotClock).
      const tau = t
        .div(slot)
        .add(sin(t.mul(TAU).div(slot.mul(3.7)).add(seed.mul(17))).mul(0.15))
        .add(sin(t.mul(TAU).div(slot.mul(2.3)).add(seed.mul(5))).mul(0.1))
        .add(K0);
      const k = floor(tau) as F;
      const f = fract(tau);
      const sM2 = station(k.sub(2) as F);
      const sM1 = station(k.sub(1) as F);
      const s0 = station(k);
      const s1 = station(k.add(1) as F);
      const glideLen = len.mul(GLIDE);
      const g0 = flat(s0.sub(sM1) as V3).mul(glideLen.mul(glides(k)));
      const gM1 = flat(sM1.sub(sM2) as V3).mul(glideLen.mul(glides(k.sub(1) as F)));
      const e0 = s0.add(g0) as V3;
      const eM1 = sM1.add(gM1) as V3;
      const gliding = glides(k);
      const dartStart = 1 - p.dart;
      const inDart = f.greaterThan(dartStart);
      const hv = f.div(dartStart).min(1);
      const sd = f.sub(dartStart).div(p.dart).max(0);
      const m = sd.mul(sd).mul(sd).mul(sd.mul(sd.mul(6).sub(15)).add(10));
      const span = s1.sub(e0);
      const hop = min(length(span).mul(0.12), float(HOP)).mul(sin(sd.mul(Math.PI)));
      const hoverPos = s0.add(g0.mul(smoothstep(0.1, 0.85, hv)));
      const dartPos = e0.add(span.mul(m)).add(vec3(0, hop, 0));
      const jitter = vec3(
        sin(t.mul(6.1).add(seed.mul(11))).mul(0.6).add(sin(t.mul(9.3).add(seed.mul(5))).mul(0.4)),
        sin(t.mul(5.3).add(seed.mul(7))).mul(0.6).add(sin(t.mul(8.1).add(seed.mul(3))).mul(0.4)),
        sin(t.mul(4.7).add(seed.mul(13))),
      ).mul(len.mul(JITTER));
      const drift = vec3(sin(t.mul(0.53).add(seed.mul(23))), sin(t.mul(0.71).add(seed.mul(29))).mul(0.6), sin(t.mul(0.37).add(seed.mul(31)))).mul(DRIFT);
      const centre = select(inDart, dartPos, hoverPos).add(jitter).add(drift) as V3;
      // Heading: arrive facing the last dart, scan a little, turn to the next target, dart.
      const arrive = yawOf(s0.sub(eM1) as V3);
      const dartYaw = yawOf(span as V3);
      const scanWindow = smoothstep(0.0, 0.18, hv).mul(float(1).sub(smoothstep(0.6, 0.8, hv))).mul(float(1).sub(gliding));
      const scan = sin(t.mul(0.9).add(seed.mul(37))).mul(0.45).add(sin(t.mul(2.3).add(seed.mul(3))).mul(0.12)).mul(scanWindow);
      const base = arrive.add(scan);
      const turn = smoothstep(0.8, 1, hv);
      const turnBy = angDiff(dartYaw, base);
      const yaw = select(inDart, dartYaw, base.add(turnBy.mul(turn))) as F;
      // Pitch: a little nose-up in the hover, nose down to accelerate and up to brake, with the climb.
      const accel = sd.mul(60).sub(sd.mul(sd).mul(180)).add(sd.mul(sd).mul(sd).mul(120)).div(5.77);
      const climb = atan(span.y, length(vec3(span.x, 0, span.z)).add(1e-3));
      const hoverPitch = sin(t.mul(1.1).add(seed.mul(9))).mul(0.03).add(0.1);
      const pitch = select(inDart, hoverPitch.sub(accel.mul(0.22)).add(climb.mul(0.4).mul(sin(sd.mul(Math.PI)))), hoverPitch) as F;
      const roll = sin(t.mul(0.9).add(seed.mul(3))).mul(0.04).sub(turnBy.mul(turn).mul(float(1).sub(turn)).mul(1.2).mul(select(inDart, float(0), float(1))));
      const cp = cos(pitch);
      const fwd = vec3(sin(yaw).mul(cp), sin(pitch), cos(yaw).negate().mul(cp)) as V3;
      const right0 = normalize(cross(fwd, vec3(0, 1, 0)));
      const up0 = cross(right0, fwd);
      const right = right0.mul(cos(roll)).add(up0.mul(sin(roll))) as V3;
      const up = up0.mul(cos(roll)).sub(right0.mul(sin(roll))) as V3;
      // Wings flap except in the still middle of a glide.
      const flap = float(1).sub(gliding.mul(smoothstep(0.18, 0.28, hv)).mul(float(1).sub(smoothstep(0.68, 0.78, hv))).mul(select(inDart, float(0), float(1)))) as F;
      const toWorld = (v: V3): V3 => right.mul(v.x).add(up.mul(v.y)).sub(fwd.mul(v.z)) as V3;
      return { centre, toWorld, len, flap, seed, wingbeat: C.z, phase: C.y };
    };

    // ---- Bodies. ----
    const partAttr = attribute<'vec4'>('part', 'vec4');
    const vBodyN = varyingProperty('vec3', 'vDragonN');
    const vBodyW = varyingProperty('vec3', 'vDragonW');
    const bodyPosition = Fn(() => {
      const fl = flight();
      const world = fl.centre.add(fl.toWorld(positionGeometry.mul(fl.len) as V3));
      vBodyN.assign(fl.toWorld(normalGeometry as V3));
      vBodyW.assign(world);
      return world;
    })();
    const view = normalize(cameraPosition.sub(vBodyW));
    const n0 = normalize(vBodyN);
    const nB = select(dot(n0, view).lessThan(0), n0.negate(), n0);
    const kind = partAttr.x;
    const along = partAttr.y;
    const height = partAttr.z;
    const isTube = kind.lessThan(0.5);
    const isEye = kind.greaterThan(0.5).and(kind.lessThan(1.5));
    const isFace = kind.greaterThan(1.5).and(kind.lessThan(2.5));
    // Along the abdomen (0 at its front, 1 at the tip).
    const zBody = along.mul(1.03).sub(0.33);
    const ab = zBody.sub(ABDOMEN_FRONT).div(ABDOMEN_TIP - ABDOMEN_FRONT);
    const onAbdomen = smoothstep(-0.01, 0.01, ab);
    let joints: F = float(0);
    for (const j of ABDOMEN_JOINTS) joints = max(joints, smoothstep(0.008, 0.0025, abs(ab.sub(j)))) as F;
    const thoraxC = colorUniform(p.thorax);
    const abdomenC = colorUniform(p.abdomen);
    // Abdomen: red, a little darker underneath; dark joints, a thin dark carina towards the tip,
    // black flecks on the sides of segments 8 and 9.
    const ventral = smoothstep(0.2, -0.7, height);
    const carina = smoothstep(0.92, 0.99, height).mul(smoothstep(0.45, 0.75, ab));
    const flecks = smoothstep(0.7, 0.75, ab).mul(smoothstep(0.88, 0.84, ab)).mul(smoothstep(0.05, 0.25, height)).mul(smoothstep(0.7, 0.45, height));
    const abdomenAlbedo = mix(abdomenC, abdomenC.mul(vec3(0.62, 0.42, 0.38)), ventral)
      .mul(float(1).sub(joints.mul(0.78)))
      .mul(float(1).sub(carina.mul(0.6)))
      .mul(float(1).sub(flecks.mul(0.8)));
    // Thorax: brown-red with soft hair texture and two faint pale side stripes.
    const hair = mx_noise_float(positionGeometry.mul(70)).mul(0.12).add(0.94);
    const stripes = smoothstep(0.1, 0.0, abs(height.sub(0.05))).mul(0.18);
    // Thin black sutures running obliquely down the sides of the synthorax.
    const gp = positionGeometry;
    let sutures: F = float(0);
    for (const z0 of [-0.2, -0.13, -0.07]) sutures = max(sutures, smoothstep(0.0045, 0.0015, abs(gp.y.sub(gp.z.sub(z0).mul(-1.3))))) as F;
    sutures = sutures.mul(smoothstep(0.018, 0.03, abs(gp.x))).mul(float(1).sub(onAbdomen)) as F;
    const thoraxAlbedo = thoraxC.mul(hair).add(vec3(0.16, 0.12, 0.08).mul(stripes)).mul(float(1).sub(sutures.mul(0.75)));
    const tubeAlbedo = mix(thoraxAlbedo, abdomenAlbedo, onAbdomen);
    // Head: compound eyes red-brown above and greyish below, with fine facets; the face (front,
    // below the eyes) orange-red; legs near black.
    const nL = normalGeometry;
    const faceMask = smoothstep(-0.5, -0.8, nL.z).mul(smoothstep(0.12, -0.25, nL.y)).mul(select(isEye, float(1), float(0)));
    const facetUV = vec2(atan(nL.x, nL.z).mul(34), nL.y.mul(52));
    const facetCells = mx_worley_noise_vec2(facetUV);
    const facets = smoothstep(0.0, 0.25, sqrt(facetCells.y).sub(sqrt(facetCells.x)));
    // The dark pseudopupil: facets pointing straight at the viewer look into the eye.
    const pseudopupil = smoothstep(0.93, 0.99, dot(nB, normalize(cameraPosition.sub(vBodyW))));
    const eyeAlbedo = mix(vec3(0.26, 0.23, 0.16), colorUniform(p.eye), smoothstep(-0.35, 0.3, height))
      .mul(facets.mul(0.25).add(0.75))
      .mul(float(1).sub(pseudopupil.mul(0.55)));
    const faceAlbedo = mix(abdomenC, thoraxC, 0.35);
    const legAlbedo = vec3(0.025, 0.02, 0.018);
    const headAlbedo = mix(eyeAlbedo, faceAlbedo, faceMask);
    const albedo = select(isTube, tubeAlbedo, select(isEye, headAlbedo, select(isFace, faceAlbedo, legAlbedo)));
    const hemi = mix(groundC, skyC, nB.y.mul(0.5).add(0.5)).mul(p.ambient);
    const ndl = dot(nB, sunDir);
    const diffuse = sunC.mul(ndl.add(0.25).div(1.25).max(0));
    // Light through the thin red cuticle when the sun is behind it (strongest at the rims).
    const ndv = abs(dot(nB, view));
    const backlit = max(dot(view, sunDir).negate(), 0).pow(2);
    const thin = select(isTube, onAbdomen.mul(0.9).add(0.25), select(isEye, float(0.15), float(0.2)));
    const transmit = abdomenC.mul(vec3(1, 0.55, 0.35)).mul(sunC).mul(backlit.mul(thin).mul(float(1).sub(ndv).mul(0.8).add(0.2)).mul(0.55));
    const hv = normalize(view.add(sunDir));
    const gloss = select(isEye, float(1).sub(faceMask.mul(0.6)).mul(facets.mul(0.4).add(0.6)), select(isTube, float(0.45), float(0.3)));
    const spec = sunC.mul(pow(max(dot(nB, hv), 0), select(isEye, float(90), float(28))).mul(gloss).mul(0.35));
    const fres = float(1).sub(ndv).pow(5).mul(0.96).add(0.04);
    const refl = reflect(view.negate(), nB);
    const env = mix(groundC, skyC, smoothstep(-0.25, 0.6, refl.y));
    const bodyLight = albedo.mul(hemi.add(diffuse)).add(transmit).add(spec).add(env.mul(fres).mul(gloss).mul(0.5));
    const bodyMat = new MeshBasicNodeMaterial();
    bodyMat.positionNode = bodyPosition;
    bodyMat.colorNode = vec4(bodyLight, 1);
    bodyMat.opacityNode = revealMask(u.presence);
    bodyMat.alphaTest = 0.5;
    bodyMat.mrtNode = mrt({ emissive: vec4(spec.mul(p.bloom), 1) });
    bodyMat.side = DoubleSide;
    const bodies = new Mesh(body, bodyMat);
    bodies.count = count;
    bodies.frustumCulled = false;

    // ---- Wings. ----
    const wingAttr = attribute<'vec4'>('wing', 'vec4');
    const vWingN = varyingProperty('vec3', 'vWingN');
    const vWingT = varyingProperty('vec3', 'vWingT');
    const vWingW = varyingProperty('vec3', 'vWingW');
    const vFlap = varyingProperty('float', 'vWingFlap');
    const wingPosition = Fn(() => {
      const fl = flight();
      const w = wingAttr.x;
      const copy = wingAttr.y;
      const hind = w.greaterThan(1.5);
      const sideSign = select(fract(w.mul(0.5)).greaterThan(0.25), float(1), float(-1));
      // Stroke phase per blur copy: copies spread over one beat (a 360° shutter).
      const beat = fract((u.time as unknown as F).mul(fl.wingbeat).add(fl.phase).add(copy.div(copies)).add(select(hind, float(0.25), float(0))));
      const ph = beat.mul(TAU);
      const flap = fl.flap;
      const strokeMid = mix(float(-0.1), float(0.1), flap);
      const stroke = strokeMid.add(sin(ph).mul(0.62).mul(flap));
      const feather = cos(ph).mul(0.38).mul(flap);
      const sweep = select(hind, float(-0.05), float(0.1));
      const g = positionGeometry;
      // Feather about the span axis (pivot just behind the leading edge).
      const pivot = float(0.03);
      const zc = g.z.sub(pivot);
      const y1 = zc.mul(sin(feather)).negate();
      const z1 = zc.mul(cos(feather)).add(pivot);
      const n1 = vec3(0, cos(feather), sin(feather));
      // Sweep about y, stroke about the body axis.
      const x2 = g.x.mul(cos(sweep)).add(z1.mul(sin(sweep)));
      const z2 = g.x.mul(sin(sweep)).negate().add(z1.mul(cos(sweep)));
      const n2 = vec3(n1.z.mul(sin(sweep)), n1.y, n1.z.mul(cos(sweep)));
      const x3 = x2.mul(cos(stroke)).sub(y1.mul(sin(stroke)));
      const y3 = x2.mul(sin(stroke)).add(y1.mul(cos(stroke)));
      const n3 = vec3(n2.x.mul(cos(stroke)).sub(n2.y.mul(sin(stroke))), n2.x.mul(sin(stroke)).add(n2.y.mul(cos(stroke))), n2.z);
      const fore = WING_ROOT[0]!;
      const hindR = WING_ROOT[1]!;
      const root = select(hind, vec3(hindR[0], hindR[1], hindR[2]), vec3(fore[0], fore[1], fore[2]));
      const local = vec3(x3.add(root.x).mul(sideSign), y3.add(root.y), z2.add(root.z));
      const localN = vec3(n3.x.mul(sideSign), n3.y, n3.z);
      const world = fl.centre.add(fl.toWorld(local.mul(fl.len) as V3));
      vWingN.assign(fl.toWorld(localN as V3));
      // The chord direction, for the pleats of the corrugated membrane.
      const tx2 = cos(feather).mul(sin(sweep));
      const ty1 = sin(feather).negate();
      const localT = vec3(tx2.mul(cos(stroke)).sub(ty1.mul(sin(stroke))).mul(sideSign), tx2.mul(sin(stroke)).add(ty1.mul(cos(stroke))), cos(feather).mul(cos(sweep)));
      vWingT.assign(fl.toWorld(localT as V3));
      vWingW.assign(world);
      vFlap.assign(flap);
      return world;
    })();

    // Wing pattern in wing-length units.
    const wIndex = wingAttr.x;
    const isHind = wIndex.greaterThan(1.5);
    const wu = positionGeometry.x.div(wingAttr.z);
    const wv = positionGeometry.z.div(wingAttr.z);
    const sm = (a0: number, a1: number, x: F): F => smoothstep(a0, a1, x) as F;
    const tipRound = sqrt(max(float(1).sub(max(wu.sub(0.78).div(0.22), 0).pow(2)), 0));
    const chordF = float(0.055).add(sm(0, 0.3, wu).mul(0.135)).sub(sm(0.45, 0.85, wu).mul(0.03));
    const chordH = float(0.06).add(sm(0, 0.12, wu).mul(0.23)).sub(sm(0.12, 0.55, wu).mul(0.1)).sub(sm(0.55, 0.85, wu).mul(0.02));
    const chord = select(isHind, chordH, chordF).mul(tipRound).max(1e-4);
    const le = sin(wu.mul(2.8)).mul(-0.015);
    const d = wv.sub(le);
    const wn = d.div(chord);
    const fw = max(fwidth(wv), 1e-5);
    const edge = min(d, chord.sub(d));
    // Blurred copies get soft edges, so the stroke reads as a smear rather than stacked wings.
    const inside = edge.add(fw.mul(0.5)).div(fw.add(vFlap.mul(0.03))).clamp(0, 1).mul(select(wu.lessThan(1), float(1), float(0)));
    /** Antialiased line: at least ~1 px wide, dimmed by its true width when thinner. */
    const line = (dist: F, hw: number): F => {
      const aa = max(fwidth(dist), 1e-5);
      const w2 = max(float(hw), aa.mul(0.5));
      return abs(dist).negate().add(w2).div(aa).add(0.5).clamp(0, 1).mul(float(hw).div(w2)) as F;
    };
    const nodus = select(isHind, float(0.42), float(0.47));
    // Costa (leading edge), subcosta to the nodus, radius to the tip; the costal field's cross-veins.
    const costa = line(d.sub(0.004) as F, 0.006);
    const subcosta = line(d.sub(0.016) as F, 0.0028).mul(sm(0.46, 0.43, wu.div(nodus).mul(0.45)));
    const radius = line(d.sub(0.031) as F, 0.0035);
    const costal = smoothstep(0.034, 0.03, d);
    const crossU = fract(wu.div(0.021).add(sin(wu.mul(37)).mul(0.15))).sub(0.5).mul(0.021);
    const crossVeins = line(crossU as F, 0.0016).mul(costal).mul(sm(0.02, 0.06, wu));
    const nodusMark = line(wu.sub(nodus) as F, 0.004).mul(costal);
    // Longitudinal veins fanning to the trailing edge.
    let longVeins: F = float(0);
    const lines: [number, number][] = [
      [0.26, 0.3],
      [0.4, 0.46],
      [0.55, 0.62],
      [0.7, 0.82],
    ];
    for (const [w0, w1] of lines) longVeins = max(longVeins, line(wn.sub(mix(float(w0), float(w1), wu)).mul(chord) as F, 0.0026)) as F;
    // Cellular field behind the radius (cells smaller towards the trailing edge, as in real wings).
    const cellsUV = vec2(wu.mul(46), wn.mul(select(isHind, float(17), float(11)))).add(vec2(isHind.select(float(31), float(7)), 0));
    const worley = mx_worley_noise_vec2(cellsUV);
    const cellEdge = sqrt(worley.y).sub(sqrt(worley.x)).mul(0.5).div(46).mul(1);
    const cellVeins = line(cellEdge as F, 0.0014).mul(smoothstep(0.034, 0.045, d)).mul(sm(0.05, 0.12, wu));
    const trailing = line(chord.sub(d).sub(0.002) as F, 0.0018);
    // Pterostigma: a solid dark cell between costa and radius near the tip.
    const stigmaU = select(isHind, vec2(0.83, 0.9), vec2(0.82, 0.895));
    const stigma = smoothstep(stigmaU.x.sub(0.003), stigmaU.x.add(0.003), wu)
      .mul(smoothstep(stigmaU.y.add(0.003), stigmaU.y.sub(0.003), wu))
      .mul(smoothstep(0.033, 0.029, d));
    const veins = max(max(max(costa, subcosta), max(radius, crossVeins.mul(float(1).sub(stigma)))), max(max(nodusMark, longVeins), max(cellVeins, trailing)));
    // Amber flush at the base (stronger on the hind wing).
    const amber = smoothstep(0.16, 0.03, wu).mul(select(isHind, float(0.35), float(0.2)));

    const wView = normalize(cameraPosition.sub(vWingW));
    const wn0 = normalize(vWingN);
    const wFlat = select(dot(wn0, wView).lessThan(0), wn0.negate(), wn0);
    // Real wings are pleated along their longitudinal veins: glints break into streaks.
    const pleat = sin(wn.mul(TAU * 4.5).add(wu.mul(3))).mul(0.14).add(mx_noise_float(vec3(wu.mul(30), wn.mul(8), wIndex)).mul(0.05));
    const wN = normalize(wFlat.add(normalize(vWingT).mul(pleat)));
    const wNdv = abs(dot(wN, wView));
    const wFres = float(1).sub(wNdv).pow(5).mul(0.96).add(0.04);
    const wRefl = reflect(wView.negate(), wN);
    const glint = max(dot(wRefl, sunDir), 0).pow(300).mul(1.4);
    // Thin-film interference: hue shifts with the viewing angle and the film thickness across the wing.
    const film = wu.mul(0.6).add(wn.mul(0.3)).add(float(1).sub(wNdv).mul(1.4));
    const iri = vec3(cos(film.mul(TAU)), cos(film.mul(TAU).sub(2.1)), cos(film.mul(TAU).sub(4.2))).mul(0.5).add(0.5);
    // What the membrane mirrors (desaturated a little: the photo's sky light is near white).
    const wEnvRaw = mix(groundC, skyC, smoothstep(-0.3, 0.55, wRefl.y));
    const wEnv = mix(wEnvRaw, vec3(dot(wEnvRaw, vec3(0.2126, 0.7152, 0.0722))), 0.5);
    const reflection = wEnv.mul(mix(vec3(1, 1, 1), iri.mul(1.5), p.iridescence)).mul(wFres).add(sunC.mul(glint));
    const lightOn = mix(groundC, skyC, wN.y.mul(0.5).add(0.5)).mul(p.ambient).add(sunC.mul(abs(dot(wN, sunDir)).mul(0.5)));
    // Forward scattering: against the light the membrane shines silvery.
    const backlitW = max(dot(wView, sunDir).negate(), 0).pow(3);
    const flapW = vFlap;
    // Opacity of each layer, then one copy's share so the coincident copies at rest add up to it.
    const membraneA = float(0.07).add(wFres.mul(0.35));
    // Veins smear out in the blur of a beating wing.
    const veinA = veins.mul(mix(float(0.92), float(0.3), flapW));
    const stigmaA = stigma.mul(0.92);
    const total = float(1).sub(float(1).sub(membraneA).mul(float(1).sub(veinA)).mul(float(1).sub(stigmaA)).mul(float(1).sub(amber)));
    const share = float(1).sub(pow(float(1).sub(total.min(0.98)), 1 / copies));
    const copyIdx = wingAttr.y;
    const copyAlpha = select(copyIdx.lessThan(0.5), mix(total, share, flapW), share.mul(flapW)).mul(inside).mul(u.presence);
    const veinC = colorUniform(p.venation);
    const stigmaC = colorUniform(p.stigma);
    const amberC = colorUniform(p.amber);
    // Clear membrane: it scatters little (what shows is its reflections, its veins and a faint tint).
    // Blurred copies scatter and mirror less each (the wing is only there part of the exposure).
    const blurDim = float(1).sub(flapW.mul(0.55));
    const membraneC = vec3(0.86, 0.85, 0.8).mul(lightOn.mul(0.12)).add(sunC.mul(backlitW.mul(0.55).mul(blurDim)));
    const weightSum = membraneA.add(veinA).add(stigmaA).add(amber).max(1e-4);
    const bodyRGB = membraneC
      .mul(membraneA)
      .add(veinC.mul(lightOn).add(skyC.mul(0.05)).add(sunC.mul(0.04)).mul(veinA))
      .add(stigmaC.mul(lightOn.add(sunC.mul(backlitW.mul(0.6)))).mul(stigmaA))
      .add(amberC.mul(lightOn.add(sunC.mul(backlitW))).mul(amber))
      .div(weightSum);
    const wingRGB = bodyRGB.add(reflection.mul(float(1).sub(veinA.mul(0.6))).mul(blurDim).div(total.max(0.06)));
    const wingMat = new MeshBasicNodeMaterial();
    wingMat.positionNode = wingPosition;
    wingMat.colorNode = vec4(wingRGB, 1);
    wingMat.opacityNode = copyAlpha;
    wingMat.transparent = true;
    wingMat.depthWrite = false;
    wingMat.blending = NormalBlending;
    wingMat.side = DoubleSide;
    // Thin glass: one pass for both faces (no back-then-front split, one draw call).
    wingMat.forceSinglePass = true;
    wingMat.mrtNode = mrt({ emissive: vec4(sunC.mul(glint).mul(p.bloom), copyAlpha) });
    const wingMesh = new Mesh(wings, wingMat);
    wingMesh.count = count;
    wingMesh.frustumCulled = false;

    const root = new Group();
    root.add(bodies);
    root.add(wingMesh);
    let clock = 0;
    return {
      object: root,
      update(frame) {
        clock += Math.min(0.1, Math.max(0, frame.dt));
        u.time.value = clock;
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        body.dispose();
        wings.dispose();
        bodyMat.dispose();
        wingMat.dispose();
      },
    };
  },
};
