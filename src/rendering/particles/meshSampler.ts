import { Color, Mesh, SkinnedMesh, Vector2, Vector3, type Material, type Matrix4, type Object3D, type Texture } from 'three/webgpu';

/** Points on a mesh surface, in that mesh's own (local / bind) space. */
export interface SurfaceSampleSet {
  readonly mesh: Mesh;
  readonly count: number;
  readonly position: Float32Array;
  readonly normal: Float32Array;
  /** Linear RGB of the surface at the point (base colour texture or material colour). */
  readonly color: Float32Array;
  /** One random number per point (delays, sizes, twinkle). */
  readonly seed: Float32Array;
  /** Four joints and weights per point when the mesh is skinned. */
  readonly skinIndex: Uint16Array | null;
  readonly skinWeight: Float32Array | null;
}

/** Reads a texture's pixels once (downscaled) so particle colours can match the model's albedo. */
export type TexelReader = (texture: Texture) => ((u: number, v: number, out: Color) => boolean) | null;

/**
 * Canvas-based texel reader for browser images. Returns null where pixels can't be read (no DOM,
 * compressed or tainted textures); callers fall back to the material colour.
 */
export const canvasTexelReader: TexelReader = (texture) => {
  const image = texture.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!image || typeof OffscreenCanvas === 'undefined' || !image.width || !image.height) return null;
  try {
    const scale = Math.min(1, 256 / Math.max(image.width, image.height));
    const w = Math.max(1, Math.round(image.width * scale));
    const h = Math.max(1, Math.round(image.height * scale));
    const ctx = new OffscreenCanvas(w, h).getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    return (u, v, out) => {
      const fu = u - Math.floor(u);
      const fv = texture.flipY ? 1 - (v - Math.floor(v)) : v - Math.floor(v);
      const x = Math.min(w - 1, Math.floor(fu * w));
      const y = Math.min(h - 1, Math.floor(fv * h));
      const i = (y * w + x) * 4;
      out.setRGB((data[i] as number) / 255, (data[i + 1] as number) / 255, (data[i + 2] as number) / 255).convertSRGBToLinear();
      return true;
    };
  } catch {
    return null;
  }
};

function baseOf(material: Material | Material[]): { color: Color; map: Texture | null } {
  const m = (Array.isArray(material) ? material[0] : material) as Material & { color?: Color; map?: Texture | null };
  return { color: m?.color instanceof Color ? m.color : new Color(1, 1, 1), map: m?.map ?? null };
}

/** World-space area of every triangle of a mesh (so samples split between meshes by real size). */
function triangleAreas(mesh: Mesh, toWorld: Matrix4): { areas: Float64Array; total: number; tri: ArrayLike<number> } {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const index = g.getIndex();
  const tri: ArrayLike<number> = index ? index.array : Uint32Array.from({ length: pos.count }, (_, i) => i);
  const n = Math.floor(tri.length / 3);
  const areas = new Float64Array(n);
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  let total = 0;
  for (let t = 0; t < n; t++) {
    a.fromBufferAttribute(pos, tri[t * 3] as number).applyMatrix4(toWorld);
    b.fromBufferAttribute(pos, tri[t * 3 + 1] as number).applyMatrix4(toWorld);
    c.fromBufferAttribute(pos, tri[t * 3 + 2] as number).applyMatrix4(toWorld);
    b.sub(a);
    c.sub(a);
    const area = 0.5 * b.cross(c).length();
    total += area;
    areas[t] = total;
  }
  return { areas, total, tri };
}

/**
 * Area-weighted samples over every visible mesh under `root`: each mesh gets a share of `count`
 * proportional to its world-space surface area, triangles are picked by a binary search over the
 * cumulative areas, and points are uniform inside each triangle (folded barycentrics). Positions
 * stay in each mesh's local space; skinned meshes keep their joints and weights (blended from the
 * triangle's corners), so particles can be skinned by the same skeleton.
 */
export function sampleModel(root: Object3D, count: number, rand: () => number, readTexels: TexelReader | null = canvasTexelReader): SurfaceSampleSet[] {
  root.updateWorldMatrix(true, true);
  const meshes: { mesh: Mesh; areas: Float64Array; total: number; tri: ArrayLike<number> }[] = [];
  root.traverse((o) => {
    if (!(o instanceof Mesh) || !o.visible || !o.geometry.getAttribute('position')) return;
    meshes.push({ mesh: o, ...triangleAreas(o, o.matrixWorld) });
  });
  const grand = meshes.reduce((s, m) => s + m.total, 0);
  if (grand <= 0 || count <= 0) return [];
  const sets: SurfaceSampleSet[] = [];
  let assigned = 0;
  meshes.forEach((m, mi) => {
    const share = mi === meshes.length - 1 ? count - assigned : Math.round((count * m.total) / grand);
    assigned += share;
    if (share > 0) sets.push(sampleOne(m.mesh, m.areas, m.total, m.tri, share, rand, readTexels));
  });
  return sets;
}

