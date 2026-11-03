/**
 * The Veil's landscape as a height function (pure, deterministic; no three.js).
 *
 * The viewer stands on a low rise at EYE. In front the ground falls away under the playfield (kept
 * below the board's view frustum) to a wet lowland at about FLOOR: pools and a long, still
 * marsh behind the board, dead forest on rising ground to either side, low hills beyond, and a
 * broken range of ridges 1.1 to 1.8 km out. The ground mesh, prop placement, creature footfalls and
 * the VR standing height all read this one function.
 */

export const EYE = { x: 0, y: 0.56, z: 31 } as const;
/** The lowland's base height and the marsh water level. */
export const FLOOR = -15;
export const WATER = -16.45;
/** The playfield's rectangle on the board plane (z = 0), with a margin, that terrain must not hide. */
const BOARD_HALF_W = 10.6;
const BOARD_BOTTOM = -11.8;

const DEG = Math.PI / 180;

function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in -1..1. */
export function vnoise(x: number, z: number, seed = 1): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const sz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz) * 2 - 1;
}

export function fbm(x: number, z: number, octaves: number, seed = 1): number {
  let s = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    s += amp * vnoise(x * f, z * f, seed + i * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / norm;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function smax(a: number, b: number, k: number): number {
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (a - b)) / k));
  return b + (a - b) * h + k * h * (1 - h);
}

/** Azimuth in degrees of a point seen from the eye (0 = straight at the board, positive = right). */
export function azimuthOf(x: number, z: number): number {
  return Math.atan2(x - EYE.x, -(z - EYE.z)) / DEG;
}

/**
 * Highest ground allowed at (x, z) so the terrain never hides any part of the playfield: below the
 * plane from the eye through the bottom of the board rectangle, wherever the point would project
 * inside that rectangle.
 */
export function boardLimit(x: number, z: number): number {
  const ahead = EYE.z - z;
  if (ahead <= 0.5 || z <= 0) return Infinity;
  const lim = EYE.y + ((BOARD_BOTTOM - EYE.y) * ahead) / EYE.z - 0.9;
  // Outside the board's horizontal angle the ground may rise again, gently.
  const half = Math.atan(BOARD_HALF_W / EYE.z) / DEG;
  const across = Math.atan(Math.abs(x - EYE.x) / ahead) / DEG;
  const outside = smoothstep(half + 1, half + 14, across);
  return lim + outside * outside * 45;
}

function smin(a: number, b: number, k: number): number {
  return -smax(-a, -b, k);
}

/** Ground height at (x, z). */
export function terrainHeight(x: number, z: number): number {
  const dx = x - EYE.x;
  const dz = z - EYE.z;
  const dist = Math.hypot(dx, dz);
  const az = Math.abs(Math.atan2(dx, -dz) / DEG);
  // The lowland: gentle hummocks, hollows that hold water, a long marsh behind the board.
  let floor = FLOOR + 1.1 * fbm(x / 55, z / 55, 4, 3) + 0.35 * fbm(x / 13, z / 13, 3, 9);
  const marsh = smoothstep(32, 14, az) * smoothstep(40, 90, dist) * smoothstep(520, 300, dist);
  floor -= marsh * 1.9;
  // Pools scattered across the lowland.
  const pools = smoothstep(0.18, 0.42, fbm(x / 34 + 11.3, z / 34 - 4.1, 3, 21));
  floor -= pools * 1.1 * smoothstep(30, 70, dist);
  // Rising ground at the sides (where the forests stand) and low hills beyond.
  const sides = smoothstep(26, 62, az);
  floor += sides * (2.5 + 5 * fbm(x / 140, z / 140, 3, 5) + 4) * smoothstep(40, 180, dist);
  const hills = Math.max(0, fbm(x / 260, z / 260, 4, 7) + 0.15) * 70 * smoothstep(280, 600, dist);
  floor += hills * (0.35 + 0.65 * sides);
  // The ridges: a broken range far out, highest off to the sides, a low saddle behind the board.
  const band = smoothstep(950, 1300, dist) * smoothstep(2100, 1800, dist);
  const massif = smoothstep(-0.25, 0.45, fbm(x / 560, z / 560, 4, 13));
  const crest = 1 - Math.abs(fbm(x / 330, z / 330, 4, 17));
  const ribs = Math.pow(1 - Math.abs(fbm(x / 150, z / 150, 4, 41)), 2.4) * 46;
  const gullies = fbm(x / 52, z / 52, 3, 43) * 16 + Math.pow(1 - Math.abs(fbm(x / 26, z / 26, 2, 47)), 3) * 7;
  const ridge = (massif * (0.62 + 0.38 * crest * crest) * 200 + (ribs + gullies) * massif) * (0.5 + 0.5 * smoothstep(8, 40, az)) * band;
  floor = smax(floor, FLOOR + ridge - 8, 8);
  // The viewer's rise: level around the eye, falling to the lowland; it reaches further at the sides.
  const reach = 20 + 70 * smoothstep(30, 110, az);
  const rise = -1.1 - 22 * smoothstep(3.5, reach * 1.45, dist) + 1.6 * fbm(x / 9, z / 9, 2, 31) * smoothstep(4, 10, dist);
  let h = smax(floor, rise, 3);
  const lim = boardLimit(x, z);
  if (lim < Infinity) h = smin(h, lim, 1.5);
  return h;
}

/** The fog's notion of ground (smooth, cheap, also evaluated in shaders): the lowland, rising near the eye. */
export function fogFloor(x: number, z: number): number {
  const dist = Math.hypot(x - EYE.x, z - EYE.z);
  return FLOOR + 13.9 * Math.exp(-Math.pow(dist / 26, 2));
}
