import { DynamicDrawUsage, Euler, Group, InstancedBufferAttribute, Matrix4, Mesh, Quaternion, Vector3 } from 'three/webgpu';
import { floatUniform, linear, seeded, z, zColor, zVec3, type ComponentFactory } from '@prismfall/sdk';
import { ROBOT_LOOK, robotMaterial } from './metal';
import { BeamSet, GlintSet } from './optics';
import { BoneTexture, RigSolver, blendSkinNode, mergeSkinned, parseRig, slotCount, twoBone, wrapAngle, type BonePose } from './rig';
import { SensorController } from './sensor';
import { GroundShadows } from './shadows';
import { GROUND_Y, TAU, VIEWER, backdropTexture, envTexture, notice, release, stageTexture, world, type F, type World, zHaze } from './shared';

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
  /**
   * Ground shadows: `contact` for the pool under the body and the feet, `cast` for the shadow thrown
   * away from the brightest nearby fire or explosion (the yard is lit by the sky and the fires, not
   * the sun, so that is where shadows show).
   */
  shadows: z.object({ contact: z.number().min(0).max(1).default(0.6), cast: z.number().min(0).max(1).default(0.85) }).prefault({}),
  haze: zHaze,
  /**
   * Call-ins (SDK 1.5): any call (`burst` in the manifest) is a loud moment at the board. The machines
   * that can see it turn their optics on the playfield and stare (`alert.weight` scales how many do,
   * like a nearby explosion would); `alert.halt` stops the patrols in their tracks for a moment.
   */
  alert: z.object({ weight: z.number().min(0).max(2).default(1.2), halt: z.number().min(0).max(4).default(1.2) }).prefault({}),
  seed: z.number().default(3),
});

type Params = z.infer<typeof schema>;

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
  seed: number;
  power: number;
  slump: number;
  visible: boolean;
  beam: boolean;
  sensor: SensorController;
  solver: RigSolver;
  driver: Driver;
  // Settle spring (pelvis height and torso pitch) kicked at heel strikes.
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

/** Sets a bone's Euler pose to a rotation of `angle` about a rest-space axis. */
const qTmp = new Quaternion();
const eTmp = new Euler();
const vAxis = new Vector3();
function axisPose(pose: BonePose, axis: [number, number, number], angle: number): void {
  eTmp.setFromQuaternion(qTmp.setFromAxisAngle(vAxis.set(...axis), angle), 'XYZ');
  pose.rx = eTmp.x;
  pose.ry = eTmp.y;
  pose.rz = eTmp.z;
}

/**
 * Humanoid machines: a rigged endoskeleton robot (scripts/build-red-horizon-robot.ts, from a
 * Sketchfab model; see ASSET_LICENSES.md) walking patrol routes, standing guard, marching in
 * distant columns and coming off the factory line.
 *
 * Every machine is posed on the CPU each frame: a heavy gait whose stride follows the measured
 * ground speed, so stance feet stay planted; two-bone leg IK with level feet, heel-off and toe
 * hinge; a pelvis that dips at each heel strike and settles on a damped spring; arm swing against
 * the legs; a twisting, bending spine; servoing fingers; and the optical-sensor controller turning
 * the head and lighting the eyes, pulling the machine round towards explosions. The pose goes to a
 * bone-matrix texture that the vertex shader blends (four bones per vertex). One instanced draw call
 * per level of detail; far machines use the light model and update at a third of the rate.
 */
