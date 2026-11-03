/**
 * Generic 3D boids (bird flocks, fish schools) on the CPU: fixed-step, allocation-free per step,
 * deterministic for a given seed and step count, safe for coincident boids.
 *
 * Interaction is topological, as measured in starling flocks (Ballerini et al. 2008): every boid
 * reacts to its k nearest neighbours (about 7) rather than to all boids within a fixed radius,
 * found through a uniform spatial hash grid. Separation is short-range; alignment and cohesion use
 * the k neighbours. A soft oriented ellipsoid keeps the flock in its region and half-spaces keep it
 * out of forbidden zones, both by gentle steering (never wrapping).
 *
 * Threats (a falcon) make nearby boids flee and start escape waves: a boid that sees a threat, or a
 * neighbour that started its escape a moment ago, swerves the same way, then cannot be re-excited
 * for a while (an excitable medium), so a band of swerving boids sweeps across the whole flock at
 * roughly 15–25 m/s, as agitation waves do in real murmurations.
 */

export type Vec3 = [number, number, number];

export interface BoidsWeights {
  /** Push apart inside the separation distance (m/s² at contact). */
  separation: number;
  /** Relaxation rate towards the neighbours' mean velocity (1/s). */
  alignment: number;
  /** Pull towards the neighbours' centroid (1/s²). */
  cohesion: number;
  /** Relaxation rate towards the cruise speed (1/s). */
  cruise: number;
  /** Damping of vertical speed: a preference for level flight (1/s). */
  level: number;
  /**
   * Pull towards the centre of the bounds, as a fraction of the pull that would make a boid at
   * cruise speed orbit along the ellipsoid's surface. Every boid feels nearly the same pull, so a
   * polarised flock wheels about the region as one body instead of milling at its edge.
   */
  roost: number;
  /** Steering back inside at the ellipsoid surface (m/s²; grows beyond it). */
  bounds: number;
  /** Gentle individual wandering (m/s²), slowly varying per boid. */
  wander: number;
  /** Steering out of an avoided half-space at its boundary (m/s²). */
  avoid: number;
  /** Flight from a threat at its centre (m/s²). */
  flee: number;
  /** Swerve of a panicking boid (m/s²). */
  evade: number;
}

export interface BoidsConfig {
  count: number;
  seed: number;
  /** Topological neighbours each boid reacts to. */
  neighbours: number;
  /** Neighbours farther than this are not seen (m). */
  perception: number;
  /** Separation acts only inside this distance (m). */
  separation: number;
  minSpeed: number;
  maxSpeed: number;
  cruiseSpeed: number;
  /** Largest steering acceleration in calm flight (m/s²). */
  maxAccel: number;
  weights: BoidsWeights;
  /** Soft region: an ellipsoid with orthonormal axes and half-extents along them. */
  bounds: { center: Vec3; radii: Vec3; axes: readonly [Vec3, Vec3, Vec3] };
  /** Half-spaces to stay out of: keep dot(normal, p) − offset ≥ 0, steering inside the margin. */
  avoid: readonly { normal: Vec3; offset: number; margin: number }[];
  /** Escape waves: how long a swerve lasts, the hand-on delay to neighbours, the refractory time (s), and the speed boost while panicking (fraction). */
  panic: { duration: number; delay: number; refractory: number; boost: number };
  /** Where the boids start: an ellipsoidal cloud and a common heading. */
  spawn: { center: Vec3; spread: Vec3; heading: Vec3 };
}

export interface Threat {
  active: boolean;
  x: number;
  y: number;
  z: number;
  /** Boids inside this distance flee; inside 70 % of it they panic. */
  radius: number;
  /** Multiplies the flee steering. */
  strength: number;
}

