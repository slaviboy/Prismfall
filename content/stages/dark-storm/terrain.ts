/**
 * Dark Storm's landscape as a height function (pure, deterministic; no three.js).
 *
 * The viewer stands on a broad ledge of wet moorland rock high above a glen. In front, under the
 * playfield, the ledge breaks off (kept below the board's view frustum) and the ground falls steeply
 * to the glen floor, where a long loch lies; to either side the ledge runs on, with rock slabs,
 * puddles in every hollow and a peat stream cutting across it on the left. Beyond the loch the far
 * shore rises into moorland and then into a ring of dark mountains 1.1 to 2.1 km away, highest to
 * the sides, with a low saddle behind the board. The ground mesh, the props, the rain splashes, the
 * strike points and the VR standing height all read this one function.
 */

export const EYE = { x: 0, y: 0.5, z: 31 } as const;
/** The ledge the viewer stands on, the glen floor and the loch's water level. */
export const LEDGE = -2.6;
export const GLEN = -44;
export const LOCH = -45.6;
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

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function smax(a: number, b: number, k: number): number {
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (a - b)) / k));
  return b + (a - b) * h + k * h * (1 - h);
}

function smin(a: number, b: number, k: number): number {
  return -smax(-a, -b, k);
}

/** Azimuth in degrees of a point seen from the eye (0 = straight at the board, positive = right). */
export function azimuthOf(x: number, z: number): number {
  return Math.atan2(x - EYE.x, -(z - EYE.z)) / DEG;
}

/** A point at an azimuth (degrees) and ground distance (m) from the eye. */
export function pointAt(azimuth: number, distance: number): { x: number; z: number } {
  const a = azimuth * DEG;
  return { x: EYE.x + Math.sin(a) * distance, z: EYE.z - Math.cos(a) * distance };
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
  const half = Math.atan(BOARD_HALF_W / EYE.z) / DEG;
  const across = Math.atan(Math.abs(x - EYE.x) / ahead) / DEG;
  // Just outside the board's angle the ground may stand at full height again.
  const outside = smoothstep(half + 0.5, half + 5, across);
  return lim + outside * outside * 60;
}

/** The peat stream on the left of the ledge: a polyline (x, z) running to the ledge's edge. */
export const STREAM: readonly (readonly [number, number])[] = [
  [-96, 52],
  [-70, 40],
  [-52, 36],
  [-38, 26],
  [-27, 22],
  [-19, 12],
  [-15, 2],
];

/** Distance (m) from (x, z) to the stream's centre line. */
export function streamDistance(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < STREAM.length - 1; i++) {
    const [ax, az] = STREAM[i]!;
    const [bx, bz] = STREAM[i + 1]!;
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return best;
}

/** How far the ledge reaches from the eye in a direction (metres to its edge). */
export function ledgeReach(azimuthDeg: number): number {
  const a = Math.abs(azimuthDeg);
  return 9 + 31 * smoothstep(12, 26, a) + 90 * smoothstep(24, 55, a) + 140 * smoothstep(60, 110, a);
}

/** The ledge's rock outcrops and slabs (0..1), also read by the ground shader through its map. */
export function rockiness(x: number, z: number): number {
  const ridged = 1 - Math.abs(fbm(x / 11, z / 11, 3, 61));
  return smoothstep(0.62, 0.88, ridged) * smoothstep(-0.2, 0.35, fbm(x / 40, z / 40, 2, 63));
}

/** Puddles (0..1): water standing in the ledge's flat hollows. */
export function puddle(x: number, z: number): number {
  const d = Math.hypot(x - EYE.x, z - EYE.z);
  if (d < 2.5) return 0;
  const hollow = smoothstep(0.18, 0.42, fbm(x / 6.5 + 3.1, z / 6.5 - 7.7, 3, 71));
  const flat = 1 - smoothstep(0.15, 0.5, rockiness(x, z));
  return hollow * flat * ledgeMask(x, z);
}

/** 1 on the ledge, 0 beyond its edge. */
export function ledgeMask(x: number, z: number): number {
  const d = Math.hypot(x - EYE.x, z - EYE.z);
  const reach = ledgeReach(azimuthOf(x, z)) + fbm(x / 23, z / 23, 2, 5) * 6;
  return 1 - smoothstep(reach - 4, reach, d);
}

