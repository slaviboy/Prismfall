/**
 * Builds Red Horizon's humanoid machine from a rigged robot model: a Sketchfab glTF imported with
 *
 *   node scripts/fetch-sketchfab.ts <uid> robot-sfm --zip <downloaded zip> --source-only
 *   node scripts/build-red-horizon-robot.ts [--source <scene.gltf>]
 *
 * 1. Reads the skinned meshes, the skeleton and its bind pose.
 * 2. Converts to game space (Y up, facing -Z, metres, feet on y = 0) at HEIGHT metres tall.
 * 3. Bakes a relaxed rest pose with the source weights: arms hanging at the sides, so the gait
 *    solver's arm swing and elbow angles start from straight down.
 * 4. Folds the source skeleton onto the machine rig (RIG / JOINT_MAP; every helper or roll joint
 *    goes with its nearest mapped ancestor), keeping up to four blended weights per vertex, and
 *    writes models/robot.rig.json: bones with parents and pivots, eye lenses, finger curl axes.
 * 5. Simplifies with meshoptimizer into models/robot.glb (near) and robot_lod.glb (far), one
 *    primitive per material (robotBody, robotHead, robotEye), meshopt-compressed; the textures go
 *    to textures/robot_*.webp.
 *
 * To use a different robot: import it the same way, pass --source, and adapt JOINT_MAP, RIG pivots,
 * MATERIALS and TEXTURES to its skeleton and files.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Document, NodeIO, type Node as GltfNode, type TypedArray } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { quantize, reorder } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { Matrix4, Quaternion, Vector3 } from 'three';

const ROOT = resolve(import.meta.dirname, '..');
const opt = (flag: string, def: string): string => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
};
const SOURCE = resolve(ROOT, opt('--source', 'assets/external/sketchfab/robot-sfm/gltf/scene.gltf'));
/** Also write uncompressed copies of the levels of detail here (for a look in Blender). */
const PREVIEW = opt('--preview', '');
const STAGE = join(ROOT, 'content/stages/red-horizon');
/** Standing height in metres (top of the head); stage instances scale from here. */
const HEIGHT = 2.2;
/** Rest pose of the arms: upper arm and forearm directions (game space, +X side; mirrored for -X). */
const UPPER_DIR = new Vector3(0.1, -1, 0.02).normalize();
const FORE_DIR = new Vector3(0.05, -1, -0.12).normalize();
const LODS = [
  // Attribute-aware edge collapse; 'Permissive' lets it collapse across UV seams (the source has
  // nearly one seam vertex per triangle), which costs nothing visible at these sizes on screen.
  // Never 'Prune': the endoskeleton is hundreds of separate rods and plates, and pruning small
  // parts takes the arms and spine with them.
  { file: 'robot.glb', triangles: Number(opt('--near-triangles', '26000')), error: Number(opt('--near-error', '0.006')), eyeTriangles: Infinity },
  { file: 'robot_lod.glb', triangles: Number(opt('--far-triangles', '6000')), error: Number(opt('--far-error', '0.05')), eyeTriangles: 96 },
];
/** Source material name → output material (and id in the shader: index in this list). */
const MATERIALS = [
  { match: /body/i, name: 'robotBody' },
  { match: /head/i, name: 'robotHead' },
  { match: /eye/i, name: 'robotEye' },
];
const TEXTURES = [
  { from: 'textures/body_baseColor.png', to: 'robot_body_albedo.webp', size: 1024, quality: 86 },
  { from: 'textures/head_baseColor.png', to: 'robot_head_albedo.webp', size: 1024, quality: 86 },
  { from: 'textures/body_normal.png', to: 'robot_body_normal.webp', size: 1024, quality: 92 },
  { from: 'textures/head_normal.png', to: 'robot_head_normal.webp', size: 512, quality: 92 },
];

type Side = 'R' | 'L';
const SIDES: Side[] = ['R', 'L'];
/**
 * The machine rig, parents before children. R is the machine's own right (+X when it faces -Z).
 * `pivot`: source joints whose (averaged) bind positions place the bone's pivot.
 */
