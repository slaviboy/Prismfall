import type { Object3D} from 'three/webgpu';
import { AnimationMixer, Box3, Group, Mesh, Vector3, type Material } from 'three/webgpu';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { floatUniform, zVec3 } from './common';
import { createRemapper, materialRuleSchema } from './materialRemap';

const schema = z.object({
  src: z.string(),
  position: zVec3.default([0, 0, 0]),
  rotation: zVec3.default([0, 0, 0]),
  scale: z.number().default(1),
  materials: z.array(materialRuleSchema).default([]),
  /** Use baked vertex-colour AO from Blender (COLOR_0) to darken creases. */
  vertexAO: z.boolean().default(true),
  rotate: z.array(z.object({ match: z.string(), axis: z.enum(['x', 'y', 'z']), speed: z.number(), alternate: z.boolean().default(false), beatSync: z.number().default(0) })).default([]),
  pistons: z.array(z.object({ match: z.string(), axis: z.enum(['x', 'y', 'z']), distance: z.number(), beats: z.number().default(4), stagger: z.number().default(0.5) })).default([]),
  animationSpeed: z.number().default(1),
  castShadow: z.boolean().default(false),
  /** Only keep top-level objects whose names match (reuse part of another kit). */
  include: z.string().optional(),
  /** Drop each top-level object onto the stage ground (terrain layers must come first). */
  snapToGround: z.boolean().default(false),
  /** How far snapped objects sink below the lowest ground point under them. */
  sink: z.number().default(0.5),
  /** Per-object snapping: `highest` for things that span dips (bridges), `center` for small props. */
  snapRules: z.array(z.object({ match: z.string(), mode: z.enum(['lowest', 'center', 'highest', 'fixed']), sink: z.number().optional(), y: z.number().optional() })).default([]),
});

type Params = z.infer<typeof schema>;

/**
 * A Blender-authored scene (GLB) placed in the world. Materials are remapped by name to
 * Prismfall presets; rotating parts and pistons animate procedurally in time with the music.
 */
export const gltfSceneComponent: ComponentFactory<Params> = {
  type: 'gltfScene',
  version: 1,
  description: 'Loads a stage GLB, remaps materials to presets, and animates rotors and beat-synced pistons.',
  schema,
  async create(ctx, p) {
    const gltf = await ctx.assets.loadGLTF(p.src);
    const root = new Group();
    // A clone per use: cached GLTFs are shared between stages (geometry stays shared, materials and
    // visibility are per stage).
    const scene = gltf.scene.clone(true);
    root.add(scene);
    root.position.set(...p.position);
    root.rotation.set(...p.rotation);
    root.scale.setScalar(p.scale);
    if (p.include) {
      const re = new RegExp(p.include, 'i');
      for (const child of [...scene.children]) if (!re.test(child.name)) child.visible = false;
    }
    const u = { emissive: floatUniform(1), music: floatUniform(0), presence: floatUniform(1) };
    const remapper = createRemapper(p.materials, { time: ctx.uniforms.time, presence: u.presence, music: u.music, emissive: u.emissive }, p.vertexAO);
    const remap = (m: Material, hasAO: boolean): Material => remapper.remap(m, hasAO);

    const rotors: { obj: Object3D; axis: 'x' | 'y' | 'z'; speed: number; beatSync: number }[] = [];
    const pistons: { obj: Object3D; axis: 'x' | 'y' | 'z'; distance: number; beats: number; phase: number; base: number }[] = [];
    let pistonIndex = 0;
    scene.traverse((obj) => {
      if (obj instanceof Mesh) {
        const hasAO = obj.geometry.getAttribute('color') !== undefined;
        obj.material = Array.isArray(obj.material) ? obj.material.map((m) => remap(m, hasAO)) : remap(obj.material, hasAO);
        obj.castShadow = p.castShadow;
        obj.receiveShadow = false;
      }
      for (const r of p.rotate) {
        if (new RegExp(r.match, 'i').test(obj.name)) {
          const sign = r.alternate && rotors.length % 2 === 1 ? -1 : 1;
          rotors.push({ obj, axis: r.axis, speed: r.speed * sign, beatSync: r.beatSync });
        }
      }
      for (const pc of p.pistons) {
        if (new RegExp(pc.match, 'i').test(obj.name)) {
          pistons.push({ obj, axis: pc.axis, distance: pc.distance, beats: pc.beats, phase: (pistonIndex++ * pc.stagger) % 1, base: obj.position[pc.axis] });
        }
      }
    });
    if (p.snapToGround) {
      // Sample the ground under each object's footprint and rest it on the lowest point, so nothing
      // floats over a dune trough (partly buried reads naturally in sand and snow).
      root.updateMatrixWorld(true);
      const box = new Box3();
      for (const child of [...scene.children]) {
        box.setFromObject(child);
        const cx = (box.min.x + box.max.x) / 2;
        const cz = (box.min.z + box.max.z) / 2;
        const rule = p.snapRules.find((r) => new RegExp(r.match, 'i').test(child.name));
        const mode = rule?.mode ?? 'lowest';
        const samples = [[cx, cz], [box.min.x, box.min.z], [box.max.x, box.min.z], [box.min.x, box.max.z], [box.max.x, box.max.z]].map(([x, z]) => ctx.ground.height(x as number, z as number));
        // 'fixed' rests the object at an explicit height (a bridge over water spans no ground at all).
        const ground = mode === 'fixed' ? (rule?.y ?? 0) : mode === 'center' ? (samples[0] as number) : mode === 'highest' ? Math.max(...samples) : Math.min(...samples);
        const worldBase = new Vector3().setFromMatrixPosition(child.matrixWorld).y;
        child.position.y += (ground - (rule?.sink ?? p.sink) - worldBase) / root.scale.y;
      }
      root.updateMatrixWorld(true);
    }
    const mixer = gltf.animations.length > 0 ? new AnimationMixer(scene) : null;
    if (mixer) for (const clip of gltf.animations) mixer.clipAction(clip).play();
    return {
      object: root,
      reactive: { emissive: u.emissive },
      update(frame) {
        u.music.value = frame.audio.bass * 0.6 + frame.audio.beatPulse * 0.4;
        const motion = ctx.quality.reducedMotion ? 0.3 : 1;
        for (const r of rotors) {
          const boost = 1 + r.beatSync * frame.audio.beatPulse;
          r.obj.rotation[r.axis] += r.speed * frame.dt * boost * motion;
        }
        const beatPos = frame.audio.beat + frame.audio.beatPhase;
        for (const pc of pistons) {
          const cycle = ((beatPos / pc.beats + pc.phase) % 1 + 1) % 1;
          // Fast strike on the downbeat, slow return: reads as a heavy machine.
          const stroke = cycle < 0.12 ? cycle / 0.12 : 1 - (cycle - 0.12) / 0.88;
          pc.obj.position[pc.axis] = pc.base - pc.distance * Math.pow(Math.max(0, stroke), 1.6) * motion;
        }
        mixer?.update(frame.dt * p.animationSpeed);
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        remapper.dispose();
        mixer?.stopAllAction();
        ctx.assets.release(p.src);
      },
    };
  },
};
