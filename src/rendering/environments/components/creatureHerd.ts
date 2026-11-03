import {
  AdditiveBlending,
  Color,
  Group,
  InstancedBufferAttribute,
  Mesh,
  MeshStandardNodeMaterial,
  NormalBlending,
  Sprite,
  SpriteNodeMaterial,
  Vector4,
} from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  clamp,
  cos,
  float,
  hash,
  instanceIndex,
  instancedBufferAttribute,
  length,
  mix,
  mrt,
  normalLocal,
  sin,
  smoothstep,
  step,
  uint,
  uniformArray,
  uv,
  vec3,
  vec4,
  attribute,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { createRigNodes, forwardYaw, rigSchema, vec4At, type CreatureRig } from '../../creatures/rig';
import { GroupMotion, PathTrack, crossingFade, pathSchema, type PathPoint } from '../../creatures/paths';
import { bakeCreatureGeometry, creatureBufferGeometry, sampleSurface } from '../../creatures/surface';
import { colorUniform, floatUniform, seeded, zColor, zVec3 } from './common';
import { revealMask } from './reveal';
import { additiveFog } from '../../shaders/uniforms';

const groupSchema = z.object({
  path: pathSchema,
  members: z.number().int().min(1).max(12).default(1),
  /** caravan = single file along the path; herd = loose cluster. */
  formation: z.enum(['caravan', 'herd']).default('caravan'),
  /** Metres between members (before scale). */
  spacing: z.number().positive().default(3.4),
  /** Ground speed in metres per second (before scale). */
  speed: z.number().positive().default(1.1),
  scale: z.number().positive().default(1),
  scaleJitter: z.number().min(0).max(0.5).default(0.08),
  delay: z.number().min(0).default(0),
  /** Where along its first crossing the group starts (0..1), so a stage opens with creatures in view. */
  start: z.number().min(0).max(1).default(0),
  /** Seconds out of sight between crossings (open paths). */
  rest: z.number().min(0).default(10),
  stopEvery: z.number().min(0).default(0),
  stopFor: z.number().min(0).default(0),
  /** Fade (assemble/dissolve) distance at both ends of an open path, in metres. */
  fade: z.number().positive().default(12),
  followGround: z.boolean().default(true),
});

const schema = z.object({
  model: z.string(),
  rig: z.string(),
  representation: z.enum(['particles', 'mesh', 'both']).default('particles'),
  groups: z.array(groupSchema).min(1).max(16),
  particles: z
    .object({
      perCreature: z.number().int().min(50).max(20000).default(2400),
      size: z.number().positive().default(0.075),
      color: zColor.default('#ffd59a'),
      colorB: zColor.default('#ff9b4f'),
      brightness: z.number().default(1.1),
      /** Surface shimmer in metres. */
      jitter: z.number().min(0).default(0.025),
      bloom: z.number().min(0).default(0.45),
      additive: z.boolean().default(true),
      /** How far particles blow away while a creature assembles or dissolves (metres). */
      scatter: z.number().min(0).default(7),
      wind: zVec3.default([1, 0.25, 0.3]),
      /** Distance (world units) at which LOD starts thinning particles. */
      lodDistance: z.number().positive().default(70),
    })
    .prefault({}),
  mesh: z
    .object({
      color: zColor.default('#b9824f'),
      roughness: z.number().min(0).max(1).default(0.85),
      rim: zColor.default('#ffcf8f'),
      rimStrength: z.number().min(0).default(0.25),
    })
    .prefault({}),
  dust: z
    .object({
      enabled: z.boolean().default(true),
      color: zColor.default('#d7ad78'),
      amount: z.number().min(0).max(4).default(1),
      size: z.number().positive().default(0.55),
    })
    .prefault({}),
  seed: z.number().default(1),
});

type Params = z.infer<typeof schema>;

const TAU = Math.PI * 2;
const MAX_CREATURES = 64;

