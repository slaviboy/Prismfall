import { BufferAttribute, BufferGeometry, DataTexture, FloatType, Matrix4, NearestFilter, Quaternion, RGBAFormat, Vector3, type Mesh, type Object3D } from 'three/webgpu';
import { Fn, attribute, dot, int, ivec2, normalGeometry, normalize, positionGeometry, textureLoad, varyingProperty, vec3, vec4, instanceIndex } from 'three/tsl';
import type { V3, V4 } from './shared';

/**
 * Rigs for the Red Horizon machines.
 *
 * The Blender kit binds every vertex to one bone (`_BONE`) and writes `<name>.rig.json`: bones with
 * their parent and pivot, and hydraulic pistons (an anchor on each of two bones). The humanoid robot
 * (scripts/build-red-horizon-robot.ts) instead blends up to four bones per vertex, with the same
 * rig file. Here the CPU solves each instance's pose (gait, IK, sensors) into bone matrices, aims
 * every piston's barrel and rod at each other, and uploads all matrices as one float texture; the
 * vertex shader skins the instanced mesh from it. One draw call per machine type and level of detail.
 */

export interface RigBone {
  name: string;
  id: number;
  parent: number;
  pivot: [number, number, number];
}
export interface RigPiston {
  name: string;
  boneA: number;
  a: [number, number, number];
  boneB: number;
  b: [number, number, number];
  barrel: number;
  rod: number;
}
export interface RigFile {
  name: string;
  bones: RigBone[];
  pistons: RigPiston[];
  /** Blended-skin robots: standing height (m), eye lenses (rest position, radius) and finger curl axes by side. */
  height?: number;
  eyes?: { side: string; at: [number, number, number]; radius: number }[];
  curl?: Record<string, [number, number, number]>;
}

export function parseRig(json: unknown): RigFile | null {
  const r = json as RigFile | null;
  if (!r || !Array.isArray(r.bones) || !Array.isArray(r.pistons)) return null;
  return r;
}

/** Material slots in merged machine geometry (the Blender material names). */
export const MAT_IDS: Record<string, number> = {
  rhArmour: 0,
  rhFrame: 1,
  rhJoint: 2,
  rhPiston: 3,
  rhCable: 4,
  rhGlass: 5,
  rhLens: 6,
  rhLamp: 7,
  rhSearch: 8,
  rhRotor: 9,
  rhSteel: 10,
  rhHot: 11,
  rhWarning: 12,
  rhRust: 13,
  rhPaint: 14,
};

/** Bone slot in the matrix texture: skeleton bones first, then each piston's barrel and rod. */
export function slotOf(rig: RigFile, id: number): number {
  if (id < 100) return id;
  return rig.bones.length + (id - 100);
}

export function slotCount(rig: RigFile): number {
  return rig.bones.length + rig.pistons.length * 2;
}

/**
 * Merges every mesh primitive of a machine GLB into one geometry: position, normal and
 * `rig` = (bone slot, material id). Positions are taken through each node's world matrix, which
 * undoes gltf-transform's quantisation.
 */
export function mergeRigged(root: Object3D, rig: RigFile): BufferGeometry {
  root.updateMatrixWorld(true);
  const pos: number[] = [];
  const nrm: number[] = [];
  const tag: number[] = [];
  const idx: number[] = [];
  const v = new Vector3();
  const nm = new Matrix4();
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const bone = g.getAttribute('_bone') ?? g.getAttribute('_BONE');
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const matId = MAT_IDS[material?.name ?? ''] ?? 1;
    const base = pos.length / 3;
    nm.copy(mesh.matrixWorld).invert().transpose();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
      pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(n, i).applyMatrix4(nm).normalize();
      nrm.push(v.x, v.y, v.z);
      const b = bone ? Math.round(bone.getX(i)) : 0;
      tag.push(slotOf(rig, b), matId);
    }
    const index = g.getIndex();
    if (index) for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) idx.push(base + i);
  });
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  out.setAttribute('rig', new BufferAttribute(new Float32Array(tag), 2));
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}

/** Material ids of a blended-skin machine's primitives (scripts/build-red-horizon-robot.ts MATERIALS). */
export const ROBOT_MATS: Record<string, number> = { robotBody: 0, robotHead: 1, robotEye: 2 };

/**
 * Merges a blended-skin machine GLB (scripts/build-red-horizon-robot.ts: up to four rig bones per
 * vertex in JOINTS_0 / WEIGHTS_0, no glTF skin) into one geometry: position, normal, tangent,
 * `robotUV` = (u, v, material id), `robotJ` (four bone slots) and `robotW` (their weights). Six
 * vertex buffers, so an instanced material can add one more and stay within eight.
 */
