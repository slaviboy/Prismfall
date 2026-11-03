/**
 * The far dune sea of Moving Sands, as pure TypeScript (no three.js): crest lines, the height of the
 * ground between them, and the mesh built from them. The component in `farDunes.ts` draws it.
 *
 * The dunes are receding ridgelines around the viewer. Each ridge is a crest line at a distance
 * that meanders with azimuth, with a sharp brink: a gentle windward (stoss) slope rises to it and a
 * steep slip face falls away behind it. The mesh is crest-aligned: every crest is an exact row of
 * vertices (duplicated, so the brink keeps a hard shading edge), which keeps the silhouettes crisp
 * at any resolution with a modest vertex count.
 */

export interface RidgeSpec {
  /** Distance of the crest line from the viewer straight ahead (world units). */
  distance: number;
  /** Crest height above the interdune floor. */
  height: number;
  /** Crest line meander, as a fraction of `distance`. */
  meander: number;
  /** Height variation along the crest (0 = uniform, 1 = from nothing to full height). */
  variation: number;
  /** Strength of the pointed star-dune peaks along the crest (0 = none). */
  peaks: number;
}

export interface DuneFieldSpec {
  /** Viewer ground position (x, z): the centre of the ridge rings. */
  center: readonly [number, number];
  /** Azimuth range in degrees (0 = straight ahead, −z; positive = right, +x). */
  span: readonly [number, number];
  /** Distance of the first mesh row (under the near terrain). */
  start: number;
  /** Interdune floor height at `start`, and its rise per 1000 units of distance. */
  floor: number;
  floorRise: number;
  ridges: readonly RidgeSpec[];
  /** Which side of each crest the slip face is on, seen from the viewer. */
  lee: 'far' | 'near';
  /** Steepest slip-face and stoss-slope angles in degrees. */
  slip: number;
  stoss: number;
  /** 2D height modulation of the slopes (fraction of the local height). */
  undulation: number;
  /** Ridges recede at the sides like straight ranges: distance × (1 / cos azimuth)^perspective. */
  perspective: number;
  seed: number;
}

/** Seeded smooth 1D gradient noise, about −1..1. */
export function noise1(seed: number): (x: number) => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  const rnd = (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const grad = Float64Array.from({ length: 256 }, () => rnd() * 2 - 1);
  return (x) => {
    const i = Math.floor(x);
    const f = x - i;
    const g0 = grad[i & 255]!;
    const g1 = grad[(i + 1) & 255]!;
    const u = f * f * f * (f * (f * 6 - 15) + 10);
    return 2 * (g0 * f + (g1 * (f - 1) - g0 * f) * u);
  };
}

/** Seeded smooth 2D value noise, about −1..1. */
export function noise2(seed: number): (x: number, y: number) => number {
  const rand = mulberry(seed * 7919 + 3);
  const lattice = Float64Array.from({ length: 256 * 256 }, () => rand() * 2 - 1);
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = lattice[(yi & 255) * 256 + (xi & 255)]!;
    const b = lattice[(yi & 255) * 256 + ((xi + 1) & 255)]!;
    const c = lattice[((yi + 1) & 255) * 256 + (xi & 255)]!;
    const d = lattice[((yi + 1) & 255) * 256 + ((xi + 1) & 255)]!;
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
}

const DEG = Math.PI / 180;

/** Smooth maximum (never below either input). */
function smax(a: number, b: number, k: number): number {
  return (a + b + Math.sqrt((a - b) * (a - b) + k * k)) / 2;
}

export interface DuneField {
  readonly spec: DuneFieldSpec;
  /** Crest distance of ridge `k` at azimuth `az` (degrees). */
  crestDistance(k: number, az: number): number;
  /** Crest height above the floor of ridge `k` at azimuth `az`. */
  crestHeight(k: number, az: number): number;
  /** Floor height at a distance. */
  floorAt(r: number): number;
  /** Ground height at azimuth `az` (degrees) and distance `r` from the centre (no near-terrain clamp). */
  height(az: number, r: number): number;
  /**
   * Ground height between a nearer crest (distance ra, height ha; ha = 0 for none) and a farther
   * one (rb, hb) at distance r: the fast path for callers that already know the crests.
   */
  between(az: number, r: number, ra: number, ha: number, rb: number, hb: number): number;
  /** World position of (azimuth, distance) on the ground plane. */
  xz(az: number, r: number): [number, number];
}