interface Member {
  readonly group: number;
  readonly slot: number;
  readonly scale: number;
  readonly phaseOffset: number;
  /** Formation offsets: along the path (behind the lead) and sideways. */
  readonly back: number;
  readonly side: number;
  yaw: number;
  phase: number;
  lastPhase: number;
}

/**
 * Walking creatures (camels, deer, ...) built from a Blender model and rig. Each creature is drawn as
 * thousands of glowing particles sampled on its surface, as a solid body, or both; the same rig
 * animates every representation in the vertex shader. Groups follow paths as solitary walkers,
 * herds or caravans, assemble out of blowing particles when they appear and dissolve when they leave,
 * and kick up dust at each footfall.
 */
export const creatureHerdComponent: ComponentFactory<Params> = {
  type: 'creatureHerd',
  version: 1,
  description: 'Rigged Blender creatures as GPU particle bodies or meshes, walking paths in caravans and herds.',
  schema,
  async create(ctx, p) {
    const rigRaw = ctx.assets.json(p.rig);
    if (!rigRaw) throw new Error(`creature rig ${p.rig} not found`);
    const rig: CreatureRig = rigSchema.parse(rigRaw);
    const gltf = await ctx.assets.loadGLTF(p.model);
    const geometry = bakeCreatureGeometry(gltf.scene);
    const rand = seeded(p.seed * 4241 + 7);
    const rigNodes = createRigNodes(rig);
    const yawOffset = forwardYaw(rig);

    // Members and per-group motion.
    const tracks = p.groups.map((g) => new PathTrack(g.path));
    const motions = p.groups.map((g, i) => {
      const groupLength = (g.members - 1) * g.spacing * g.scale + g.spacing;
      const motion = new GroupMotion({ speed: g.speed * g.scale, delay: g.delay, rest: g.rest, stopEvery: g.stopEvery, stopFor: g.stopFor }, tracks[i]!.length + groupLength, tracks[i]!.closed);
      motion.distance = g.start * (tracks[i]!.length + groupLength);
      return motion;
    });
    const members: Member[] = [];
    p.groups.forEach((g, gi) => {
      for (let k = 0; k < g.members && members.length < MAX_CREATURES; k++) {
        const scale = g.scale * (1 + (rand() * 2 - 1) * g.scaleJitter);
        const caravan = g.formation === 'caravan';
        members.push({
          group: gi,
          slot: k,
          scale,
          phaseOffset: caravan ? k * 0.37 : rand(),
          back: caravan ? k * g.spacing * g.scale : (k === 0 ? 0 : (0.3 + rand()) * g.spacing * g.scale * Math.sqrt(k)),
          side: caravan ? (rand() - 0.5) * 0.4 * g.scale : k === 0 ? 0 : (rand() - 0.5) * 2.2 * g.spacing * g.scale,
          yaw: 0,
          phase: 0,
          lastPhase: 0,
        });
      }
    });
    const count = Math.max(1, members.length);
    // Per-creature state, updated on the CPU each frame: A = position + yaw, B = phase, scale, fade, gait.
    const stateA = Array.from({ length: count }, () => new Vector4());
    const stateB = Array.from({ length: count }, () => new Vector4(0, 1, 0, 0));
    const stA = uniformArray(stateA, 'vec4');
    const stB = uniformArray(stateB, 'vec4');

    const u = {
      brightness: floatUniform(p.particles.brightness),
      size: floatUniform(1),
      jitter: floatUniform(p.particles.jitter),
      presence: floatUniform(1),
      music: floatUniform(0),
    };
    /** Walking pace multiplier (reactive: the music can hurry the caravans along). */
    const pace = { value: 1 };
    const time = ctx.uniforms.time;
    const root = new Group();
    const disposables: { dispose(): void }[] = [];

    // World transform of a posed rig-space point for creature `c`.
    const toWorld = (posed: Node<'vec3'>, a: Node<'vec4'>, scale: Node<'float'>): Node<'vec3'> => {
      const yaw = a.w;
      const cy = cos(yaw);
      const sy = sin(yaw);
      const s = posed.mul(scale);
      return vec3(s.x.mul(cy).add(s.z.mul(sy)), s.y, s.x.negate().mul(sy).add(s.z.mul(cy))).add(a.xyz) as Node<'vec3'>;
    };

    if (p.representation !== 'mesh') {
      const detail = ctx.quality.detail === 'low' ? 0.35 : ctx.quality.detail === 'medium' ? 0.65 : ctx.quality.detail === 'high' ? 1 : 1.3;
      const perCreature = Math.max(60, Math.round(p.particles.perCreature * detail * Math.min(1.5, Math.max(0.25, ctx.quality.particles))));
      const total = perCreature * count;
      const a = new Float32Array(total * 4);
      const b = new Float32Array(total * 4);
      for (let c = 0; c < count; c++) {
        // Each creature gets its own sampling, so no two bodies sparkle identically.
        const samples = sampleSurface(geometry, perCreature, rand);
        a.set(samples.a, c * perCreature * 4);
        b.set(samples.b, c * perCreature * 4);
      }
      const attrA = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(a, 4), 'vec4');
      const attrB = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(b, 4), 'vec4');
      const creature = instanceIndex.div(uint(perCreature));
      const sa = vec4At(stA, creature);
      const sb = vec4At(stB, creature);
      const r1 = hash(instanceIndex);
      const r2 = hash(instanceIndex.add(uint(7919)));
      const r3 = hash(instanceIndex.add(uint(15485)));
      const posed = rigNodes.pose(attrA.xyz, attrB.yzw, attrA.w, attrB.x, sb.x, sb.w);
      const normal = posed.normal ?? vec3(0, 1, 0);
      // Shimmer along the surface normal, then the assemble/dissolve scatter carried by the wind.
      const shimmer = normal.mul(sin(time.mul(r2.mul(3).add(1.5)).add(r1.mul(TAU))).mul(u.jitter));
      const fade = sb.z;
      const assembled = smoothstep(r1.mul(0.55), r1.mul(0.55).add(0.45), fade);
      const loose = float(1).sub(assembled);
      const drift = vec3(...p.particles.wind)
        .mul(loose.mul(loose).mul(p.particles.scatter).mul(r2.add(0.5)))
        .add(vec3(r1.sub(0.5), r3.mul(0.6), r2.sub(0.5)).mul(loose.mul(p.particles.scatter * 0.6)))
        .add(vec3(sin(time.mul(1.3).add(r3.mul(TAU))), cos(time.mul(1.1).add(r1.mul(TAU))), 0).mul(loose.mul(0.4)));
      const world = toWorld(posed.position.add(shimmer) as Node<'vec3'>, sa, sb.y).add(drift);
      // Distance LOD: thin out particles far away and enlarge the survivors to keep coverage.
      const dist = length(world.sub(cameraPosition));
      const keep = clamp(float(p.particles.lodDistance).div(dist), 0.3, 1);
      const shown = step(r3, keep);
      const size = float(p.particles.size)
        .mul(sb.y)
        .mul(r2.mul(0.8).add(0.6))
        .mul(u.size)
        .mul(shown)
        .div(keep.sqrt())
        .mul(assembled.mul(0.6).add(0.4))
        .mul(step(0.001, fade));
      const q = uv().sub(0.5).mul(2);
      const shape = smoothstep(1, 0, length(q)).pow(1.6);
      // Light from above and the sky: tops of the body catch more light than bellies.
      const lightUp = normal.y.mul(0.3).add(0.85);
      const twinkle = sin(time.mul(r1.mul(4).add(2)).add(r3.mul(TAU))).mul(0.18).add(0.92);
      const tint = mix(colorUniform(p.particles.color), colorUniform(p.particles.colorB), r2);
      const light = tint
        .mul(shape)
        .mul(lightUp)
        .mul(twinkle)
        .mul(u.brightness)
        .mul(float(1).add(u.music.mul(0.35)))
        .mul(fade.mul(0.5).add(0.5))
        .mul(u.presence);
      const material = new SpriteNodeMaterial();
      material.positionNode = world;
      material.scaleNode = size;
      material.colorNode = p.particles.additive ? vec4(additiveFog(light), 1) : vec4(light, shape.mul(u.presence));
      material.transparent = true;
      material.depthWrite = false;
      material.blending = p.particles.additive ? AdditiveBlending : NormalBlending;
      material.fog = !p.particles.additive;
      material.mrtNode = p.particles.additive ? mrt({ emissive: vec4(light.mul(p.particles.bloom), 1) }) : mrt({ emissive: vec4(tint.mul(u.brightness).mul(p.particles.bloom), shape.mul(u.presence)) });
      const sprite = new Sprite(material);
      sprite.count = total;
      sprite.frustumCulled = false;
      sprite.renderOrder = -4;
      root.add(sprite);
      disposables.push(material, sprite.geometry);
    }

    if (p.representation !== 'particles') {
      const body = creatureBufferGeometry(geometry);
      const material = new MeshStandardNodeMaterial();
      material.color = new Color(p.mesh.color);
      material.roughness = p.mesh.roughness;
      material.metalness = 0;
      const ja = attribute<'float'>('ja', 'float');
      const jb = attribute<'float'>('jb', 'float');
      const rest = attribute<'vec3'>('position', 'vec3');
      const restN = attribute<'vec3'>('normal', 'vec3');
      material.positionNode = Fn(() => {
        const sa = vec4At(stA, instanceIndex);
        const sb = vec4At(stB, instanceIndex);
        const posed = rigNodes.pose(rest, restN, ja, jb, sb.x, sb.w);
        const yaw = sa.w;
        const n = posed.normal ?? restN;
        normalLocal.assign(vec3(n.x.mul(cos(yaw)).add(n.z.mul(sin(yaw))), n.y, n.x.negate().mul(sin(yaw)).add(n.z.mul(cos(yaw)))));
        return toWorld(posed.position, sa, sb.y);
      })();
      // Dissolve in and out with a stable per-point pattern (no transparency sorting).
      const fade = vec4At(stB, instanceIndex).z;
      material.opacityNode = step(hash(rest.mul(97.3)), fade.mul(1.02)).mul(revealMask(u.presence));
      material.alphaTest = 0.5;
      const rimGlow = colorUniform(p.mesh.rim).mul(p.mesh.rimStrength).mul(u.presence);
      material.emissiveNode = rimGlow.mul(float(0.3).add(u.music.mul(0.4)));
      const mesh = new Mesh(body, material);
      mesh.count = count;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      root.add(mesh);
      disposables.push(material, body);
    }

    // Feet for dust: hip joints define the legs; contact happens just after the forward reach.
    const feet = rig.joints
      .map((j, i) => ({ j, i }))
      .filter(({ j }) => /hip|shoulder/i.test(j.name))
      .map(({ j }) => ({ x: j.pivot[0], z: j.pivot[2], phase: j.phase }));
    const dustColor = new Color(p.dust.color).convertSRGBToLinear();
    const pt: PathPoint = { x: 0, y: 0, z: 0, dx: 0, dz: -1 };

    const kickDust = (m: Member, a: Vector4, foot: { x: number; z: number }, now: number): void => {
      const n = ctx.bursts.budget(4 * p.dust.amount);
      const cy = Math.cos(a.w);
      const sy = Math.sin(a.w);
      const fx = a.x + (foot.x * cy + foot.z * sy) * m.scale;
      const fz = a.z + (-foot.x * sy + foot.z * cy) * m.scale;
      for (let i = 0; i < n; i++) {
        const ang = rand() * TAU;
        const sp = (0.25 + rand() * 0.5) * m.scale;
        ctx.bursts.emit(
          {
            x: fx + (rand() - 0.5) * 0.3 * m.scale,
            y: a.y + 0.05,
            z: fz + (rand() - 0.5) * 0.3 * m.scale,
            vx: Math.cos(ang) * sp + p.particles.wind[0] * 0.3,
            vy: (0.3 + rand() * 0.4) * m.scale,
            vz: Math.sin(ang) * sp + p.particles.wind[2] * 0.3,
            r: dustColor.r * 0.22,
            g: dustColor.g * 0.22,
            b: dustColor.b * 0.22,
            size: p.dust.size * m.scale * (0.6 + rand() * 0.8),
            life: 1.4 + rand() * 1.2,
            gravity: 0.15,
            drag: 1.4,
            shape: 'soft',
            swirl: 0.3,
          },
          now,
        );
      }
    };

    const reduced = ctx.quality.reducedMotion;
    return {
      object: root,
      reactive: { brightness: u.brightness, size: u.size, jitter: u.jitter, pace },
      update(frame) {
        const dt = Math.min(0.1, frame.dt) * (reduced ? 0.6 : 1) * Math.max(0.2, Math.min(2.5, pace.value));
        u.music.value = frame.audio.bass * 0.5 + frame.audio.beatPulse * 0.5;
        const moved = motions.map((m) => m.step(dt));
        const emitDust = p.dust.enabled && frame.presence > 0.2;
        for (let i = 0; i < members.length; i++) {
          const m = members[i]!;
          const g = p.groups[m.group]!;
          const track = tracks[m.group]!;
          const motion = motions[m.group]!;
          const d = motion.distance - m.back;
          track.at(d, pt);
          // Sideways offset (herds spread out; caravans keep a slight wobble).
          const x = pt.x + -pt.dz * m.side;
          const z = pt.z + pt.dx * m.side;
          const y = g.followGround ? ctx.ground.height(x, z) : pt.y;
          const targetYaw = Math.atan2(-pt.dx, -pt.dz) + yawOffset;
          let dy = targetYaw - m.yaw;
          dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          m.yaw = m.phase === 0 && m.lastPhase === 0 ? targetYaw : m.yaw + dy * Math.min(1, dt * 2.5);
          m.lastPhase = m.phase;
          m.phase += moved[m.group]! / (rig.stride * m.scale);
          // Loops assemble once at the start; open paths assemble on entry and dissolve on exit.
          const fade = track.closed ? Math.min(1, motion.distance / (g.fade * g.scale * 0.5)) : crossingFade(d, track.length, g.fade * g.scale);
          const a = stateA[i]!;
          a.set(x, y, z, m.yaw);
          const gaitPhase = (((m.phase + m.phaseOffset) % 1) + 1) % 1;
          stateB[i]!.set(gaitPhase, m.scale, fade, motion.walking);
          if (emitDust && fade > 0.5 && motion.walking > 0.3) {
            const prev = (((m.lastPhase + m.phaseOffset) % 1) + 1) % 1;
            for (const foot of feet) {
              const contact = (((0.3 - foot.phase) % 1) + 1) % 1;
              const crossed = prev <= gaitPhase ? prev < contact && contact <= gaitPhase : contact > prev || contact <= gaitPhase;
              if (crossed) {
                kickDust(m, a, foot, ctx.uniforms.time.value);
                // Soft footfalls for the nearer walkers (the audio system pans them in 3D).
                if (foot === feet[0] || foot === feet[2]) ctx.sounds.emit('footstep', a.x, a.y, a.z, Math.min(1, m.scale / 3) * 0.6);
              }
            }
          }
        }
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        disposables.forEach((d) => d.dispose());
        ctx.assets.release(p.model);
      },
    };
  },
};

export type CreatureHerdParams = Params;