export function mergeSkinned(root: Object3D): BufferGeometry {
  root.updateMatrixWorld(true);
  const pos: number[] = [];
  const nrm: number[] = [];
  const tan: number[] = [];
  const uvm: number[] = [];
  const jnt: number[] = [];
  const wgt: number[] = [];
  const idx: number[] = [];
  const v = new Vector3();
  const nm = new Matrix4();
  const rot = new Matrix4();
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const t = g.getAttribute('tangent');
    const uv = g.getAttribute('uv');
    const j = g.getAttribute('skinIndex');
    const w = g.getAttribute('skinWeight');
    if (!p || !n || !t || !uv || !j || !w) throw new Error('[red-horizon] skinned machine mesh lacks normals, tangents, UVs or weights');
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const matId = ROBOT_MATS[material?.name ?? ''] ?? 0;
    const base = pos.length / 3;
    nm.copy(mesh.matrixWorld).invert().transpose();
    rot.extractRotation(mesh.matrixWorld);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
      pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(n, i).applyMatrix4(nm).normalize();
      nrm.push(v.x, v.y, v.z);
      v.set(t.getX(i), t.getY(i), t.getZ(i)).applyMatrix4(rot).normalize();
      tan.push(v.x, v.y, v.z, t.getW(i) < 0 ? -1 : 1);
      uvm.push(uv.getX(i), uv.getY(i), matId);
      // Weights arrive quantised: renormalise so the blend never shrinks the part.
      const ws = [w.getX(i), w.getY(i), w.getZ(i), w.getW(i)];
      const sum = ws[0]! + ws[1]! + ws[2]! + ws[3]! || 1;
      jnt.push(j.getX(i), j.getY(i), j.getZ(i), j.getW(i));
      wgt.push(ws[0]! / sum, ws[1]! / sum, ws[2]! / sum, ws[3]! / sum);
    }
    const index = g.getIndex();
    if (index) for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) idx.push(base + i);
  });
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  out.setAttribute('tangent', new BufferAttribute(new Float32Array(tan), 4));
  out.setAttribute('robotUV', new BufferAttribute(new Float32Array(uvm), 3));
  out.setAttribute('robotJ', new BufferAttribute(new Float32Array(jnt), 4));
  out.setAttribute('robotW', new BufferAttribute(new Float32Array(wgt), 4));
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}

/** Instances × bone slots of 3×4 matrices in a float texture (3 texels per bone). */
export class BoneTexture {
  readonly texture: DataTexture;
  readonly data: Float32Array;
  readonly slots: number;
  readonly count: number;