export const DEFAULT_WEIGHTS: BoidsWeights = {
  separation: 30,
  alignment: 2.6,
  cohesion: 1.1,
  cruise: 1.2,
  level: 0.6,
  roost: 1,
  bounds: 6,
  wander: 1.2,
  avoid: 16,
  flee: 28,
  evade: 16,
};

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_K = 16;
/** Grid capacity; a scattered flock gets larger cells instead of more of them. */
const MAX_CELLS = 1 << 18;
/** Each boid's neighbour list is refreshed every this many steps (distances are always current). */
const NEIGHBOUR_REFRESH = 2;
const MAX_THREATS = 4;

export class Boids {
  readonly count: number;
  readonly config: BoidsConfig;
  /** Positions and velocities, xyz interleaved. */
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  /** Smoothed acceleration (for banking), xyz interleaved. */
  readonly acc: Float32Array;
  /** Escape state per boid: 1 at the start of a swerve, decaying to 0. */
  readonly panic: Float32Array;
  readonly threats: Threat[] = [];
  /** Steps taken since construction. */
  steps = 0;

  private readonly velNext: Float32Array;
  private readonly panicNext: Float32Array;
  private readonly refractory: Float32Array;
  private readonly evade: Float32Array;
  private readonly evadeNext: Float32Array;
  private readonly wanderPhase: Float32Array;
  // Uniform grid over the flock's bounding box (counting sort of boids into cells).
  private readonly baseCell: number;
  private cell = 1;
  private gx = 1;
  private gy = 1;
  private gz = 1;
  private minX = 0;
  private minY = 0;
  private minZ = 0;
  private readonly cellStart: Int32Array;
  private readonly cellOf: Int32Array;
  private readonly order: Int32Array;
  /** Each boid's slot in cell order, and positions copied into cell order (contiguous scans). */
  private readonly slotOf: Int32Array;
  private readonly sx: Float32Array;
  private readonly sy: Float32Array;
  private readonly sz: Float32Array;
  // Neighbour lists, refreshed every NEIGHBOUR_REFRESH steps.
  private readonly nbr: Int32Array;
  private readonly nbrCount: Uint8Array;
  // k-nearest scratch.
  private readonly bestD = new Float64Array(MAX_K);
  private readonly bestJ = new Int32Array(MAX_K);
  private found = 0;
  private readonly k: number;

  constructor(config: BoidsConfig) {
    this.config = config;
    const n = Math.max(1, Math.floor(config.count));
    this.count = n;
    this.k = Math.max(1, Math.min(MAX_K, Math.floor(config.neighbours)));
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.acc = new Float32Array(n * 3);
    this.velNext = new Float32Array(n * 3);
    this.panic = new Float32Array(n);
    this.panicNext = new Float32Array(n);
    this.refractory = new Float32Array(n);
    this.evade = new Float32Array(n * 3);
    this.evadeNext = new Float32Array(n * 3);
    this.wanderPhase = new Float32Array(n);
    // Cells about the size of the k-th neighbour distance in a flock packed at the separation.
    this.baseCell = Math.max(0.05, config.separation * 1.1);
    this.cellStart = new Int32Array(MAX_CELLS + 1);
    this.cellOf = new Int32Array(n);
    this.order = new Int32Array(n);
    this.slotOf = new Int32Array(n);
    this.sx = new Float32Array(n);
    this.sy = new Float32Array(n);
    this.sz = new Float32Array(n);
    this.nbr = new Int32Array(n * this.k);
    this.nbrCount = new Uint8Array(n);
    for (let i = 0; i < MAX_THREATS; i++) this.threats.push({ active: false, x: 0, y: 0, z: 0, radius: 10, strength: 1 });

    const r = rng(config.seed);
    const { center, spread, heading } = config.spawn;
    const hl = Math.hypot(heading[0], heading[1], heading[2]) || 1;
    for (let i = 0; i < n; i++) {
      let x: number;
      let y: number;
      let z: number;
      do {
        x = r() * 2 - 1;
        y = r() * 2 - 1;
        z = r() * 2 - 1;
      } while (x * x + y * y + z * z > 1);
      this.wanderPhase[i] = r() * Math.PI * 2;
      this.pos[i * 3] = center[0] + x * spread[0];
      this.pos[i * 3 + 1] = center[1] + y * spread[1];
      this.pos[i * 3 + 2] = center[2] + z * spread[2];
      const s = config.cruiseSpeed * (0.9 + r() * 0.2);
      this.vel[i * 3] = (heading[0] / hl + (r() - 0.5) * 0.2) * s;
      this.vel[i * 3 + 1] = (heading[1] / hl + (r() - 0.5) * 0.05) * s;
      this.vel[i * 3 + 2] = (heading[2] / hl + (r() - 0.5) * 0.2) * s;
    }
  }