export function createDuneField(spec: DuneFieldSpec): DuneField {
  const K = spec.ridges.length;
  const meanders = spec.ridges.map((_, k) => {
    const n = noise1(spec.seed * 101 + k * 17 + 1);
    return (az: number) => 0.7 * n(az / 9 + 0.3) + 0.3 * n(az / 3.6 + 7.1);
  });
  // Height along each crest: broad massifs and saddles, independent per ridge, so the ridgelines
  // dip and rise against each other instead of running parallel.
  const envelopes = spec.ridges.map((_, k) => {
    const n = noise1(spec.seed * 211 + k * 29 + 5);
    return (az: number) => {
      const v = 0.55 * n(az / 26 + 2.3) + 0.3 * n(az / 10 + 9.4) + 0.15 * n(az / 4.5 + 4.1);
      const s = Math.max(0, Math.min(1, 0.5 + 0.65 * v));
      return s * s * (3 - 2 * s);
    };
  });
  // Rounded star-dune peaks rising out of the crest here and there.
  const peakLists = spec.ridges.map((ridge, k) => {
    const rand = mulberry(spec.seed * 977 + k * 131 + 7);
    const list: { at: number; width: number; amp: number }[] = [];
    if (ridge.peaks <= 0) return list;
    for (let az = spec.span[0] + rand() * 14; az < spec.span[1]; az += 12 + rand() * 16) {
      list.push({ at: az, width: 2.5 + rand() * 3.5, amp: ridge.peaks * (0.3 + rand() * 0.7) });
    }
    return list;
  });
  const persp = (az: number): number => Math.pow(1 / Math.cos(Math.min(Math.abs(az), 62) * DEG), spec.perspective);
  const crestDistance = (k: number, az: number): number => {
    const ridge = spec.ridges[k]!;
    return ridge.distance * persp(az) * (1 + ridge.meander * meanders[k]!(az));
  };
  const crestHeight = (k: number, az: number): number => {
    const ridge = spec.ridges[k]!;
    const base = 1 - ridge.variation + ridge.variation * envelopes[k]!(az);
    let peak = 0;
    for (const p of peakLists[k]!) {
      const x = (az - p.at) / p.width;
      if (x * x < 9) peak += p.amp * Math.exp(-1.6 * x * x);
    }
    return ridge.height * base * (1 + peak);
  };
  const floorAt = (r: number): number => spec.floor + (spec.floorRise * (r - spec.start)) / 1000;
  const slipRun = 1.25 / Math.tan(spec.slip * DEG);
  const stossRun = 1.7 / Math.tan(spec.stoss * DEG);
  // Profiles of one dune either side of its crest (dr ≥ 0 from the crest, h = crest height).
  const slipProfile = (dr: number, h: number): number => (dr >= h * slipRun ? 0 : h * Math.pow(1 - dr / (h * slipRun), 1.25));
  const stossProfile = (dr: number, h: number): number => (dr >= h * stossRun ? 0 : h * Math.pow(1 - dr / (h * stossRun), 1.7));
  const farSide = spec.lee === 'far' ? slipProfile : stossProfile;
  const nearSide = spec.lee === 'far' ? stossProfile : slipProfile;
  const und = noise2(spec.seed * 31 + 11);
  const xz = (az: number, r: number): [number, number] => [spec.center[0] + Math.sin(az * DEG) * r, spec.center[1] - Math.cos(az * DEG) * r];

  const between = (az: number, r: number, ra: number, ha: number, rb: number, hb: number): number => {
    const fa = ha > 0 ? farSide(Math.max(0, r - ra), ha) : 0;
    const nb = hb > 0 ? nearSide(Math.max(0, rb - r), hb) : 0;
    const ref = Math.max(ha, hb, 1);
    const h = Math.max(0, smax(fa, nb, ref * 0.05) - ref * 0.025);
    const [x, z] = xz(az, r);
    return floorAt(r) + h * (1 + spec.undulation * und(x / 95, z / 95));
  };
  const height = (az: number, r: number): number => {
    let kb = 0;
    while (kb < K && crestDistance(kb, az) <= r) kb++;
    const ra = kb > 0 ? crestDistance(kb - 1, az) : spec.start;
    const ha = kb > 0 ? crestHeight(kb - 1, az) : 0;
    const rb = kb < K ? crestDistance(kb, az) : 1e9;
    const hb = kb < K ? crestHeight(kb, az) : 0;
    return between(az, r, ra, ha, rb, hb);
  };
  return { spec, crestDistance, crestHeight, floorAt, height, between, xz };
}

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

