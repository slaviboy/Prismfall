import { AnimationClip, AnimationMixer, Box3, Color, Group, LoopOnce, Mesh, PropertyBinding, Quaternion, SkinnedMesh, Vector3, type AnimationAction, type Bone, type Material, type Object3D } from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { z } from 'zod';
import type { CallInfo, ComponentFactory } from '../../../sdk/types';
import { sampleModel, type SurfaceSampleSet } from '../../particles/meshSampler';
import { createSurfaceParticles, type GlowOptions, type SurfaceParticleOptions, type SurfaceParticles } from '../../particles/surfaceParticles';
import { createRemapper, materialRuleSchema } from './materialRemap';
import { floatUniform, seeded, zColor, zVec3 } from './common';
import { RevealTracker, buildPath, inPlaceClip, orderedStops, passWaypoints, pathState, stopWeight, type PathPlan, type PathShape } from './modelMotion';

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
         * Kept out of sight until a `pass` call-in sends it past the camera (since SDK 1.5); its
         * position only sets where it rests unseen, and `walk` is ignored.
         */
        pass: z.boolean().default(false),
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
   * Arrival with the run: the creatures assemble from their particles as game progress (0..1)
   * goes from `from` to `to` (hidden before; in menus progress is 0). Once progress reaches
   * `unlock`, a QUAD or a perfect clear also calls them in for `hold` seconds. Unset: always there.
   */
  reveal: z
    .object({
      from: z.number().min(0).max(1).default(0),
      to: z.number().min(0).max(1).default(0.1),
      unlock: z.number().min(0).max(2).default(2),
      hold: z.number().positive().default(24),
    })
    .optional(),
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
      /**
       * surface: plain dots coloured by the model. glow: luminous moving points (additive; dark
       * worlds). glowEdges: the plain dots plus a lighter overlay of glowing edges and shed sparkles
       * (bright worlds, where pure glow would wash out).
       */
      style: z.enum(['surface', 'glow', 'glowEdges']).default('surface'),
      /** The glowing points (styles glow and glowEdges); distances are world units. */
      glow: z
        .object({
          color: zColor.default('#5ad8ff'),
          /** 0 = the glow colour only, 1 = the model's own colours lifted to glow. */
          textureMix: z.number().min(0).max(1).default(0.2),
          /** Face-on body brightness relative to the edges: lower = stronger outlines. */
          core: z.number().min(0).max(1).default(0.35),
          edge: z.number().min(0).max(2).default(1),
          twinkle: z.number().min(0).max(1).default(0.5),
          /** Share of points that now and then flash. */
          sparkle: z.number().min(0).max(1).default(0.1),
          /** Orbit of each point around its surface point. */
          drift: z.number().min(0).default(0.04),
          /** Length and rate of the slow stream of points along the body. */
          flow: z.number().min(0).default(0.25),
          flowRate: z.number().min(0).default(0.12),
          /** Share of points shed into a fading wake behind the moving creature, their life and wander. */
          shed: z.number().min(0).max(1).default(0.12),
          shedLife: z.number().positive().default(2.5),
          shedSpread: z.number().min(0).default(1.2),
          /** Bass slowly breathes the glow; treble adds sparkle (both 0..1, never on the beat). */
          breathe: z.number().min(0).max(1).default(0.3),
          shimmer: z.number().min(0).max(1).default(0.4),
          /** glowEdges: share of `count` drawn as the glowing overlay. */
          overlay: z.number().min(0).max(1).default(0.35),
          /** Size of the glowing points relative to `size`. */
          size: z.number().positive().default(1),
          /** Brightness of the glowing points relative to `brightness` (glow), or absolute for the glowEdges overlay. */
          brightness: z.number().min(0).default(1),
        })
        .prefault({}),
      /** Shimmer as the world clear wave passes the creatures (x their light; 0 = off). Since SDK 1.5. */
      clearWave: z.number().min(0).default(0),
      seed: z.number().default(1),
    })
    .prefault({}),
  /**
   * Near-field passes (since SDK 1.5): a `pass` call-in sends an instance marked `pass` along a path
   * close in front of the camera, on one side of the board and never across its screen rectangle
   * (widened by `margin`, in NDC): from `distance[1]` units away in to `distance[0]` (`in`), or out
   * the other way, over `duration` seconds, at NDC height `height`. `ground` keeps it on the terrain
   * (walkers) instead of flying; `y` keeps it at that world height instead (a swimmer at the water
   * line), and `arc` with `leaps` lifts it into that many leaps of `arc` units along the way, nose
   * following the arc. A call's params may override any of these, plus `instance` (index) and `side`
   * (`left`, `right`).
   */
  pass: z
    .object({
      duration: z.number().positive().default(7),
      distance: z.tuple([z.number().positive(), z.number().positive()]).default([18, 140]),
      height: z.number().min(-0.9).max(0.9).default(-0.15),
      margin: z.number().min(0).max(0.8).default(0.18),
      direction: z.enum(['in', 'out', 'alternate']).default('in'),
      side: z.enum(['left', 'right', 'alternate']).default('alternate'),
      ground: z.boolean().optional(),
      y: z.number().optional(),
      arc: z.number().min(0).default(0),
      leaps: z.number().int().min(1).max(12).default(1),
      scale: z.number().positive().default(1),
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
      /** The glowing overlay of style glowEdges. */
      overlay: SurfaceParticles | null;
      /** World velocity along the path (for the glow wake). */
      velocity: Vector3;
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
    /** Per instance: what call-ins and the bindable `visible` share act on. */
    interface Inst {
      root: Group;
      scene: Object3D;
      mixer: AnimationMixer | null;
      /** The looping clip it normally plays (walk or idle). */
      base: AnimationAction | null;
      walker: Walker | null;
      sets: SurfaceParticles[];
      materials: Material[];
      scale: number;
      heading: number;
      snap: boolean;
      lift: number;
      /** Shown share 0..1 (it fades towards its target at `fadeRate` per second). */
      fade: number;
      fadeRate: number;
      /** A show or hide call's override of the bindable visible share, until `overrideUntil`. */
      override: number | null;
      overrideUntil: number;
      passer: boolean;
      oneShot: { action: AnimationAction; start: number; duration: number; fade: number } | null;
      run: { path: PathShape; start: number; duration: number; ground: boolean; arc: number; leaps: number } | null;
    }
    const insts: Inst[] = [];
    const mixers: AnimationMixer[] = [];
    const flexed: Flexed[] = [];
    const spinners: { obj: Object3D; axis: Vector3; speed: number }[] = [];
    const particleSets: SurfaceParticles[] = [];
    /** Brightness of a set relative to the layer's (bindable) particle brightness. */
    const brightnessOf = new Map<SurfaceParticles, number>();
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
    // The glowing style; reduced motion keeps the glow but calms the drift and sheds much less.
    const g = p.particles.glow;
    const calm = ctx.quality.reducedMotion ? 0.3 : 1;
    const glowColor = new Color(g.color).convertSRGBToLinear();
    const glowOptions: GlowOptions = {
      color: [glowColor.r, glowColor.g, glowColor.b],
      textureMix: g.textureMix,
      core: g.core,
      edge: g.edge,
      twinkle: g.twinkle,
      sparkle: g.sparkle,
      drift: g.drift * (0.5 + calm * 0.5),
      flow: g.flow * calm,
      flowRate: g.flowRate,
      shed: g.shed * calm,
      shedLife: g.shedLife,
      shedSpread: g.shedSpread,
      breathe: g.breathe,
      shimmer: g.shimmer,
    };
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
      let instanceOverlay: SurfaceParticles | null = null;
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
        const options: SurfaceParticleOptions = {
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
          clearWave: p.particles.clearWave,
        };
        const glowing = { ...options, size: p.particles.size * p.particles.glow.size, glow: glowOptions };
        instanceParticles = createSurfaceParticles(sets, p.particles.style === 'glow' ? glowing : options, ctx.uniforms.time);
        particleSets.push(instanceParticles);
        if (p.particles.style === 'glow') brightnessOf.set(instanceParticles, p.particles.glow.brightness);
        if (p.particles.style === 'glowEdges' && p.particles.glow.overlay > 0) {
          instanceOverlay = createSurfaceParticles(subsetSets(sets, p.particles.glow.overlay), glowing, ctx.uniforms.time);
          particleSets.push(instanceOverlay);
          brightnessOf.set(instanceOverlay, p.particles.glow.brightness / Math.max(1e-3, p.particles.brightness));
          // Transparent objects draw back to front by their geometry's centre. The overlay's own centre
          // sits a little off its dots', so from some sides it drew first and the dots covered it. With
          // the dots' centre the depths tie and creation order keeps it on top from every side.
          for (const o of instanceOverlay.objects) {
            const dots = instanceParticles.objects.find((b) => b.parent === o.parent);
            if (!dots) continue;
            if (!dots.geometry.boundingSphere) dots.geometry.computeBoundingSphere();
            if (dots.geometry.boundingSphere) o.geometry.boundingSphere = dots.geometry.boundingSphere.clone();
          }
        }
      }
      if (inst.walk && !inst.pass) {
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
          overlay: instanceOverlay,
          velocity: new Vector3(),
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
      const walker = inst.walk && !inst.pass ? (walkers[walkers.length - 1] ?? null) : null;
      insts.push({
        root,
        scene,
        mixer,
        base: walkAction,
        walker,
        sets: [instanceParticles, instanceOverlay].filter((x): x is SurfaceParticles => x !== null),
        materials: instanceMaterials,
        scale: inst.scale,
        heading: (inst.yaw * Math.PI) / 180,
        snap: inst.snapToGround,
        lift: y,
        fade: inst.pass ? 0 : 1,
        fadeRate: 1,
        override: null,
        overrideUntil: 0,
        passer: inst.pass,
        oneShot: null,
        run: null,
      });
    }

    let burst = 0;
    /** A `burst` call on a model that does not dissolve: the particles flare and fade back. */
    let shimmer = 0;
    let presenceValue = 1;
    // Bindable: pace scales walking and clips; visible is the share of instances shown.
    const pace = floatUniform(1);
    const visibleShare = floatUniform(1);
    /** Walk and clip clock: frame time advanced at `pace` (equal to it while pace stays 1). */
    let clock = Number.NaN;
    let lastTime = 0;
    let passCount = 0;
    // Bindable particle brightness (dims particle creatures at night, for instance).
    const particleBrightness = floatUniform(p.particles.brightness);
    // Arrival with the run (reveal): 0 = not here yet (scattered and dark), 1 = whole.
    const reveal = new RevealTracker(p.reveal);
    let revealLevel = reveal.level;
    let breath = 0;
    let sparkle = 0;
    const apply = (shared: number): void => {
      const dissolve = Math.max(shared, 1 - revealLevel);
      const arrived = presenceValue * smooth(Math.min(1, revealLevel * 4));
      const solid = p.render === 'dissolve' ? 1 - smooth(Math.min(1, dissolve * 1.4)) : 1;
      const lift = 1 + shimmer;
      for (const it of insts) {
        // Hidden instances (show/hide, the visible share, passes) break into their particles and fade.
        const f = it.fade;
        const away = 1 - f;
        // Walkers assemble and disperse at their path ends on top of any shared dissolve.
        const d = Math.max(dissolve, it.walker?.apart ?? 0, away);
        const shown = arrived * smooth(Math.min(1, f * 1.6));
        for (const s of it.sets) {
          s.uniforms.dissolve.value = d;
          s.uniforms.presence.value = shown;
          // Not yet arrived (or hidden): skip drawing (and skinning) them at all.
          if (p.reveal || it.passer || f < 1) for (const o of s.objects) o.visible = shown > 1e-3;
          s.uniforms.brightness.value = particleBrightness.value * (brightnessOf.get(s) ?? 1) * lift;
        }
        const own = it.walker || away > 0 ? 1 - smooth(Math.min(1, d * 1.4)) : solid;
        for (const m of it.materials) m.opacity = own * presenceValue;
        it.root.visible = f > 1e-3;
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
        w.velocity.copy(tangent).multiplyScalar(w.plan.speed * st.pace);
        if (w.particles) w.particles.uniforms.velocity.value.copy(w.velocity);
        if (w.overlay) w.overlay.uniforms.velocity.value.copy(w.velocity);
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
    // ---- call-ins (since SDK 1.5): clips, near-field passes, show and hide ----
    const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const pick = (v: unknown, fallback: Inst[]): Inst[] => {
      if (Array.isArray(v)) return v.map((i) => insts[Math.round(num(i, -1))]).filter((x): x is Inst => x !== undefined);
      if (v === 'random') {
        const pool = fallback.filter((i) => i.fade > 0.5);
        const one = pool[Math.floor(rand() * pool.length)];
        return one ? [one] : [];
      }
      return fallback;
    };
    const regular = insts.filter((i) => !i.passer);
    /** Plays a clip once on an instance, crossfaded in and out over the base clip. */
    const playClip = (it: Inst, name: string, speed: number, fade: number, delay: number): boolean => {
      const clip = named(name);
      if (!clip) return false;
      if (!it.mixer) {
        it.mixer = new AnimationMixer(it.scene);
        mixers.push(it.mixer);
      }
      it.oneShot?.action.stop();
      const action = it.mixer.clipAction(prepare(clip).clip);
      action.reset();
      action.setLoop(LoopOnce, 1);
      action.clampWhenFinished = false;
      action.timeScale = speed;
      action.setEffectiveWeight(0);
      action.play();
      action.paused = delay > 0;
      it.oneShot = { action, start: clock + delay, duration: clip.duration / Math.max(0.05, speed), fade };
      return true;
    };
    const tickClips = (time: number): void => {
      for (const it of insts) {
        const o = it.oneShot;
        if (!o) continue;
        const t = time - o.start;
        if (t >= o.duration) {
          o.action.stop();
          it.oneShot = null;
          if (it.base && !it.walker) it.base.setEffectiveWeight(1);
          continue;
        }
        if (t < 0) continue;
        o.action.paused = false;
        const w = smooth(Math.max(0, Math.min(1, t / o.fade, (o.duration - t) / o.fade)));
        o.action.setEffectiveWeight(w);
        // The walk weight was just set by walk(); idle clips sit at 1.
        if (it.base) it.base.setEffectiveWeight((it.walker ? it.base.getEffectiveWeight() : 1) * (1 - w));
      }
    };
    let passSide = 1;
    let passDir = 1;
    /** Sends a `pass` instance close past the camera, clear of the board on screen. */
    const startPass = (call: CallInfo): void => {
      const view = ctx.view;
      if (!view) return;
      const q = call.params;
      const cfg = p.pass;
      const idle = insts.filter((i) => i.passer && !i.run);
      const it = typeof q.instance === 'number' ? insts[Math.round(q.instance)] : idle[passCount % Math.max(1, idle.length)];
      if (!it || it.run) return;
      passCount++;
      const sideParam = typeof q.side === 'string' ? q.side : cfg.side;
      const side: 1 | -1 = sideParam === 'left' ? -1 : sideParam === 'right' ? 1 : (passSide = -passSide) > 0 ? 1 : -1;
      const dirParam = typeof q.direction === 'string' ? q.direction : cfg.direction;
      const direction = dirParam === 'out' ? 'out' : dirParam === 'in' ? 'in' : (passDir = -passDir) > 0 ? 'in' : 'out';
      const dist = Array.isArray(q.distance) ? [num(q.distance[0], cfg.distance[0]), num(q.distance[1], cfg.distance[1])] : cfg.distance;
      const pts = passWaypoints(view.boardRect(), side, direction, num(q.height, cfg.height), dist[0] as number, dist[1] as number, num(q.margin, cfg.margin));
      const fixedY = typeof q.y === 'number' ? q.y : cfg.y;
      const ground = fixedY === undefined && (typeof q.ground === 'boolean' ? q.ground : (cfg.ground ?? it.snap));
      const world = pts.map((w) => view.toWorld(w.x, w.y, w.distance, new Vector3()));
      if (ground) for (const w of world) w.y = ctx.ground.height(w.x, w.z) + it.lift;
      else if (fixedY !== undefined) for (const w of world) w.y = fixedY;
      it.run = { path: buildPath(world, false, true), start: clock, duration: Math.max(1, num(q.duration, cfg.duration)), ground, arc: Math.max(0, num(q.arc, cfg.arc)), leaps: Math.max(1, Math.round(num(q.leaps, cfg.leaps))) };
      it.root.scale.setScalar(it.scale * num(q.scale, cfg.scale));
    };
    const passVelocity = new Vector3();
    const runPasses = (time: number): void => {
      for (const it of insts) {
        const r = it.run;
        if (!r) continue;
        const t = (time - r.start) / r.duration;
        if (t >= 1) {
          it.run = null;
          it.fade = 0;
          continue;
        }
        const distance = r.path.length * t;
        r.path.sample(distance, point, tangent);
        // Leaps: ballistic-looking arcs that touch down between them; the nose follows the arc.
        const leap = (u: number): number => r.arc * Math.pow(Math.abs(Math.sin(Math.PI * r.leaps * u)), 0.85);
        const rise = r.arc > 0 ? (leap(Math.min(1, t + 0.002)) - leap(Math.max(0, t - 0.002))) / (0.004 * r.path.length) : 0;
        it.root.position.set(point.x, (r.ground ? ctx.ground.height(point.x, point.z) + it.lift : point.y) + leap(t), point.z);
        const yaw = Math.atan2(tangent.x, tangent.z);
        const pitch = r.ground ? 0 : Math.atan2(tangent.y + rise, Math.hypot(tangent.x, tangent.z));
        qYaw.setFromAxisAngle(UP, yaw);
        qPitch.setFromAxisAngle(SIDE, -pitch);
        qHead.setFromAxisAngle(UP, it.heading);
        it.root.quaternion.copy(qYaw).multiply(qPitch).multiply(qHead);
        // Assembles out of the distance, and is gone by the time it leaves the frame close by.
        it.fade = smooth(Math.max(0, Math.min(1, t / 0.12, (1 - t) / 0.1)));
        passVelocity.copy(tangent).multiplyScalar(r.path.length / r.duration);
        for (const set of it.sets) set.uniforms.velocity.value.copy(passVelocity);
        if (it.base && stride > 0) it.base.time = mod(distance / (stride * it.root.scale.x), it.base.getClip().duration);
      }
    };
    /** Visibility targets: the bindable share of the regular instances, show/hide overrides on top. */
    const fadeTowards = (time: number, dt: number): void => {
      const share = Math.max(0, Math.min(1, visibleShare.value)) * regular.length;
      regular.forEach((it, k) => {
        if (it.override !== null && time > it.overrideUntil) it.override = null;
        const target = it.override ?? Math.max(0, Math.min(1, share - k));
        it.fade += (target - it.fade) * (1 - Math.exp(-dt * it.fadeRate * 2.2));
        if (Math.abs(target - it.fade) < 1e-3) it.fade = target;
      });
      for (const it of insts) if (it.passer && !it.run) it.fade = 0;
    };
    const onCall = (call: CallInfo): void => {
      const q = call.params;
      // Before the first frame the walk clock has not started: it will start at the call's time.
      if (Number.isNaN(clock)) clock = lastTime = call.time;
      switch (call.action) {
        case 'clip': {
          if (typeof q.clip !== 'string') return;
          const targets = pick(q.instances, regular.filter((i) => i.fade > 0.5));
          const stagger = num(q.stagger, 0.15);
          targets.forEach((it, i) => playClip(it, q.clip as string, num(q.speed, 1), Math.max(0.05, num(q.fade, 0.35)), i * stagger + rand() * stagger * 0.5));
          return;
        }
        case 'pass':
          startPass(call);
          return;
        case 'show':
        case 'hide': {
          const seconds = Math.max(0.1, num(q.seconds, 1.5));
          const hold = num(q.hold, 0);
          for (const it of pick(q.instances, regular)) {
            it.override = call.action === 'show' ? 1 : 0;
            it.overrideUntil = hold > 0 ? clock + hold : Number.POSITIVE_INFINITY;
            it.fadeRate = 1 / seconds;
          }
          return;
        }
        case 'reveal':
          reveal.callIn(num(q.hold, p.reveal?.hold ?? 0));
          return;
        case 'burst':
          if (p.render === 'dissolve') burst = 1;
          else shimmer = Math.min(1.5, shimmer + num(q.strength, 0.8) * Math.min(1, call.strength));
          return;
        default:
          return;
      }
    };

    walk(0);
    for (const m of mixers) m.update(0);
    flexAt(0);
    apply(0);
    return {
      object: group,
      reactive: { brightness: particleBrightness, pace, visible: visibleShare },
      onCall,
      update(frame) {
        // Walks, clips and bone swings run on their own clock at the bindable pace.
        // It follows the frame clock exactly at pace 1, so walks keep their place in time.
        const rate = Math.max(0, pace.value);
        clock = Number.isNaN(clock) ? frame.time : clock + (frame.time - lastTime) * rate;
        lastTime = frame.time;
        const dtp = frame.dt * rate;
        // Flexed bones start from rest each frame; any clip then poses them, and the swing goes on top.
        for (const f of flexed) f.bone.quaternion.copy(f.rest);
        walk(clock);
        runPasses(clock);
        fadeTowards(clock, frame.dt);
        tickClips(clock);
        for (const m of mixers) m.update(dtp);
        flexAt(clock);
        shimmer *= Math.exp(-frame.dt / 1.2);
        // Music: the bass slowly breathes the glow, the treble adds sparkle (slow envelopes: never on the beat).
        breath += ((frame.audio.bass ?? 0) - breath) * (1 - Math.exp(-frame.dt / 1.6));
        sparkle += ((frame.audio.treble ?? 0) - sparkle) * (1 - Math.exp(-frame.dt / 0.5));
        for (const s of particleSets) {
          s.update();
          s.uniforms.breath.value = breath;
          s.uniforms.sparkle.value = sparkle;
        }
        revealLevel = reveal.update(frame.time, frame.game?.progress ?? 0, frame.dt);
        for (const s of spinners) s.obj.rotateOnAxis(s.axis, s.speed * frame.dt);
        burst = Math.max(0, burst - frame.dt / 6);
        let dissolve = 0;
        if (p.render === 'dissolve') dissolve = Math.max(cycleDissolve(frame.time, p.dissolve.period), burst > 0 ? Math.min(1, burst * 3) : 0);
        apply(dissolve);
      },
      onGameEvent(e) {
        // Built-in call-ins: `reveal.hold` and `dissolve.onBigClears` are shorthands for
        // `events: [{ "on": "clear>=4", "action": "reveal" | "burst" }]` (no quantise, no cooldown).
        const big = e.kind === 'clear' && (e.lines >= 4 || e.perfectClear);
        if (p.render === 'dissolve' && p.dissolve.onBigClears && big) burst = 1;
        if (big) reveal.bigClear();
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
        // The clones share the cached GLB's geometry and textures: release it (ref-counted).
        ctx.assets.release(p.src);
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

/** The first `share` of every sample set (samples are random, so any prefix is an even subset). */
function subsetSets(sets: readonly SurfaceSampleSet[], share: number): SurfaceSampleSet[] {
  return sets
    .map((set) => {
      const n = Math.max(1, Math.round(set.count * share));
      const morph = set.morph ? { targets: set.morph.targets, deltas: new Float32Array(set.morph.targets * n * 3) } : null;
      if (morph && set.morph) for (let t = 0; t < morph.targets; t++) morph.deltas.set(set.morph.deltas.subarray(t * set.count * 3, (t * set.count + n) * 3), t * n * 3);
      return {
        mesh: set.mesh,
        count: n,
        position: set.position.slice(0, n * 3),
        normal: set.normal.slice(0, n * 3),
        color: set.color.slice(0, n * 3),
        seed: set.seed.slice(0, n),
        skinIndex: set.skinIndex ? set.skinIndex.slice(0, n * 4) : null,
        skinWeight: set.skinWeight ? set.skinWeight.slice(0, n * 4) : null,
        morph,
      };
    })
    .filter((set) => set.count > 0);
}