function sampleOne(mesh: Mesh, areas: Float64Array, total: number, tri: ArrayLike<number>, count: number, rand: () => number, readTexels: TexelReader | null): SurfaceSampleSet {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  const vcol = g.getAttribute('color');
  const skinned = mesh instanceof SkinnedMesh;
  const si = skinned ? g.getAttribute('skinIndex') : undefined;
  const sw = skinned ? g.getAttribute('skinWeight') : undefined;
  const { color: baseColor, map } = baseOf(mesh.material);
  const texel = map && uv && readTexels ? readTexels(map) : null;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const skinIndex = si && sw ? new Uint16Array(count * 4) : null;
  const skinWeight = si && sw ? new Float32Array(count * 4) : null;
  const pa = new Vector3();
  const pb = new Vector3();
  const pc = new Vector3();
  const v = new Vector3();
  const uva = new Vector2();
  const uvb = new Vector2();
  const uvc = new Vector2();
  const c = new Color();
  const tex = new Color();
  const triCount = areas.length;
  for (let s = 0; s < count; s++) {
    const target = rand() * total;
    let lo = 0;
    let hi = triCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((areas[mid] as number) < target) lo = mid + 1;
      else hi = mid;
    }
    let r1 = rand();
    let r2 = rand();
    if (r1 + r2 > 1) {
      r1 = 1 - r1;
      r2 = 1 - r2;
    }
    const r0 = 1 - r1 - r2;
    const i0 = tri[lo * 3] as number;
    const i1 = tri[lo * 3 + 1] as number;
    const i2 = tri[lo * 3 + 2] as number;
    pa.fromBufferAttribute(pos, i0);
    pb.fromBufferAttribute(pos, i1);
    pc.fromBufferAttribute(pos, i2);
    v.copy(pa).multiplyScalar(r0).addScaledVector(pb, r1).addScaledVector(pc, r2);
    position.set([v.x, v.y, v.z], s * 3);
    if (nor) {
      pa.fromBufferAttribute(nor, i0);
      pb.fromBufferAttribute(nor, i1);
      pc.fromBufferAttribute(nor, i2);
      v.copy(pa).multiplyScalar(r0).addScaledVector(pb, r1).addScaledVector(pc, r2).normalize();
    } else {
      // Flat normal from the triangle itself.
      pb.sub(pa);
      pc.sub(pa);
      v.copy(pb).cross(pc).normalize();
    }
    normal.set([v.x, v.y, v.z], s * 3);
    c.copy(baseColor);
    if (texel && uv) {
      uva.set(uv.getX(i0), uv.getY(i0));
      uvb.set(uv.getX(i1), uv.getY(i1));
      uvc.set(uv.getX(i2), uv.getY(i2));
      const u = uva.x * r0 + uvb.x * r1 + uvc.x * r2;
      const w = uva.y * r0 + uvb.y * r1 + uvc.y * r2;
      if (texel(u, w, tex)) c.multiply(tex);
    }
    if (vcol) c.multiply(tex.setRGB(vcol.getX(i0) * r0 + vcol.getX(i1) * r1 + vcol.getX(i2) * r2, vcol.getY(i0) * r0 + vcol.getY(i1) * r1 + vcol.getY(i2) * r2, vcol.getZ(i0) * r0 + vcol.getZ(i1) * r1 + vcol.getZ(i2) * r2));
    color.set([c.r, c.g, c.b], s * 3);
    seed[s] = rand();
    if (skinIndex && skinWeight && si && sw) blendSkin(si, sw, [i0, i1, i2], [r0, r1, r2], skinIndex, skinWeight, s);
  }
  return { mesh, count, position, normal, color, seed, skinIndex, skinWeight };
}

type SkinAttr = { getComponent(index: number, component: number): number };

/** Merges the corners' joint influences by barycentric weight and keeps the strongest four. */
function blendSkin(si: SkinAttr, sw: SkinAttr, corners: number[], bary: number[], outIndex: Uint16Array, outWeight: Float32Array, s: number): void {
  const acc = new Map<number, number>();
  corners.forEach((vi, k) => {
    for (let j = 0; j < 4; j++) {
      const w = sw.getComponent(vi, j) * (bary[k] as number);
      if (w <= 0) continue;
      const joint = si.getComponent(vi, j);
      acc.set(joint, (acc.get(joint) ?? 0) + w);
    }
  });
  const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sum = top.reduce((t, [, w]) => t + w, 0) || 1;
  for (let j = 0; j < 4; j++) {
    const e = top[j];
    outIndex[s * 4 + j] = e ? e[0] : 0;
    outWeight[s * 4 + j] = e ? e[1] / sum : 0;
  }
}
