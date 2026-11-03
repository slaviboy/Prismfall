import { DynamicDrawUsage, Group, InstancedBufferAttribute, Matrix4, Mesh, Quaternion, Vector3 } from 'three/webgpu';
import { instancedBufferAttribute } from 'three/tsl';
import { floatUniform, linear, seeded, z, zColor, zVec3, type ComponentFactory } from '@prismfall/sdk';
import { SENTINEL_LOOK, machineMaterial } from './metal';
import { BeamSet, GlintSet } from './optics';
import { BoneTexture, RigSolver, mergeRigged, parseRig, skinNode, slotCount, twoBone, wrapAngle } from './rig';
import { SensorController } from './sensor';
import { GROUND_Y, TAU, VIEWER, backdropTexture, envTexture, release, stageTexture, world, zHaze, type F, type World } from './shared';

const zXZ = z.tuple([z.number(), z.number()]);

const schema = z.object({
  /** Squads walking a path in single file (pingpong: back and forth; loop: closed). */
  patrols: z
    .array(
      z.object({
        path: z.array(zXZ).min(2),
        mode: z.enum(['pingpong', 'loop']).default('pingpong'),
        members: z.number().int().min(1).max(12).default(4),
        /** Seconds between members (they walk in the leader's footsteps). */
        gap: z.number().positive().default(2.2),
        /** Side offset of alternate members (metres). */
        lateral: z.number().default(0.8),
        speed: z.number().positive().default(0.95),
        /** Chance of a halt at each waypoint, and its length (seconds). */
        stops: z.number().min(0).max(1).default(0.5),
        stop: z.tuple([z.number(), z.number()]).default([3, 8]),
        start: z.number().min(0).max(1).default(0),
        scale: z.number().positive().default(1),
        far: z.boolean().default(false),
      }),
    )
    .default([]),
  /** Machines standing guard and scanning, turning to a new facing now and then. */
  sentries: z.array(z.object({ at: zXZ, facing: z.number().default(0), scale: z.number().positive().default(1), far: z.boolean().default(false) })).default([]),
  /** Long marching columns far away (rendered with the light model), in ranks of `files`. */
  columns: z
    .array(
      z.object({
        from: zXZ,
        to: zXZ,
        members: z.number().int().min(1).max(60).default(16),
        files: z.number().int().min(1).max(4).default(2),
        spacing: z.number().positive().default(4.2),
        speed: z.number().positive().default(1.1),
        scale: z.number().positive().default(1),
      }),
    )
    .default([]),
  /** The factory line: units ride the conveyor powered down, boot up at its end and walk out. */
  assembly: z
    .object({
      from: zVec3,
      to: zVec3,
      exit: z.array(zXZ).min(2),
      units: z.number().int().min(1).max(16).default(7),
      speed: z.number().positive().default(0.45),
      boot: z.number().positive().default(4),
      /** Heading of the units on the line (degrees; 0 faces -Z, 180 faces the viewer). */
      facing: z.number().default(180),
    })
    .optional(),
  /** Share of near machines projecting a faint red sensor beam into the haze. */
  beams: z.number().min(0).max(1).default(0.25),
  lens: zColor.default('#ff1c0c'),
  beamColor: zColor.default('#ff2a12'),
  footsteps: z.boolean().default(true),
  haze: zHaze,
  seed: z.number().default(3),
});

type Params = z.infer<typeof schema>;

/** Lens centres per head variant (game coordinates, rest pose). */
const LENS = [new Vector3(0, 2.3955, -0.235), new Vector3(0, 2.404, -0.195), new Vector3(0.0427, 2.453, -0.196)];
const LENS_R = [0.018, 0.045, 0.038];

interface Driver {
  /** Moves the agent's root (x, z, heading) and sets its power/slump; returns false to hide it. */
  step(a: Agent, t: number, dt: number): boolean;
}

interface Agent {
  lod: 0 | 1;
  slot: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  px: number;
  pz: number;
  ph: number;
  scale: number;
  v: number;
  turn: number;
  phase: number;
  cycle: number;
  variant: number;
  seed: number;
  power: number;
  slump: number;
  visible: boolean;
  beam: boolean;
  sensor: SensorController;
  solver: RigSolver;
  driver: Driver;
  // Hydraulic settle spring (pelvis height and torso pitch) kicked at heel strikes.
  sy: number;
  svy: number;
  lastPhase: number;
  idleT: number;
  shift: number;
  shiftTarget: number;
  fingers: number;
  armLift: number;
  rand: () => number;
}

interface PathSampler {
  length: number;
  at(s: number, out: { x: number; z: number; dx: number; dz: number }): void;
  vertices: number[];
}

