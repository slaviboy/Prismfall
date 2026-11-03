import type { Object3D} from 'three/webgpu';
import { AnimationMixer, Box3, Color, Group, Mesh, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, Vector3, type Material } from 'three/webgpu';
import { attribute, float, mix, mrt, sin, vec4 } from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { colorUniform, floatUniform, zColor, zVec3 } from './common';
import { revealMask } from './reveal';

const materialRule = z.object({
  /** Regex tested against the Blender material name. */
  match: z.string(),
  preset: z.enum(['darkMetal', 'metal', 'hot', 'emissive', 'glass', 'stone', 'keep']),
  color: zColor.optional(),
  emissive: zColor.optional(),
  emissiveIntensity: z.number().default(1),
  roughness: z.number().optional(),
  metalness: z.number().optional(),
  /** How strongly the emissive part follows the music (0..1). */
  musicGlow: z.number().default(0.5),
});

const schema = z.object({
  src: z.string(),
  position: zVec3.default([0, 0, 0]),
  rotation: zVec3.default([0, 0, 0]),
  scale: z.number().default(1),
  materials: z.array(materialRule).default([]),
  /** Use baked vertex-colour AO from Blender (COLOR_0) to darken creases. */
  vertexAO: z.boolean().default(true),
  rotate: z.array(z.object({ match: z.string(), axis: z.enum(['x', 'y', 'z']), speed: z.number(), alternate: z.boolean().default(false), beatSync: z.number().default(0) })).default([]),
  pistons: z.array(z.object({ match: z.string(), axis: z.enum(['x', 'y', 'z']), distance: z.number(), beats: z.number().default(4), stagger: z.number().default(0.5) })).default([]),
  animationSpeed: z.number().default(1),
  castShadow: z.boolean().default(false),
  /** Drop each top-level object onto the stage ground (terrain layers must come first). */
  snapToGround: z.boolean().default(false),
  /** How far snapped objects sink below the lowest ground point under them. */
  sink: z.number().default(0.5),
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
    const scene = gltf.scene;
    root.add(scene);
    root.position.set(...p.position);
    root.rotation.set(...p.rotation);
    root.scale.setScalar(p.scale);
    const u = { emissive: floatUniform(1), music: floatUniform(0), presence: floatUniform(1) };
    const created: Material[] = [];
    const rules = p.materials.map((r) => ({ ...r, re: new RegExp(r.match, 'i') }));

    const remap = (source: Material, hasAO: boolean): Material => {
      const rule = rules.find((r) => r.re.test(source.name));
      if (!rule || rule.preset === 'keep') return source;
      const baseColor = rule.color ?? ('color' in source && source.color instanceof Color ? `#${source.color.getHexString()}` : '#808080');
      const physical = rule.preset === 'glass';
      const mat = physical ? new MeshPhysicalNodeMaterial() : new MeshStandardNodeMaterial();
      mat.name = source.name;
      mat.color = new Color(baseColor);
      const presets: Record<string, [number, number]> = { darkMetal: [0.45, 0.9], metal: [0.3, 1], hot: [0.6, 0.4], emissive: [0.5, 0.1], glass: [0.05, 0], stone: [0.85, 0] };
      const [rough, metal] = presets[rule.preset] ?? [0.5, 0];
      mat.roughness = rule.roughness ?? rough;
      mat.metalness = rule.metalness ?? metal;
      if (physical) {
        (mat as MeshPhysicalNodeMaterial).clearcoat = 1;
        (mat as MeshPhysicalNodeMaterial).transmission = 0;
      }
      const ao = hasAO && p.vertexAO ? mix(float(0.35), float(1), attribute<'vec4'>('color', 'vec4').r) : float(1);
      mat.colorNode = vec4(colorUniform(baseColor).mul(ao), 1);
      mat.opacityNode = revealMask(u.presence);
      mat.alphaTest = 0.5;
      if (rule.emissive) {
        const flicker = rule.preset === 'hot' ? sin(ctx.uniforms.time.mul(2.3)).mul(0.08).add(0.92) : float(1);
        const glow = colorUniform(rule.emissive)
          .mul(rule.emissiveIntensity)
          .mul(flicker)
          .mul(float(1).add(u.music.mul(rule.musicGlow)))
          .mul(u.emissive)
          .mul(u.presence);
        mat.emissiveNode = glow;
        mat.mrtNode = mrt({ emissive: vec4(glow, 1) });
      }
      created.push(mat);
      return mat;
    };

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
        let ground = Infinity;
        for (const [x, z] of [[cx, cz], [box.min.x, box.min.z], [box.max.x, box.min.z], [box.min.x, box.max.z], [box.max.x, box.max.z]] as const) ground = Math.min(ground, ctx.ground.height(x, z));
        const worldBase = new Vector3().setFromMatrixPosition(child.matrixWorld).y;
        child.position.y += (ground - p.sink - worldBase) / root.scale.y;
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
        created.forEach((m) => m.dispose());
        mixer?.stopAllAction();
        ctx.assets.release(p.src);
      },
    };
  },
};
