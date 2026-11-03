import { BufferAttribute, BufferGeometry } from 'three/webgpu';

/**
 * A clothed human figure built from anatomical cross-sections, in metres: 1.75 m tall, feet on
 * y = 0, facing +z, the figure's left side at +x, standing with the arms hanging.
 *
 * Every vertex carries `rig` = (limb × 8 + material, w1, w2, w3): the limb it belongs to and how
 * strongly it follows that limb's joints (smoothly blended near each joint), so the shader can pose
 * the whole body analytically. Limbs: 0 torso (w1 spine), 1 neck and head (w1 neck), 2/3 left and
 * right arm (shoulder, elbow, wrist), 4/5 left and right leg (hip, knee, ankle), 6 coat skirt
 * (w1 how far it follows the thighs). Materials: 0 skin, 1 shirt or jacket, 2 trousers, 3 shoes,
 * 4 hair, 5 coat, 6 hood (shown on some figures only).
 */

/** Joint pivots in the rest pose (left side; mirror x for the right). */
export const JOINTS = {
  hip: [0.092, 0.93, 0.0],
  knee: [0.098, 0.5, 0.014],
  ankle: [0.103, 0.088, -0.022],
  spine: [0, 1.0, -0.015],
  neck: [0, 1.5, -0.028],
  shoulder: [0.188, 1.42, -0.03],
  elbow: [0.212, 1.13, -0.045],
  wrist: [0.224, 0.865, -0.025],
} as const;

export const LIMB = { torso: 0, head: 1, armL: 2, armR: 3, legL: 4, legR: 5, skirt: 6 } as const;
export const MAT = { skin: 0, top: 1, trousers: 2, shoes: 3, hair: 4, coat: 5, hood: 6 } as const;

type V3 = [number, number, number];

interface Ring {
  /** Centre. */
  c: V3;
  /** Half-extent along +u and −u (u = x for vertical rings). */
  ru: number;
  ruN?: number;
  /** Half-extent along +v and −v (v = z, the front, for vertical rings). */
  rv: number;
  rvN?: number;
  /** Superellipse exponent (2 = ellipse, larger = boxier). */
  e?: number;
}

class Builder {
  readonly pos: number[] = [];
  readonly rig: number[] = [];
  readonly idx: number[] = [];

  vertex(p: V3, rig: [number, number, number, number]): number {
    this.pos.push(p[0], p[1], p[2]);
    this.rig.push(...rig);
    return this.pos.length / 3 - 1;
  }

