import { describe, expect, it } from 'vitest';
import { Bone, BoxGeometry, BufferAttribute, BufferGeometry, Group, Matrix4, Mesh, MeshBasicMaterial, Skeleton, SkinnedMesh, Texture, Uint16BufferAttribute, Float32BufferAttribute } from 'three/webgpu';
import type { TexelReader } from './meshSampler';
import { seeded } from '../environments/components/common';
import { sampleModel } from './meshSampler';

/** Two triangles in the z = 0 plane: the second has three times the area of the first. */
function unevenPlane(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 13, 0, 0, 10, 1, 0]), 3));
  g.setIndex([0, 1, 2, 3, 4, 5]);
  return g;
}

describe('mesh surface sampling', () => {
  it('places every point on the surface', () => {
    const mesh = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
    const [set] = sampleModel(mesh, 2000, seeded(1), null);
    expect(set?.count).toBe(2000);
    for (let i = 0; i < 2000; i++) {
      const x = Math.abs(set!.position[i * 3]!);
      const y = Math.abs(set!.position[i * 3 + 1]!);
      const z = Math.abs(set!.position[i * 3 + 2]!);
      expect(Math.max(x, y, z)).toBeCloseTo(1, 5);
    }
  });

  it('weights triangles by area', () => {
    const [set] = sampleModel(new Mesh(unevenPlane(), new MeshBasicMaterial()), 8000, seeded(2), null);
    let big = 0;
    for (let i = 0; i < set!.count; i++) if (set!.position[i * 3]! >= 10) big++;
    expect(big / set!.count).toBeGreaterThan(0.72);
    expect(big / set!.count).toBeLessThan(0.78);
  });

  it('splits the count between meshes by world-space area, scale included', () => {
    const root = new Group();
    const small = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    const large = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    large.scale.setScalar(2);
    root.add(small, large);
    const sets = sampleModel(root, 1000, seeded(3), null);
    expect(sets.map((s) => s.count)).toEqual([200, 800]);
  });

  it('takes colour from the material and vertex colours', () => {
    const g = new BoxGeometry(1, 1, 1);
    g.setAttribute('color', new Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 3).fill(0.5), 3));
    const [set] = sampleModel(new Mesh(g, new MeshBasicMaterial({ color: 0xffffff })), 10, seeded(4), null);
    expect(set!.color[0]).toBeCloseTo(0.5, 5);
    expect(set!.color[2]).toBeCloseTo(0.5, 5);
  });

  it('blends the corner joint weights of skinned meshes and keeps them normalised', () => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    g.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4));
    g.setAttribute('skinWeight', new Float32BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4));
    const bones = [new Bone(), new Bone()];
    bones[0]!.add(bones[1]!);
    const mesh = new SkinnedMesh(g, new MeshBasicMaterial());
    mesh.add(bones[0]!);
    mesh.bind(new Skeleton(bones));
    const [set] = sampleModel(mesh, 500, seeded(5), null);
    expect(set!.skinIndex).not.toBeNull();
    for (let i = 0; i < set!.count; i++) {
      const w = set!.skinWeight!;
      expect(w[i * 4]! + w[i * 4 + 1]! + w[i * 4 + 2]! + w[i * 4 + 3]!).toBeCloseTo(1, 5);
      // Points near corner 0 lean on joint 0; the other corners belong to joint 1.
      const x = set!.position[i * 3]!;
      const y = set!.position[i * 3 + 1]!;
      const joint0 = set!.skinIndex![i * 4] === 0 ? w[i * 4]! : w[i * 4 + 1]!;
      expect(joint0).toBeCloseTo(1 - x - y, 4);
    }
  });

  it('keeps the particles of cut-out surfaces on their opaque texels', () => {
    // A unit quad whose texture is opaque only where u < 0.25.
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const reader: TexelReader = () => (u, _v, out) => {
      out.setRGB(1, 1, 1);
      return u < 0.25 ? 1 : 0;
    };
    const opaque = (transparent: boolean): number => {
      const material = new MeshBasicMaterial({ map: new Texture(), transparent });
      const [set] = sampleModel(new Mesh(g, material), 2000, seeded(6), reader);
      let inside = 0;
      for (let i = 0; i < set!.count; i++) if (set!.position[i * 3]! < 0.25) inside++;
      return inside / set!.count;
    };
    // Eight tries at a 25% chance each: about 90% land on the opaque part; opaque materials ignore alpha.
    expect(opaque(true)).toBeGreaterThan(0.85);
    expect(opaque(false)).toBeLessThan(0.3);
  });

  it('carries morph target offsets to every point, relative or absolute', () => {
    for (const relative of [true, false]) {
      const g = new BoxGeometry(1, 1, 1);
      const pos = g.getAttribute('position');
      const lift = new Float32Array(pos.count * 3);
      const stretch = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        // Target 0 lifts every point by 2; target 1 doubles its distance from the centre.
        lift[i * 3] = relative ? 0 : pos.getX(i);
        lift[i * 3 + 1] = relative ? 2 : pos.getY(i) + 2;
        lift[i * 3 + 2] = relative ? 0 : pos.getZ(i);
        for (let k = 0; k < 3; k++) stretch[i * 3 + k] = pos.getComponent(i, k) * (relative ? 1 : 2);
      }
      g.morphAttributes.position = [new Float32BufferAttribute(lift, 3), new Float32BufferAttribute(stretch, 3)];
      g.morphTargetsRelative = relative;
      const [set] = sampleModel(new Mesh(g, new MeshBasicMaterial()), 100, seeded(7), null);
      expect(set!.morph?.targets).toBe(2);
      const d = set!.morph!.deltas;
      for (let i = 0; i < set!.count; i++) {
        expect(d[i * 3]).toBeCloseTo(0, 5);
        expect(d[i * 3 + 1]).toBeCloseTo(2, 5);
        for (let k = 0; k < 3; k++) expect(d[(set!.count + i) * 3 + k]).toBeCloseTo(set!.position[i * 3 + k]!, 5);
      }
    }
  });

  it('splits samples between skinned meshes by their posed size, whatever space their raw positions use', () => {
    // A quantised export keeps one mesh's positions normalised (here 1/4 size) and folds the
    // scale into its inverse bind matrix: both boxes are the same size once posed.
    const bone = new Bone();
    const root = new Group();
    root.add(bone);
    root.updateMatrixWorld(true);
    const skinnedBox = (shrink: number): SkinnedMesh => {
      const g = new BoxGeometry(1, 1, 1);
      g.scale(shrink, shrink, shrink);
      const n = g.getAttribute('position').count;
      g.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(n * 4), 4));
      g.setAttribute('skinWeight', new Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
      const mesh = new SkinnedMesh(g, new MeshBasicMaterial());
      mesh.bind(new Skeleton([bone], [new Matrix4().makeScale(1 / shrink, 1 / shrink, 1 / shrink)]), new Matrix4());
      return mesh;
    };
    root.add(skinnedBox(1), skinnedBox(0.25));
    const sets = sampleModel(root, 1000, seeded(8), null);
    expect(sets.map((s) => s.count)).toEqual([500, 500]);
  });

  it('skips meshes the filter rejects', () => {
    const root = new Group();
    const body = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    const hair = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    hair.name = 'Hair';
    root.add(body, hair);
    const sets = sampleModel(root, 300, seeded(9), null, (m) => m.name !== 'Hair');
    expect(sets).toHaveLength(1);
    expect(sets[0]!.mesh).toBe(body);
    expect(sets[0]!.count).toBe(300);
  });
});
