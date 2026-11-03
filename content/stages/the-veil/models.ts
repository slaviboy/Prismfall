import type { Mesh} from 'three/webgpu';
import { BufferAttribute, BufferGeometry, Matrix3, type Material, type MeshStandardMaterial, type Object3D, type Texture } from 'three/webgpu';

/**
 * Pulls meshes out of the stage's GLBs as plain float geometry in the GLB's own (Y-up) space.
 * gltf-transform quantises positions and moves the dequantisation into the node transform, so
 * every attribute is read back through getX/Y/Z (normalised integers become floats) and the node's
 * world matrix is baked in.
 */

export interface PartMaps {
  map: Texture | null;
  normalMap: Texture | null;
  roughnessMap: Texture | null;
  aoMap: Texture | null;
}

export interface BakedPart {
  readonly name: string;
  readonly geometry: BufferGeometry;
  readonly maps: PartMaps;
  readonly material: string;
}

function floatAttribute(attr: { count: number; itemSize: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number; getW(i: number): number }): BufferAttribute {
  const n = attr.count;
  const k = attr.itemSize;
  const out = new Float32Array(n * k);
  for (let i = 0; i < n; i++) {
    out[i * k] = attr.getX(i);
    if (k > 1) out[i * k + 1] = attr.getY(i);
    if (k > 2) out[i * k + 2] = attr.getZ(i);
    if (k > 3) out[i * k + 3] = attr.getW(i);
  }
  return new BufferAttribute(out, k);
}

export function bakeMesh(mesh: Mesh): BufferGeometry {
  mesh.updateWorldMatrix(true, false);
  const src = mesh.geometry;
  const geo = new BufferGeometry();
  for (const name of ['position', 'normal', 'uv', 'color']) {
    const a = src.getAttribute(name);
    if (a) geo.setAttribute(name, floatAttribute(a as unknown as BufferAttribute));
  }
  if (src.index) geo.setIndex(Array.from(src.index.array as ArrayLike<number>));
  const m = mesh.matrixWorld;
  const pos = geo.getAttribute('position') as BufferAttribute;
  const nm = new Matrix3().getNormalMatrix(m);
  const arr = pos.array as Float32Array;
  const e = m.elements;
  for (let i = 0; i < pos.count; i++) {
    const x = arr[i * 3]!;
    const y = arr[i * 3 + 1]!;
    const z = arr[i * 3 + 2]!;
    arr[i * 3] = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
    arr[i * 3 + 1] = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
    arr[i * 3 + 2] = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!;
  }
  const nrm = geo.getAttribute('normal') as BufferAttribute | undefined;
  if (nrm) {
    const na = nrm.array as Float32Array;
    const ne = nm.elements;
    for (let i = 0; i < nrm.count; i++) {
      const x = na[i * 3]!;
      const y = na[i * 3 + 1]!;
      const z = na[i * 3 + 2]!;
      const nx = ne[0]! * x + ne[3]! * y + ne[6]! * z;
      const ny = ne[1]! * x + ne[4]! * y + ne[7]! * z;
      const nz = ne[2]! * x + ne[5]! * y + ne[8]! * z;
      const l = Math.hypot(nx, ny, nz) || 1;
      na[i * 3] = nx / l;
      na[i * 3 + 1] = ny / l;
      na[i * 3 + 2] = nz / l;
    }
  } else {
    geo.computeVertexNormals();
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function mapsOf(material: Material | Material[]): PartMaps {
  const m = (Array.isArray(material) ? material[0] : material) as MeshStandardMaterial | undefined;
  return { map: m?.map ?? null, normalMap: m?.normalMap ?? null, roughnessMap: m?.roughnessMap ?? null, aoMap: m?.aoMap ?? null };
}

/** Every mesh under `root` whose own name or ancestor's name is `name` (one part per primitive). */
export function partsNamed(root: Object3D, name: string): BakedPart[] {
  const out: BakedPart[] = [];
  let node: Object3D | undefined;
  root.traverse((o) => {
    if (!node && o.name === name) node = o;
  });
  if (!node) return out;
  root.updateMatrixWorld(true);
  node.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const mat = Array.isArray(mesh.material) ? mesh.material[0]! : mesh.material;
    out.push({ name, geometry: bakeMesh(mesh), maps: mapsOf(mesh.material), material: mat.name });
  });
  return out;
}

/** Bottom of a geometry's bounding box (to stand it on the ground). */
export function baseOf(geo: BufferGeometry): number {
  geo.computeBoundingBox();
  return geo.boundingBox?.min.y ?? 0;
}