/** The near terrain's mesh wedge (copy of the terrain layer's `mesh` params), which hides the start of the field. */
export interface NearTerrain {
  apex: readonly [number, number];
  far: number;
  spread: number;
  /** Ground height of the near terrain. */
  height(x: number, z: number): number;
}

export interface DuneMesh {
  positions: Float32Array;
  normals: Float32Array;
  /** Per vertex: height above the floor relative to the crest (0..1), ridge index, slip side (0/1), distance from the centre. */
  dune: Float32Array;
  index: Uint32Array;
  /** Crest vertices (x, y, z, height above floor) per ridge, one per column. */
  crests: Float32Array[];
  columns: number;
}

/**
 * Builds the crest-aligned mesh: one strip of rows per gap between crests (plus one before the
 * first crest and one behind the last), `cols` columns over the span.
 */
export function buildDuneMesh(field: DuneField, opts: { columnsPerDegree: number; rowsPerGap: number; near?: NearTerrain }): DuneMesh {
  const spec = field.spec;
  const K = spec.ridges.length;
  const cols = Math.max(8, Math.round((spec.span[1] - spec.span[0]) * opts.columnsPerDegree) + 1);
  const azs = Float64Array.from({ length: cols }, (_, c) => spec.span[0] + ((spec.span[1] - spec.span[0]) * c) / (cols - 1));
  const crestR = Array.from({ length: K }, (_, k) => Float64Array.from(azs, (az) => field.crestDistance(k, az)));
  const crestH = Array.from({ length: K }, (_, k) => Float64Array.from(azs, (az) => field.crestHeight(k, az)));
  // Gaps: before ridge 0, between ridges, and a short run behind the last ridge.
  const gaps: { ka: number; kb: number; rows: number }[] = [];
  gaps.push({ ka: -1, kb: 0, rows: Math.max(6, Math.round(opts.rowsPerGap * 0.6)) });
  for (let k = 0; k < K - 1; k++) gaps.push({ ka: k, kb: k + 1, rows: opts.rowsPerGap });
  gaps.push({ ka: K - 1, kb: K, rows: Math.max(4, Math.round(opts.rowsPerGap * 0.3)) });
  const totalRows = gaps.reduce((s, g) => s + g.rows, 0);
  const count = totalRows * cols;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const dune = new Float32Array(count * 4);
  const index = new Uint32Array(gaps.reduce((s, g) => s + (g.rows - 1) * (cols - 1) * 6, 0));
  const crests = Array.from({ length: K }, () => new Float32Array(cols * 4));
  const near = opts.near;
  const nearEdgeZ = near ? near.apex[1] - near.far : 0;

  let base = 0;
  let ii = 0;
  for (const gap of gaps) {
    for (let row = 0; row < gap.rows; row++) {
      // Rows crowd towards both crests, where the profile bends most.
      const s = (1 - Math.cos((Math.PI * row) / (gap.rows - 1))) / 2;
      for (let c = 0; c < cols; c++) {
        const az = azs[c]!;
        const ra = gap.ka >= 0 ? crestR[gap.ka]![c]! : spec.start;
        const rb = gap.kb < K ? crestR[gap.kb]![c]! : ra + spec.ridges[K - 1]!.height * 1.4;
        const r = ra + (rb - ra) * s;
        const ha = gap.ka >= 0 ? crestH[gap.ka]![c]! : 0;
        const hb = gap.kb < K ? crestH[gap.kb]![c]! : 0;
        const ref = Math.max(ha, hb, 1);
        let y = field.between(az, r, ra, ha, gap.kb < K ? rb : 1e9, hb);
        const [x, z] = field.xz(az, r);
        if (near) {
          // Stay under the near terrain where it exists, rising out from behind its far edge.
          const half = (near.apex[1] - z) * near.spread + 20;
          const inside = Math.min(smooth(nearEdgeZ - 40, nearEdgeZ, z), smooth(half + 30, half, Math.abs(x)));
          if (inside > 0) y = y + (Math.min(y, near.height(x, z) - 2.5) - y) * inside;
        }
        const i = base + row * cols + c;
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
        const own = s >= 0.5 ? (gap.kb < K ? hb : ha) : gap.ka >= 0 ? ha : hb;
        const rel = (y - field.floorAt(r)) / Math.max(1, own || ref);
        const slipSide = spec.lee === 'far' ? (s < 0.5 && gap.ka >= 0 ? 1 : 0) : s >= 0.5 && gap.kb < K ? 1 : 0;
        dune[i * 4] = Math.max(0, Math.min(1.2, rel));
        dune[i * 4 + 1] = gap.kb;
        dune[i * 4 + 2] = slipSide;
        dune[i * 4 + 3] = r;
        if (row === 0 && gap.ka >= 0) crests[gap.ka]!.set([x, y, z, y - field.floorAt(r)], c * 4);
      }
    }
    // Normals from the strip's own grid (one-sided at its edges, so crests keep a hard edge).
    for (let row = 0; row < gap.rows; row++) {
      for (let c = 0; c < cols; c++) {
        const i = base + row * cols + c;
        const r0 = base + Math.max(0, row - 1) * cols + c;
        const r1 = base + Math.min(gap.rows - 1, row + 1) * cols + c;
        const c0 = base + row * cols + Math.max(0, c - 1);
        const c1 = base + row * cols + Math.min(cols - 1, c + 1);
        const ax = positions[r1 * 3]! - positions[r0 * 3]!;
        const ay = positions[r1 * 3 + 1]! - positions[r0 * 3 + 1]!;
        const az = positions[r1 * 3 + 2]! - positions[r0 * 3 + 2]!;
        const bx = positions[c1 * 3]! - positions[c0 * 3]!;
        const by = positions[c1 * 3 + 1]! - positions[c0 * 3 + 1]!;
        const bz = positions[c1 * 3 + 2]! - positions[c0 * 3 + 2]!;
        let nx = ay * bz - az * by;
        let ny = az * bx - ax * bz;
        let nz = ax * by - ay * bx;
        if (ny < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        const l = Math.hypot(nx, ny, nz) || 1;
        normals[i * 3] = nx / l;
        normals[i * 3 + 1] = ny / l;
        normals[i * 3 + 2] = nz / l;
      }
    }
    for (let row = 0; row < gap.rows - 1; row++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = base + row * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        // Counter-clockwise seen from above (front faces up): columns run to the right (+x) and
        // rows away from the viewer (−z).
        index[ii++] = a;
        index[ii++] = b;
        index[ii++] = d;
        index[ii++] = b;
        index[ii++] = e;
        index[ii++] = d;
      }
    }
    base += gap.rows * cols;
  }
  return { positions, normals, dune, index, crests, columns: cols };
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * The skyline seen from `eye`: the highest elevation (degrees) of the mesh per azimuth step,
 * as [azimuth, elevation] points (the meteors layer keeps its paths above it).
 */
export function skyline(mesh: DuneMesh, eye: readonly [number, number, number], step: number, extra: readonly { az: number; el: number; halfWidth: number }[] = []): [number, number][] {
  const best = new Map<number, number>();
  const n = mesh.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const x = mesh.positions[i * 3]! - eye[0];
    const y = mesh.positions[i * 3 + 1]! - eye[1];
    const z = mesh.positions[i * 3 + 2]! - eye[2];
    const d = Math.hypot(x, z);
    const az = Math.atan2(x, -z) / DEG;
    const el = Math.atan2(y, d) / DEG;
    const key = Math.round(az / step) * step;
    if (el > (best.get(key) ?? -90)) best.set(key, el);
  }
  for (const e of extra) {
    for (let a = Math.round((e.az - e.halfWidth) / step) * step; a <= e.az + e.halfWidth; a += step) {
      best.set(a, Math.max(best.get(a) ?? -90, e.el));
    }
  }
  return [...best.entries()].sort((a, b) => a[0] - b[0]).map(([a, e]) => [Math.round(a * 10) / 10, Math.round(e * 100) / 100]);
}
