import { describe, expect, it } from 'vitest';
import { AdditiveBlending, Bone, BoxGeometry, Float32BufferAttribute, Group, Matrix4, Mesh, MeshBasicMaterial, NormalBlending, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3, Vector4, type MeshBasicNodeMaterial } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { seeded } from '../environments/components/common';
import { sampleModel } from './meshSampler';
import { createSurfaceParticles, DEFAULT_GLOW, groupSets, MORPH_TEXTURE_WIDTH, strongestInfluences } from './surfaceParticles';

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

  /** A skinned box whose vertices all follow `joint` of `bones`. */
  function skinnedBox(bones: Bone[], joint: number, inverses?: Matrix4[]): SkinnedMesh {
    const g = new BoxGeometry(1, 1, 1);
    const n = g.getAttribute('position').count;
    g.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(n * 4).map((_, i) => (i % 4 === 0 ? joint : 0)), 4));
    g.setAttribute('skinWeight', new Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
    const mesh = new SkinnedMesh(g, new MeshBasicMaterial());
    // An explicit bind matrix keeps the given inverses (bind() recomputes them otherwise).
    if (inverses) mesh.bind(new Skeleton(bones, inverses), new Matrix4());
    else mesh.bind(new Skeleton(bones));
    return mesh;
  }

  it('merges skinned parts of one body into one particle mesh on the union of their joints', () => {
    const hips = new Bone();
    const head = new Bone();
    const tail = new Bone();
    hips.add(head, tail);
    head.position.set(0, 1, 0);
    tail.position.set(0, 0, -1);
    const root = new Group();
    root.add(hips);
    root.updateMatrixWorld(true);
    // Separate skins, as glTF exports often give them: the body on [hips, head], the tail on [tail, hips].
    const body = skinnedBox([hips, head], 1);
    const tailMesh = skinnedBox([tail, hips], 0);
    root.add(body, tailMesh);
    const sets = sampleModel(root, 400, seeded(8), null);
    const parts = groupSets(sets);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.skeleton!.bones).toEqual([hips, head, tail]);
    const particles = createSurfaceParticles(sets, OPTIONS, uniform(0));
    expect(particles.objects).toHaveLength(1);
    const obj = particles.objects[0] as SkinnedMesh;
    expect(obj.geometry.getAttribute('position').count).toBe(400 * 4);
    // Body particles follow the head (joint 1); tail particles follow the tail, now joint 2.
    const joints = new Set<number>();
    const si = obj.geometry.getAttribute('skinIndex');
    for (let v = 0; v < si.count; v += 4) joints.add(si.getX(v));
    expect([...joints].sort()).toEqual([1, 2]);
    particles.dispose();
  });

  it('merges skins whose inverse bind matrices differ by one common matrix, skinning them identically', () => {
    // Quantised exports keep positions normalised and fold the scale into the inverse bind matrices.
    const hips = new Bone();
    const knee = new Bone();
    hips.add(knee);
    knee.position.set(0, -1, 0);
    const root = new Group();
    root.add(hips);
    root.updateMatrixWorld(true);
    const rest = (b: Bone) => b.matrixWorld.clone().invert();
    const body = skinnedBox([hips], 0, [rest(hips)]);
    const quantise = new Matrix4().makeScale(0.25, 0.25, 0.25);
    const leg = skinnedBox([knee, hips], 0, [rest(knee).multiply(quantise.clone().invert()), rest(hips).multiply(quantise.clone().invert())]);
    // The leg's raw box spans ±0.5 · 4 = ±2 units once dequantised: scale its geometry to match.
    leg.geometry.scale(0.25, 0.25, 0.25);
    root.add(body, leg);
    // Pose: the knee swings forward.
    knee.rotation.x = 0.6;
    root.updateMatrixWorld(true);
    const sets = sampleModel(root, 600, seeded(9), null);
    const parts = groupSets(sets);
    expect(parts).toHaveLength(1);
    const particles = createSurfaceParticles(sets, OPTIONS, uniform(0));
    const merged = particles.objects[0] as SkinnedMesh;
    merged.skeleton.update();
    leg.skeleton.update();
    // Every leg particle, skinned through the merged mesh, lands on the leg's own skinned surface.
    const legSet = sets.find((s) => s.mesh === leg)!;
    const start = sets[0] === legSet ? 0 : sets[0]!.count;
    const a = new Vector3();
    const b = new Vector3();
    const legGeometry = leg.geometry.clone();
    legGeometry.setAttribute('position', new Float32BufferAttribute(legSet.position, 3));
    legGeometry.setAttribute('skinIndex', new Uint16BufferAttribute(legSet.skinIndex!, 4));
    legGeometry.setAttribute('skinWeight', new Float32BufferAttribute(legSet.skinWeight!, 4));
    legGeometry.setIndex(null);
    const reference = new SkinnedMesh(legGeometry, leg.material);
    reference.bind(leg.skeleton, leg.bindMatrix);
    for (let i = 0; i < legSet.count; i += 17) {
      merged.getVertexPosition((start + i) * 4, a);
      reference.getVertexPosition(i, b);
      expect(a.distanceTo(b)).toBeLessThan(1e-4);
    }
    particles.dispose();
  });

  it('keeps skins apart when their joints disagree on the bind pose', () => {
    const b0 = new Bone();
    const b1 = new Bone();
    b0.add(b1);
    const root = new Group();
    root.add(b0);
    root.updateMatrixWorld(true);
    const a = skinnedBox([b0, b1], 0, [new Matrix4(), new Matrix4()]);
    const b = skinnedBox([b0, b1], 0, [new Matrix4(), new Matrix4().makeTranslation(0, 1, 0)]);
    root.add(a, b);
    expect(groupSets(sampleModel(root, 100, seeded(9), null))).toHaveLength(2);
  });

  it('gives morphing meshes a particle index for their morph texture', () => {
    const g = new BoxGeometry(1, 1, 1);
    const n = g.getAttribute('position').count;
    g.morphAttributes.position = [0, 1, 2].map((k) => new Float32BufferAttribute(new Float32Array(n * 3).fill(k + 1), 3));
    g.morphTargetsRelative = true;
    const mesh = new Mesh(g, new MeshBasicMaterial());
    mesh.updateMorphTargets();
    const particles = createSurfaceParticles(sampleModel(mesh, 5000, seeded(10), null), OPTIONS, uniform(0));
    expect(particles.objects).toHaveLength(1);
    expect(particles.objects[0]!.geometry.getAttribute('pindex').getX(4 * 4999)).toBe(4999);
    // Texel rows are a power of two wide, so the shader's index maths is exact in floats.
    expect(MORPH_TEXTURE_WIDTH & (MORPH_TEXTURE_WIDTH - 1)).toBe(0);
    mesh.morphTargetInfluences![2] = 0.75;
    particles.update();
    particles.dispose();
  });

  it('picks the four strongest morph influences', () => {
    const index = new Vector4();
    const weight = new Vector4();
    strongestInfluences([0, 0.1, 0, 0.9, -0.5, 0.05, 0.3], index, weight);
    const pairs = [0, 1, 2, 3].map((k) => [index.getComponent(k), weight.getComponent(k)]).sort((x, y) => x[0]! - y[0]!);
    expect(pairs).toEqual([
      [1, 0.1],
      [3, 0.9],
      [4, -0.5],
      [6, 0.3],
    ]);
    strongestInfluences([0, 1], index, weight);
    expect([index.x, weight.x, weight.y, weight.z, weight.w]).toEqual([1, 1, 0, 0, 0]);
  });

  it('shares the quads of instances that reuse the same samples, until the last one is disposed', () => {
    const a = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    const b = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    const sets = sampleModel(a, 200, seeded(11), null);
    const first = createSurfaceParticles(sets, OPTIONS, uniform(0));
    const second = createSurfaceParticles(
      sets.map((s) => ({ ...s, mesh: b })),
      OPTIONS,
      uniform(0),
    );
    const geometry = first.objects[0]!.geometry;
    expect(second.objects[0]!.geometry).toBe(geometry);
    expect(second.objects[0]!.parent).toBe(b);
    let disposed = 0;
    geometry.addEventListener('dispose', () => disposed++);
    first.dispose();
    expect(disposed).toBe(0);
    second.dispose();
    expect(disposed).toBe(1);
  });
});

describe('glowing surface particles', () => {
  it('draw additive, fog-free points when given glow options, and plain ones otherwise', () => {
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    const plain = createSurfaceParticles(sampleModel(mesh, 100, seeded(12), null), { ...OPTIONS, blend: 'normal' }, uniform(0));
    const plainMaterial = plain.objects[0]!.material as MeshBasicNodeMaterial;
    expect(plainMaterial.blending).toBe(NormalBlending);
    const glowing = createSurfaceParticles(sampleModel(mesh, 100, seeded(12), null), { ...OPTIONS, blend: 'normal', glow: DEFAULT_GLOW }, uniform(0));
    const glowMaterial = glowing.objects[0]!.material as MeshBasicNodeMaterial;
    expect(glowMaterial.blending).toBe(AdditiveBlending);
    expect(glowMaterial.fog).toBe(false);
    expect(glowMaterial.depthWrite).toBe(false);
    expect(glowMaterial).not.toBe(plainMaterial);
    // The owner drives the wake and the music envelopes through these.
    glowing.uniforms.velocity.value.set(1, 0, 0);
    glowing.uniforms.breath.value = 0.5;
    glowing.uniforms.sparkle.value = 0.5;
    plain.dispose();
    glowing.dispose();
  });
});
