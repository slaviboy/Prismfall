import { AnimationClip, AnimationMixer, Box3, Color, Group, Mesh, PropertyBinding, Quaternion, SkinnedMesh, Vector3, type AnimationAction, type Bone, type Material, type Object3D } from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { sampleModel, type SurfaceSampleSet } from '../../particles/meshSampler';
import { createSurfaceParticles, type SurfaceParticles } from '../../particles/surfaceParticles';
import { createRemapper, materialRuleSchema } from './materialRemap';
import { floatUniform, seeded, zColor, zVec3 } from './common';
import { buildPath, inPlaceClip, orderedStops, pathState, stopWeight, type PathPlan, type PathShape } from './modelMotion';

const zStop = z.object({
  /** Share of the path (0..1) where the walker halts. */
  at: z.number().gt(0).lt(1),
  /** Seconds it stays. */
  for: z.number().positive(),
  /** Clip it plays while it stands (crossfaded in as it slows down); default: the walk pose holds. */
  clip: z.string().optional(),
});

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
         * Walks from `position` through `via` to `to` at `speed` units per second and loops,
         * assembling from its particles at the start and dispersing at the end (`fade`: share of the
         * path; 0 = never). It faces the way it walks; `yaw` is then the model's own heading offset.
         */
        walk: z
          .object({
            to: zVec3,
            /** Waypoints between `position` and `to`. */
            via: z.array(zVec3).max(32).default([]),
            /** Back from `to` to `position` (an endless loop: no assembling or dispersing). */
            closed: z.boolean().default(false),
            /** A smooth curve through the points instead of straight legs. */
            smooth: z.boolean().default(false),
            speed: z.number().positive().default(1.2),
            phase: z.number().min(0).max(1).default(0),
            fade: z.number().min(0).max(0.45).default(0.12),
            /** Pauses along the path, each easing in and out, optionally with its own clip (grazing, howling). */
            stops: z.array(zStop).max(8).default([]),
            /** Seconds to slow into a stop and to get going again. */
            ease: z.number().min(0).default(1.2),
            /** Pitch with the ground slope (snapped) or the path's climb (free). */
            tilt: z.boolean().default(true),
            /** Roll into turns, degrees at the tightest turn (flyers, swimmers). */
            bank: z.number().min(0).max(80).default(0),
          })
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
  /**
   * Skeletal animation: a clip by name (default the first), with per-instance speed and phase
   * variation. `inPlace` removes the clip's own forward motion (root motion) so a walker can follow
   * its path; `stride` is the clip's ground speed in model units per second (measured from the
   * removed root motion when not given). With a stride, a walker's legs follow the distance it
   * covers, so its feet never slide (speed and vary are then unused for it).
   */
  animation: z
    .object({
      clip: z.string().optional(),
      speed: z.number().default(1),
      vary: z.number().min(0).max(0.5).default(0.12),
      inPlace: z.boolean().default(false),
      stride: z.number().positive().optional(),
    })
    .optional(),
  /**
   * Procedural bone swing on top of any clip: bones whose names match `match` turn about `axis`
   * (in the bone's own space) by `degrees` · sin(2π(t / period + phase)) plus `offset`. Each
   * instance gets its own phase. For models whose rig has no usable clip (a turtle's flippers).
   */
  flex: z
    .array(
      z.object({
        match: z.string(),
        axis: zVec3.default([1, 0, 0]),
        degrees: z.number(),
        period: z.number().positive(),
        phase: z.number().default(0),
        offset: z.number().default(0),
      }),
    )
    .max(24)
    .default([]),
  /**
   * solid: the model alone. surface: the model with particles on its surface. particles: only
   * particles sampled from the model. dissolve: the model breaks into its particles and reforms.
   */
  render: z.enum(['solid', 'surface', 'particles', 'dissolve']).default('solid'),
  particles: z
    .object({
      /** Particles per instance. */
      count: z.number().int().min(0).max(60000).default(4000),
      /** Regex on mesh or material names that get no particles (hair cards, shadow planes, props). */
      exclude: z.string().optional(),
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
      /** 0 = flat colour; up to 1 = lit through the surface normal from `light` (reads as a rounded body). */
      shading: z.number().min(0).max(1).default(0),
      /** World direction towards that light. */
      light: zVec3.optional(),
      /** Saturation of the model's own colours (1 as sampled, 0 grey), e.g. to mute painted-in mouth colours. */
      saturation: z.number().min(0).max(1).default(1),
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
const mod = (x: number, m: number): number => ((x % m) + m) % m;
const UP = new Vector3(0, 1, 0);
const SIDE = new Vector3(1, 0, 0);
const AHEAD = new Vector3(0, 0, 1);

/** Bounds of a (possibly skinned) model in its current pose; skinned meshes are posed first. */
function poseBox(scene: Object3D): Box3 {
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!(o instanceof SkinnedMesh)) return;
    o.skeleton.update();
    o.computeBoundingBox();
  });
  return new Box3().setFromObject(scene);
}