function polyline(points: [number, number][], closed: boolean): PathSampler {
  const pts = closed ? [...points, points[0]!] : points;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  const length = cum[cum.length - 1]!;
  return {
    length,
    vertices: cum,
    at(s, out) {
      const ss = Math.min(length, Math.max(0, s));
      let i = 1;
      while (i < cum.length - 1 && cum[i]! < ss) i++;
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const seg = Math.max(1e-6, cum[i]! - cum[i - 1]!);
      const t = (ss - cum[i - 1]!) / seg;
      out.x = a[0] + (b[0] - a[0]) * t;
      out.z = a[1] + (b[1] - a[1]) * t;
      out.dx = (b[0] - a[0]) / seg;
      out.dz = (b[1] - a[1]) / seg;
    },
  };
}

/** Heading (0 = facing -Z, positive turns left) of a travel direction. */
const headingOf = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

/**
 * A patrol leader walking its path with halts and turns; members replay the leader's recorded
 * pose a few seconds later, offset sideways, so a squad moves together but every machine reacts a
 * moment after the one in front.
 */
class Patrol {
  private readonly path: PathSampler;
  private readonly mode: 'pingpong' | 'loop';
  private s: number;
  private v = 0;
  private dir = 1;
  private heading: number;
  private state: 'walk' | 'stop' | 'turn' = 'walk';
  private timer = 0;
  private nextVertex = 1;
  private readonly hist: { t: number; x: number; z: number; h: number }[] = [];
  private readonly tmp = { x: 0, z: 0, dx: 0, dz: 0 };
  now = 0;

  constructor(
    readonly cfg: Params['patrols'][number],
    private readonly rand: () => number,
  ) {
    this.path = polyline(cfg.path, cfg.mode === 'loop');
    this.mode = cfg.mode;
    this.s = cfg.start * this.path.length;
    this.path.at(this.s, this.tmp);
    this.heading = headingOf(this.tmp.dx, this.tmp.dz);
    this.nextVertex = this.path.vertices.findIndex((c) => c > this.s);
    if (this.nextVertex < 0) this.nextVertex = this.path.vertices.length - 1;
    // Pre-roll so every member has a recorded past to follow.
    const pre = (cfg.members + 1) * cfg.gap + 1;
    for (let t = -pre; t < 0; t += 1 / 30) this.advance(1 / 30, t);
  }

  private record(t: number): void {
    this.path.at(this.s, this.tmp);
    this.hist.push({ t, x: this.tmp.x, z: this.tmp.z, h: this.heading });
    const keep = (this.cfg.members + 2) * this.cfg.gap + 2;
    while (this.hist.length > 2 && this.hist[0]!.t < t - keep) this.hist.shift();
  }

  advance(dt: number, t: number): void {
    this.now = t;
    const p = this.tmp;
    const L = this.path.length;
    if (this.state === 'stop') {
      this.v = Math.max(0, this.v - dt * 1.2);
      this.timer -= dt;
      if (this.timer <= 0) this.state = 'walk';
    } else if (this.state === 'turn') {
      this.v = 0;
      this.path.at(this.s + this.dir * 0.5, p);
      const target = headingOf(p.dx * this.dir, p.dz * this.dir);
      const d = wrapAngle(target - this.heading);
      this.heading += Math.sign(d) * Math.min(Math.abs(d), dt * 0.55);
      if (Math.abs(d) < 0.02) {
        this.state = 'stop';
        this.timer = 0.8 + this.rand();
      }
    } else {
      // Slow down for a halt at the next vertex, or at a sharp corner.
      const vx = this.path.vertices[this.nextVertex] ?? L;
      const toVertex = Math.abs(vx - this.s);
      const target = this.cfg.speed * Math.min(1, toVertex / 1.6 + 0.35);
      this.v += Math.max(-dt * 0.9, Math.min(dt * 0.5, target - this.v));
      this.s += this.dir * this.v * dt;
      if ((this.dir > 0 && this.s >= vx) || (this.dir < 0 && this.s <= vx)) {
        this.s = vx;
        const atEnd = this.nextVertex === 0 || this.nextVertex === this.path.vertices.length - 1;
        if (atEnd && this.mode === 'pingpong') {
          this.dir = -this.dir;
          this.state = 'turn';
        } else if (atEnd && this.mode === 'loop') {
          this.s = 0;
          this.nextVertex = 1;
          if (this.rand() < this.cfg.stops) {
            this.state = 'stop';
            this.timer = this.cfg.stop[0] + this.rand() * (this.cfg.stop[1] - this.cfg.stop[0]);
          }
          this.record(t);
          return;
        } else if (this.rand() < this.cfg.stops) {
          this.state = 'stop';
          this.timer = this.cfg.stop[0] + this.rand() * (this.cfg.stop[1] - this.cfg.stop[0]);
        }
        this.nextVertex += this.dir;
        this.nextVertex = Math.max(0, Math.min(this.path.vertices.length - 1, this.nextVertex));
      }
      this.path.at(this.s + this.dir * 0.4, p);
      const want = headingOf(p.dx * this.dir, p.dz * this.dir);
      const d = wrapAngle(want - this.heading);
      // Large corners: stop and turn in place first.
      if (Math.abs(d) > 0.9 && this.v < 0.25) this.state = 'turn';
      this.heading += Math.sign(d) * Math.min(Math.abs(d), dt * (0.35 + this.v * 0.45));
    }
    this.record(t);
  }

