import { BufferAttribute, BufferGeometry, Matrix3, Matrix4, Mesh, Vector3, type Object3D } from 'three/webgpu';

/** Creature geometry in rig space: float positions/normals plus the two joint attributes. */
export interface CreatureGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly ja: Float32Array;
  readonly jb: Float32Array;
  readonly index: Uint32Array | null;
}

/**
 * Bakes the first mesh of a creature GLB into rig space. Quantised exports keep positions as
 * normalised integers with a dequantising node transform, so the world matrix is applied here.
 */
export function bakeCreatureGeometry(root: Object3D): CreatureGeometry {
  let mesh: Mesh | null = null;
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    if (!mesh && o instanceof Mesh) mesh = o;
  });
  if (!mesh) throw new Error('creature GLB has no mesh');
  const m = mesh as Mesh;
  const g = m.geometry;
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  // GLTFLoader lowercases custom attribute names.
  const ja = g.getAttribute('_ja') ?? g.getAttribute('_JA');
  const jb = g.getAttribute('_jb') ?? g.getAttribute('_JB');
  const count = pos.count;
  const world = new Matrix4().copy(m.matrixWorld);
  const normalMatrix = new Matrix3().getNormalMatrix(world);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const jaOut = new Float32Array(count).fill(-1);
  const jbOut = new Float32Array(count).fill(-1);
  const v = new Vector3();
  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(world);
    positions.set([v.x, v.y, v.z], i * 3);
    if (nor) {
      v.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
      normals.set([v.x, v.y, v.z], i * 3);
    }
    if (ja) jaOut[i] = Math.round(ja.getX(i));
    if (jb) jbOut[i] = Math.round(jb.getX(i));
  }
  const idx = g.getIndex();
  return { positions, normals, ja: jaOut, jb: jbOut, index: idx ? Uint32Array.from(idx.array as ArrayLike<number>) : null };
}

/** Three.js geometry for the solid creature body (rig space). */
export function creatureBufferGeometry(c: CreatureGeometry): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(c.positions, 3));
  g.setAttribute('normal', new BufferAttribute(c.normals, 3));
  g.setAttribute('ja', new BufferAttribute(c.ja, 1));
  g.setAttribute('jb', new BufferAttribute(c.jb, 1));
  if (c.index) g.setIndex(new BufferAttribute(c.index, 1));
  g.computeBoundingSphere();
  return g;
}

export interface SurfaceSamples {
  /** xyz = rest position, w = primary joint. */
  readonly a: Float32Array;
  /** x = parent joint, yzw = outward normal (for scatter and rim light). */
  readonly b: Float32Array;
  readonly count: number;
}

/**
 * Area-weighted random points on the creature surface (so particles spread evenly over the body,
 * not clustered where the mesh is dense). Each point inherits the joints of its nearest corner, so
 * particles move exactly with the animated limbs.
 */
export function sampleSurface(c: CreatureGeometry, count: number, rand: () => number): SurfaceSamples {
  const tri = c.index ?? Uint32Array.from({ length: c.positions.length / 3 }, (_, i) => i);
  const triCount = Math.floor(tri.length / 3);
  const cdf = new Float32Array(triCount);
  const p = c.positions;
  let total = 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = tri[t * 3]! * 3;
    const i1 = tri[t * 3 + 1]! * 3;
    const i2 = tri[t * 3 + 2]! * 3;
    const ux = p[i1]! - p[i0]!;
    const uy = p[i1 + 1]! - p[i0 + 1]!;
    const uz = p[i1 + 2]! - p[i0 + 2]!;
    const vx = p[i2]! - p[i0]!;
    const vy = p[i2 + 1]! - p[i0 + 1]!;
    const vz = p[i2 + 2]! - p[i0 + 2]!;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    total += 0.5 * Math.hypot(cx, cy, cz);
    cdf[t] = total;
  }
  const a = new Float32Array(count * 4);
  const b = new Float32Array(count * 4);
  for (let s = 0; s < count; s++) {
    const target = rand() * total;
    let lo = 0;
    let hi = triCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    let r1 = rand();
    let r2 = rand();
    if (r1 + r2 > 1) {
      r1 = 1 - r1;
      r2 = 1 - r2;
    }
    const r0 = 1 - r1 - r2;
    const v0 = tri[lo * 3]!;
    const v1 = tri[lo * 3 + 1]!;
    const v2 = tri[lo * 3 + 2]!;
    for (let k = 0; k < 3; k++) {
      a[s * 4 + k] = p[v0 * 3 + k]! * r0 + p[v1 * 3 + k]! * r1 + p[v2 * 3 + k]! * r2;
      b[s * 4 + 1 + k] = c.normals[v0 * 3 + k]! * r0 + c.normals[v1 * 3 + k]! * r1 + c.normals[v2 * 3 + k]! * r2;
    }
    const nearest = r0 >= r1 && r0 >= r2 ? v0 : r1 >= r2 ? v1 : v2;
    a[s * 4 + 3] = c.ja[nearest]!;
    b[s * 4] = c.jb[nearest]!;
  }
  return { a, b, count };
}