const RIG: { name: string; parent: string | null; pivot: RegExp[] }[] = [
  { name: 'pelvis', parent: null, pivot: [/^bip_pelvis/] },
  { name: 'spine', parent: 'pelvis', pivot: [/^bip_spine_0_/] },
  { name: 'torso', parent: 'spine', pivot: [/^bip_spine_2_/] },
  { name: 'neck', parent: 'torso', pivot: [/^bip_neck_/] },
  { name: 'head', parent: 'neck', pivot: [/^bip_head_/] },
  ...SIDES.flatMap((s) => [
    { name: `upper${s}`, parent: 'torso', pivot: [new RegExp(`^bip_upperArm_${s}_`)] },
    { name: `fore${s}`, parent: `upper${s}`, pivot: [new RegExp(`^bip_lowerArm_${s}_`)] },
    { name: `hand${s}`, parent: `fore${s}`, pivot: [new RegExp(`^bip_hand_${s}_`)] },
    { name: `fingers${s}`, parent: `hand${s}`, pivot: ['index', 'middle', 'ring', 'pinky'].map((f) => new RegExp(`^bip_${f}_0_${s}_`)) },
    { name: `tips${s}`, parent: `fingers${s}`, pivot: ['index', 'middle', 'ring', 'pinky'].map((f) => new RegExp(`^bip_${f}_1_${s}_`)) },
  ]),
  ...SIDES.flatMap((s) => [
    { name: `thigh${s}`, parent: 'pelvis', pivot: [new RegExp(`^bip_hip_${s}_`)] },
    { name: `shin${s}`, parent: `thigh${s}`, pivot: [new RegExp(`^bip_knee_${s}_`)] },
    { name: `foot${s}`, parent: `shin${s}`, pivot: [new RegExp(`^bip_foot_${s}_`)] },
    { name: `toe${s}`, parent: `foot${s}`, pivot: [new RegExp(`^bip_toe_${s}_`)] },
  ]),
];
/** Source joint name → rig bone. Unlisted joints (helpers, roll bones) follow their nearest mapped ancestor. */
const JOINT_MAP: [RegExp, string][] = [
  [/^bip_pelvis/, 'pelvis'],
  [/^bip_spine_[01]_/, 'spine'],
  [/^bip_spine_[23]_|^bip_collar_/, 'torso'],
  [/^Neck_|^bip_neck_/, 'neck'],
  [/^bip_head_/, 'head'],
  ...SIDES.flatMap((s): [RegExp, string][] => [
    [new RegExp(`^bip_upperArm_${s}_`), `upper${s}`],
    [new RegExp(`^bip_lowerArm_${s}_`), `fore${s}`],
    [new RegExp(`^bip_hand_${s}_|^bip_thumb_\\d_${s}_`), `hand${s}`],
    [new RegExp(`^bip_(index|middle|ring|pinky)_0_${s}_`), `fingers${s}`],
    [new RegExp(`^bip_(index|middle|ring|pinky)_[12]_${s}_`), `tips${s}`],
    [new RegExp(`^bip_hip_${s}_`), `thigh${s}`],
    [new RegExp(`^bip_knee_${s}_`), `shin${s}`],
    [new RegExp(`^bip_foot_${s}_`), `foot${s}`],
    [new RegExp(`^bip_toe_${s}_`), `toe${s}`],
  ]),
];

if (!existsSync(SOURCE)) {
  console.error(`no source model at ${SOURCE}\nimport it first: node scripts/fetch-sketchfab.ts <uid> robot-sfm --zip <zip> --source-only`);
  process.exit(1);
}
await Promise.all([MeshoptSimplifier.ready, MeshoptEncoder.ready]);

// ---- 1. Source meshes and skeleton.
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const src = await io.read(SOURCE);
const skinnedNodes = src.getRoot().listNodes().filter((n) => n.getMesh() && n.getSkin());
if (skinnedNodes.length === 0) throw new Error('the source has no skinned mesh');
const skin = skinnedNodes[0]!.getSkin()!;
if (skinnedNodes.some((n) => n.getSkin() !== skin)) throw new Error('the skinned meshes must share one skin');
const joints = skin.listJoints();
const ibmAccessor = skin.getInverseBindMatrices();
if (!ibmAccessor) throw new Error('the skin has no inverse bind matrices');
const ibm = joints.map((_, k) => new Matrix4().fromArray(ibmAccessor.getElement(k, new Array<number>(16))));
const worldOf = (n: GltfNode) => new Matrix4().fromArray(n.getWorldMatrix());