  /** The leader's pose `delay` seconds ago. */
  sample(delay: number, out: { x: number; z: number; h: number }): void {
    const t = this.now - delay;
    const h = this.hist;
    let i = h.length - 1;
    while (i > 0 && h[i]!.t > t) i--;
    const a = h[i]!;
    const b = h[Math.min(h.length - 1, i + 1)]!;
    const k = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    out.x = a.x + (b.x - a.x) * k;
    out.z = a.z + (b.z - a.z) * k;
    out.h = a.h + wrapAngle(b.h - a.h) * k;
  }
}

/**
 * Humanoid machines: original rigid-segment sentinels (Blender kit) walking patrol routes, standing
 * guard, marching in distant columns and coming off the factory line.
 *
 * Every machine is posed on the CPU each frame: a heavy gait whose stride follows the measured
 * ground speed, so stance feet stay planted; two-bone leg IK with level feet, heel-off and toe
 * hinge; a pelvis that dips at each heel strike and settles on a damped hydraulic spring; arm swing
 * against the legs; torso twist; and the optical-sensor controller turning the head, racking the
 * lens and pulling the machine round towards explosions. Pistons (knees, ankles, elbows, neck)
 * are re-aimed every frame so their rods slide in the barrels. One skinned, instanced draw call per
 * level of detail; far columns use the light model and update at a third of the rate.
 */