/** Ground height at (x, z), before the puddles and the stream are pressed into it. */
function baseHeight(x: number, z: number): number {
  const dx = x - EYE.x;
  const dz = z - EYE.z;
  const dist = Math.hypot(dx, dz);
  const az = Math.atan2(dx, -dz) / DEG;
  const aaz = Math.abs(az);
  // The ledge: slabs and outcrops on a gently undulating shelf.
  const reach = ledgeReach(az) + fbm(x / 23, z / 23, 2, 5) * 6;
  let ledge = LEDGE + 0.55 * fbm(x / 17, z / 17, 3, 11) + 0.18 * fbm(x / 3.1, z / 3.1, 2, 13) + rockiness(x, z) * (0.45 + 0.5 * fbm(x / 2.3, z / 2.3, 2, 17));
  // A low rise of rock right around the viewer's stance.
  ledge += 0.25 * Math.exp(-(dist * dist) / 30);
  // The drop: a steep, broken slope from the ledge's edge down to the glen.
  const run = 34 + 26 * (fbm(x / 60, z / 60, 2, 19) * 0.5 + 0.5);
  // A steep, broken rock face below the edge, then a talus slope down to the glen.
  const cliff = smoothstep(reach, reach + run * 0.32, dist);
  const talus = smoothstep(reach + run * 0.2, reach + run, dist);
  const fall = Math.min(1, cliff * 0.62 + talus * 0.38);
  const ridged = 1 - Math.abs(fbm(x / 6.5, z / 6.5, 3, 23));
  const scarp = (ridged * ridged * 9 + fbm(x / 2.2, z / 2.2, 2, 27) * 2.2) * Math.sin(Math.PI * Math.min(1, fall * 1.1));
  const shelves = Math.sin(fall * Math.PI * 4 + fbm(x / 30, z / 30, 2, 29) * 3) * 1.8 * fall * (1 - fall) * 4;
  let h = ledge + (GLEN - ledge) * fall + scarp + shelves;
  // The glen floor and the loch's basin in front.
  const floor = GLEN + 1.6 * fbm(x / 70, z / 70, 3, 29);
  const loch = smoothstep(62, 30, aaz) * smoothstep(150, 260, dist) * smoothstep(1250, 950, dist);
  const shore = floor - loch * 6 + smoothstep(0.3, 0.8, fbm(x / 90, z / 90, 2, 31)) * 3 * (1 - loch);
  h = fall >= 1 ? shore : h + (shore - GLEN) * fall;
  // The far shore rises into moorland, then the mountains.
  const moor = Math.max(0, fbm(x / 240, z / 240, 4, 37) + 0.25) * 55 * smoothstep(650, 1050, dist);
  h += moor * (0.4 + 0.6 * smoothstep(10, 50, aaz));
  const band = smoothstep(1000, 1350, dist) * smoothstep(2300, 2000, dist);
  const massif = smoothstep(-0.3, 0.4, fbm(x / 520, z / 520, 4, 41));
  const crest = 1 - Math.abs(fbm(x / 300, z / 300, 4, 43));
  const ribs = Math.pow(1 - Math.abs(fbm(x / 130, z / 130, 4, 47)), 2.3) * 52;
  const gullies = fbm(x / 47, z / 47, 3, 53) * 14 + Math.pow(1 - Math.abs(fbm(x / 23, z / 23, 2, 59)), 3) * 6;
  const sides = 0.42 + 0.58 * smoothstep(6, 46, aaz);
  const ridge = (massif * (0.55 + 0.45 * crest * crest) * 270 + (ribs + gullies) * massif) * sides * band;
  h = smax(h, GLEN + ridge - 10, 10);
  // Moorland hills behind the viewer and at the far sides of the ledge.
  const behindMask = smoothstep(95, 150, aaz);
  if (behindMask > 0) {
    const hills = LEDGE - 4 + smoothstep(80, 260, dist) * (20 + 40 * (fbm(x / 160, z / 160, 3, 67) * 0.5 + 0.5));
    h += Math.max(0, hills - h) * behindMask;
  }
  return h;
}

/** Ground height at (x, z). */
export function terrainHeight(x: number, z: number): number {
  let h = baseHeight(x, z);
  // Puddles sit a hand's depth into the hollows; the stream cuts a narrow channel.
  h -= puddle(x, z) * 0.09;
  const sd = streamDistance(x, z);
  if (sd < 3) h -= 0.42 * (1 - smoothstep(0.25, 1.6, sd)) * ledgeMask(x, z);
  const lim = boardLimit(x, z);
  if (lim < Infinity) h = smin(h, lim, 1.5);
  return h;
}

/** 1 in the stream's water, falling off at its banks. */
export function streamMask(x: number, z: number): number {
  return (1 - smoothstep(0.35, 1.05, streamDistance(x, z))) * ledgeMask(x, z);
}

/** Where a viewer stands (VR): the ground, or the loch's surface where that is higher. */
export function standingHeight(x: number, z: number): number {
  return Math.max(terrainHeight(x, z), LOCH);
}