// Bind space (where the vertices live) from the node hierarchy, via the pelvis: zero-weight joints
// can carry placeholder inverse bind matrices, so joint positions come from the nodes. Check that the
// nodes' rest pose is the bind pose first.
const pelvisK = joints.findIndex((j) => /^bip_pelvis/.test(j.getName()));
if (pelvisK < 0) throw new Error('no pelvis joint');
const bindToWorld = worldOf(joints[pelvisK]!).multiply(ibm[pelvisK]!);
const worldToBind = bindToWorld.clone().invert();
let worst = 0;
joints.forEach((j, k) => {
  const det = ibm[k]!.determinant();
  if (Math.abs(det) < 1e-9) return;
  const fromIbm = new Vector3().setFromMatrixPosition(ibm[k]!.clone().invert());
  const fromNode = new Vector3().setFromMatrixPosition(worldOf(j)).applyMatrix4(worldToBind);
  if (fromIbm.lengthSq() > 1e-6) worst = Math.max(worst, fromIbm.distanceTo(fromNode));
});
console.log(`bind pose vs node rest pose: worst joint offset ${worst.toFixed(4)} source units`);
const jointBind = joints.map((j) => new Vector3().setFromMatrixPosition(worldOf(j)).applyMatrix4(worldToBind));

// Rig bone of every source joint.
const rigIndex = new Map(RIG.map((b, i) => [b.name, i]));
const boneOfJoint = joints.map((j) => {
  for (let n: GltfNode | null = j; n; n = n.getParentNode()) {
    const hit = JOINT_MAP.find(([re]) => re.test(n!.getName()));
    if (hit) return rigIndex.get(hit[1])!;
  }
  return 0;
});

// Vertices of every primitive, in bind space.
interface Verts {
  pos: number[];
  nrm: number[];
  tan: number[];
  uv: number[];
  jnt: number[];
  wgt: number[];
  mat: number[];
  idx: number[];
}
const V: Verts = { pos: [], nrm: [], tan: [], uv: [], jnt: [], wgt: [], mat: [], idx: [] };
const e4 = [0, 0, 0, 0];
for (const node of skinnedNodes) {
  for (const prim of node.getMesh()!.listPrimitives()) {
    const matName = prim.getMaterial()?.getName() ?? '';
    const mat = MATERIALS.findIndex((m) => m.match.test(matName));
    if (mat < 0) throw new Error(`no output material for source material "${matName}"`);
    const P = prim.getAttribute('POSITION')!;
    const N = prim.getAttribute('NORMAL');
    const T = prim.getAttribute('TANGENT');
    const UV = prim.getAttribute('TEXCOORD_0');
    const J = prim.getAttribute('JOINTS_0');
    const W = prim.getAttribute('WEIGHTS_0');
    if (!N || !T || !UV || !J || !W) throw new Error(`primitive of "${matName}" lacks normals, tangents, UVs or skin weights`);
    const base = V.mat.length;
    for (let i = 0; i < P.getCount(); i++) {
      V.pos.push(...P.getElement(i, [0, 0, 0]));
      V.nrm.push(...N.getElement(i, [0, 0, 0]));
      V.tan.push(...T.getElement(i, [0, 0, 0, 0]));
      V.uv.push(...UV.getElement(i, [0, 0]));
      V.jnt.push(...J.getElement(i, e4.slice()));
      V.wgt.push(...W.getElement(i, e4.slice()));
      V.mat.push(mat);
    }
    const I = prim.getIndices();
    if (I) for (let i = 0; i < I.getCount(); i++) V.idx.push(base + I.getScalar(i));
    else for (let i = 0; i < P.getCount(); i++) V.idx.push(base + i);
  }
}
const vertexCount = V.mat.length;
console.log(`source: ${vertexCount} vertices, ${V.idx.length / 3} triangles, ${joints.length} joints -> ${RIG.length} rig bones`);