  private buildGrid(): void {
    const n = this.count;
    const pos = this.pos;
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < n * 3; i += 3) {
      const x = pos[i]!;
      const y = pos[i + 1]!;
      const z = pos[i + 2]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    // Grow the cells if a scattered flock would need more of them than the grid holds.
    let cell = this.baseCell;
    const cells = (c: number) => (Math.floor((x1 - x0) / c) + 1) * (Math.floor((y1 - y0) / c) + 1) * (Math.floor((z1 - z0) / c) + 1);
    while (cells(cell) > MAX_CELLS) cell *= 1.26;
    const gx = Math.floor((x1 - x0) / cell) + 1;
    const gy = Math.floor((y1 - y0) / cell) + 1;
    const gz = Math.floor((z1 - z0) / cell) + 1;
    this.cell = cell;
    this.gx = gx;
    this.gy = gy;
    this.gz = gz;
    this.minX = x0;
    this.minY = y0;
    this.minZ = z0;
    const total = gx * gy * gz;
    const start = this.cellStart;
    start.fill(0, 0, total + 1);
    const inv = 1 / cell;
    const cellOf = this.cellOf;
    for (let i = 0; i < n; i++) {
      const ix = Math.floor((pos[i * 3]! - x0) * inv);
      const iy = Math.floor((pos[i * 3 + 1]! - y0) * inv);
      const iz = Math.floor((pos[i * 3 + 2]! - z0) * inv);
      const c = ix + gx * (iy + gy * iz);
      cellOf[i] = c;
      start[c + 1]!++;
    }
    for (let c = 0; c < total; c++) start[c + 1]! += start[c]!;
    const order = this.order;
    for (let i = 0; i < n; i++) order[start[cellOf[i]!]!++] = i;
    // Each cursor now sits at the next cell's start: shift back.
    for (let c = total; c > 0; c--) start[c] = start[c - 1]!;
    start[0] = 0;
    for (let q = 0; q < n; q++) {
      const i = order[q]!;
      this.slotOf[i] = q;
      this.sx[q] = pos[i * 3]!;
      this.sy[q] = pos[i * 3 + 1]!;
      this.sz[q] = pos[i * 3 + 2]!;
    }
  }

