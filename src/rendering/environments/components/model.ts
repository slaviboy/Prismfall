import { AnimationMixer, Box3, Color, Group, Mesh, Vector3, type AnimationClip, type Material, type Object3D } from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { sampleModel } from '../../particles/meshSampler';
import { createSurfaceParticles, type SurfaceParticles } from '../../particles/surfaceParticles';
import { createRemapper, materialRuleSchema } from './materialRemap';
import { floatUniform, seeded, zColor, zVec3 } from './common';

const schema = z.object({
  src: z.string(),
  /** Regex on top-level node names to keep (others are dropped). */
  include: z.string().optional(),
  /** Move the kept nodes so their footprint centre is the origin and their base sits at y = 0. */
  recenter: z.boolean().default(true),
  instances: z
    .array(
      z.object({
        position: zVec3,
        /** Heading in degrees. */
        yaw: z.number().default(0),
        scale: z.number().positive().default(1),
        /** Sit on the terrain (position y becomes an offset from the ground). */
        snapToGround: z.boolean().default(true),
        /** Slow tumble around a random axis, degrees per second (floating rocks, debris). */
        spin: z.number().default(0),
        /**
         * Walks from `position` to `to` at `speed` units per second and loops, assembling from its
         * particles at the start and dispersing at the end (`fade`: share of the path). It faces the
         * way it walks; `yaw` is then the model's own heading offset.
         */
        walk: z
          .object({ to: zVec3, speed: z.number().positive().default(1.2), phase: z.number().min(0).max(1).default(0), fade: z.number().min(0.01).max(0.45).default(0.12) })
          .optional(),
      }),
    )
    .min(1),
  /** Optional material rules; unmatched materials keep the model's own PBR textures. */
  materials: z.array(materialRuleSchema).default([]),
  /** Scales the materials' own colour (night scenes dim real assets without dimming the board). */
  exposure: z.number().min(0).default(1),
  /** Multiplies the materials' colour (sRGB hex), e.g. a cool moonlight cast. */
  tint: zColor.optional(),
  castShadow: z.boolean().default(false),
  /** Skeletal animation: a clip by name (default the first), with per-instance speed and phase variation. */
  animation: z.object({ clip: z.string().optional(), speed: z.number().default(1), vary: z.number().min(0).max(0.5).default(0.12) }).optional(),
  /**
   * solid: the model alone. surface: the model with particles on its surface. particles: only
   * particles sampled from the model. dissolve: the model breaks into its particles and reforms.
   */
  render: z.enum(['solid', 'surface', 'particles', 'dissolve']).default('solid'),
  particles: z
    .object({
      /** Particles per instance. */
      count: z.number().int().min(0).max(60000).default(4000),
      size: z.number().positive().default(0.25),
      brightness: z.number().min(0).default(1),
      tint: zColor.default('#ffffff'),
      /** 0 = the model's own surface colours, 1 = the tint. */
      colorMix: z.number().min(0).max(1).default(0),
      blend: z.enum(['additive', 'normal']).default('additive'),
      jitter: z.number().min(0).default(0.02),
      spread: z.number().min(0).default(6),
      wind: zVec3.default([3, 1, 0]),
      bloom: z.number().min(0).default(0.3),
      seed: z.number().default(1),
    })
    .prefault({}),
  dissolve: z
    .object({
      /** Seconds per cycle (solid, break apart, hold, reform). */
      period: z.number().positive().default(30),
      /** Also break apart on QUADs and perfect clears. */
      onBigClears: z.boolean().default(true),
    })
    .prefault({}),
});

type Params = z.infer<typeof schema>;

/** Dissolve curve over one cycle: solid, 3 s apart, 2.5 s scattered, 4 s back together. */
function cycleDissolve(t: number, period: number): number {
  const apart = 3;
  const hold = 2.5;
  const back = 4;
  const solid = Math.max(0, period - apart - hold - back);
  const x = ((t % period) + period) % period;
  if (x < solid) return 0;
  if (x < solid + apart) return (x - solid) / apart;
  if (x < solid + apart + hold) return 1;
  return Math.max(0, 1 - (x - solid - apart - hold) / back);
}

const smooth = (x: number): number => x * x * (3 - 2 * x);