export const sentinelsComponent: ComponentFactory<Params> = {
  type: 'redHorizonSentinels',
  version: 1,
  description: 'Humanoid machines patrolling, standing guard, marching and leaving the factory line, with planted-foot gaits, hydraulics and scanning optical sensors.',
  schema,
  async create(ctx, p) {
    const w: World = world(ctx);
    const rig = parseRig(ctx.assets.json('models/sentinel.rig.json'));
    if (!rig) throw new Error('sentinel rig missing');
    const [gltf, gltfLod, env, backdrop, aAlb, aNr, sAlb, sNr] = await Promise.all([
      ctx.assets.loadGLTF('models/sentinel.glb'),
      ctx.assets.loadGLTF('models/sentinel_lod.glb'),
      envTexture(w),
      backdropTexture(w),
      stageTexture(w, 'textures/armour_albedo.webp'),
      stageTexture(w, 'textures/armour_nr.webp', false),
      stageTexture(w, 'textures/steel_albedo.webp'),
      stageTexture(w, 'textures/steel_nr.webp', false),
    ]);
    const detail = ctx.quality.detail;
    const k = detail === 'low' ? 0.45 : detail === 'medium' ? 0.7 : 1;
    const reduced = ctx.quality.reducedMotion;
    const rand = seeded(p.seed * 4801 + 7);
    const agents: Agent[] = [];
    const counts = [0, 0];
    const bones = rig.bones;
    const B = (name: string) => bones.find((b) => b.name === name)!.id;
    const id = {
      pelvis: B('pelvis'),
      torso: B('torso'),
      head: [B('headA'), B('headB'), B('headC')],
      sensor: [B('sensorA'), B('sensorB'), B('sensorC')],
      thigh: [B('thighL'), B('thighR')],
      shin: [B('shinL'), B('shinR')],
      foot: [B('footL'), B('footR')],
      toe: [B('toeL'), B('toeR')],
      upper: [B('upperL'), B('upperR')],
      fore: [B('foreL'), B('foreR')],
      hand: [B('handL'), B('handR')],
      fingers: [B('fingersL'), B('fingersR')],
    };
    const piv = (i: number) => new Vector3(...bones[i]!.pivot);
    const hipP = [piv(id.thigh[0]!), piv(id.thigh[1]!)];
    const kneeP = [piv(id.shin[0]!), piv(id.shin[1]!)];
    const ankleP = [piv(id.foot[0]!), piv(id.foot[1]!)];
    const L1 = Math.hypot(kneeP[0]!.y - hipP[0]!.y, kneeP[0]!.z - hipP[0]!.z);
    const L2 = Math.hypot(ankleP[0]!.y - kneeP[0]!.y, ankleP[0]!.z - kneeP[0]!.z);
    // Rest angles from straight down, positive forward (-Z).
    const thigh0 = Math.atan2(-(kneeP[0]!.z - hipP[0]!.z), hipP[0]!.y - kneeP[0]!.y);
    const shin0 = Math.atan2(-(ankleP[0]!.z - kneeP[0]!.z), kneeP[0]!.y - ankleP[0]!.y);
    const ankleH = ankleP[0]!.y;

    const addAgent = (lod: 0 | 1, x: number, zz: number, heading: number, scale: number, driver: Driver, beamOk: boolean): Agent => {
      const seed = rand();
      const variant = Math.floor(rand() * 3);
      const solver = new RigSolver(rig);
      for (let v = 0; v < 3; v++) {
        if (v !== variant) {
          solver.hidden.add(id.head[v]!);
          solver.hidden.add(id.sensor[v]!);
        }
      }
      const a: Agent = {
        lod,
        slot: counts[lod]!++,
        x,
        y: GROUND_Y,
        z: zz,
        heading,
        px: x,
        pz: zz,
        ph: heading,
        scale: scale * (0.94 + rand() * 0.1),
        v: 0,
        turn: 0,
        phase: rand(),
        cycle: (1.35 + rand() * 0.3) * Math.sqrt(scale),
        variant,
        seed,
        power: 1,
        slump: 0,
        visible: true,
        beam: lod === 0 && beamOk && rand() < p.beams,
        sensor: new SensorController({ seed: Math.floor(seed * 1e6), scanSpeed: 0.22 + rand() * 0.14, yaw: [-1.15, 1.15], pitch: [-0.55, 0.2], restPitch: -0.16 - rand() * 0.14, curiosity: 0.75 }),
        solver,
        driver,
        sy: 0,
        svy: 0,
        lastPhase: 0,
        idleT: rand() * 8,
        shift: 0,
        shiftTarget: 0,
        fingers: 0.35,
        armLift: 0,
        rand: seeded(Math.floor(seed * 1e6) + 3),
      };
      agents.push(a);
      return a;
    };

    // ---- Patrols.
    for (const cfg of p.patrols) {
      const patrol = new Patrol(cfg, seeded(Math.floor(rand() * 1e6)));
      // Level of detail by distance: patrols that never come within 55 m use the light model.
      const farPath = Math.min(...cfg.path.map(([x, zz]) => Math.hypot(x - VIEWER.x, zz - VIEWER.z))) > 55;
      const members = Math.max(1, Math.round(cfg.members * (cfg.far ? k : Math.max(0.6, k))));
      const pose = { x: 0, z: 0, h: 0 };
      for (let m = 0; m < members; m++) {
        const delay = m * cfg.gap + (m > 0 ? (rand() - 0.5) * cfg.gap * 0.25 : 0);
        const side = m === 0 ? 0 : (m % 2 === 0 ? 1 : -1) * cfg.lateral * (0.7 + rand() * 0.5);
        patrol.sample(delay, pose);
        const driver: Driver = {
          step(a, t, dt) {
            if (m === 0) patrol.advance(dt, t);
            patrol.sample(delay, pose);
            const c = Math.cos(pose.h);
            const s = Math.sin(pose.h);
            // Lateral offset to the machine's right (+X when facing -Z).
            a.x = pose.x + c * side;
            a.z = pose.z - s * side;
            a.heading = pose.h;
            return true;
          },
        };
        addAgent(cfg.far || farPath ? 1 : 0, pose.x, pose.z, pose.h, cfg.scale, driver, true);
      }
    }
    // Patrol members must advance after their leader each frame: leaders come first in `agents`.

    // ---- Sentries.
    for (const s of p.sentries) {
      const base = (s.facing * Math.PI) / 180;
      let target = base;
      let timer = 4 + rand() * 10;
      const r = seeded(Math.floor(rand() * 1e6));
      const driver: Driver = {
        step(a, _t, dt) {
          timer -= dt;
          if (timer <= 0) {
            target = base + (r() - 0.5) * 2.0;
            timer = 12 + r() * 16;
          }
          const d = wrapAngle(target - a.heading);
          a.heading += Math.sign(d) * Math.min(Math.abs(d), dt * 0.42);
          return true;
        },
      };
      addAgent(s.far || Math.hypot(s.at[0] - VIEWER.x, s.at[1] - VIEWER.z) > 55 ? 1 : 0, s.at[0], s.at[1], base, s.scale, driver, true);
    }

    // ---- Columns.
    for (const c of p.columns) {
      const L = Math.hypot(c.to[0] - c.from[0], c.to[1] - c.from[1]);
      const dx = (c.to[0] - c.from[0]) / L;
      const dz = (c.to[1] - c.from[1]) / L;
      const h = headingOf(dx, dz);
      const members = Math.max(2, Math.round(c.members * k));
      const ranks = Math.ceil(members / c.files);
      const span = Math.max(L, ranks * c.spacing + 10);
      const speedVar = 1 + (rand() - 0.5) * 0.06;
      for (let m = 0; m < members; m++) {
        const rank = Math.floor(m / c.files);
        const file = m % c.files;
        const lat = (file - (c.files - 1) / 2) * 1.5 + (rand() - 0.5) * 0.3;
        const jitter = (rand() - 0.5) * 0.8;
        const driver: Driver = {
          step(a, t) {
            const s = (((t * c.speed * speedVar - rank * c.spacing + jitter) % span) + span) % span;
            a.x = c.from[0] + dx * s - dz * lat;
            a.z = c.from[1] + dz * s + dx * lat;
            a.heading = h;
            // Hidden while it wraps from the far end back to the start (out of sight either way).
            return s < L;
          },
        };
        addAgent(1, c.from[0], c.from[1], h, c.scale, driver, false);
      }
    }

    // ---- Factory line.
    if (p.assembly) {
      const as = p.assembly;
      const line = new Vector3(as.to[0] - as.from[0], as.to[1] - as.from[1], as.to[2] - as.from[2]);
      const lineLen = line.length();
      const ride = lineLen / as.speed;
      const exit = polyline(as.exit, false);
      const walkSpeed = 0.85;
      const walkTime = exit.length / walkSpeed;
      const cycle = ride + as.boot + walkTime + 6;
      const units = Math.max(2, Math.round(as.units * Math.max(0.6, k)));
      const face = (as.facing * Math.PI) / 180;
      const tmp = { x: 0, z: 0, dx: 0, dz: 0 };
      for (let u = 0; u < units; u++) {
        const offset = (u / units) * cycle;
        let heading = face;
        const driver: Driver = {
          step(a, t, dt) {
            const c = (((t + offset) % cycle) + cycle) % cycle;
            if (c < ride) {
              const f = c / ride;
              a.x = as.from[0] + line.x * f;
              a.y = as.from[1] + line.y * f;
              a.z = as.from[2] + line.z * f;
              heading = face;
              a.heading = heading;
              a.power = 0;
              a.slump = 1;
              a.px = a.x;
              a.pz = a.z;
              return true;
            }
            if (c < ride + as.boot) {
              const f = (c - ride) / as.boot;
              a.x = as.to[0];
              a.y = as.to[1];
              a.z = as.to[2];
              a.power = Math.min(1, f * 1.6);
              a.slump = Math.max(0, 1 - f * 1.25);
              a.heading = heading;
              return true;
            }
            const s = (c - ride - as.boot) * walkSpeed;
            if (s > exit.length) return false;
            exit.at(s, tmp);
            a.x = tmp.x;
            a.z = tmp.z;
            // Step down from the line to the yard over the first metres.
            a.y = as.to[1] + (GROUND_Y - as.to[1]) * Math.min(1, s / 2.5);
            const want = headingOf(tmp.dx, tmp.dz);
            const d = wrapAngle(want - heading);
            heading += Math.sign(d) * Math.min(Math.abs(d), dt * 0.6);
            a.heading = heading;
            a.power = 1;
            a.slump = 0;
            return true;
          },
        };
        // Hundreds of metres away: the light model is plenty.
        addAgent(1, as.from[0], as.from[2], face, 1, driver, false);
      }
    }

    // ---- Meshes.
    const slots = slotCount(rig);
    const meshes: Mesh[] = [];
    const textures: BoneTexture[] = [];
    const optics: InstancedBufferAttribute[] = [];
    const seeds: InstancedBufferAttribute[] = [];
    const presence = floatUniform(1);
    const group = new Group();
    const time = ctx.uniforms.time as unknown as F;
    [gltf, gltfLod].forEach((g, lod) => {
      const count = counts[lod]!;
      if (count === 0) return;
      const geometry = mergeRigged(g.scene, rig);
      const tex = new BoneTexture(count, slots);
      const optic = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
      optic.setUsage(DynamicDrawUsage);
      const seedAttr = new InstancedBufferAttribute(new Float32Array(count), 1);
      for (const a of agents) if (a.lod === lod) seedAttr.setX(a.slot, a.seed * 100);
      const skin = skinNode(tex, `Sentinel${lod}`);
      const material = machineMaterial(
        w,
        { position: skin.position, normal: skin.normal, rest: skin.rest, tag: skin.tag as unknown as { x: F; y: F } },
        optic,
        instancedBufferAttribute<'float'>(seedAttr, 'float') as unknown as F,
        { ...SENTINEL_LOOK, lens: p.lens },
        { armour: [aAlb, aNr], steel: [sAlb, sNr] },
        env,
        backdrop,
        p.haze,
        presence as unknown as F,
        time,
      );
      const mesh = new Mesh(geometry, material);
      mesh.count = count;
      mesh.frustumCulled = false;
      // Read-only handle for review tools (bone matrices, agents).
      mesh.userData.redHorizon = { world: w, bones: tex, agents: () => agents.filter((a) => a.lod === lod).map((a) => ({ x: a.x, z: a.z, heading: a.heading, v: a.v, phase: a.phase, variant: a.variant, mode: a.sensor.mode })) };
      group.add(mesh);
      meshes[lod] = mesh;
      textures[lod] = tex;
      optics[lod] = optic;
      seeds[lod] = seedAttr;
    });
    const beams = new BeamSet(ctx, 16, p.haze, 1);
    const glints = new GlintSet(agents.length * 1 + 4, p.haze, 2.2, 0.3);
    group.add(beams.cones, beams.spots, glints.mesh);
    const lensCol = linear(p.lens);
    const beamCol = linear(p.beamColor);

    // ---- Pose solving.
    const root = new Matrix4();
    const q = new Quaternion();
    const yAxis = new Vector3(0, 1, 0);
    const vPos = new Vector3();
    const vScale = new Vector3();
    const lensW = new Vector3();
    const fwd = new Vector3();
    const camP = VIEWER;
    let frame = 0;
    let stepBudget = 0;
    const solveAgent = (a: Agent, dt: number, t: number): void => {
      const P = a.solver;
      P.reset();
      const vel = a.v;
      const T = a.cycle;
      const duty = 0.62;
      const walk = Math.min(1, vel / 0.85);
      // Stride from the measured speed: the stance foot moves back exactly as fast as the body moves on.
      const S = vel * duty * T;
      const turning = Math.min(1, Math.abs(a.turn) / 0.35);
      const lift = 0.085 * Math.max(Math.min(1, vel / 0.35), turning * 0.7);
      // ---- Hydraulic settle spring: kicked at every heel strike.
      const kk = 11;
      a.svy += (-kk * kk * a.sy - 2 * 0.32 * kk * a.svy) * dt;
      a.sy += a.svy * dt;
      // ---- Idle: weight shifts, finger servos, arm adjustments.
      a.idleT -= dt;
      if (a.idleT <= 0) {
        a.idleT = 3 + a.rand() * 7;
        a.shiftTarget = (a.rand() - 0.5) * 0.06 * (1 - walk);
        a.fingers = 0.15 + a.rand() * 0.6;
        a.armLift = a.rand() < 0.3 ? 0.15 + a.rand() * 0.25 : 0;
      }
      a.shift += (a.shiftTarget - a.shift) * Math.min(1, dt * 1.2);
      const slump = a.slump;
      const ph = a.phase;
      const phases = [ph, (ph + 0.5) % 1];
      // ---- Pelvis: a lower stance while walking, bob with two dips per cycle, sway onto the stance leg.
      const drop = 0.035 + 0.075 * walk + slump * 0.06;
      const bob = -0.018 * walk * (0.5 + 0.5 * Math.cos(phases[0]! * TAU * 2)) + a.sy;
      const sway = 0.028 * walk * Math.sin(phases[0]! * TAU) + a.shift;
      const pelvis = P.pose(id.pelvis);
      pelvis.tx = sway;
      pelvis.ty = -drop + bob;
      pelvis.rz = -sway * 0.9;
      pelvis.ry = 0.05 * walk * Math.sin(phases[0]! * TAU);
      pelvis.rx = 0.03 * walk + slump * 0.05;
      for (let side = 0; side < 2; side++) {
        const sgn = side === 0 ? 1 : -1;
        const phi = phases[side]!;
        let fz: number;
        let fy: number;
        let footPitch: number;
        if (phi < duty) {
          const u = phi / duty;
          fz = -S / 2 + S * u;
          // Heel-off in the last part of stance.
          const off = Math.max(0, (u - 0.78) / 0.22) * walk;
          footPitch = -0.38 * off * off;
          fy = 0.05 * off * off;
        } else {
          const u = (phi - duty) / (1 - duty);
          const sm = u * u * (3 - 2 * u);
          fz = S / 2 - S * sm;
          fy = Math.sin(Math.PI * u) * lift;
          footPitch = 0.16 * Math.sin(Math.PI * u) * Math.min(1, walk + turning) - 0.1 * (1 - u) * walk;
        }
        // Hip position after the pelvis translation (roll ignored: small).
        const hip = hipP[side]!;
        const hx = hip.x + sway;
        const hy = hip.y - drop + bob;
        const hz = hip.z;
        const ax = sgn * 0.205;
        const ay = ankleH + fy;
        const az = fz + 0.02;
        const dxL = ax - hx;
        const dyL = ay - hy;
        const dzL = az - hz;
        const abd = Math.atan2(dxL, -dyL);
        const vert = Math.hypot(dxL, dyL);
        const alpha = Math.atan2(-dzL, vert);
        const D = Math.hypot(dzL, vert);
        const { a1, a2 } = twoBone(L1, L2, D);
        const thighAbs = alpha + a1;
        const shinAbs = alpha - a2;
        const th = P.pose(id.thigh[side]!);
        th.rx = thighAbs - thigh0 - pelvis.rx;
        th.rz = abd - pelvis.rz;
        const sh = P.pose(id.shin[side]!);
        sh.rx = shinAbs - shin0 - (thighAbs - thigh0);
        const ft = P.pose(id.foot[side]!);
        ft.rx = footPitch - (shinAbs - shin0);
        ft.rz = -abd;
        const toe = P.pose(id.toe[side]!);
        toe.rx = -footPitch * 0.85;
        // ---- Arms: swing against the same-side leg, elbows working, fingers servoing.
        const swing = -0.2 * walk * Math.cos(phi * TAU);
        const up = P.pose(id.upper[side]!);
        up.rx = swing + a.armLift * 0.4 - slump * 0.1;
        up.rz = sgn * (0.07 + 0.03 * walk);
        const fo = P.pose(id.fore[side]!);
        fo.rx = 0.22 + 0.12 * walk + 0.06 * walk * Math.sin(phi * TAU - 0.6) + a.armLift - slump * 0.18;
        const hd = P.pose(id.hand[side]!);
        hd.rx = 0.05 + 0.05 * walk * Math.sin(phi * TAU - 1.2);
        hd.ry = sgn * 0.1;
        P.pose(id.fingers[side]!).rx = a.fingers * (1 - slump * 0.6);
      }
      // ---- Torso and head: the sensor leads, the body follows a little.
      const sens = a.sensor;
      const torso = P.pose(id.torso);
      torso.ry = -0.07 * walk * Math.sin(phases[0]! * TAU) + sens.yaw * 0.22;
      torso.rx = 0.05 + 0.04 * walk + slump * 0.32 - a.sy * 1.5;
      torso.rz = sway * 0.4;
      const variant = a.variant;
      const headPitchShare = variant === 2 ? 0.45 : 1;
      for (let v = 0; v < 3; v++) {
        const hp = P.pose(id.head[v]!);
        hp.ry = sens.yaw * 0.78;
        hp.rx = sens.pitch * headPitchShare - slump * 0.55;
        hp.rz = slump * 0.12;
      }
      const sA = P.pose(id.sensor[0]!);
      sA.rx = 0;
      const sB = P.pose(id.sensor[1]!);
      sB.rz = sens.focus * 0.9 + t * 0.05;
      sB.tz = -sens.focus * 0.012;
      const sC = P.pose(id.sensor[2]!);
      sC.rx = sens.pitch * (1 - headPitchShare) + sens.focus * 0.06;
      // ---- Root: on the ground (or the conveyor), facing its heading.
      root.compose(vPos.set(a.x, a.y, a.z), q.setFromAxisAngle(yAxis, a.heading), vScale.setScalar(a.scale));
      P.solve(root, textures[a.lod]!, a.slot);
    };

    let clock = 0;
    const update = (dt: number): void => {
      clock += dt;
      w.time = clock;
      frame++;
      stepBudget = Math.min(6, stepBudget + dt * 5);
      beams.begin();
      glints.begin();
      for (const a of agents) {
        a.px = a.x;
        a.pz = a.z;
        a.ph = a.heading;
        a.visible = a.driver.step(a, clock, dt);
        const tex = textures[a.lod]!;
        if (!a.visible) {
          tex.hide(a.slot);
          continue;
        }
        // Measured motion drives the gait.
        const dx = a.x - a.px;
        const dz = a.z - a.pz;
        const f = -Math.sin(a.heading) * dx - Math.cos(a.heading) * dz;
        const vNow = dt > 0 ? Math.max(0, f / dt) : 0;
        a.v += (Math.min(2, vNow) - a.v) * Math.min(1, dt * 6);
        const tr = dt > 0 ? wrapAngle(a.heading - a.ph) / dt : 0;
        a.turn += (tr - a.turn) * Math.min(1, dt * 5);
        if (a.v > 0.04 || Math.abs(a.turn) > 0.06) {
          a.phase = (a.phase + dt / a.cycle) % 1;
        } else if (a.phase % 0.5 > 0.02) {
          // Coast to a double-support pose instead of freezing mid-step.
          a.phase = (a.phase + dt / a.cycle) % 1;
        }
        // Heel strikes: settle the hydraulics, emit a metallic footfall near the viewer.
        const crossed = (a.lastPhase > a.phase) || (a.lastPhase < 0.5 && a.phase >= 0.5);
        if (crossed && (a.v > 0.2 || Math.abs(a.turn) > 0.2)) {
          a.svy -= 0.16 * Math.min(1, a.v + 0.3);
          const dcx = a.x - camP.x;
          const dcz = a.z - camP.z;
          const dist = Math.hypot(dcx, dcz);
          if (p.footsteps && a.lod === 0 && dist < 85 && stepBudget >= 1) {
            stepBudget -= 1;
            ctx.sounds.emit('footstep', a.x, a.y, a.z, Math.min(1, 0.55 * a.scale * (0.5 + a.v)));
          }
        }
        a.lastPhase = a.phase;
        // Sensors: events pull heads round; powered-down units stay dark.
        a.sensor.power = a.power;
        a.sensor.update(dt, w.events, clock, { x: a.x, y: a.y + 2.4, z: a.z, heading: a.heading });
        // Animation LOD: distant machines re-pose every third frame.
        if (a.lod === 0 || (frame + a.slot) % 3 === 0) solveAgent(a, a.lod === 0 ? dt : dt * 3, clock);
        // Optics: per-instance lens state, glint sprites, optional beam.
        const scanX = Math.max(-1, Math.min(1, a.sensor.yaw / 0.9));
        optics[a.lod]!.setXYZW(a.slot, a.sensor.intensity, a.sensor.focus, scanX, a.variant);
        if (a.sensor.intensity > 0.02) {
          const sb = id.sensor[a.variant]!;
          a.solver.pointOn(sb, LENS[a.variant]!, lensW);
          const wm = a.solver.worldOf(sb);
          fwd.set(-wm.elements[8]!, -wm.elements[9]!, -wm.elements[10]!).normalize();
          const toCam = vPos.copy(camP).sub(lensW).normalize();
          const facing = Math.max(0, fwd.dot(toCam));
          const gain = a.sensor.intensity * (0.18 + 0.82 * facing * facing) * 1.6;
          glints.add(lensW.x + toCam.x * 0.06, lensW.y + toCam.y * 0.06, lensW.z + toCam.z * 0.06, LENS_R[a.variant]! * a.scale, lensCol.x * gain, lensCol.y * gain, lensCol.z * gain);
          // A faint red sensor beam only while the optics look down at the ground nearby: short,
          // soft, fading out as the gaze levels (never a flat line across the view).
          const down = Math.min(1, Math.max(0, (-fwd.y - 0.12) / 0.25));
          if (a.beam && !reduced && down > 0.01) {
            const bi = a.sensor.intensity * (0.3 + a.sensor.focus * 0.7) * down * 0.35;
            beams.add(lensW.x, lensW.y, lensW.z, fwd.x, fwd.y, fwd.z, 9, 0.16, beamCol.x * bi, beamCol.y * bi, beamCol.z * bi, GROUND_Y, 0.12);
          }
        }
      }
      for (const tex of textures) tex?.upload();
      for (const o of optics) if (o) o.needsUpdate = true;
      beams.end();
      glints.end();
    };
    update(0);

    return {
      object: group,
      update(frameInfo) {
        update(Math.min(0.1, frameInfo.dt) * (reduced ? 0.7 : 1));
      },
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        for (const m of meshes) {
          if (!m) continue;
          m.geometry.dispose();
          (m.material as { dispose(): void }).dispose();
        }
        for (const t of textures) t?.dispose();
        beams.dispose();
        glints.dispose();
        ctx.assets.release('models/sentinel.glb');
        ctx.assets.release('models/sentinel_lod.glb');
        release(w);
      },
    };
  },
};