  /** Scans the cells of a block (inclusive cell ranges), keeping the k nearest to boid i. */
  private scan(i: number, px: number, py: number, pz: number, xa: number, xb: number, ya: number, yb: number, za: number, zb: number, skipInner: number): void {
    const k = this.k;
    const bestD = this.bestD;
    const bestJ = this.bestJ;
    const sx = this.sx;
    const sy = this.sy;
    const sz = this.sz;
    const self = this.slotOf[i]!;
    const start = this.cellStart;
    const gx = this.gx;
    const gy = this.gy;
    const cx = Math.floor((px - this.minX) / this.cell);
    const cy = Math.floor((py - this.minY) / this.cell);
    const cz = Math.floor((pz - this.minZ) / this.cell);
    let found = this.found;
    let worst = found < k ? Infinity : bestD[k - 1]!;
    for (let z = za; z <= zb; z++) {
      for (let y = ya; y <= yb; y++) {
        const row = gx * (y + gy * z);
        for (let x = xa; x <= xb; x++) {
          // The second ring skips the block already scanned.
          if (skipInner > 0 && Math.abs(x - cx) < skipInner && Math.abs(y - cy) < skipInner && Math.abs(z - cz) < skipInner) continue;
          const c = row + x;
          const end = start[c + 1]!;
          for (let q = start[c]!; q < end; q++) {
            if (q === self) continue;
            const dx = sx[q]! - px;
            const dy = sy[q]! - py;
            const dz = sz[q]! - pz;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 >= worst) continue;
            let m = found < k ? found++ : k - 1;
            while (m > 0 && bestD[m - 1]! > d2) {
              bestD[m] = bestD[m - 1]!;
              bestJ[m] = bestJ[m - 1]!;
              m--;
            }
            bestD[m] = d2;
            bestJ[m] = q;
            if (found === k) worst = bestD[k - 1]!;
          }
        }
      }
    }
    this.found = found;
  }

  /** Finds boid i's k nearest neighbours within the perception range (nearest first). */
  private nearest(i: number): void {
    this.found = 0;
    const px = this.pos[i * 3]!;
    const py = this.pos[i * 3 + 1]!;
    const pz = this.pos[i * 3 + 2]!;
    const inv = 1 / this.cell;
    const cx = Math.floor((px - this.minX) * inv);
    const cy = Math.floor((py - this.minY) * inv);
    const cz = Math.floor((pz - this.minZ) * inv);
    const gx = this.gx - 1;
    const gy = this.gy - 1;
    const gz = this.gz - 1;
    this.scan(i, px, py, pz, Math.max(0, cx - 1), Math.min(gx, cx + 1), Math.max(0, cy - 1), Math.min(gy, cy + 1), Math.max(0, cz - 1), Math.min(gz, cz + 1), 0);
    // Sparse surroundings (the flock's edge, stragglers): look one ring further.
    if (this.found < this.k) this.scan(i, px, py, pz, Math.max(0, cx - 2), Math.min(gx, cx + 2), Math.max(0, cy - 2), Math.min(gy, cy + 2), Math.max(0, cz - 2), Math.min(gz, cz + 2), 2);
    // Limited perception; slots back to boid indices.
    const p2 = this.config.perception * this.config.perception;
    while (this.found > 0 && this.bestD[this.found - 1]! > p2) this.found--;
    for (let m = 0; m < this.found; m++) this.bestJ[m] = this.order[this.bestJ[m]!]!;
  }

  /** The k nearest neighbours of boid i (indices, nearest first), for inspection and tests. */
  neighboursOf(i: number): number[] {
    this.buildGrid();
    this.nearest(i);
    return Array.from(this.bestJ.subarray(0, this.found));
  }

  /** Advances the flock by dt seconds (call with a fixed dt). */
  step(dt: number): void {
    const n = this.count;
    const c = this.config;
    const w = c.weights;
    const pos = this.pos;
    const vel = this.vel;
    const out = this.velNext;
    const sep = c.separation;
    const [bc0, bc1, bc2] = c.bounds.center;
    const [ax, ay, az] = c.bounds.axes;
    const [r0, r1, r2] = c.bounds.radii;
    const pd = c.panic;
    const handOn = Math.max(0, 1 - pd.delay / Math.max(1e-3, pd.duration));
    // v² / r: the pull that makes a boid at cruise speed orbit at the surface (per unit of q).
    // (A thin axis pulls as if it were half the longest, so the flock does not bob on it.)
    const roostK = w.roost * c.cruiseSpeed * c.cruiseSpeed;
    const rHalf = 0.5 * Math.max(r0, r1, r2);
    const time = this.steps * dt;
    const k = this.k;
    const panicA = this.panic;
    const panicN = this.panicNext;
    const refrA = this.refractory;
    const evadeA = this.evade;
    const evadeN = this.evadeNext;
    const wanderA = this.wanderPhase;
    const avoid = c.avoid;
    const avoidCount = avoid.length;
    const threats = this.threats;
    // Only scan threats when one is active.
    let threatCount = 0;
    for (let t = 0; t < MAX_THREATS; t++) if (threats[t]!.active) threatCount = t + 1;
    const nbr = this.nbr;
    const nbrCount = this.nbrCount;
    // Neighbour lists are refreshed round-robin (an equal share every step, so the cost is even);
    // the first step finds everyone's.
    this.buildGrid();
    const phase = this.steps % NEIGHBOUR_REFRESH;
    for (let i = this.steps === 0 ? 0 : phase; i < n; i += this.steps === 0 ? 1 : NEIGHBOUR_REFRESH) {
      this.nearest(i);
      nbrCount[i] = this.found;
      for (let m = 0; m < this.found; m++) nbr[i * k + m] = this.bestJ[m]!;
    }

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const px = pos[i3]!;
      const py = pos[i3 + 1]!;
      const pz = pos[i3 + 2]!;
      const vx = vel[i3]!;
      const vy = vel[i3 + 1]!;
      const vz = vel[i3 + 2]!;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let mvx = 0;
      let mvy = 0;
      let mvz = 0;
      let mx = 0;
      let my = 0;
      let mz = 0;
      let panic = panicA[i]!;
      let refr = refrA[i]!;
      let ex = evadeA[i3]!;
      let ey = evadeA[i3 + 1]!;
      let ez = evadeA[i3 + 2]!;
      let excited = false;
      const f = nbrCount[i]!;
      for (let m = 0; m < f; m++) {
        const j = nbr[i * k + m]!;
        const j3 = j * 3;
        const dx = px - pos[j3]!;
        const dy = py - pos[j3 + 1]!;
        const dz = pz - pos[j3 + 2]!;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < sep) {
          const push = (sep - d) / sep;
          if (d > 1e-5) {
            sx += (dx / d) * push;
            sy += (dy / d) * push;
            sz += (dz / d) * push;
          } else {
            // Coincident boids: part along a direction fixed by the pair, never NaN.
            const a = ((i * 2654435761) ^ (j * 40503)) % 6283;
            sx += Math.cos(a / 1000) * push;
            sz += Math.sin(a / 1000) * push;
          }
        }
        mvx += vel[j3]!;
        mvy += vel[j3 + 1]!;
        mvz += vel[j3 + 2]!;
        mx += pos[j3]!;
        my += pos[j3 + 1]!;
        mz += pos[j3 + 2]!;
        // Escape waves hand on from neighbours that started swerving a moment ago.
        if (!excited && refr <= 0) {
          const pj = panicA[j]!;
          if (pj > 0.2 && pj < handOn) {
            excited = true;
            ex = evadeA[j3]!;
            ey = evadeA[j3 + 1]!;
            ez = evadeA[j3 + 2]!;
          }
        }
      }
      let axc = 0;
      let ayc = 0;
      let azc = 0;
      if (f > 0) {
        const inv = 1 / f;
        axc += sx * w.separation + (mvx * inv - vx) * w.alignment + (mx * inv - px) * w.cohesion;
        ayc += sy * w.separation + (mvy * inv - vy) * w.alignment + (my * inv - py) * w.cohesion;
        azc += sz * w.separation + (mvz * inv - vz) * w.alignment + (mz * inv - pz) * w.cohesion;
      }
      // Cruise speed (faster while panicking) and level flight.
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      // The swerve's strength is the length of its direction vector (1 for an escape).
      const urgency = panic * Math.sqrt(ex * ex + ey * ey + ez * ez);
      const cruise = c.cruiseSpeed * (1 + pd.boost * urgency);
      if (speed > 1e-5) {
        const g = ((cruise - speed) * w.cruise) / speed;
        axc += vx * g;
        ayc += vy * g;
        azc += vz * g;
      }
      ayc -= vy * w.level;
      // Roost: a harmonic pull to the centre of the bounds, per axis, so the flock wheels about it.
      const ox = px - bc0;
      const oy = py - bc1;
      const oz = pz - bc2;
      const q0 = (ox * ax[0] + oy * ax[1] + oz * ax[2]) / r0;
      const q1 = (ox * ay[0] + oy * ay[1] + oz * ay[2]) / r1;
      const q2 = (ox * az[0] + oy * az[1] + oz * az[2]) / r2;
      const k0 = roostK / Math.max(r0, rHalf);
      const k1 = roostK / Math.max(r1, rHalf);
      const k2 = roostK / Math.max(r2, rHalf);
      axc -= ax[0] * q0 * k0 + ay[0] * q1 * k1 + az[0] * q2 * k2;
      ayc -= ax[1] * q0 * k0 + ay[1] * q1 * k1 + az[1] * q2 * k2;
      azc -= ax[2] * q0 * k0 + ay[2] * q1 * k1 + az[2] * q2 * k2;
      // Wandering: each boid's own slow drift (smooth, deterministic).
      if (w.wander > 0) {
        const ph = wanderA[i]!;
        axc += Math.sin(time * 0.9 + ph) * w.wander;
        ayc += Math.sin(time * 0.7 + ph * 1.7) * w.wander * 0.3;
        azc += Math.sin(time * 0.8 + ph * 2.3) * w.wander;
      }
      // Soft wall from 80 % of the way out: the boids that lead out turn first and the rest follow
      // them by alignment, so the flock bends and pours through its turns.
      const rr = Math.sqrt(q0 * q0 + q1 * q1 + q2 * q2);
      if (rr > 0.8) {
        const gx = (ax[0] * q0) / r0 + (ay[0] * q1) / r1 + (az[0] * q2) / r2;
        const gy = (ax[1] * q0) / r0 + (ay[1] * q1) / r1 + (az[1] * q2) / r2;
        const gz = (ax[2] * q0) / r0 + (ay[2] * q1) / r1 + (az[2] * q2) / r2;
        const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
        if (gl > 1e-9) {
          const s = (w.bounds * (rr - 0.8)) / 0.2 / gl;
          axc -= gx * s;
          ayc -= gy * s;
          azc -= gz * s;
        }
      }
      // Outside the bounds a boid may turn harder to come home.
      let limit = rr > 1 ? c.maxAccel * 1.8 : c.maxAccel;
      for (let hv = 0; hv < avoidCount; hv++) {
        const h = avoid[hv]!;
        const s = h.normal[0] * px + h.normal[1] * py + h.normal[2] * pz - h.offset;
        if (s < h.margin) {
          const ramp = Math.min(3, 1 - s / Math.max(1e-3, h.margin));
          // Push out, and cancel the part of the velocity heading in.
          const inward = Math.max(0, -(h.normal[0] * vx + h.normal[1] * vy + h.normal[2] * vz));
          const push = w.avoid * ramp + inward * ramp * 3;
          axc += h.normal[0] * push;
          ayc += h.normal[1] * push;
          azc += h.normal[2] * push;
          // Turning away from a forbidden zone may take a harder turn than calm flight.
          limit = Math.max(limit, c.maxAccel * 2.5);
        }
      }
      // Threats: flee, and panic close in (starting an escape wave).
      for (let t = 0; t < threatCount; t++) {
        const th = threats[t]!;
        if (!th.active) continue;
        const dx = px - th.x;
        const dy = py - th.y;
        const dz = pz - th.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d >= th.radius || d < 1e-5) continue;
        const u = 1 - d / th.radius;
        const s = (w.flee * th.strength * u * u) / d;
        axc += dx * s;
        ayc += dy * s;
        azc += dz * s;
        limit = Math.max(limit, c.maxAccel * 2);
        if (refr <= 0 && d < th.radius * 0.7 && speed > 1e-5) {
          // Swerve sideways away from the threat (its component across the flight direction).
          const along = (dx * vx + dy * vy + dz * vz) / speed;
          let qx = dx - (vx / speed) * along;
          let qy = (dy - (vy / speed) * along) * 0.5;
          let qz = dz - (vz / speed) * along;
          const ql = Math.sqrt(qx * qx + qy * qy + qz * qz);
          if (ql > 1e-5) {
            qx /= ql;
            qy /= ql;
            qz /= ql;
            excited = true;
            ex = qx;
            ey = qy;
            ez = qz;
          }
        }
      }
      if (excited) {
        panic = 1;
        refr = pd.refractory;
      }
      if (panic > 0) {
        axc += ex * w.evade * panic;
        ayc += ey * w.evade * panic;
        azc += ez * w.evade * panic;
        limit = Math.max(limit, c.maxAccel * 1.8);
      }
      const al = Math.sqrt(axc * axc + ayc * ayc + azc * azc);
      if (al > limit) {
        const s = limit / al;
        axc *= s;
        ayc *= s;
        azc *= s;
      }
      let nvx = vx + axc * dt;
      let nvy = vy + ayc * dt;
      let nvz = vz + azc * dt;
      const ns = Math.sqrt(nvx * nvx + nvy * nvy + nvz * nvz);
      const maxS = c.maxSpeed * (1 + pd.boost * Math.max(urgency, panic * Math.sqrt(ex * ex + ey * ey + ez * ez)));
      if (ns > maxS) {
        const s = maxS / ns;
        nvx *= s;
        nvy *= s;
        nvz *= s;
      } else if (ns < c.minSpeed) {
        if (ns > 1e-5) {
          const s = c.minSpeed / ns;
          nvx *= s;
          nvy *= s;
          nvz *= s;
        } else {
          nvx = c.minSpeed;
        }
      }
      out[i3] = nvx;
      out[i3 + 1] = nvy;
      out[i3 + 2] = nvz;
      panicN[i] = Math.max(0, panic - dt / Math.max(1e-3, pd.duration));
      refrA[i] = refr - dt;
      evadeN[i3] = ex;
      evadeN[i3 + 1] = ey;
      evadeN[i3 + 2] = ez;
    }

    // Integrate (every boid steered from the same previous state).
    const blend = 1 - Math.exp(-dt / 0.12);
    const invDt = 1 / dt;
    for (let i = 0; i < n * 3; i++) {
      const a = (out[i]! - vel[i]!) * invDt;
      this.acc[i] = this.acc[i]! + (a - this.acc[i]!) * blend;
      vel[i] = out[i]!;
      pos[i] = pos[i]! + out[i]! * dt;
      evadeA[i] = evadeN[i]!;
    }
    this.panic.set(this.panicNext);
    this.steps++;
  }

  /**
   * Starts a swerve at boid i (a spontaneous turn by one bird at the edge, say) that spreads across
   * the flock like an escape wave. `strength` scales the swerve (1 = an escape from a predator).
   */
  startle(i: number, dir: Vec3, strength: number): void {
    if (i < 0 || i >= this.count || this.refractory[i]! > 0) return;
    const l = Math.hypot(dir[0], dir[1], dir[2]);
    if (l < 1e-6) return;
    const s = strength / l;
    this.panic[i] = 1;
    this.refractory[i] = this.config.panic.refractory;
    this.evade[i * 3] = dir[0] * s;
    this.evade[i * 3 + 1] = dir[1] * s;
    this.evade[i * 3 + 2] = dir[2] * s;
  }

  /** Mean position and velocity of the flock. */
  centroid(outPos: Vec3, outVel: Vec3): void {
    let x = 0;
    let y = 0;
    let z = 0;
    let a = 0;
    let b = 0;
    let c = 0;
    const n = this.count;
    for (let i = 0; i < n; i++) {
      x += this.pos[i * 3]!;
      y += this.pos[i * 3 + 1]!;
      z += this.pos[i * 3 + 2]!;
      a += this.vel[i * 3]!;
      b += this.vel[i * 3 + 1]!;
      c += this.vel[i * 3 + 2]!;
    }
    outPos[0] = x / n;
    outPos[1] = y / n;
    outPos[2] = z / n;
    outVel[0] = a / n;
    outVel[1] = b / n;
    outVel[2] = c / n;
  }
}