// ---- 2. Game space: forward (+X in the source) becomes -Z, up (+Z) becomes +Y, feet on y = 0.
let minUp = Infinity;
let maxUp = -Infinity;
for (let i = 0; i < vertexCount; i++) {
  minUp = Math.min(minUp, V.pos[i * 3 + 2]!);
  maxUp = Math.max(maxUp, V.pos[i * 3 + 2]!);
}
const scale = HEIGHT / (maxUp - minUp);
// Bind space -> game space (rotation + scale + lift), and the bare rotation for directions.
const toGame = new Matrix4().set(0, -scale, 0, 0, 0, 0, scale, -minUp * scale, -scale, 0, 0, 0, 0, 0, 0, 1);
const rotGame = new Matrix4().set(0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 0, 1);
const v3 = new Vector3();
for (let i = 0; i < vertexCount; i++) {
  v3.fromArray(V.pos, i * 3).applyMatrix4(toGame).toArray(V.pos, i * 3);
  v3.fromArray(V.nrm, i * 3).applyMatrix4(rotGame).normalize().toArray(V.nrm, i * 3);
  v3.set(V.tan[i * 4]!, V.tan[i * 4 + 1]!, V.tan[i * 4 + 2]!).applyMatrix4(rotGame).normalize();
  V.tan[i * 4] = v3.x;
  V.tan[i * 4 + 1] = v3.y;
  V.tan[i * 4 + 2] = v3.z;
}
const jointGame = jointBind.map((p) => p.clone().applyMatrix4(toGame));
const pivotOf = (patterns: RegExp[], pts: Vector3[]): Vector3 => {
  const hits = joints.map((j, k) => (patterns.some((re) => re.test(j.getName())) ? pts[k]! : null)).filter((p): p is Vector3 => !!p);
  if (hits.length === 0) throw new Error(`no source joint matches ${patterns.join(' ')}`);
  return hits.reduce((a, p) => a.add(p), new Vector3()).divideScalar(hits.length);
};