  /**
   * Lofts rings into a tube. `u`/`v` span each ring; rings progress along the third axis.
   * `skip(ringIndex, angle)` leaves faces out (coat opening).
   */
  loft(
    rings: Ring[],
    seg: number,
    u: V3,
    v: V3,
    rig: (p: V3, ring: number) => [number, number, number, number],
    opts: { capStart?: boolean; capEnd?: boolean; skip?: (ring: number, angle: number) => boolean; jitter?: (p: V3, ring: number, angle: number) => number } = {},
  ): void {
    const first: number[] = [];
    const rowsIdx: number[][] = [];
    rings.forEach((r, i) => {
      const row: number[] = [];
      for (let j = 0; j < seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        const cu = Math.cos(a);
        const sv = Math.sin(a);
        const e = r.e ?? 2;
        const fu = Math.sign(cu) * Math.pow(Math.abs(cu), 2 / e);
        const fv = Math.sign(sv) * Math.pow(Math.abs(sv), 2 / e);
        const ru = cu >= 0 ? r.ru : (r.ruN ?? r.ru);
        const rv = sv >= 0 ? r.rv : (r.rvN ?? r.rv);
        let p: V3 = [r.c[0] + u[0] * fu * ru + v[0] * fv * rv, r.c[1] + u[1] * fu * ru + v[1] * fv * rv, r.c[2] + u[2] * fu * ru + v[2] * fv * rv];
        if (opts.jitter) {
          const k = opts.jitter(p, i, a);
          const nx = u[0] * cu + v[0] * sv;
          const ny = u[1] * cu + v[1] * sv;
          const nz = u[2] * cu + v[2] * sv;
          p = [p[0] + nx * k, p[1] + ny * k, p[2] + nz * k];
        }
        row.push(this.vertex(p, rig(p, i)));
      }
      rowsIdx.push(row);
      if (i === 0) first.push(...row);
    });
    const a0 = rings[0]!.c;
    const a1 = rings[rings.length - 1]!.c;
    const prog: V3 = [a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]];
    const uxv: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const same = uxv[0] * prog[0] + uxv[1] * prog[1] + uxv[2] * prog[2] > 0;
    for (let i = 0; i < rings.length - 1; i++) {
      for (let j = 0; j < seg; j++) {
        if (opts.skip?.(i, ((j + 0.5) / seg) * Math.PI * 2)) continue;
        const a = rowsIdx[i]![j]!;
        const b = rowsIdx[i]![(j + 1) % seg]!;
        const c = rowsIdx[i + 1]![(j + 1) % seg]!;
        const d = rowsIdx[i + 1]![j]!;
        if (same) this.idx.push(a, b, c, a, c, d);
        else this.idx.push(a, c, b, a, d, c);
      }
    }
    const cap = (row: number[], ring: Ring, start: boolean, ri: number) => {
      const centre = this.vertex(ring.c, rig(ring.c, ri));
      for (let j = 0; j < seg; j++) {
        const p = row[j]!;
        const q = row[(j + 1) % seg]!;
        // The fan's normal points along u×v; a start cap must face −progress.
        const flip = start ? same : !same;
        if (flip) this.idx.push(centre, q, p);
        else this.idx.push(centre, p, q);
      }
    };
    if (opts.capStart) cap(rowsIdx[0]!, rings[0]!, true, 0);
    if (opts.capEnd) cap(rowsIdx[rings.length - 1]!, rings[rings.length - 1]!, false, rings.length - 1);
  }

  /** A closed surface around `centre` from a direction → point function (lat-long grid with poles). */
  sphere(centre: V3, lat: number, seg: number, shape: (d: V3) => V3, rig: (p: V3) => [number, number, number, number]): void {
    const rows: number[][] = [];
    const bottom = this.vertex(add(centre, shape([0, -1, 0])), rig(add(centre, shape([0, -1, 0]))));
    for (let i = 1; i < lat; i++) {
      const th = Math.PI * (1 - i / lat);
      const row: number[] = [];
      for (let j = 0; j < seg; j++) {
        const ph = (j / seg) * Math.PI * 2;
        const d: V3 = [Math.sin(th) * Math.sin(ph), Math.cos(th), Math.sin(th) * Math.cos(ph)];
        const p = add(centre, shape(d));
        row.push(this.vertex(p, rig(p)));
      }
      rows.push(row);
    }
    const top = this.vertex(add(centre, shape([0, 1, 0])), rig(add(centre, shape([0, 1, 0]))));
    // φ runs from +z towards +x, i.e. clockwise seen from above; rows go upward.
    for (let j = 0; j < seg; j++) this.idx.push(bottom, rows[0]![(j + 1) % seg]!, rows[0]![j]!);
    for (let i = 0; i < rows.length - 1; i++) {
      for (let j = 0; j < seg; j++) {
        const a = rows[i]![j]!;
        const b = rows[i]![(j + 1) % seg]!;
        const c = rows[i + 1]![(j + 1) % seg]!;
        const d = rows[i + 1]![j]!;
        this.idx.push(a, b, c, a, c, d);
      }
    }
    const last = rows[rows.length - 1]!;
    for (let j = 0; j < seg; j++) this.idx.push(top, last[j]!, last[(j + 1) % seg]!);
  }

  /** A cap of hair over the cranium: rows from the crown down to a hairline that dips at the nape. */
  hairCap(centre: V3, rows: number, seg: number, shape: (d: V3, row: number) => V3, limit: (phi: number) => number, rig: (p: V3) => [number, number, number, number]): void {
    const crown = this.vertex(add(centre, shape([0, 1, 0], 0)), rig(add(centre, shape([0, 1, 0], 0))));
    const grid: number[][] = [];
    for (let r = 1; r <= rows; r++) {
      const row: number[] = [];
      for (let j = 0; j < seg; j++) {
        const ph = (j / seg) * Math.PI * 2;
        const th = limit(ph) * (r / rows);
        const d: V3 = [Math.sin(th) * Math.sin(ph), Math.cos(th), Math.sin(th) * Math.cos(ph)];
        const p = add(centre, shape(d, r / rows));
        row.push(this.vertex(p, rig(p)));
      }
      grid.push(row);
    }
    for (let j = 0; j < seg; j++) this.idx.push(crown, grid[0]![j]!, grid[0]![(j + 1) % seg]!);
    for (let r = 0; r < grid.length - 1; r++) {
      for (let j = 0; j < seg; j++) {
        const a = grid[r]![j]!;
        const b = grid[r]![(j + 1) % seg]!;
        const c = grid[r + 1]![(j + 1) % seg]!;
        const d = grid[r + 1]![j]!;
        this.idx.push(a, c, b, a, d, c);
      }
    }
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('rig', new BufferAttribute(new Float32Array(this.rig), 4));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

function add(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Cheap deterministic lumpiness (cloth bunching) from a position. */
function lump(p: V3, f: number): number {
  return Math.sin(p[0] * 37 * f + p[1] * 23 * f) * Math.sin(p[1] * 41 * f - p[2] * 29 * f + 1.7) * 0.5 + Math.sin(p[2] * 53 * f + p[1] * 17 * f + 0.4) * 0.5;
}

const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const Zf: V3 = [0, 0, 1];

export function figureGeometry(detail: 'low' | 'medium' | 'high' | 'ultra'): BufferGeometry {
  const b = new Builder();
  const hi = detail === 'high' || detail === 'ultra';
  const segT = hi ? 30 : 20;
  const segL = hi ? 16 : 11;
  const code = (limb: number, mat: number) => limb * 8 + mat;

  // ---- Torso: trousers from the crotch to the belt, a shirt or jacket above. Boxy chest,
  // shoulder slope, shoulder blades and buttocks as front/back asymmetry.
  const torso: Ring[] = [
    { c: [0, 0.8, -0.005], ru: 0.13, rv: 0.085, rvN: 0.095, e: 2.2 },
    { c: [0, 0.86, -0.01], ru: 0.165, rv: 0.1, rvN: 0.12, e: 2.4 },
    { c: [0, 0.94, -0.01], ru: 0.176, rv: 0.102, rvN: 0.118, e: 2.5 },
    { c: [0, 1.0, -0.008], ru: 0.168, rv: 0.1, rvN: 0.104, e: 2.5 },
    { c: [0, 1.07, -0.005], ru: 0.156, rv: 0.098, rvN: 0.096, e: 2.4 },
    { c: [0, 1.16, -0.005], ru: 0.164, rv: 0.108, rvN: 0.1, e: 2.5 },
    { c: [0, 1.26, -0.01], ru: 0.177, rv: 0.12, rvN: 0.106, e: 2.6 },
    { c: [0, 1.34, -0.015], ru: 0.188, rv: 0.115, rvN: 0.11, e: 2.7 },
    { c: [0, 1.4, -0.022], ru: 0.198, rv: 0.1, rvN: 0.104, e: 2.5 },
    { c: [0, 1.435, -0.026], ru: 0.182, rv: 0.084, rvN: 0.092, e: 2.3 },
    { c: [0, 1.462, -0.028], ru: 0.142, rv: 0.07, rvN: 0.08, e: 2.3 },
    { c: [0, 1.488, -0.028], ru: 0.092, rv: 0.058, rvN: 0.066, e: 2.1 },
    { c: [0, 1.508, -0.028], ru: 0.062, rv: 0.052, rvN: 0.056, e: 2 },
  ];
  b.loft(torso, segT, X, Zf, (p) => [code(LIMB.torso, p[1] < 0.985 ? MAT.trousers : MAT.top), smooth(1.0, 1.34, p[1]), 0, 0], {
    capStart: true,
    capEnd: true,
    jitter: (p) => lump(p, 1.2) * 0.005 * smooth(1.02, 1.12, p[1]) * (1 - smooth(1.38, 1.46, p[1])),
  });

  // ---- Neck.
  const neck: Ring[] = [
    { c: [0, 1.46, -0.03], ru: 0.06, rv: 0.058 },
    { c: [0, 1.52, -0.02], ru: 0.054, rv: 0.055 },
    { c: [0, 1.57, -0.008], ru: 0.051, rv: 0.054 },
    { c: [0, 1.6, 0.0], ru: 0.05, rv: 0.052 },
  ];
  b.loft(neck, segL, X, Zf, (p) => [code(LIMB.head, MAT.skin), smooth(1.5, 1.58, p[1]), 0, 0]);

  // ---- Collar: a turned-up jacket collar round the back and sides of the neck, open at the front.
  const collar: Ring[] = [
    { c: [0, 1.462, -0.03], ru: 0.088, rv: 0.072, rvN: 0.08 },
    { c: [0, 1.5, -0.03], ru: 0.074, rv: 0.066, rvN: 0.07 },
    { c: [0, 1.54, -0.032], ru: 0.07, rv: 0.064, rvN: 0.07 },
  ];
  b.loft(collar, segT, X, Zf, () => [code(LIMB.torso, MAT.top), 1, 0, 0], { skip: (_ring, a) => Math.abs(a - Math.PI / 2) < 0.75 });

  // ---- Head: a sculpted ovoid (cranium wider at the back, tapering jaw and chin), with brow, nose,
  // cheekbones, sunken eye sockets and ears as displacements.
  const headC: V3 = [0, 1.65, 0.012];
  const headShape = (d: V3): V3 => {
    const [dx, dy, dz] = d;
    const front = Math.max(0, dz);
    const back = Math.max(0, -dz);
    const jaw = smooth(-0.05, -0.85, dy);
    let rx = 0.075 * (1 - 0.3 * jaw) * (1 + 0.04 * back);
    const ry = dy > 0 ? 0.112 : 0.118;
    let rz = (dz > 0 ? 0.096 : 0.104) * (1 - 0.18 * jaw * back);
    rx *= 1 - 0.08 * smooth(0.2, 0.9, dy) * (1 - back);
    rz *= 1 + 0.06 * smooth(0.1, 0.6, dy) * back;
    let p: V3 = [dx * rx, dy * ry, dz * rz];
    // Chin forward, jaw line.
    p[2] += 0.014 * smooth(-0.45, -0.9, dy) * front;
    const g2 = (a: number, w: number) => Math.exp(-(a * a) / (w * w));
    const ax = Math.abs(dx);
    // Nose, brow ridge, eye sockets, cheekbones, gaunt cheeks, ears.
    const nose = 0.02 * g2(dx, 0.07) * g2(dy + 0.12, 0.13) * front;
    const brow = 0.011 * g2(dy - 0.12, 0.06) * g2(ax, 0.45) * front;
    const socket = -0.017 * g2(ax - 0.3, 0.13) * g2(dy - 0.035, 0.085) * front;
    const cheek = 0.007 * g2(ax - 0.55, 0.14) * g2(dy + 0.06, 0.09) * front - 0.011 * g2(ax - 0.6, 0.16) * g2(dy + 0.3, 0.12) * front;
    const mouth = 0.006 * g2(dx, 0.22) * g2(dy + 0.42, 0.06) * front - 0.004 * g2(dx, 0.25) * g2(dy + 0.47, 0.025) * front;
    const ear = 0.016 * g2(ax - 0.98, 0.09) * g2(dy + 0.04, 0.22) * g2(dz + 0.05, 0.2);
    const k = nose + brow + socket + cheek + mouth + ear;
    p = [p[0] + dx * k, p[1] + dy * k, p[2] + dz * k];
    return p;
  };
  b.sphere(headC, hi ? 20 : 14, hi ? 30 : 20, headShape, (p) => [code(LIMB.head, MAT.skin), p[1] > 1.55 ? 1 : smooth(1.5, 1.58, p[1]), 0, 0]);

  // ---- Hair: an uneven cap over the cranium, hairline high at the brow, low at the nape.
  b.hairCap(
    headC,
    hi ? 9 : 6,
    hi ? 30 : 20,
    (d, r) => {
      const base = headShape(d);
      const len = Math.hypot(base[0], base[1], base[2]) || 1;
      // Thick over the crown, thinning to nothing at the hairline (more at the nape), unevenly.
      const back = Math.max(0, -d[2]);
      const edge = 1 - Math.pow(r, 2.2) * (1 - 0.55 * back);
      const off = (0.006 + 0.012 * (0.5 + 0.5 * Math.sin(d[0] * 23 + d[2] * 17 + d[1] * 11)) * (0.6 + 0.4 * back)) * edge + 0.0015;
      return [base[0] + (base[0] / len) * off, base[1] + (base[1] / len) * off - 0.01 * r * r * back, base[2] + (base[2] / len) * off];
    },
    (ph) => 1.42 - 0.68 * Math.cos(ph) + 0.06 * Math.sin(ph * 5),
    () => [code(LIMB.head, MAT.hair), 1, 0, 0],
  );

  // ---- Hood: a loose fabric shell over the head, framing the face, hanging at the back of the
  // neck. The shader hides it (collapses it into the head) on figures without one.
  b.hairCap(
    headC,
    hi ? 10 : 7,
    hi ? 30 : 20,
    (d, r) => {
      const base = headShape(d);
      const len = Math.hypot(base[0], base[1], base[2]) || 1;
      const back = Math.max(0, -d[2]);
      const off = 0.028 + 0.012 * Math.sin(d[0] * 13 + d[1] * 7) + 0.05 * r * r * back + 0.012 * r;
      return [base[0] + (base[0] / len) * off, base[1] + (base[1] / len) * off - 0.03 * r * r * back, base[2] + (base[2] / len) * off - 0.01 * r * back];
    },
    (ph) => 1.95 - 1.05 * Math.cos(ph),
    () => [code(LIMB.head, MAT.hood), 1, 0, 0],
  );

  // ---- Arms: deltoid, upper arm, elbow, forearm in a sleeve with a loose cuff, wrist, then a
  // relaxed hand (palm towards the thigh, fingers slightly curled).
  for (const side of [1, -1]) {
    const sx = (x: number) => x * side;
    const arm: Ring[] = [
      { c: [sx(0.19), 1.436, -0.03], ru: 0.02, rv: 0.022 },
      { c: [sx(0.198), 1.418, -0.031], ru: 0.044, rv: 0.05 },
      { c: [sx(0.205), 1.38, -0.033], ru: 0.055, rv: 0.058 },
      { c: [sx(0.209), 1.33, -0.036], ru: 0.051, rv: 0.054 },
      { c: [sx(0.211), 1.23, -0.04], ru: 0.047, rv: 0.05 },
      { c: [sx(0.212), 1.135, -0.045], ru: 0.045, rv: 0.047 },
      { c: [sx(0.215), 1.05, -0.04], ru: 0.046, rv: 0.045 },
      { c: [sx(0.219), 0.96, -0.032], ru: 0.042, rv: 0.04 },
      { c: [sx(0.222), 0.895, -0.027], ru: 0.046, rv: 0.044 },
      { c: [sx(0.223), 0.885, -0.026], ru: 0.03, rv: 0.026 },
      { c: [sx(0.224), 0.86, -0.025], ru: 0.023, rv: 0.02 },
      { c: [sx(0.223), 0.836, -0.02], ru: 0.018, rv: 0.035 },
      { c: [sx(0.221), 0.8, -0.015], ru: 0.016, rv: 0.037 },
      { c: [sx(0.216), 0.768, -0.009], ru: 0.013, rv: 0.031 },
      { c: [sx(0.21), 0.744, -0.003], ru: 0.011, rv: 0.025 },
      { c: [sx(0.206), 0.728, 0.0], ru: 0.007, rv: 0.014 },
    ];
    b.loft(
      arm,
      segL,
      X,
      Zf,
      (p, ring) => [
        code(side > 0 ? LIMB.armL : LIMB.armR, ring >= 9 ? MAT.skin : MAT.top),
        1 - smooth(1.38, 1.47, p[1]),
        1 - smooth(1.09, 1.17, p[1]),
        1 - smooth(0.845, 0.88, p[1]),
      ],
      { capStart: true, capEnd: true, jitter: (p, ring) => (ring >= 3 && ring <= 8 ? lump(p, 1.6) * 0.005 : 0) },
    );
    // Thumb, resting along the front of the hand.
    const thumb: Ring[] = [
      { c: [sx(0.225), 0.85, 0.008], ru: 0.011, rv: 0.012 },
      { c: [sx(0.223), 0.825, 0.024], ru: 0.01, rv: 0.01 },
      { c: [sx(0.219), 0.8, 0.032], ru: 0.008, rv: 0.008 },
      { c: [sx(0.216), 0.787, 0.034], ru: 0.005, rv: 0.005 },
    ];
    b.loft(thumb, 8, X, Zf, () => [code(side > 0 ? LIMB.armL : LIMB.armR, MAT.skin), 1, 1, 1], { capEnd: true });
  }

  // ---- Legs: trousers (baggy at the knee and shin, a frayed hem), then the shoe.
  for (const side of [1, -1]) {
    const sx = (x: number) => x * side;
    const leg: Ring[] = [
      { c: [sx(0.088), 0.99, -0.005], ru: 0.088, rv: 0.092 },
      { c: [sx(0.094), 0.86, -0.004], ru: 0.083, ruN: 0.078, rv: 0.088, rvN: 0.09 },
      { c: [sx(0.099), 0.72, 0.0], ru: 0.07, ruN: 0.066, rv: 0.074 },
      { c: [sx(0.1), 0.58, 0.008], ru: 0.06, rv: 0.062 },
      { c: [sx(0.1), 0.5, 0.012], ru: 0.057, rv: 0.06, rvN: 0.058 },
      { c: [sx(0.102), 0.41, 0.0], ru: 0.055, rv: 0.055, rvN: 0.066 },
      { c: [sx(0.103), 0.3, -0.008], ru: 0.051, rv: 0.052, rvN: 0.06 },
      { c: [sx(0.104), 0.19, -0.014], ru: 0.049, rv: 0.052, rvN: 0.054 },
      { c: [sx(0.104), 0.125, -0.016], ru: 0.052, rv: 0.058, rvN: 0.054 },
      { c: [sx(0.104), 0.115, -0.018], ru: 0.04, rv: 0.044 },
    ];
    const limb = side > 0 ? LIMB.legL : LIMB.legR;
    b.loft(leg, segL + 2, X, Zf, (p) => [code(limb, MAT.trousers), 1 - smooth(0.88, 1.0, p[1]), 1 - smooth(0.45, 0.55, p[1]), 1 - smooth(0.07, 0.13, p[1])], {
      jitter: (p, ring) => (ring >= 3 && ring <= 8 ? lump(p, 1.4) * 0.005 : 0),
    });
    // Shoe: heel to toe along +z, flat sole on the ground.
    const shoe: Ring[] = [
      { c: [sx(0.104), 0.05, -0.075], ru: 0.03, rv: 0.035, rvN: 0.045 },
      { c: [sx(0.104), 0.055, -0.05], ru: 0.042, rv: 0.06, rvN: 0.052 },
      { c: [sx(0.106), 0.05, 0.0], ru: 0.046, rv: 0.06, rvN: 0.048 },
      { c: [sx(0.108), 0.04, 0.06], ru: 0.048, rv: 0.04, rvN: 0.038 },
      { c: [sx(0.108), 0.032, 0.12], ru: 0.045, rv: 0.03, rvN: 0.03 },
      { c: [sx(0.106), 0.027, 0.16], ru: 0.036, rv: 0.024, rvN: 0.025 },
      { c: [sx(0.104), 0.024, 0.18], ru: 0.02, rv: 0.016, rvN: 0.018 },
    ];
    b.loft(shoe, segL, X, Y, () => [code(limb, MAT.shoes), 1, 1, 1], { capStart: true, capEnd: true });
  }

  // ---- Coat skirt: from the waist down past the knee, flared, open at the front. Its length is
  // set per figure in the shader (zero collapses it for figures without a coat).
  const skirt: Ring[] = [];
  const steps = hi ? 9 : 6;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = 1.02 - t * 0.5;
    skirt.push({ c: [0, y, -0.012 - 0.02 * t], ru: 0.17 + 0.05 * t, rv: 0.106 + 0.045 * t, rvN: 0.112 + 0.05 * t, e: 2.3 - 0.2 * t });
  }
  b.loft(skirt, segT + 4, X, Zf, (p) => [code(LIMB.skirt, MAT.coat), 0.85 * smooth(0.98, 0.6, p[1]), 0, 0], {
    // The opening widens downwards; φ = π/2 is the front.
    skip: (ring, a) => Math.abs(a - Math.PI / 2) < 0.04 + 0.32 * smooth(0, steps, ring + 0.5),
    jitter: (p, ring) => (ring > 0 ? lump(p, 1.1) * 0.012 * (ring / steps) : 0),
  });

  return b.geometry();
}
