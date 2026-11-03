import { describe, expect, it, vi } from 'vitest';
import {
  AnimationClip,
  Bone,
  BoxGeometry,
  Box3,
  Float32BufferAttribute,
  Group,
  MeshStandardMaterial,
  Quaternion,
  QuaternionKeyframeTrack,
  Scene,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
  VectorKeyframeTrack,
  type Object3D,
} from 'three/webgpu';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { EnvFrame, EnvironmentContext } from '../../../sdk/types';
import { frameUniforms } from '../../shaders/uniforms';
import { createSurfaceParticles } from '../../particles/surfaceParticles';
import type * as SurfaceParticlesModule from '../../particles/surfaceParticles';
import { modelComponent } from './model';

vi.mock('../../particles/surfaceParticles', async (importOriginal) => {
  const mod = await importOriginal<typeof SurfaceParticlesModule>();
  return { ...mod, createSurfaceParticles: vi.fn(mod.createSurfaceParticles) };
});

const Q_HOWL = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 1.2);

/**
 * A rigged box creature: hips carrying a head bone, skinned (all vertices on the hips), with a
 * Walk clip that moves the hips forward 1.5 units/s (root motion) and swings the head, and a Howl
 * clip that tips the head to a fixed pose.
 */
function creature(): GLTF {
  const scene = new Group();
  const hips = new Bone();
  hips.name = 'Hips';
  hips.position.set(0, 1, 0);
  const head = new Bone();
  head.name = 'Head';
  head.position.set(0, 0.5, 0.5);
  hips.add(head);
  const g = new BoxGeometry(1, 1, 2);
  const n = g.getAttribute('position').count;
  g.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(n * 4), 4));
  g.setAttribute('skinWeight', new Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
  g.translate(0, 1, 0);
  const body = new SkinnedMesh(g, new MeshStandardMaterial());
  body.name = 'Body';
  scene.add(hips, body);
  scene.updateMatrixWorld(true);
  body.bind(new Skeleton([hips, head]));
  const times = [0, 0.25, 0.5, 0.75, 1];
  const walk = new AnimationClip('Walk', 1, [
    new VectorKeyframeTrack('Hips.position', times, times.flatMap((t) => [0, 1, 1.5 * t])),
    new QuaternionKeyframeTrack('Head.quaternion', times, times.flatMap((t) => new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.sin(t * Math.PI * 2) * 0.5).toArray())),
  ]);
  const howl = new AnimationClip('Howl', 2, [new QuaternionKeyframeTrack('Head.quaternion', [0, 2], [...Q_HOWL.toArray(), ...Q_HOWL.toArray()])]);
  return { scene, scenes: [scene], animations: [walk, howl], cameras: [], asset: {}, parser: null as never, userData: {} } as unknown as GLTF;
}

function context(gltf: GLTF): EnvironmentContext {
  return {
    stageId: 'test',
    scene: new Scene(),
    quality: { detail: 'high', particles: 1, reflections: 'off', reducedMotion: false },
    uniforms: frameUniforms,
    assets: { url: () => null, loadGLTF: async () => gltf, release: () => undefined } as unknown as EnvironmentContext['assets'],
    bursts: {} as EnvironmentContext['bursts'],
    palette: {} as EnvironmentContext['palette'],
    ground: { height: () => 0, provide: () => undefined, surface: () => 0, setWaterLevel: () => undefined },
    sounds: { emit: () => undefined },
  };
}

const frame = (time: number, dt = 1 / 60): EnvFrame => ({ time, dt, audio: {} as EnvFrame['audio'], game: {} as EnvFrame['game'], presence: 1 });

const bone = (root: Object3D, name: string): Bone => {
  let found: Bone | null = null;
  root.traverse((o) => {
    if (!found && o.name === name && (o as Bone).isBone) found = o as Bone;
  });
  return found!;
};

async function build(params: unknown) {
  const component = await modelComponent.create(context(creature()), modelComponent.schema.parse(params));
  const roots = component.object.children;
  return { component, roots };
}