// ---- 3. Rest pose: rotate each arm about the shoulder, then the forearm about the elbow.
const bake = joints.map(() => new Matrix4());
const bone = (name: string) => rigIndex.get(name)!;
const about = (pivot: Vector3, q: Quaternion) => new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z).multiply(new Matrix4().makeRotationFromQuaternion(q)).multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
for (const s of SIDES) {
  const sgn = s === 'R' ? 1 : -1;
  const S = pivotOf(RIG[bone(`upper${s}`)]!.pivot, jointGame);
  const E = pivotOf(RIG[bone(`fore${s}`)]!.pivot, jointGame);
  const H = pivotOf(RIG[bone(`hand${s}`)]!.pivot, jointGame);
  const upDir = UPPER_DIR.clone().setX(UPPER_DIR.x * sgn);
  const foDir = FORE_DIR.clone().setX(FORE_DIR.x * sgn);
  const elbowBend = (E.clone().sub(S).normalize().angleTo(H.clone().sub(E).normalize()) * 180) / Math.PI;
  const q1 = new Quaternion().setFromUnitVectors(E.clone().sub(S).normalize(), upDir);
  const M1 = about(S, q1);
  const E1 = E.clone().applyMatrix4(M1);
  const H1 = H.clone().applyMatrix4(M1);
  const q2 = new Quaternion().setFromUnitVectors(H1.clone().sub(E1).normalize(), foDir);
  const M2 = about(E1, q2).multiply(M1);
  console.log(`arm ${s}: source shoulder ${fmt(S)} elbow ${fmt(E)} wrist ${fmt(H)}, elbow bend ${elbowBend.toFixed(1)} deg; rotated ${((2 * Math.acos(Math.min(1, Math.abs(q1.w))) * 180) / Math.PI).toFixed(1)} deg at the shoulder`);
  joints.forEach((_, k) => {
    const b = RIG[boneOfJoint[k]!]!.name;
    if (b === `upper${s}`) bake[k] = M1;
    else if ([`fore${s}`, `hand${s}`, `fingers${s}`, `tips${s}`].includes(b)) bake[k] = M2;
  });
}
function fmt(v: Vector3): string {
  return `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
}
// Linear-blend the vertices into the rest pose with the source weights.
{
  const acc = new Vector3();
  const tmp = new Vector3();
  const rot = bake.map((m) => new Matrix4().extractRotation(m));
  for (let i = 0; i < vertexCount; i++) {
    const p = new Vector3().fromArray(V.pos, i * 3);
    const n = new Vector3().fromArray(V.nrm, i * 3);
    const t = new Vector3(V.tan[i * 4]!, V.tan[i * 4 + 1]!, V.tan[i * 4 + 2]!);
    acc.set(0, 0, 0);
    const an = new Vector3();
    const at = new Vector3();
    for (let c = 0; c < 4; c++) {
      const w = V.wgt[i * 4 + c]!;
      if (w <= 0) continue;
      const k = V.jnt[i * 4 + c]!;
      acc.addScaledVector(tmp.copy(p).applyMatrix4(bake[k]!), w);
      an.addScaledVector(tmp.copy(n).applyMatrix4(rot[k]!), w);
      at.addScaledVector(tmp.copy(t).applyMatrix4(rot[k]!), w);
    }
    acc.toArray(V.pos, i * 3);
    an.normalize().toArray(V.nrm, i * 3);
    at.normalize();
    V.tan[i * 4] = at.x;
    V.tan[i * 4 + 1] = at.y;
    V.tan[i * 4 + 2] = at.z;
  }
}
const jointRest = jointGame.map((p, k) => p.clone().applyMatrix4(bake[k]!));

// ---- 4. Rig: pivots, weights folded onto rig bones (top four), eyes, finger curl axes.
const pivots = RIG.map((b) => pivotOf(b.pivot, jointRest));
const rigJ = new Uint8Array(vertexCount * 4);
const rigW = new Float32Array(vertexCount * 4);
{
  const sum = new Float32Array(RIG.length);
  for (let i = 0; i < vertexCount; i++) {
    sum.fill(0);
    for (let c = 0; c < 4; c++) sum[boneOfJoint[V.jnt[i * 4 + c]!]!]! += V.wgt[i * 4 + c]!;
    const order = [...sum.keys()].sort((a, b) => sum[b]! - sum[a]!).slice(0, 4).filter((b) => sum[b]! > 0.004);
    const total = order.reduce((t, b) => t + sum[b]!, 0) || 1;
    order.forEach((b, c) => {
      rigJ[i * 4 + c] = b;
      rigW[i * 4 + c] = sum[b]! / total;
    });
    if (order.length === 0) rigW[i * 4] = 1;
  }
}
const eyeMat = MATERIALS.findIndex((m) => m.name === 'robotEye');
const eyes = SIDES.map((s) => {
  const sgn = s === 'R' ? 1 : -1;
  const box = { min: new Vector3(Infinity, Infinity, Infinity), max: new Vector3(-Infinity, -Infinity, -Infinity) };
  for (let i = 0; i < vertexCount; i++) {
    if (V.mat[i] !== eyeMat || Math.sign(V.pos[i * 3]!) !== sgn) continue;
    v3.fromArray(V.pos, i * 3);
    box.min.min(v3);
    box.max.max(v3);
  }
  const c = box.min.clone().add(box.max).multiplyScalar(0.5);
  return { side: s, at: [c.x, c.y, box.min.z].map((x) => +x.toFixed(4)), radius: +((box.max.x - box.min.x) / 2).toFixed(4) };
});
const curl = Object.fromEntries(
  SIDES.map((s) => {
    const k = (re: RegExp) => jointRest[joints.findIndex((j) => re.test(j.getName()))]!;
    const i0 = k(new RegExp(`^bip_index_0_${s}_`));
    const i1 = k(new RegExp(`^bip_index_1_${s}_`));
    const i2 = k(new RegExp(`^bip_index_2_${s}_`));
    const p0 = k(new RegExp(`^bip_pinky_0_${s}_`));
    // Fingers curl about the knuckle line, towards the side the rest pose already bends them.
    const axis = p0.clone().sub(i0).normalize();
    const bend = i1.clone().sub(i0).cross(i2.clone().sub(i1));
    if (bend.dot(axis) < 0) axis.negate();
    return [s, axis.toArray().map((x) => +x.toFixed(4))];
  }),
);
const attribution = (() => {
  const meta = join(dirname(dirname(SOURCE)), 'source.json');
  return existsSync(meta) ? (JSON.parse(readFileSync(meta, 'utf8')) as { attribution: string }).attribution : 'see ASSET_LICENSES.md';
})();
const rigFile = {
  name: 'robot',
  generator: 'scripts/build-red-horizon-robot.ts',
  source: attribution,
  forward: '-z',
  note: 'R is the machine\'s own right (+X when it faces -Z). Bones rotate about their pivots in model axes; weights blend up to four bones.',
  height: HEIGHT,
  bones: RIG.map((b, id) => ({ name: b.name, id, parent: b.parent ? rigIndex.get(b.parent)! : -1, pivot: pivots[id]!.toArray().map((x) => +x.toFixed(4)) })),
  pistons: [],
  eyes,
  curl,
};
writeFileSync(join(STAGE, 'models/robot.rig.json'), `${JSON.stringify(rigFile, null, 2)}\n`);
for (const b of rigFile.bones) console.log(`  ${b.name.padEnd(9)} parent ${String(b.parent).padStart(2)} pivot ${b.pivot.join(', ')}`);
console.log(`  eyes ${JSON.stringify(eyes)} curl ${JSON.stringify(curl)}`);

// ---- 5. Levels of detail.
const posF = new Float32Array(V.pos);
const nrmF = new Float32Array(V.nrm);
for (const lod of LODS) {
  const all = new Uint32Array(V.idx);
  const body: number[] = [];
  const eye: number[] = [];
  for (let t = 0; t < all.length; t += 3) (V.mat[all[t]!] === eyeMat ? eye : body).push(all[t]!, all[t + 1]!, all[t + 2]!);
  const target = Math.min(body.length, lod.triangles * 3);
  const [bodyOut, bodyErr] = MeshoptSimplifier.simplifyWithAttributes(new Uint32Array(body), posF, 3, nrmF, 3, [0.25, 0.25, 0.25], null, target, lod.error, ['Permissive']);
  const [eyeOut] = Number.isFinite(lod.eyeTriangles) ? MeshoptSimplifier.simplify(new Uint32Array(eye), posF, 3, lod.eyeTriangles * 3, 0.2, []) : [new Uint32Array(eye)];
  const tris = new Uint32Array([...bodyOut, ...eyeOut]);
  const bytes = await writeLod(tris, true);
  writeFileSync(join(STAGE, 'models', lod.file), bytes);
  if (PREVIEW) writeFileSync(join(PREVIEW, lod.file), await writeLod(tris, false));
  console.log(`${lod.file}: ${tris.length / 3} triangles (body error ${(bodyErr * 100).toFixed(2)} %), ${Math.round(bytes.length / 1024)} KB`);
}

async function writeLod(tris: Uint32Array, compress: boolean): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh('robot');
  MATERIALS.forEach((m, mi) => {
    const remap = new Map<number, number>();
    const index: number[] = [];
    for (let t = 0; t < tris.length; t += 3) {
      if (V.mat[tris[t]!] !== mi) continue;
      for (let c = 0; c < 3; c++) {
        const v = tris[t + c]!;
        let o = remap.get(v);
        if (o === undefined) remap.set(v, (o = remap.size));
        index.push(o);
      }
    }
    if (index.length === 0) return;
    const n = remap.size;
    const pos = new Float32Array(n * 3);
    const nrm = new Float32Array(n * 3);
    const tan = new Float32Array(n * 4);
    const uv = new Float32Array(n * 2);
    const jnt = new Uint8Array(n * 4);
    const wgt = new Float32Array(n * 4);
    for (const [v, o] of remap) {
      for (let c = 0; c < 3; c++) {
        pos[o * 3 + c] = V.pos[v * 3 + c]!;
        nrm[o * 3 + c] = V.nrm[v * 3 + c]!;
      }
      for (let c = 0; c < 4; c++) {
        tan[o * 4 + c] = V.tan[v * 4 + c]!;
        jnt[o * 4 + c] = rigJ[v * 4 + c]!;
        wgt[o * 4 + c] = rigW[v * 4 + c]!;
      }
      uv[o * 2] = V.uv[v * 2]!;
      uv[o * 2 + 1] = V.uv[v * 2 + 1]!;
    }
    const acc = (type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4', array: TypedArray) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', acc('VEC3', pos))
      .setAttribute('NORMAL', acc('VEC3', nrm))
      .setAttribute('TANGENT', acc('VEC4', tan))
      .setAttribute('TEXCOORD_0', acc('VEC2', uv))
      .setAttribute('JOINTS_0', acc('VEC4', jnt))
      .setAttribute('WEIGHTS_0', acc('VEC4', wgt))
      .setIndices(acc('SCALAR', n < 65536 ? new Uint16Array(index) : new Uint32Array(index)))
      .setMaterial(doc.createMaterial(m.name));
    mesh.addPrimitive(prim);
  });
  doc.createScene('robot').addChild(doc.createNode('robot').setMesh(mesh));
  if (!compress) return new NodeIO().writeBinary(doc);
  // UVs leave [0, 1] (the texture repeats), so they stay float; everything else is quantised.
  await doc.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }), quantize({ pattern: /^(POSITION|NORMAL|TANGENT|WEIGHTS_0)$/, quantizePosition: 14, quantizeNormal: 10 }));
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const out = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  return out.writeBinary(doc);
}

// ---- Textures.
for (const t of TEXTURES) {
  const from = join(dirname(SOURCE), t.from);
  const to = join(STAGE, 'textures', t.to);
  const info = await sharp(from).resize(t.size, t.size, { fit: 'fill' }).webp({ quality: t.quality, effort: 6 }).toFile(to);
  console.log(`${t.to}: ${info.width}x${info.height}, ${Math.round(info.size / 1024)} KB`);
}