/**
 * A real 3D model (Blender export or a licensed scan) placed in the world, keeping its own PBR
 * materials, optionally animated by its skeleton, and optionally represented or enhanced by
 * particles sampled from its actual surface (see meshSampler / surfaceParticles). The solid model
 * fades with a dithered alpha so crossfades and dissolves stay sortable.
 */
export const modelComponent: ComponentFactory<Params> = {
  type: 'model',
  version: 1,
  description: 'Places a GLB model with its own materials, skeletal animation and surface particles (solid, surface, particles, dissolve).',
  schema,
  async create(ctx, p) {
    const gltf = await ctx.assets.loadGLTF(p.src);
    const group = new Group();
    const presence = floatUniform(1);
    const remapper = createRemapper(p.materials, { time: ctx.uniforms.time, presence, music: floatUniform(0), emissive: floatUniform(1) }, false);
    const fading: Material[] = [];
    interface Walker {
      root: Group;
      from: Vector3;
      to: Vector3;
      length: number;
      speed: number;
      phase: number;
      fade: number;
      heading: number;
      lift: number;
      snap: boolean;
      particles: SurfaceParticles | null;
      materials: Material[];
      /** 0 = whole, 1 = dispersed (at the path ends). */
      apart: number;
    }
    const walkers: Walker[] = [];
    const mixers: AnimationMixer[] = [];
    const spinners: { obj: Object3D; axis: Vector3; speed: number }[] = [];
    const particleSets: SurfaceParticles[] = [];
    const rand = seeded(p.particles.seed * 6151);
    const clip: AnimationClip | undefined = p.animation ? (gltf.animations.find((a) => a.name === p.animation?.clip) ?? gltf.animations[0]) : undefined;
    const tint = new Color(p.particles.tint).convertSRGBToLinear();
    const detail = ctx.quality.detail === 'low' ? 0.35 : ctx.quality.detail === 'medium' ? 0.65 : ctx.quality.detail === 'high' ? 1 : 1.3;
    const perInstance = Math.round(p.particles.count * detail * Math.min(1.5, Math.max(0.25, ctx.quality.particles)));

    for (const inst of p.instances) {
      const scene = cloneSkinned(gltf.scene) as Object3D;
      if (p.include) {
        const re = new RegExp(p.include, 'i');
        for (const child of [...scene.children]) if (!re.test(child.name)) child.removeFromParent();
      }
      if (p.recenter) {
        const box = new Box3().setFromObject(scene);
        const c = box.getCenter(new Vector3());
        scene.position.set(-c.x, -box.min.y, -c.z);
      }
      const root = new Group();
      root.add(scene);
      const [x, y, zPos] = inst.position;
      root.position.set(x, inst.snapToGround ? ctx.ground.height(x, zPos) + y : y, zPos);
      root.rotation.y = (inst.yaw * Math.PI) / 180;
      root.scale.setScalar(inst.scale);
      if (inst.spin !== 0) {
        root.rotation.set(rand() * Math.PI * 2, root.rotation.y, rand() * Math.PI * 2);
        spinners.push({ obj: root, axis: new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(), speed: (inst.spin * Math.PI) / 180 });
      }
      const instanceMaterials: Material[] = [];
      scene.traverse((o) => {
        if (!(o instanceof Mesh)) return;
        const convert = (m: Material): Material => {
          // A per-instance copy that can fade (dithered alpha keeps depth sorting intact).
          const out = remapper.remap(m, false).clone();
          out.alphaHash = true;
          const c = (out as Material & { color?: Color }).color;
          if (c instanceof Color) {
            c.multiplyScalar(p.exposure);
            if (p.tint) c.multiply(new Color(p.tint));
          }
          fading.push(out);
          instanceMaterials.push(out);
          return out;
        };
        o.material = Array.isArray(o.material) ? o.material.map(convert) : convert(o.material);
        o.castShadow = p.castShadow;
        o.receiveShadow = false;
        o.frustumCulled = false;
      });
      group.add(root);
      if (clip) {
        const mixer = new AnimationMixer(scene);
        const action = mixer.clipAction(clip);
        action.timeScale = p.animation!.speed * (1 + (rand() * 2 - 1) * p.animation!.vary);
        action.time = rand() * clip.duration;
        action.play();
        mixers.push(mixer);
      }
      let instanceParticles: SurfaceParticles | null = null;
      if (p.render !== 'solid' && perInstance > 0) {
        const sets = sampleModel(scene, perInstance, rand);
        // Sizes and distances are given in world units; particles live in model units.
        const unit = 1 / inst.scale;
        instanceParticles = createSurfaceParticles(
            sets,
            {
              size: p.particles.size * unit,
              brightness: p.particles.brightness,
              tint: [tint.r, tint.g, tint.b],
              colorMix: p.particles.colorMix,
              blend: p.particles.blend,
              jitter: p.particles.jitter,
              spread: p.particles.spread,
              wind: p.particles.wind,
              bloom: p.particles.bloom,
            },
            ctx.uniforms.time,
          );
        particleSets.push(instanceParticles);
      }
      if (inst.walk) {
        const from = new Vector3(x, y, zPos);
        const to = new Vector3(...inst.walk.to);
        walkers.push({
          root,
          from,
          to,
          length: Math.max(0.01, from.distanceTo(to)),
          speed: inst.walk.speed,
          phase: inst.walk.phase,
          fade: inst.walk.fade,
          heading: (inst.yaw * Math.PI) / 180,
          lift: y,
          snap: inst.snapToGround,
          particles: instanceParticles,
          materials: instanceMaterials,
          apart: 0,
        });
      }
      if (p.render === 'particles') scene.traverse((o) => o instanceof Mesh && !o.name.endsWith(':particles') && (o.material = hiddenMaterial(o.material)));
    }

    let burst = 0;
    let presenceValue = 1;
    const apply = (dissolve: number): void => {
      for (const s of particleSets) {
        s.uniforms.dissolve.value = dissolve;
        s.uniforms.presence.value = presenceValue;
      }
      const solid = p.render === 'dissolve' ? 1 - smooth(Math.min(1, dissolve * 1.4)) : 1;
      for (const m of fading) m.opacity = solid * presenceValue;
      // Walkers assemble and disperse at their path ends on top of any shared dissolve.
      for (const w of walkers) {
        const d = Math.max(dissolve, w.apart);
        if (w.particles) w.particles.uniforms.dissolve.value = d;
        const wSolid = 1 - smooth(Math.min(1, d * 1.4));
        for (const m of w.materials) m.opacity = wSolid * presenceValue;
      }
    };
    const step = new Vector3();
    const walk = (time: number): void => {
      for (const w of walkers) {
        const t = (((w.phase + (time * w.speed) / w.length) % 1) + 1) % 1;
        step.lerpVectors(w.from, w.to, t);
        const ground = w.snap ? ctx.ground.height(step.x, step.z) + w.lift : step.y;
        w.root.position.set(step.x, ground, step.z);
        w.root.rotation.y = Math.atan2(w.to.x - w.from.x, w.to.z - w.from.z) + w.heading;
        w.apart = 1 - smooth(Math.min(1, t / w.fade, (1 - t) / w.fade));
      }
    };
    walk(0);
    apply(0);
    return {
      object: group,
      update(frame) {
        for (const m of mixers) m.update(frame.dt);
        walk(frame.time);
        for (const s of spinners) s.obj.rotateOnAxis(s.axis, s.speed * frame.dt);
        burst = Math.max(0, burst - frame.dt / 6);
        let dissolve = 0;
        if (p.render === 'dissolve') dissolve = Math.max(cycleDissolve(frame.time, p.dissolve.period), burst > 0 ? Math.min(1, burst * 3) : 0);
        apply(dissolve);
      },
      onGameEvent(e) {
        if (p.render === 'dissolve' && p.dissolve.onBigClears && e.kind === 'clear' && (e.lines >= 4 || e.perfectClear)) burst = 1;
      },
      setPresence(v) {
        presenceValue = v;
        presence.value = v;
        apply(0);
      },
      dispose() {
        for (const s of particleSets) s.dispose();
        for (const m of fading) m.dispose();
        for (const mixer of mixers) mixer.stopAllAction();
        remapper.dispose();
      },
    };
  },
};

/** Particles-only mode keeps the meshes (their skeletons drive the particles) but draws nothing. */
function hiddenMaterial(m: Material | Material[]): Material | Material[] {
  const hide = (x: Material): Material => {
    x.visible = false;
    return x;
  };
  return Array.isArray(m) ? m.map(hide) : hide(m);
}