  constructor(count: number, slots: number) {
    this.count = Math.max(1, count);
    this.slots = slots;
    this.data = new Float32Array(this.count * slots * 12);
    this.texture = new DataTexture(this.data, slots * 3, this.count, RGBAFormat, FloatType);
    this.texture.magFilter = NearestFilter;
    this.texture.minFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  set(instance: number, slot: number, m: Matrix4): void {
    const e = m.elements;
    const o = (instance * this.slots + slot) * 12;
    const d = this.data;
    d[o] = e[0]!;
    d[o + 1] = e[4]!;
    d[o + 2] = e[8]!;
    d[o + 3] = e[12]!;
    d[o + 4] = e[1]!;
    d[o + 5] = e[5]!;
    d[o + 6] = e[9]!;
    d[o + 7] = e[13]!;
    d[o + 8] = e[2]!;
    d[o + 9] = e[6]!;
    d[o + 10] = e[10]!;
    d[o + 11] = e[14]!;
  }

  /** Collapses one instance (hidden). */
  hide(instance: number): void {
    this.data.fill(0, instance * this.slots * 12, (instance + 1) * this.slots * 12);
  }

  upload(): void {
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/**
 * The skinned world position, plus world normal and the rest position (for textures that stick to
 * the parts) as varyings. The mesh itself stays at the origin; instances come from instanceIndex.
 */
export function skinNode(bones: BoneTexture, prefix: string): { position: V3; normal: V3; rest: V3; tag: ReturnType<typeof attribute> } {
  const tag = attribute('rig', 'vec2');
  const vWorld = varyingProperty('vec3', `v${prefix}World`);
  const vNormal = varyingProperty('vec3', `v${prefix}Normal`);
  const vRest = varyingProperty('vec3', `v${prefix}Rest`);
  const position = Fn(() => {
    const slot = int(tag.x.add(0.5));
    const row = int(instanceIndex);
    const x = slot.mul(3);
    const r0 = textureLoad(bones.texture, ivec2(x, row)) as unknown as V4;
    const r1 = textureLoad(bones.texture, ivec2(x.add(1), row)) as unknown as V4;
    const r2 = textureLoad(bones.texture, ivec2(x.add(2), row)) as unknown as V4;
    const p = vec4(positionGeometry, 1);
    const wp = vec3(dot(r0, p), dot(r1, p), dot(r2, p));
    const n = normalGeometry;
    const wn = normalize(vec3(dot(r0.xyz, n), dot(r1.xyz, n), dot(r2.xyz, n)).add(vec3(0, 1e-5, 0)));
    vWorld.assign(wp);
    vNormal.assign(wn);
    vRest.assign(positionGeometry);
    return wp;
  })() as unknown as V3;
  return { position, normal: normalize(vNormal) as unknown as V3, rest: vRest as unknown as V3, tag };
}

/**
 * Linear-blend skinning from the same bone texture (mergeSkinned geometry): four bones per vertex.
 * Returns the skinned world position, world normal and tangent (xyz, handedness) as varyings, the
 * rest position, and the `robotUV` attribute (u, v, material id).
 */
export function blendSkinNode(bones: BoneTexture, prefix: string): { position: V3; normal: V3; tangent: V4; rest: V3; uvm: V3 } {
  const j = attribute('robotJ', 'vec4') as unknown as V4;
  const wt = attribute('robotW', 'vec4') as unknown as V4;
  const tangent = attribute('tangent', 'vec4') as unknown as V4;
  const vNormal = varyingProperty('vec3', `v${prefix}Normal`);
  const vTangent = varyingProperty('vec4', `v${prefix}Tangent`);
  const vRest = varyingProperty('vec3', `v${prefix}Rest`);
  const position = Fn(() => {
    const row = int(instanceIndex);
    const rows = (slot: V4['x']): V4[] => {
      const x = int(slot.add(0.5)).mul(3);
      return [0, 1, 2].map((k) => textureLoad(bones.texture, ivec2(x.add(k), row)) as unknown as V4);
    };
    const a = rows(j.x);
    const b = rows(j.y);
    const c = rows(j.z);
    const d = rows(j.w);
    const blend = (k: number) => a[k]!.mul(wt.x).add(b[k]!.mul(wt.y)).add(c[k]!.mul(wt.z)).add(d[k]!.mul(wt.w)) as unknown as V4;
    const r0 = blend(0);
    const r1 = blend(1);
    const r2 = blend(2);
    const p = vec4(positionGeometry, 1);
    const wp = vec3(dot(r0, p), dot(r1, p), dot(r2, p));
    const n = normalGeometry;
    const wn = normalize(vec3(dot(r0.xyz, n), dot(r1.xyz, n), dot(r2.xyz, n)).add(vec3(0, 1e-5, 0)));
    const t = tangent.xyz;
    const wtan = vec3(dot(r0.xyz, t), dot(r1.xyz, t), dot(r2.xyz, t)).add(vec3(1e-5, 0, 0));
    vNormal.assign(wn);
    vTangent.assign(vec4(wtan, tangent.w));
    vRest.assign(positionGeometry);
    return wp;
  })() as unknown as V3;
  return {
    position,
    normal: normalize(vNormal) as unknown as V3,
    tangent: vTangent as unknown as V4,
    rest: vRest as unknown as V3,
    uvm: attribute('robotUV', 'vec3') as unknown as V3,
  };
}

/** Per-bone local motion: rotation (Euler XYZ, radians) about the bone's pivot and an offset. */
export interface BonePose {
  rx: number;
  ry: number;
  rz: number;
  tx: number;
  ty: number;
  tz: number;
  scale: number;
}

const tmpQ = new Quaternion();
const tmpQ2 = new Quaternion();
const tmpV = new Vector3();
const tmpA = new Vector3();
const tmpB = new Vector3();
const tmpD0 = new Vector3();
const tmpD1 = new Vector3();
const tmpS = new Vector3();
const tmpM = new Matrix4();
const tmpM2 = new Matrix4();
const ZERO = new Matrix4().makeScale(0, 0, 0);

function eulerQuat(q: Quaternion, x: number, y: number, z: number): Quaternion {
  // XYZ order (pitch about the pivot, then yaw, then roll), matching three's default Euler.
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return q.set(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3);
}

/**
 * Solves one instance: world matrices from the root transform and the bones' local poses, then the
 * skin matrices (world × inverse rest) and the pistons. `root` places the model (position, heading,
 * scale); poses are indexed by bone id.
 */
export class RigSolver {
  readonly rig: RigFile;
  readonly poses: BonePose[];
  private readonly world: Matrix4[];
  private readonly skin: Matrix4[];
  private readonly pivots: Vector3[];
  /** Bones to collapse (hidden variants), by id. */
  readonly hidden = new Set<number>();

  constructor(rig: RigFile) {
    this.rig = rig;
    this.poses = rig.bones.map(() => ({ rx: 0, ry: 0, rz: 0, tx: 0, ty: 0, tz: 0, scale: 1 }));
    this.world = rig.bones.map(() => new Matrix4());
    this.skin = rig.bones.map(() => new Matrix4());
    this.pivots = rig.bones.map((b) => new Vector3(...b.pivot));
  }

  reset(): void {
    for (const p of this.poses) {
      p.rx = p.ry = p.rz = p.tx = p.ty = p.tz = 0;
      p.scale = 1;
    }
  }

  pose(id: number): BonePose {
    return this.poses[id]!;
  }

  boneId(name: string): number {
    const b = this.rig.bones.find((x) => x.name === name);
    if (!b) throw new Error(`[red-horizon] rig ${this.rig.name} has no bone ${name}`);
    return b.id;
  }

  pivot(id: number): Vector3 {
    return this.pivots[id]!;
  }

  /** World position of a rest-space point carried by a bone (after solve()). */
  pointOn(id: number, rest: Vector3, out: Vector3): Vector3 {
    return out.copy(rest).applyMatrix4(this.skin[id]!);
  }

  /** World matrix of a bone (after solve()). */
  worldOf(id: number): Matrix4 {
    return this.world[id]!;
  }

  solve(root: Matrix4, out: BoneTexture, instance: number): void {
    const bones = this.rig.bones;
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i]!;
      const p = this.poses[i]!;
      const pv = this.pivots[i]!;
      const w = this.world[i]!;
      if (b.parent < 0) {
        w.copy(root).multiply(tmpM.makeTranslation(pv.x + p.tx, pv.y + p.ty, pv.z + p.tz));
      } else {
        const pp = this.pivots[b.parent]!;
        w.copy(this.world[b.parent]!).multiply(tmpM.makeTranslation(pv.x - pp.x + p.tx, pv.y - pp.y + p.ty, pv.z - pp.z + p.tz));
      }
      w.multiply(tmpM.makeRotationFromQuaternion(eulerQuat(tmpQ, p.rx, p.ry, p.rz)));
      if (p.scale !== 1) w.multiply(tmpM.makeScale(p.scale, p.scale, p.scale));
      this.skin[i]!.copy(w).multiply(tmpM.makeTranslation(-pv.x, -pv.y, -pv.z));
    }
    for (let i = 0; i < bones.length; i++) out.set(instance, i, this.hidden.has(i) ? ZERO : this.skin[i]!);
    // Pistons: the barrel keeps bone A's roll and turns to aim at the rod's anchor; the rod aims back.
    const base = bones.length;
    this.rig.pistons.forEach((pst, k) => {
      const sa = this.skin[pst.boneA]!;
      const sb = this.skin[pst.boneB]!;
      tmpA.set(...pst.a).applyMatrix4(sa);
      tmpB.set(...pst.b).applyMatrix4(sb);
      sa.decompose(tmpV, tmpQ2, tmpS);
      tmpD0.set(pst.b[0] - pst.a[0], pst.b[1] - pst.a[1], pst.b[2] - pst.a[2]).normalize().applyQuaternion(tmpQ2);
      tmpD1.copy(tmpB).sub(tmpA).normalize();
      tmpQ.setFromUnitVectors(tmpD0, tmpD1).multiply(tmpQ2);
      const hide = this.hidden.has(pst.boneA) || this.hidden.has(pst.boneB);
      tmpM.compose(tmpA, tmpQ, tmpS).multiply(tmpM2.makeTranslation(-pst.a[0], -pst.a[1], -pst.a[2]));
      out.set(instance, base + k * 2, hide ? ZERO : tmpM);
      tmpM.compose(tmpB, tmpQ, tmpS).multiply(tmpM2.makeTranslation(-pst.b[0], -pst.b[1], -pst.b[2]));
      out.set(instance, base + k * 2 + 1, hide ? ZERO : tmpM);
    });
  }
}

/** Two-bone planar IK: lengths l1, l2 and a target at distance d; returns interior angles. */
export function twoBone(l1: number, l2: number, d: number): { a1: number; a2: number } {
  const dd = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, d));
  const a1 = Math.acos(Math.min(1, Math.max(-1, (l1 * l1 + dd * dd - l2 * l2) / (2 * l1 * dd))));
  const a2 = Math.acos(Math.min(1, Math.max(-1, (l2 * l2 + dd * dd - l1 * l1) / (2 * l2 * dd))));
  return { a1, a2 };
}

export const smootherstep = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

export function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