export const sentinelsComponent: ComponentFactory<Params> = {
  type: 'redHorizonSentinels',
  version: 1,
  description: 'Humanoid machines patrolling, standing guard, marching and leaving the factory line, with planted-foot gaits and scanning optical sensors.',
  schema,
  async create(ctx, p) {
    const w: World = world(ctx);
    const rig = parseRig(ctx.assets.json('models/robot.rig.json'));
    if (!rig?.eyes?.length || !rig.curl) throw new Error('robot rig missing or incomplete');
    const [gltf, gltfLod, env, backdrop, bAlb, bNrm, hAlb, hNrm] = await Promise.all([
      ctx.assets.loadGLTF('models/robot.glb'),
      ctx.assets.loadGLTF('models/robot_lod.glb'),
      envTexture(w),
      backdropTexture(w),
      stageTexture(w, 'textures/robot_body_albedo.webp'),
      stageTexture(w, 'textures/robot_body_normal.webp', false),
      stageTexture(w, 'textures/robot_head_albedo.webp'),
      stageTexture(w, 'textures/robot_head_normal.webp', false),
    ]);
    const detail = ctx.quality.detail;
    const k = detail === 'low' ? 0.45 : detail === 'medium' ? 0.7 : 1;
    const reduced = ctx.quality.reducedMotion;
    const rand = seeded(p.seed * 4801 + 7);
    const agents: Agent[] = [];
    const counts = [0, 0];
    const bones = rig.bones;
    const B = (name: string) => {
      const b = bones.find((x) => x.name === name);
      if (!b) throw new Error(`robot rig has no bone ${name}`);
      return b.id;
    };
    // Side 0 is the machine's right (+X when it faces -Z), side 1 its left.
    const SIDE = ['R', 'L'] as const;
    const id = {
      pelvis: B('pelvis'),
      spine: B('spine'),
      torso: B('torso'),
      neck: B('neck'),
      head: B('head'),
      thigh: SIDE.map((s) => B(`thigh${s}`)),
      shin: SIDE.map((s) => B(`shin${s}`)),
      foot: SIDE.map((s) => B(`foot${s}`)),
      toe: SIDE.map((s) => B(`toe${s}`)),
      upper: SIDE.map((s) => B(`upper${s}`)),
      fore: SIDE.map((s) => B(`fore${s}`)),
      hand: SIDE.map((s) => B(`hand${s}`)),
      fingers: SIDE.map((s) => B(`fingers${s}`)),
      tips: SIDE.map((s) => B(`tips${s}`)),
    };
    const curl = SIDE.map((s): [number, number, number] => rig.curl![s] ?? [1, 0, 0]);
    const piv = (i: number) => new Vector3(...bones[i]!.pivot);
    const hipP = id.thigh.map(piv);
    const kneeP = id.shin.map(piv);
    const ankleP = id.foot.map(piv);
    const L1 = hipP[0]!.distanceTo(kneeP[0]!);
    const L2 = kneeP[0]!.distanceTo(ankleP[0]!);
    // Rest angles of the leg segments from straight down (positive forward, -Z) and the splay of the
    // whole leg (positive outward on side 0). The gait works relative to them.
    const thigh0 = Math.atan2(-(kneeP[0]!.z - hipP[0]!.z), Math.hypot(kneeP[0]!.x - hipP[0]!.x, hipP[0]!.y - kneeP[0]!.y));
    const shin0 = Math.atan2(-(ankleP[0]!.z - kneeP[0]!.z), Math.hypot(ankleP[0]!.x - kneeP[0]!.x, kneeP[0]!.y - ankleP[0]!.y));
    const splay0 = SIDE.map((_, s) => Math.atan2(ankleP[s]!.x - hipP[s]!.x, hipP[s]!.y - ankleP[s]!.y));
    const ankleH = ankleP[0]!.y;
    const eyes = rig.eyes.map((e) => ({ at: new Vector3(...e.at), radius: e.radius }));
    const eyeMid = eyes.reduce((m, e) => m.add(e.at), new Vector3()).divideScalar(eyes.length);
    const eyeHeight = eyeMid.y;
    // Foot soles in rest space (heel under the ankle, ball under the toe hinge) for contact shadows.
    const heelRest = ankleP.map((v) => new Vector3(v.x, 0, v.z));
    const ballRest = id.toe.map((t) => new Vector3(bones[t]!.pivot[0], 0, bones[t]!.pivot[2]));

    const addAgent = (lod: 0 | 1, x: number, zz: number, heading: number, scale: number, driver: Driver, beamOk: boolean): Agent => {
      const seed = rand();
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
        cycle: (0.98 + rand() * 0.14) * Math.sqrt(scale),
        seed,
        power: 1,
        slump: 0,
        visible: true,
        beam: lod === 0 && beamOk && rand() < p.beams,
        sensor: new SensorController({ seed: Math.floor(seed * 1e6), scanSpeed: 0.22 + rand() * 0.14, yaw: [-1.15, 1.15], pitch: [-0.55, 0.2], restPitch: -0.16 - rand() * 0.14, curiosity: 0.75 }),
        solver: new RigSolver(rig),
        driver,
        sy: 0,
        svy: 0,
        lastPhase: 0,
        idleT: rand() * 8,
        shift: 0,
        shiftTarget: 0,
        fingers: 0.3,
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
    const presence = floatUniform(1);
    const group = new Group();
    [gltf, gltfLod].forEach((g, lod) => {
      const count = counts[lod]!;
      if (count === 0) return;
      const geometry = mergeSkinned(g.scene);
      const tex = new BoneTexture(count, slots);
      // Per instance: (sensor intensity, focus, scan, seed).
      const optic = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
      optic.setUsage(DynamicDrawUsage);
      for (const a of agents) if (a.lod === lod) optic.setW(a.slot, a.seed * 100);
      const skin = blendSkinNode(tex, `Robot${lod}`);
      const material = robotMaterial(w, skin, optic, { ...ROBOT_LOOK, lens: p.lens }, { body: [bAlb, bNrm], head: [hAlb, hNrm] }, env, backdrop, p.haze, presence as unknown as F);
      const mesh = new Mesh(geometry, material);
      mesh.count = count;
      mesh.frustumCulled = false;
      // Read-only handle for review tools (bone matrices, agents).
      mesh.userData.redHorizon = { world: w, bones: tex, agents: () => agents.filter((a) => a.lod === lod).map((a) => ({ x: a.x, z: a.z, heading: a.heading, v: a.v, phase: a.phase, mode: a.sensor.mode })) };
      group.add(mesh);
      meshes[lod] = mesh;
      textures[lod] = tex;
      optics[lod] = optic;
    });
    const beams = new BeamSet(ctx, 16, p.haze, 1);
    const glints = new GlintSet(agents.length * eyes.length + 4, p.haze, 2.2, 0.3);
    const shadows = new GroundShadows(agents.length * 4 + 8, p.haze, presence as unknown as F);
    group.add(shadows.mesh, beams.cones, beams.spots, glints.mesh);
    /**
     * Ground light from the sky and the fill, in the units of the shared local lights (shared.ts
     * localLight): the open yard is nearly black, so near a fire the fire is most of the light.
     */
    const SKY_LIGHT = 0.06;
    const height = (rig.height ?? 2.2) * 0.95;
    const heel = new Vector3();
    const ball = new Vector3();
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
    // Cadence rises with speed (shorter cycles, so the stride stays within the leg's reach).
    const cycleOf = (a: Agent): number => a.cycle * Math.min(1.15, Math.max(0.78, Math.sqrt(0.9 / Math.max(0.3, a.v))));
    const solveAgent = (a: Agent, dt: number): void => {
      const P = a.solver;
      P.reset();
      const vel = a.v;
      const T = cycleOf(a);
      const duty = 0.62;
      const walk = Math.min(1, vel / 0.85);
      // Stride from the measured speed: the stance foot moves back exactly as fast as the body moves on.
      const S = vel * duty * T;
      const turning = Math.min(1, Math.abs(a.turn) / 0.35);
      const lift = 0.085 * Math.max(Math.min(1, vel / 0.35), turning * 0.7);
      // ---- Settle spring: kicked at every heel strike.
      const kk = 11;
      a.svy += (-kk * kk * a.sy - 2 * 0.32 * kk * a.svy) * dt;
      a.sy += a.svy * dt;
      // ---- Idle: weight shifts, finger servos, arm adjustments.
      a.idleT -= dt;
      if (a.idleT <= 0) {
        a.idleT = 3 + a.rand() * 7;
        a.shiftTarget = (a.rand() - 0.5) * 0.06 * (1 - walk);
        a.fingers = 0.15 + a.rand() * 0.55;
        a.armLift = a.rand() < 0.3 ? 0.15 + a.rand() * 0.25 : 0;
      }
      a.shift += (a.shiftTarget - a.shift) * Math.min(1, dt * 1.2);
      const slump = a.slump;
      const ph = a.phase;
      const phases = [ph, (ph + 0.5) % 1];
      // ---- Pelvis: the legs are nearly straight at rest, so a few centimetres of drop bend the knees a
      // lot. Upright when standing; walking, it vaults over the stance leg (high at mid-stance) and
      // dips at each heel strike, where both feet are furthest apart. Sways onto the stance leg.
      const drop = 0.004 + 0.008 * walk + slump * 0.06;
      const bob = -0.042 * walk * (0.5 + 0.5 * Math.cos(phases[0]! * TAU * 2)) + a.sy;
      const sway = 0.026 * walk * Math.sin(phases[0]! * TAU) + a.shift;
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
        // The feet come in a little under the body while walking (the rest stance is wide).
        const ankle = ankleP[side]!;
        const ax = ankle.x - sgn * 0.04 * walk;
        const ay = ankleH + fy;
        const az = ankle.z + fz;
        const dxL = ax - hx;
        const dyL = ay - hy;
        const dzL = az - hz;
        const splay = Math.atan2(dxL, -dyL) - splay0[side]!;
        const vert = Math.hypot(dxL, dyL);
        const alpha = Math.atan2(-dzL, vert);
        const D = Math.hypot(dzL, vert);
        const { a1, a2 } = twoBone(L1, L2, D);
        const thighAbs = alpha + a1;
        const shinAbs = alpha - a2;
        const th = P.pose(id.thigh[side]!);
        th.rx = thighAbs - thigh0 - pelvis.rx;
        th.rz = splay - pelvis.rz;
        const sh = P.pose(id.shin[side]!);
        sh.rx = shinAbs - shin0 - (thighAbs - thigh0);
        const ft = P.pose(id.foot[side]!);
        ft.rx = footPitch - (shinAbs - shin0);
        ft.rz = -splay;
        const toe = P.pose(id.toe[side]!);
        toe.rx = -footPitch * 0.85;
        // ---- Arms: swing against the same-side leg, elbows working, fingers servoing.
        const swing = -0.2 * walk * Math.cos(phi * TAU);
        const up = P.pose(id.upper[side]!);
        up.rx = swing + a.armLift * 0.4 - slump * 0.1;
        up.rz = sgn * (0.02 + 0.03 * walk);
        const fo = P.pose(id.fore[side]!);
        fo.rx = 0.06 + 0.06 * walk + 0.05 * walk * Math.sin(phi * TAU - 0.6) + a.armLift * 0.6 - slump * 0.12;
        const hd = P.pose(id.hand[side]!);
        hd.rx = 0.04 + 0.05 * walk * Math.sin(phi * TAU - 1.2);
        const grip = a.fingers * (1 - slump * 0.6);
        axisPose(P.pose(id.fingers[side]!), curl[side]!, grip);
        axisPose(P.pose(id.tips[side]!), curl[side]!, grip * 1.2);
      }
      // ---- Spine, neck and head: the sensor leads, the body follows a little.
      const sens = a.sensor;
      const twist = -0.07 * walk * Math.sin(phases[0]! * TAU) + sens.yaw * 0.22;
      const lean = 0.02 + 0.04 * walk + slump * 0.34 - a.sy * 1.5;
      const spine = P.pose(id.spine);
      spine.ry = twist * 0.4;
      spine.rx = lean * 0.45;
      spine.rz = sway * 0.16;
      const torso = P.pose(id.torso);
      torso.ry = twist * 0.6;
      torso.rx = lean * 0.55;
      torso.rz = sway * 0.24;
      const neck = P.pose(id.neck);
      neck.ry = sens.yaw * 0.3;
      neck.rx = sens.pitch * 0.4 - slump * 0.25;
      const head = P.pose(id.head);
      head.ry = sens.yaw * 0.48;
      head.rx = sens.pitch * 0.6 - slump * 0.3;
      head.rz = slump * 0.12;
      // ---- Root: on the ground (or the conveyor), facing its heading.
      root.compose(vPos.set(a.x, a.y, a.z), q.setFromAxisAngle(yAxis, a.heading), vScale.setScalar(a.scale));
      P.solve(root, textures[a.lod]!, a.slot);
    };

    // Bindable walking pace (section states quicken the squads in drops); sensors keep real time.
    const pace = floatUniform(1);
    let walkClock = 0;
    let halted = 0;
    let haltK = 0;
    // Alarm: after a call-in every machine's optics flare for a few seconds (light channel of the
    // world events, so flash reduction and calm world events soften it).
    let alarm = 0;
    let alarmTarget = 0;
    let clock = 0;
    const update = (dt: number): void => {
      clock += dt;
      w.time = clock;
      // A halt eases the squads almost to a stop and back (no sudden freeze).
      halted = Math.max(0, halted - dt);
      haltK += ((halted > 0 ? 1 : 0) - haltK) * Math.min(1, dt * 2.5);
      const walkRate = Math.max(0, pace.value) * (1 - haltK * 0.85);
      const walkDt = dt * walkRate;
      alarm += (alarmTarget - alarm) * Math.min(1, dt * 5);
      alarmTarget *= Math.exp(-dt / 1.6);
      const eyeLift = 1 + alarm * 0.9 * ctx.uniforms.waveLight.value;
      walkClock += walkDt;
      frame++;
      stepBudget = Math.min(6, stepBudget + dt * 5);
      beams.begin();
      glints.begin();
      shadows.begin();
      for (const a of agents) {
        a.px = a.x;
        a.pz = a.z;
        a.ph = a.heading;
        a.visible = a.driver.step(a, walkClock, walkDt);
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
          a.phase = (a.phase + dt / cycleOf(a)) % 1;
        } else if (a.phase % 0.5 > 0.02) {
          // Coast to a double-support pose instead of freezing mid-step.
          a.phase = (a.phase + dt / cycleOf(a)) % 1;
        }
        // Heel strikes: settle the frame, emit a metallic footfall near the viewer.
        const crossed = a.lastPhase > a.phase || (a.lastPhase < 0.5 && a.phase >= 0.5);
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
        a.sensor.update(dt, w.events, clock, { x: a.x, y: a.y + eyeHeight * a.scale, z: a.z, heading: a.heading });
        // Animation LOD: distant machines re-pose every third frame.
        if (a.lod === 0 || (frame + a.slot) % 3 === 0) solveAgent(a, a.lod === 0 ? dt : dt * 3);
        // Ground shadows: a pool under the body, contact shadows under planted feet (near machines),
        // and the long soft streak cast by the sunset.
        {
          const s = a.scale;
          // Near machines re-pose every frame (the pool follows the pelvis sway); far ones every
          // third frame, so they use their root (their pelvis may not be posed yet).
          const pm = a.solver.worldOf(id.pelvis).elements;
          const gx = a.lod === 0 ? pm[12]! : a.x;
          const gz = a.lod === 0 ? pm[14]! : a.z;
          const gy = a.y + 0.012;
          const contact = p.shadows.contact;
          shadows.add(gx, gy, gz, -Math.sin(a.heading), -Math.cos(a.heading), 0.46 * s, 0.34 * s, contact * 0.55);
          if (a.lod === 0) {
            for (let side = 0; side < 2; side++) {
              a.solver.pointOn(id.foot[side]!, heelRest[side]!, heel);
              a.solver.pointOn(id.toe[side]!, ballRest[side]!, ball);
              const lift = Math.max(0, Math.min(heel.y, ball.y) - a.y);
              const fx = ball.x - heel.x;
              const fz = ball.z - heel.z;
              const fl = Math.hypot(fx, fz) || 1;
              const k = Math.max(0, 1 - lift / (0.22 * s));
              shadows.add((heel.x + ball.x) / 2, gy + 0.002, (heel.z + ball.z) / 2, fx / fl, fz / fl, 0.15 * s, 0.085 * s, contact * 0.85 * k * k);
            }
          }
          // Cast shadow from the local light that lights this spot of ground the most (the ground's
          // own light model: wrapped Lambert, softened inverse square, smooth range cut-off). It
          // darkens by that light's share of the ground's light, and is as long as a figure this tall
          // throws from a light that high and that far.
          let best = 0;
          let bx = 0;
          let bz = 0;
          let bh = 0;
          for (let i = 0; i < w.lightValues.length; i++) {
            const L = w.lightValues[i]!;
            if (L.w <= 0 || L.y < -500) continue;
            const C = w.lightColours[i]!;
            const dx = gx - L.x;
            const dz = gz - L.z;
            const dy = L.y - a.y;
            const d2 = dx * dx + dy * dy + dz * dz;
            const fall = Math.max(0, 1 - d2 / (C.w * C.w)) ** 2;
            if (fall <= 0) continue;
            const lambert = Math.max(0, (dy / Math.sqrt(d2) + 0.25) / 1.25);
            const e = (0.2126 * C.x + 0.7152 * C.y + 0.0722 * C.z) * L.w * lambert * fall / (d2 + 25);
            if (e > best) {
              best = e;
              bx = dx;
              bz = dz;
              bh = dy;
            }
          }
          const bd = Math.hypot(bx, bz);
          if (best > 0.005 && bd > 0.3) {
            const H = height * s;
            // A fire lower than the head throws an unbounded shadow; its large flame blurs it out
            // within a few metres, so cap the length and let the streak fade.
            const reach = bh > H + 0.2 ? (H * bd) / (bh - H) : 4.6 * s;
            const half = Math.max(0.7 * s, Math.min(4.6 * s, reach)) / 2;
            const ux = bx / bd;
            const uz = bz / bd;
            shadows.add(gx + ux * half * 0.9, gy, gz + uz * half * 0.9, ux, uz, half, 0.34 * s, (p.shadows.cast * best) / (best + SKY_LIGHT), 1);
          }
        }
        // Optics: per-instance eye state, a glint per eye, optional beam.
        const scanX = Math.max(-1, Math.min(1, a.sensor.yaw / 0.9));
        optics[a.lod]!.setXYZW(a.slot, a.sensor.intensity, a.sensor.focus, scanX, a.seed * 100);
        if (a.sensor.intensity > 0.02) {
          const wm = a.solver.worldOf(id.head);
          fwd.set(-wm.elements[8]!, -wm.elements[9]!, -wm.elements[10]!).normalize();
          a.solver.pointOn(id.head, eyeMid, lensW);
          const toCam = vPos.copy(camP).sub(lensW).normalize();
          const facing = Math.max(0, fwd.dot(toCam));
          const gain = a.sensor.intensity * (0.18 + 0.82 * facing * facing) * 1.4 * eyeLift;
          for (const e of eyes) {
            a.solver.pointOn(id.head, e.at, lensW);
            glints.add(lensW.x + toCam.x * 0.03, lensW.y + toCam.y * 0.03, lensW.z + toCam.z * 0.03, e.radius * 1.5 * a.scale, lensCol.x * gain, lensCol.y * gain, lensCol.z * gain);
          }
          // A faint red sensor beam only while the eyes look down at the ground nearby: short,
          // soft, fading out as the gaze levels (never a flat line across the view).
          const down = Math.min(1, Math.max(0, (-fwd.y - 0.12) / 0.25));
          if (a.beam && !reduced && down > 0.01) {
            a.solver.pointOn(id.head, eyeMid, lensW);
            const bi = a.sensor.intensity * (0.3 + a.sensor.focus * 0.7) * down * 0.35;
            beams.add(lensW.x, lensW.y, lensW.z, fwd.x, fwd.y, fwd.z, 9, 0.16, beamCol.x * bi, beamCol.y * bi, beamCol.z * bi, GROUND_Y, 0.12);
          }
        }
      }
      for (const tex of textures) tex?.upload();
      for (const o of optics) if (o) o.needsUpdate = true;
      beams.end();
      glints.end();
      shadows.end();
    };
    update(0);

    const boardAt = new Vector3();
    return {
      object: group,
      reactive: { pace },
      update(frameInfo) {
        update(Math.min(0.1, frameInfo.dt) * (reduced ? 0.7 : 1));
      },
      onCall(call) {
        // The playfield did something loud: machines in view of it turn to look (their own reaction
        // delay, stare and scan back, as for an explosion), and the squads pause for a moment.
        boardAt.copy(ctx.uniforms.waveOrigin.value);
        notice(w, boardAt.x, boardAt.y, boardAt.z, p.alert.weight * Math.min(1.5, Math.max(0.5, call.strength)));
        halted = Math.max(halted, p.alert.halt);
        alarmTarget = Math.min(1, Math.max(alarmTarget, 0.6 * call.strength + 0.2));
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
        shadows.dispose();
        ctx.assets.release('models/robot.glb');
        ctx.assets.release('models/robot_lod.glb');
        release(w);
      },
    };
  },
};
