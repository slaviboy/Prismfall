import { describe, expect, it } from 'vitest';
import { Bone, BoxGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { seeded } from '../environments/components/common';
import { sampleModel } from './meshSampler';
import { createSurfaceParticles } from './surfaceParticles';

const OPTIONS = { size: 0.2, brightness: 1, tint: [1, 1, 1] as const, colorMix: 0, blend: 'additive' as const, jitter: 0.02, spread: 4, wind: [1, 0, 0] as const, bloom: 0.3 };

describe('surface particles', () => {
  it('attaches a quad per sample to a static mesh', () => {
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    const particles = createSurfaceParticles(sampleModel(mesh, 300, seeded(1), null), OPTIONS, uniform(0));
    const [obj] = particles.objects;
    expect(obj?.parent).toBe(mesh);
    expect(obj).not.toBeInstanceOf(SkinnedMesh);
    expect(obj?.geometry.getAttribute('position').count).toBe(300 * 4);
    expect(obj?.geometry.getIndex()?.count).toBe(300 * 6);
    particles.dispose();
    expect(mesh.children).toHaveLength(0);
  });

  it('binds particles of a skinned mesh to the same skeleton and bind matrix', () => {
    const g = new BoxGeometry(1, 1, 1);
    const n = g.getAttribute('position').count;
    g.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(n * 4), 4));
    g.setAttribute('skinWeight', new Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
    const bone = new Bone();
    const body = new SkinnedMesh(g, new MeshBasicMaterial());
    body.add(bone);
    body.bind(new Skeleton([bone]));
    const particles = createSurfaceParticles(sampleModel(body, 200, seeded(2), null), OPTIONS, uniform(0));
    const obj = particles.objects[0] as SkinnedMesh;
    expect(obj).toBeInstanceOf(SkinnedMesh);
    expect(obj.skeleton).toBe(body.skeleton);
    expect(obj.bindMatrix.equals(body.bindMatrix)).toBe(true);
    expect(obj.geometry.getAttribute('skinWeight').count).toBe(200 * 4);
  });
});