/**
 * A real 3D model (Blender export or a licensed scan) placed in the world, keeping its own PBR
 * materials, optionally animated by its skeleton, and optionally represented or enhanced by
 * particles sampled from its actual surface (see meshSampler / surfaceParticles). The solid model
 * fades with a dithered alpha so crossfades and dissolves stay sortable. Instances can walk paths
 * with stops (each with its own clip), feet matched to the clip's stride.
 */
export const modelComponent: ComponentFactory<Params> = {
  type: 'model',
  version: 1,
  description: 'Places a GLB model with its own materials, skeletal animation and surface particles (solid, surface, particles, dissolve); instances can walk paths.',
  schema,
  async create(ctx, p) {
    const gltf = await ctx.assets.loadGLTF(p.src);
    const group = new Group();
    const presence = floatUniform(1);
    const remapper = createRemapper(p.materials, { time: ctx.uniforms.time, presence, music: floatUniform(0), emissive: floatUniform(1) }, false);
    const fading: Material[] = [];
    interface Walker {
      root: Group;
      path: PathShape;
      plan: PathPlan;
      stops: { at: number; for: number; clip?: string }[];
      fade: number;
      heading: number;
      lift: number;
      snap: boolean;
      tilt: boolean;
      bank: number;
      scale: number;
      /** Half the body length along the walking direction (world units), for slope tilt. */
      reach: number;
      particles: SurfaceParticles | null;
      materials: Material[];
      walkAction: AnimationAction | null;
      /** Walk clip time base rate for walkers without a stride (seconds of clip per second). */
      walkRate: number;
      clipOffset: number;
      stopActions: Map<string, AnimationAction>;
      /** 0 = whole, 1 = dispersed (at the path ends). */
      apart: number;
    }
    interface Flexed {
      bone: Bone;
      rest: Quaternion;
      axis: Vector3;
      amp: number;
      offset: number;
      period: number;
      phase: number;
    }
    const walkers: Walker[] = [];
    const mixers: AnimationMixer[] = [];
    const flexed: Flexed[] = [];
    const spinners: { obj: Object3D; axis: Vector3; speed: number }[] = [];
    const particleSets: SurfaceParticles[] = [];
    const rand = seeded(p.particles.seed * 6151);
    const named = (name: string | undefined): AnimationClip | undefined => (name ? gltf.animations.find((a) => a.name === name) : undefined);
    const baseClip: AnimationClip | undefined = p.animation ? (named(p.animation.clip) ?? gltf.animations[0]) : undefined;
    // Nodes `include` keeps: clip tracks aimed at dropped ones are pruned (no unbound tracks).
    let kept: Set<string> | null = null;
    if (p.include) {
      const re = new RegExp(p.include, 'i');
      const names = new Set<string>();
      for (const child of gltf.scene.children) if (re.test(child.name)) child.traverse((o) => (names.add(o.name), names.add(o.uuid)));
      kept = names;
    }
    // Root motion removal works on the untouched source scene (rest pose), once per clip.
    const prepared = new Map<AnimationClip, { clip: AnimationClip; speed: number }>();
    const prepare = (clip: AnimationClip): { clip: AnimationClip; speed: number } => {
      let entry = prepared.get(clip);
      if (!entry) {
        const names = kept;
        const bound = names ? new AnimationClip(clip.name, clip.duration, clip.tracks.filter((t) => names.has(PropertyBinding.parseTrackName(t.name).nodeName)), clip.blendMode) : clip;
        entry = p.animation?.inPlace ? inPlaceClip(bound, gltf.scene) : { clip: bound, speed: 0 };
        prepared.set(clip, entry);
      }
      return entry;
    };
    const walkClip = baseClip ? prepare(baseClip) : undefined;
    const stride = p.animation?.stride ?? walkClip?.speed ?? 0;
    const tint = new Color(p.particles.tint).convertSRGBToLinear();
    const detail = ctx.quality.detail === 'low' ? 0.35 : ctx.quality.detail === 'medium' ? 0.65 : ctx.quality.detail === 'high' ? 1 : 1.3;
    const perInstance = Math.round(p.particles.count * detail * Math.min(1.5, Math.max(0.25, ctx.quality.particles)));
    const flexRules = p.flex.map((f) => ({ ...f, re: new RegExp(f.match, 'i'), axisV: new Vector3(...f.axis).normalize() }));
    // Every instance reuses the first one's samples (same points, its own meshes and skeleton).
    let template: { sets: SurfaceSampleSet[]; meshes: Mesh[] } | null = null;
    const skip = p.particles.exclude ? new RegExp(p.particles.exclude, 'i') : null;
    const sampled = (m: Mesh): boolean => !skip || !(skip.test(m.name) || (Array.isArray(m.material) ? m.material : [m.material]).some((x) => skip.test(x.name)));
    const meshesOf = (root: Object3D): Mesh[] => {
      const out: Mesh[] = [];
      root.traverse((o) => o instanceof Mesh && o.visible && sampled(o) && out.push(o));
      return out;
    };

    for (const inst of p.instances) {
      const scene = cloneSkinned(gltf.scene) as Object3D;
      if (p.include) {
        const re = new RegExp(p.include, 'i');
        for (const child of [...scene.children]) if (!re.test(child.name)) child.removeFromParent();
      }
      const box = poseBox(scene);
      if (p.recenter) {
        const c = box.getCenter(new Vector3());
        scene.position.set(-c.x, -box.min.y, -c.z);
      }
      const size = box.getSize(new Vector3());
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
      let walkAction: AnimationAction | null = null;
      const stopActions = new Map<string, AnimationAction>();
      let mixer: AnimationMixer | null = null;
      if (walkClip) {
        mixer = new AnimationMixer(scene);
        walkAction = mixer.clipAction(walkClip.clip);
        walkAction.timeScale = p.animation!.speed * (1 + (rand() * 2 - 1) * p.animation!.vary);
        walkAction.time = rand() * walkClip.clip.duration;
        walkAction.play();
        mixers.push(mixer);
      }
      const stops = inst.walk ? orderedStops(inst.walk.stops) : [];
      for (const stop of stops) {
        const clip = named(stop.clip);
        if (!clip || stopActions.has(clip.name)) continue;
        mixer ??= new AnimationMixer(scene);
        if (!mixers.includes(mixer)) mixers.push(mixer);
        const action = mixer.clipAction(prepare(clip).clip);
        action.timeScale = 0;
        action.setEffectiveWeight(0);
        action.play();
        stopActions.set(clip.name, action);
      }
      if (flexRules.length > 0) {
        const phase = rand();
        scene.traverse((o) => {
          const rule = flexRules.find((r) => r.re.test(o.name));
          if (!rule || !(o as Bone).isBone) return;
          flexed.push({ bone: o as Bone, rest: o.quaternion.clone(), axis: rule.axisV, amp: (rule.degrees * Math.PI) / 180, offset: (rule.offset * Math.PI) / 180, period: rule.period, phase: rule.phase + phase });
        });
      }
      let instanceParticles: SurfaceParticles | null = null;
      if (p.render !== 'solid' && perInstance > 0) {
        const meshes = meshesOf(scene);
        let sets: SurfaceSampleSet[];
        if (template && template.meshes.length === meshes.length) {
          const from = template;
          sets = from.sets.map((set) => ({ ...set, mesh: meshes[from.meshes.indexOf(set.mesh)]! }));
        } else {
          sets = sampleModel(scene, perInstance, rand, undefined, sampled);
          template = { sets, meshes };
        }
        // Sizes and distances are world units: the particle shader measures them in world space
        // whatever the instance and node scales.
        instanceParticles = createSurfaceParticles(
          sets,
          {
            size: p.particles.size,
            brightness: p.particles.brightness,
            tint: [tint.r, tint.g, tint.b],
            colorMix: p.particles.colorMix,
            blend: p.particles.blend,
            jitter: p.particles.jitter,
            spread: p.particles.spread,
            wind: p.particles.wind,
            bloom: p.particles.bloom,
            shading: p.particles.shading,
            light: p.particles.light,
            saturation: p.particles.saturation,
          },
          ctx.uniforms.time,
        );
        particleSets.push(instanceParticles);
      }
      if (inst.walk) {
        const wk = inst.walk;
        const path = buildPath([new Vector3(x, y, zPos), ...wk.via.map((v) => new Vector3(...v)), new Vector3(...wk.to)], wk.closed, wk.smooth);
        const heading = (inst.yaw * Math.PI) / 180;
        // The model's own forward axis in its space, and its extent along it.
        const fx = Math.abs(Math.sin(-heading));
        const fz = Math.abs(Math.cos(-heading));
        walkers.push({
          root,
          path,
          plan: { length: path.length, speed: wk.speed, phase: wk.phase, stops, ease: wk.ease },
          stops,
          fade: wk.closed ? 0 : wk.fade,
          heading,
          lift: y,
          snap: inst.snapToGround,
          tilt: wk.tilt,
          bank: (wk.bank * Math.PI) / 180,
          scale: inst.scale,
          reach: 0.5 * (fx * size.x + fz * size.z) * inst.scale * 0.7,
          particles: instanceParticles,
          materials: instanceMaterials,
          walkAction,
          walkRate: walkAction?.timeScale ?? 1,
          clipOffset: rand() * (walkClip?.clip.duration ?? 1),
          stopActions,
          apart: 0,
        });
        if (walkAction && stride > 0) walkAction.timeScale = 0;
      }
      if (p.render === 'particles') scene.traverse((o) => o instanceof Mesh && !o.name.endsWith(':particles') && (o.material = hiddenMaterial(o.material)));
    }

    let burst = 0;
    let presenceValue = 1;
    // Bindable particle brightness (dims particle creatures at night, for instance).
    const particleBrightness = floatUniform(p.particles.brightness);
    const apply = (dissolve: number): void => {
      for (const s of particleSets) {
        s.uniforms.dissolve.value = dissolve;
        s.uniforms.presence.value = presenceValue;
        s.uniforms.brightness.value = particleBrightness.value;
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
    const point = new Vector3();
    const tangent = new Vector3();
    const qYaw = new Quaternion();
    const qPitch = new Quaternion();
    const qRoll = new Quaternion();
    const qHead = new Quaternion();
    const walk = (time: number): void => {
      for (const w of walkers) {
        const st = pathState(time, w.plan);
        w.path.sample(st.distance, point, tangent);
        const ground = w.snap ? ctx.ground.height(point.x, point.z) + w.lift : point.y;
        w.root.position.set(point.x, ground, point.z);
        const yaw = Math.atan2(tangent.x, tangent.z);
        let pitch = 0;
        if (w.tilt) {
          if (w.snap) {
            const fx = Math.sin(yaw) * w.reach;
            const fz = Math.cos(yaw) * w.reach;
            pitch = Math.atan2(ctx.ground.height(point.x + fx, point.z + fz) - ctx.ground.height(point.x - fx, point.z - fz), 2 * w.reach);
          } else pitch = Math.atan2(tangent.y, Math.hypot(tangent.x, tangent.z));
        }
        const roll = w.bank > 0 && w.path.maxTurn > 0 ? (-w.bank * w.path.turn(st.distance)) / w.path.maxTurn : 0;
        qYaw.setFromAxisAngle(UP, yaw);
        qPitch.setFromAxisAngle(SIDE, -pitch);
        qRoll.setFromAxisAngle(AHEAD, roll);
        qHead.setFromAxisAngle(UP, w.heading);
        w.root.quaternion.copy(qYaw).multiply(qPitch).multiply(qRoll).multiply(qHead);
        w.apart = w.fade > 0 ? 1 - smooth(Math.min(1, st.t / w.fade, (1 - st.t) / w.fade)) : 0;
        // Clips: the walk follows the distance covered (or slows with the pace); a stop's own clip
        // fades in as the walker slows and plays from its start while it stands.
        const stop = st.stop >= 0 ? w.stops[st.stop] : undefined;
        const stopAction = stop?.clip ? w.stopActions.get(stop.clip) : undefined;
        const weight = stopAction ? stopWeight(st) : 0;
        for (const a of w.stopActions.values()) if (a !== stopAction) a.setEffectiveWeight(0);
        if (stopAction && stop) {
          stopAction.setEffectiveWeight(weight);
          stopAction.time = mod(Math.min(stop.for, Math.max(0, st.stopTime)), stopAction.getClip().duration);
        }
        if (w.walkAction) {
          w.walkAction.setEffectiveWeight(1 - weight);
          if (stride > 0) w.walkAction.time = mod(st.distance / (stride * w.scale) + w.clipOffset, w.walkAction.getClip().duration);
          else w.walkAction.timeScale = w.walkRate * st.pace;
        }
      }
    };
    const flexAt = (time: number): void => {
      for (const f of flexed) f.bone.quaternion.multiply(qYaw.setFromAxisAngle(f.axis, f.offset + f.amp * Math.sin(Math.PI * 2 * (time / f.period + f.phase))));
    };
    walk(0);
    for (const m of mixers) m.update(0);
    flexAt(0);
    apply(0);
    return {
      object: group,
      reactive: { brightness: particleBrightness },
      update(frame) {
        // Flexed bones start from rest each frame; any clip then poses them, and the swing goes on top.
        for (const f of flexed) f.bone.quaternion.copy(f.rest);
        walk(frame.time);
        for (const m of mixers) m.update(frame.dt);
        flexAt(frame.time);
        for (const s of particleSets) s.update();
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
