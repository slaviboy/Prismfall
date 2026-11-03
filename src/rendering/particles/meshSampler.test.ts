import { describe, expect, it } from 'vitest';
import { Bone, BoxGeometry, BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute, Float32BufferAttribute } from 'three/webgpu';
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
});