describe('model component', () => {
  it('gives particles their size, jitter and spread in world units at any instance scale', async () => {
    const make = vi.mocked(createSurfaceParticles);
    make.mockClear();
    await build({
      src: 'x.glb',
      render: 'particles',
      instances: [{ position: [0, 0, 0], scale: 0.05 }, { position: [5, 0, 0], scale: 1 }],
      particles: { count: 200, size: 0.3, jitter: 0.04, spread: 7 },
    });
    expect(make).toHaveBeenCalledTimes(2);
    const [small, unit] = make.mock.calls.map((c) => c[1]);
    for (const opts of [small!, unit!]) {
      expect(opts.size).toBe(0.3);
      expect(opts.jitter).toBe(0.04);
      expect(opts.spread).toBe(7);
      expect(opts.saturation).toBe(1);
    }
  });

  it('sits a skinned model on the ground from its posed bounds', async () => {
    const { roots } = await build({ src: 'x.glb', instances: [{ position: [0, 0, 0], scale: 2 }] });
    const root = roots[0]!;
    root.updateMatrixWorld(true);
    const body = root.getObjectByName('Body') as SkinnedMesh;
    body.skeleton.update();
    body.computeBoundingBox();
    expect(new Box3().setFromObject(root).min.y).toBeCloseTo(0, 4);
  });

  it('walks its path, faces the way it goes, and plays a stop clip while it stands', async () => {
    const { component, roots } = await build({
      src: 'x.glb',
      animation: { clip: 'Walk', inPlace: true },
      instances: [{ position: [0, 0, 0], walk: { to: [20, 0, 0], speed: 2, fade: 0.01, ease: 1, stops: [{ at: 0.5, for: 4, clip: 'Howl' }] } }],
    });
    const root = roots[0]!;
    const head = bone(root, 'Head');
    // Cruising: heading +x (yaw 90 degrees), halfway to the stop after 2.5 s.
    component.update!(frame(2.5));
    expect(root.position.x).toBeCloseTo(5, 4);
    const forward = new Vector3(0, 0, 1).applyQuaternion(root.quaternion);
    expect(forward.x).toBeCloseTo(1, 4);
    expect(head.quaternion.angleTo(Q_HOWL)).toBeGreaterThan(0.3);
    // 10 units of walking at 2 u/s plus half a second for easing in: standing at the stop, howling.
    component.update!(frame(7.5));
    expect(root.position.x).toBeCloseTo(10, 4);
    expect(head.quaternion.angleTo(Q_HOWL)).toBeLessThan(1e-3);
    // Back on the move afterwards.
    component.update!(frame(13));
    expect(root.position.x).toBeGreaterThan(11);
    expect(head.quaternion.angleTo(Q_HOWL)).toBeGreaterThan(0.3);
  });

  it('keeps the feet on the ground: the walk clip follows the distance covered', async () => {
    // Root motion 1.5 units/s at scale 2 is 3 world units per clip second: walking 3 u/s, one
    // clip cycle every second, so the pose repeats every second and the hips never drift.
    const { component, roots } = await build({
      src: 'x.glb',
      animation: { clip: 'Walk', inPlace: true },
      instances: [{ position: [0, 0, 0], scale: 2, walk: { to: [0, 0, 300], speed: 3, fade: 0.01 } }],
    });
    const root = roots[0]!;
    const head = bone(root, 'Head');
    const hips = bone(root, 'Hips');
    const at = (t: number) => {
      component.update!(frame(t));
      return { head: head.quaternion.clone(), hips: hips.position.clone() };
    };
    const a = at(10.2);
    const b = at(11.2);
    const c = at(10.45);
    expect(a.head.angleTo(b.head)).toBeLessThan(1e-3);
    expect(a.head.angleTo(c.head)).toBeGreaterThan(0.1);
    expect(a.hips.z).toBeCloseTo(0, 6);
    expect(b.hips.z).toBeCloseTo(0, 6);
  });

  it('swings flexed bones about their own axis on top of the rest pose', async () => {
    const { component, roots } = await build({
      src: 'x.glb',
      flex: [{ match: '^Head$', axis: [1, 0, 0], degrees: 30, period: 2 }],
      instances: [{ position: [0, 0, 0] }],
    });
    const head = bone(roots[0]!, 'Head');
    const angles = [0, 0.25, 0.5, 0.75, 1, 1.5].map((t) => {
      component.update!(frame(t));
      return head.quaternion.angleTo(new Quaternion());
    });
    // Each instance has its own phase, but the swing never exceeds the amplitude and does move.
    expect(Math.max(...angles)).toBeLessThanOrEqual((30 * Math.PI) / 180 + 1e-6);
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(0.1);
  });
});
