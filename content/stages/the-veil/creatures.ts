import { DoubleSide, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicNodeMaterial, Quaternion, Vector3, type BufferGeometry, type Object3D, type SkinnedMesh } from 'three/webgpu';
import { attribute, cameraPosition, cos, float, instancedBufferAttribute, mix, mrt, normalize, normalWorld, positionGeometry, positionWorld, sin, smoothstep, vec3, vec4 } from 'three/tsl';
import { floatUniform, z, type ComponentFactory, type EnvironmentContext } from '@prismfall/sdk';
import { fogModelFor } from './atmosphere';
import type { VeilEvent } from './director';
import { aim, makeLeg, noise1, PathFollower, resetPose, rigOf, rotateWorld, smoothstep as sstep, solveLeg, type Leg, type RigInfo, type Waypoint } from './gait';
import { partsNamed } from './models';
import { castShadow } from './shadow';
import { cast, MAX_POCKETS, release, rng, shared, type F, type V3, type V4 } from './shared';
import { createLighting, zLighting, type Lighting } from './surface';
import { EYE, terrainHeight } from './terrain';

const DEG = Math.PI / 180;

const schema = z.object({
  exposure: z.number().min(0).default(0.3),
  lighting: zLighting,
  strider: z.object({ model: z.string(), scale: z.number().default(6.5), speed: z.number().default(5.5) }).prefault({ model: 'models/strider.glb' }),
  hollow: z.object({ model: z.string(), scale: z.number().default(1), speed: z.number().default(1.35) }).prefault({ model: 'models/hollow.glb' }),
  colossus: z.object({ model: z.string(), scale: z.number().default(9), speed: z.number().default(11) }).prefault({ model: 'models/colossus.glb' }),
  rays: z.object({ model: z.string(), count: z.number().int().min(4).max(160).default(48), size: z.tuple([z.number(), z.number()]).default([2.2, 3.2]) }).prefault({ model: 'models/ray.glb' }),
  footsteps: z.number().min(0).max(1).default(0.35),
  seed: z.number().default(3),
});

type Params = z.infer<typeof schema>;

/** A point at azimuth (degrees from the board direction) and distance from the eye. */
function at(az: number, dist: number, extra: Partial<Waypoint> = {}): Waypoint {
  const a = az * DEG;
  return { x: EYE.x + Math.sin(a) * dist, z: EYE.z - Math.cos(a) * dist, ...extra };
}

/** Mirrors a path to the other side of the board (azimuths flipped). */
function mirrorPath(points: Waypoint[], side: number): Waypoint[] {
  if (side > 0) return points;
  return points.map((p) => ({ ...p, x: 2 * EYE.x - p.x, look: p.look ? ([2 * EYE.x - p.look[0], p.look[1], p.look[2]] as const) : undefined }) as Waypoint);
}

interface WalkerSpec {
  legs: { names: [string, string, string, string]; offset: number; front: boolean; side: number }[];
  /** Spine bones from pelvis forward, neck bones, head, tail bones. */
  spine: string[];
  neck: string[];
  head: string;
  tail: string[];
  arms?: { upper: string; lower: string; hand: string; side: number }[];
  /** Stride (m at scale 1), fraction of the cycle a foot is down, lift height (m at scale 1), min swing (s). */
  stride: number;
  duty: number;
  lift: number;
  minSwing: number;
  bob: number;
  hunch: number;
}

const QUAD = (stride: number, lift: number, minSwing: number): WalkerSpec => ({
  legs: [
    { names: ['thigh_L', 'shin_L', 'foot_L', 'foot_L_tip'], offset: 0.0, front: false, side: 1 },
    { names: ['arm_L', 'forearm_L', 'hand_L', 'hand_L_tip'], offset: 0.25, front: true, side: 1 },
    { names: ['thigh_R', 'shin_R', 'foot_R', 'foot_R_tip'], offset: 0.5, front: false, side: -1 },
    { names: ['arm_R', 'forearm_R', 'hand_R', 'hand_R_tip'], offset: 0.75, front: true, side: -1 },
  ],
  spine: ['spine1', 'spine2', 'chest'],
  neck: ['neck1', 'neck2', 'neck3'],
  head: 'head',
  tail: ['tail1', 'tail2'],
  stride,
  duty: 0.72,
  lift,
  minSwing,
  bob: 0.012,
  hunch: 0,
});

const STRIDER: WalkerSpec = QUAD(6.2, 0.9, 0.45);
const COLOSSUS: WalkerSpec = { ...QUAD(17, 2.2, 0.5), neck: ['neck1'], tail: [] };
const HOLLOW: WalkerSpec = {
  legs: [
    { names: ['thigh_L', 'shin_L', 'foot_L', 'foot_L_tip'], offset: 0.0, front: false, side: 1 },
    { names: ['thigh_R', 'shin_R', 'foot_R', 'foot_R_tip'], offset: 0.5, front: false, side: -1 },
  ],
  spine: ['spine1', 'chest'],
  neck: ['neck'],
  head: 'head',
  tail: [],
  arms: [
    { upper: 'arm_L', lower: 'forearm_L', hand: 'hand_L', side: 1 },
    { upper: 'arm_R', lower: 'forearm_R', hand: 'hand_R', side: -1 },
  ],
  stride: 3.0,
  duty: 0.62,
  lift: 0.32,
  minSwing: 0.35,
  bob: 0.06,
  hunch: 0.32,
};

/** Creature hide: dark, a pale bone tint from the vertex colours, wet sheen, back-lit rim. */
function hideMaterial(light: Lighting, tint: [number, number, number], rim: number, wet: number): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  const col = cast<V3>(attribute('color', 'vec4').rgb);
  const albedo = cast<V3>(col.mul(vec3(...tint)));
  const n = cast<V3>(normalize(normalWorld));
  const color = light.shade({ albedo, normal: n, world: cast<V3>(positionWorld), roughness: cast<F>(float(0.55)), wet: cast<F>(float(wet)), rim, translucent: cast<F>(float(0.12)), fill: 0.8 });
  m.colorNode = vec4(color, 1);
  m.fog = false;
  m.side = DoubleSide;
  m.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
  return m;
}

/** One rigged creature walking a path, posed every frame. */
class Walker {
  readonly root: Object3D;
  readonly rig: RigInfo;
  readonly legs: Leg[];
  readonly mesh: SkinnedMesh;
  path: PathFollower | null = null;
  scale = 1;
  phase = 0;
  eventId = -1;
  private look = 0;
  private lookPitch = 0;
  private hunchNow = 0;
  private armSwing: number[] = [];
  private readonly fwd = new Vector3();
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();

  constructor(
    root: Object3D,
    readonly spec: WalkerSpec,
    material: MeshBasicNodeMaterial,
    readonly seed: number,
    readonly onStep: (x: number, y: number, zz: number) => void,
  ) {
    this.root = root;
    this.rig = rigOf(root);
    let mesh: SkinnedMesh | null = null;
    root.traverse((o) => {
      const sm = o as SkinnedMesh;
      if (sm.isSkinnedMesh) {
        mesh = sm;
        sm.material = material;
        sm.frustumCulled = false;
      }
    });
    if (!mesh) throw new Error('creature model has no skinned mesh');
    this.mesh = mesh;
    root.updateMatrixWorld(true);
    this.legs = spec.legs.map((l) => makeLeg(this.rig, root, l.names, l.offset, l.front, l.side));
    this.armSwing = (spec.arms ?? []).map(() => 0);
    root.visible = false;
  }

  get active(): boolean {
    return this.root.visible;
  }

  start(points: Waypoint[], scale: number, speed: number, eventId: number): void {
    this.scale = scale;
    this.path = new PathFollower(points, speed, 0.22 * (6 / Math.max(1, scale)) + 0.08, speed * 0.25, this.seed);
    this.eventId = eventId;
    this.phase = 0;
    this.root.scale.setScalar(scale);
    this.root.visible = true;
    this.place(0);
    // Plant every foot where it rests under the starting body.
    for (const leg of this.legs) {
      this.ideal(leg, 0, leg.plant);
      leg.swing = null;
      leg.lastCycle = -1;
    }
  }

  stop(): void {
    this.root.visible = false;
    this.path = null;
    this.eventId = -1;
  }

  /** Where a leg's foot would rest under the body `ahead` seconds from now (ground height applied). */
  private ideal(leg: Leg, ahead: number, out: Vector3): Vector3 {
    const p = this.path!;
    const h = p.heading;
    const s = this.scale;
    const x = p.x + Math.sin(h) * p.speed * ahead;
    const zz = p.z + Math.cos(h) * p.speed * ahead;
    const c = leg.restContact;
    const ch = Math.cos(h);
    const sh = Math.sin(h);
    out.set(x + (c.x * ch + c.z * sh) * s, 0, zz + (-c.x * sh + c.z * ch) * s);
    out.y = terrainHeight(out.x, out.z);
    return out;
  }

  private place(bob: number): void {
    const p = this.path!;
    let gy = 0;
    if (this.legs.every((l) => l.plant.lengthSq() > 0)) {
      for (const l of this.legs) gy += l.swing ? l.swing.from.y * 0.5 + l.swing.to.y * 0.5 : l.plant.y;
      gy /= this.legs.length;
    } else gy = terrainHeight(p.x, p.z);
    this.root.position.set(p.x, gy - bob * this.scale, p.z);
    this.root.rotation.set(0, p.heading, 0, 'YXZ');
    this.root.updateMatrixWorld(true);
  }

  update(dt: number, time: number): void {
    const p = this.path;
    if (!p || !this.root.visible) return;
    p.update(dt);
    const sp = this.spec;
    const s = this.scale;
    const strideW = sp.stride * s;
    this.phase += (p.speed / strideW) * dt;
    const cycleTime = strideW / Math.max(p.speed, 0.05);
    const swingDur = Math.max(sp.minSwing * Math.sqrt(s), (1 - sp.duty) * cycleTime);
    resetPose(this.rig);
    // Weight comes off a leg as it swings: the body dips a little.
    let swinging = 0;
    for (const l of this.legs) if (l.swing) swinging += Math.sin(Math.PI * Math.min(1, l.swing.t));
    this.place(sp.bob * swinging);
    this.fwd.set(Math.sin(p.heading), 0, Math.cos(p.heading));
    const side = this.tmp2.set(Math.cos(p.heading), 0, -Math.sin(p.heading));
    const moving = p.speed > 0.08 * p.baseSpeed;

    // Body pitch from the ground under the front and hind feet.
    const front = this.legs.filter((l) => l.front);
    const hind = this.legs.filter((l) => !l.front);
    const rootBone = this.rig.bones.get('root');
    if (front.length && hind.length && rootBone) {
      const fy = front.reduce((a, l) => a + l.plant.y, 0) / front.length;
      const hy = hind.reduce((a, l) => a + l.plant.y, 0) / hind.length;
      const span = Math.max(1, front[0]!.restContact.distanceTo(hind[0]!.restContact) * s);
      rotateWorld(rootBone, side, -Math.atan2(fy - hy, span) * 0.8);
    }

    // Spine: a hunch for the biped (deeper while still), a little sway with the gait.
    const sway = Math.sin(this.phase * Math.PI * 2) * 0.03 * (moving ? 1 : 0.2);
    this.hunchNow += ((moving ? sp.hunch : sp.hunch * 1.25) - this.hunchNow) * Math.min(1, dt * 0.8);
    sp.spine.forEach((n, i) => {
      const b = this.rig.bones.get(n);
      if (!b) return;
      rotateWorld(b, side, (this.hunchNow / sp.spine.length) * (i + 1) * 0.6);
      rotateWorld(b, this.fwd, sway / sp.spine.length);
    });

    // Head: looks about slowly; during a pause it turns towards the look target (or the viewer).
    let wantLook = noise1(time * 0.07, this.seed) * 0.35;
    let wantPitch = noise1(time * 0.05 + 7, this.seed) * 0.12;
    if (p.pausedFor > 0) {
      const target = p.look ?? [EYE.x, EYE.y, EYE.z];
      const dx = target[0] - p.x;
      const dz = target[2] - p.z;
      let dh = Math.atan2(dx, dz) - p.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      wantLook = Math.max(-1.1, Math.min(1.1, dh)) * 0.85;
      wantPitch = 0.15 + 0.08 * noise1(time * 0.3, this.seed + 3);
    }
    this.look += (wantLook - this.look) * Math.min(1, dt * 0.35);
    this.lookPitch += (wantPitch - this.lookPitch) * Math.min(1, dt * 0.4);
    const up = this.tmp.set(0, 1, 0);
    const neckBones = [...sp.neck, sp.head].map((n) => this.rig.bones.get(n)).filter((b): b is NonNullable<typeof b> => !!b);
    neckBones.forEach((b, i) => {
      const w = (i + 1) / neckBones.length / neckBones.length * 2;
      rotateWorld(b, up, this.look * w);
      rotateWorld(b, side, this.lookPitch * w + Math.sin(this.phase * Math.PI * 4) * 0.015 * (moving ? 1 : 0));
    });
    sp.tail.forEach((n, i) => {
      const b = this.rig.bones.get(n);
      if (b) rotateWorld(b, up, Math.sin(this.phase * Math.PI * 2 + i * 0.8) * 0.12 + noise1(time * 0.2, this.seed + i) * 0.1);
    });

    // Legs: step when their turn comes and the foot lags behind, swing on an arc, plant.
    const cycle = this.phase;
    for (const leg of this.legs) {
      const c = Math.floor(cycle - leg.offset);
      const ideal = this.ideal(leg, 0, new Vector3());
      const lag = ideal.distanceTo(leg.plant);
      const others = this.legs.some((o) => o !== leg && o.swing && (o.side === leg.side || this.legs.length === 2));
      const wantStep = moving ? c > leg.lastCycle : lag > strideW * 0.22 && !this.legs.some((o) => o.swing);
      if (!leg.swing && wantStep && !(others && this.legs.length > 2 && !moving)) {
        leg.lastCycle = c;
        if (lag > strideW * 0.08 || moving) {
          const dur = moving ? swingDur : Math.max(sp.minSwing * Math.sqrt(s), 0.9);
          const to = this.ideal(leg, dur, new Vector3()).addScaledVector(this.fwd, moving ? strideW * sp.duty * 0.5 : 0);
          to.y = terrainHeight(to.x, to.z);
          leg.swing = { from: leg.plant.clone(), to, t: 0, dur };
        }
      }
      let contact = leg.plant;
      let lift = 0;
      if (leg.swing) {
        const sw = leg.swing;
        sw.t += dt / sw.dur;
        // Re-aim the landing as the body turns or changes pace.
        const re = this.ideal(leg, Math.max(0, (1 - sw.t) * sw.dur), new Vector3()).addScaledVector(this.fwd, moving ? strideW * sp.duty * 0.5 : 0);
        re.y = terrainHeight(re.x, re.z);
        sw.to.lerp(re, Math.min(1, dt * 3));
        const u = Math.min(1, sw.t);
        const e = u * u * (3 - 2 * u);
        contact = new Vector3().lerpVectors(sw.from, sw.to, e);
        lift = Math.sin(Math.PI * u) * sp.lift * s * (0.7 + 0.3 * Math.min(1, sw.from.distanceTo(sw.to) / strideW));
        contact.y += lift;
        if (sw.t >= 1) {
          leg.plant.copy(sw.to);
          leg.swing = null;
          this.onStep(leg.plant.x, leg.plant.y, leg.plant.z);
          contact = leg.plant;
        }
      }
      // Ankle above the contact, keeping the foot segment's rest slope (tilted up a little mid-swing).
      const fv = this.tmp.copy(leg.footVec).multiplyScalar(s).applyAxisAngle(new Vector3(0, 1, 0), p.heading);
      const ankle = new Vector3().copy(contact).sub(fv);
      if (lift > 0) ankle.y += lift * 0.15;
      const pole = leg.pole.clone().applyAxisAngle(new Vector3(0, 1, 0), p.heading);
      solveLeg(leg, s, ankle, contact, pole);
    }

    // Arms (the biped): hang heavy, swing against the legs with a lag, and stir while it stands.
    (sp.arms ?? []).forEach((a, i) => {
      const upper = this.rig.bones.get(a.upper);
      const lower = this.rig.bones.get(a.lower);
      if (!upper || !lower) return;
      const want = moving ? Math.sin((this.phase + (a.side > 0 ? 0.5 : 0)) * Math.PI * 2 - 0.6) * 0.22 : noise1(time * 0.15, this.seed + i * 5) * 0.06;
      this.armSwing[i]! += (want - this.armSwing[i]!) * Math.min(1, dt * 3);
      rotateWorld(upper, side, -this.armSwing[i]!);
      rotateWorld(upper, this.fwd, a.side * 0.04);
      rotateWorld(lower, side, -Math.max(0, this.armSwing[i]!) * 0.6 - 0.05);
    });
    void aim;
  }
}

/** The ray swarm: instanced, wings rippling on the GPU, positions from a formation flock on the CPU. */
class Swarm {
  readonly mesh: InstancedMesh;
  readonly count: number;
  private readonly pos: InstancedBufferAttribute;
  private readonly rot: InstancedBufferAttribute;
  private readonly anim: InstancedBufferAttribute;
  private readonly p: Vector3[];
  private readonly v: Vector3[];
  private readonly seedOff: Vector3[];
  private readonly sizes: number[];
  private readonly phases: number[];
  private route: Vector3[] = [];
  private t = 0;
  duration = 40;
  eventId = -1;
  private readonly q = new Quaternion();
  private readonly m = new Matrix4();

  constructor(geometry: BufferGeometry, light: Lighting, count: number, size: [number, number], seed: number) {
    this.count = count;
    const r = rng(seed);
    this.pos = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.rot = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.anim = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.p = Array.from({ length: count }, () => new Vector3());
    this.v = Array.from({ length: count }, () => new Vector3());
    this.seedOff = Array.from({ length: count }, () => new Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1));
    this.sizes = Array.from({ length: count }, () => size[0] + (size[1] - size[0]) * r());
    this.phases = Array.from({ length: count }, () => r() * Math.PI * 2);
    const ip = cast<V4>(instancedBufferAttribute(this.pos));
    const iq = cast<V4>(instancedBufferAttribute(this.rot));
    const ia = cast<V4>(instancedBufferAttribute(this.anim));
    const g = cast<V3>(positionGeometry);
    const ax = cast<F>(g.x.abs().div(2.5).clamp(0, 1));
    const ph = cast<F>(ia.x);
    const flap = cast<F>(sin(ph.sub(ax.mul(1.7))).mul(ia.y).mul(ax.pow(1.5)).mul(1.1));
    const chord = cast<F>(sin(ph.mul(1.3).add(g.z.mul(2.6)).sub(ax.mul(2))).mul(0.07).mul(ax));
    const tailK = cast<F>(smoothstep(-0.8, -3.6, g.z));
    const tailX = cast<F>(sin(ph.mul(0.8).add(g.z.mul(1.8))).mul(0.18).mul(tailK));
    const local = cast<V3>(vec3(g.x.add(tailX), g.y.add(flap).add(chord).add(tailK.mul(sin(ph.mul(0.6).add(g.z)).mul(0.08))), g.z));
    const rotate = (vv: V3): V3 => {
      const t = cast<V3>(iq.xyz.cross(vv).mul(2));
      return cast<V3>(vv.add(t.mul(iq.w)).add(iq.xyz.cross(t)));
    };
    const world = cast<V3>(rotate(cast<V3>(local.mul(ip.w))).add(ip.xyz));
    // Wing slope from the flap's spanwise derivative, for the lighting.
    const dflap = cast<F>(cos(ph.sub(ax.mul(1.7))).mul(ia.y).mul(ax.pow(0.5)).mul(1.65).mul(g.x.sign()).mul(-0.3));
    const nLocal = cast<V3>(normalize(attribute('normal', 'vec3').add(vec3(dflap, 0, 0))));
    const material = new MeshBasicNodeMaterial();
    material.positionNode = world;
    const nWorld = cast<V3>(normalize(rotate(nLocal)));
    const albedo = cast<V3>(cast<V4>(attribute('color', 'vec4')).rgb.mul(vec3(0.075, 0.078, 0.088)));
    const shaded = light.shade({ albedo, normal: nWorld, world: cast<V3>(positionWorld), roughness: cast<F>(float(0.5)), rim: 1.1, translucent: cast<F>(float(0.35).add(ax.mul(0.25))) });
    material.colorNode = vec4(shaded, 1);
    material.opacityNode = cast<F>(ia.w);
    material.alphaTest = 0.5;
    material.side = DoubleSide;
    material.fog = false;
    material.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
    this.mesh = new InstancedMesh(geometry, material, count);
    // Instance matrices stay identity: the TSL position node places every ray.
    this.mesh.frustumCulled = false;
    this.mesh.name = 'veil-rays';
    this.mesh.visible = false;
    this.material = material;
    this.positionNode = world;
    void mix;
    void cameraPosition;
  }

  readonly material: MeshBasicNodeMaterial;
  readonly positionNode: V3;

  /** A route through the sky (world points); the flock follows it over `duration` seconds. */
  start(route: Vector3[], duration: number, eventId: number): void {
    this.route = route;
    this.duration = duration;
    this.t = 0;
    this.eventId = eventId;
    const start = route[0]!;
    this.p.forEach((pp, i) => pp.copy(start).addScaledVector(this.seedOff[i]!, 60));
    this.v.forEach((vv) => vv.set(0, 0, 0));
    this.mesh.visible = true;
  }

  stop(): void {
    this.mesh.visible = false;
    this.eventId = -1;
  }

  private along(u: number, out: Vector3): Vector3 {
    const r = this.route;
    const f = Math.min(r.length - 1.001, Math.max(0, u * (r.length - 1)));
    const i = Math.floor(f);
    const k = f - i;
    // Catmull-Rom through the route points.
    const p0 = r[Math.max(0, i - 1)]!;
    const p1 = r[i]!;
    const p2 = r[i + 1]!;
    const p3 = r[Math.min(r.length - 1, i + 2)]!;
    const k2 = k * k;
    const k3 = k2 * k;
    out.set(0, 0, 0)
      .addScaledVector(p0, -0.5 * k3 + k2 - 0.5 * k)
      .addScaledVector(p1, 1.5 * k3 - 2.5 * k2 + 1)
      .addScaledVector(p2, -1.5 * k3 + 2 * k2 + 0.5 * k)
      .addScaledVector(p3, 0.5 * k3 - 0.5 * k2);
    return out;
  }

  update(dt: number, time: number): void {
    if (!this.mesh.visible) return;
    this.t += dt;
    const u = this.t / this.duration;
    if (u >= 1) {
      this.stop();
      return;
    }
    const lead = new Vector3();
    const ahead = new Vector3();
    const target = new Vector3();
    // The formation morphs: a long ribbon, a loose cloud, a turning ring, back to a ribbon.
    const mode = (Math.sin(time * 0.045 + 1.3) + 1) * 0.5;
    const ring = Math.max(0, Math.sin(time * 0.031 + 4.1));
    const pa = this.pos.array as Float32Array;
    const qa = this.rot.array as Float32Array;
    const aa = this.anim.array as Float32Array;
    const fadeIn = sstep(0, 0.08, u);
    const fadeOut = sstep(1, 0.88, u);
    for (let i = 0; i < this.count; i++) {
      const f = i / this.count;
      const lagU = Math.max(0, u - f * 0.09 * (1 - ring * 0.6));
      this.along(lagU, lead);
      this.along(Math.min(1, lagU + 0.01), ahead);
      const dir = ahead.clone().sub(lead).normalize();
      const sideV = new Vector3(dir.z, 0, -dir.x).normalize();
      const so = this.seedOff[i]!;
      // Ribbon: a sheet that undulates; cloud: scattered; ring: a wheel around the lead point.
      const ribbon = new Vector3().addScaledVector(sideV, so.x * 34).add(new Vector3(0, Math.sin(f * 9 + time * 0.4) * 12 + so.y * 6, 0));
      const cloud = new Vector3(so.x, so.y * 0.5, so.z).multiplyScalar(70);
      const ang = f * Math.PI * 2 + time * 0.18;
      const wheel = new Vector3().addScaledVector(sideV, Math.cos(ang) * 55).add(new Vector3(0, Math.sin(ang) * 36, 0));
      const off = ribbon.lerp(cloud, mode * (1 - ring)).lerp(wheel, ring * 0.8);
      target.copy(lead).add(off);
      // Spring towards the formation slot, with a little wander.
      const pp = this.p[i]!;
      const vv = this.v[i]!;
      const acc = target.sub(pp).multiplyScalar(0.25).sub(vv.clone().multiplyScalar(0.55));
      acc.x += noise1(time * 0.3 + i, 2) * 1.5;
      acc.y += noise1(time * 0.27 + i, 5) * 0.8;
      vv.addScaledVector(acc, dt);
      pp.addScaledVector(vv, dt);
      // Orientation: along the velocity (blended with the route direction), banking into turns.
      const heading = vv.lengthSq() > 0.5 ? vv.clone().normalize().lerp(dir, 0.5).normalize() : dir;
      const bank = Math.max(-0.7, Math.min(0.7, acc.dot(sideV) * -0.04));
      this.m.lookAt(new Vector3(0, 0, 0), heading.clone().negate(), new Vector3(0, 1, 0));
      this.q.setFromRotationMatrix(this.m);
      this.q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), bank));
      const sc = this.sizes[i]! * 1.0;
      pa[i * 4] = pp.x;
      pa[i * 4 + 1] = pp.y;
      pa[i * 4 + 2] = pp.z;
      pa[i * 4 + 3] = sc;
      qa[i * 4] = this.q.x;
      qa[i * 4 + 1] = this.q.y;
      qa[i * 4 + 2] = this.q.z;
      qa[i * 4 + 3] = this.q.w;
      // Slow wingbeats, a travelling wave across the flock; glides between bouts.
      const bout = 0.55 + 0.45 * Math.max(0, Math.sin(time * 0.21 + f * 2.5));
      this.phases[i]! += dt * (1.9 + 0.4 * so.z) * bout;
      aa[i * 4] = this.phases[i]!;
      aa[i * 4 + 1] = 0.55 * bout;
      aa[i * 4 + 2] = bank;
      aa[i * 4 + 3] = fadeIn * fadeOut > (i % 7) / 7 * 0.6 + 0.2 ? 1 : 0;
    }
    this.pos.needsUpdate = true;
    this.rot.needsUpdate = true;
    this.anim.needsUpdate = true;
  }
}

function sideOf(e: VeilEvent): number {
  return e.variant < 0.5 ? -1 : 1;
}

/**
 * The creatures and what they do for each director event:
 * - silhouette / shadowRuin: the strider walks out of the deep fog on the moon side (backlit), pauses,
 *   and recedes; on the shadowRuin path its shadow sweeps over the lookout tower and the trees.
 * - treeWalker: the hollow steps out from between the dead trees, stops, turns its head, moves on.
 * - giantShadow: the colossus walks behind the far ridges in deep fog; mostly only its shadow, sweeping
 *   across the lowland, and the line of its back above the mountains are seen.
 * - swarm: a flock of fog rays crosses the sky against the bright fog, changing formation.
 */
export const creaturesComponent: ComponentFactory<Params> = {
  type: 'veilCreatures',
  version: 1,
  description: 'Original rigged creatures (strider, hollow, colossus) and a ray swarm, driven by the event director.',
  schema,
  async create(ctx: EnvironmentContext, p: Params) {
    const s = shared(ctx);
    const fog = await fogModelFor(ctx, s, p.exposure);
    const light = createLighting(s, fog, p.lighting);
    const group = new Group();
    const presence = floatUniform(1);
    const steps = (gain: number) => (x: number, y: number, zz: number) => {
      if (p.footsteps > 0 && ctx.quality.detail !== 'low') ctx.sounds.emit('footstep', x, y, zz, gain * p.footsteps);
    };
    const load = async (src: string) => (await ctx.assets.loadGLTF(src)).scene;
    const striderScene = await load(p.strider.model);
    const hollowScene = await load(p.hollow.model);
    const colossusScene = await load(p.colossus.model);
    const rayScene = await load(p.rays.model);
    const strider = new Walker(striderScene, STRIDER, hideMaterial(light, [0.3, 0.3, 0.32], 1.2, 0.25), 11, steps(0.25));
    const hollow = new Walker(hollowScene, HOLLOW, hideMaterial(light, [0.28, 0.27, 0.27], 1.0, 0.15), 23, steps(0.12));
    const colossus = new Walker(colossusScene, COLOSSUS, hideMaterial(light, [0.24, 0.24, 0.26], 0.6, 0.0), 37, steps(0.4));
    for (const w of [strider, hollow, colossus]) {
      group.add(w.root);
      castShadow(w.mesh);
    }
    const rayParts = partsNamed(rayScene, 'ray');
    const detailScale = ctx.quality.detail === 'low' ? 0.45 : ctx.quality.detail === 'medium' ? 0.7 : 1;
    const swarm = rayParts[0] ? new Swarm(rayParts[0].geometry, light, Math.max(8, Math.round(p.rays.count * detailScale)), p.rays.size, p.seed) : null;
    if (swarm) {
      group.add(swarm.mesh);
      castShadow(swarm.mesh, swarm.positionNode);
    }

    const director = s.director;
    if (typeof __PRISMFALL_HOOKS__ !== 'undefined' && __PRISMFALL_HOOKS__) {
      const h = (globalThis as unknown as { __veil?: Record<string, unknown> }).__veil;
      if (h) h.creatures = { strider, hollow, colossus, swarm };
    }
    const startFor = (e: VeilEvent) => {
      const side = sideOf(e);
      const calm = (s.director?.comfort ?? 'full') !== 'full';
      const far = calm ? 1.25 : 1;
      switch (e.kind) {
        case 'silhouette': {
          // On the moon side (left), where the fog is brightest behind it: out of the deep fog,
          // a pause, then away again.
          const pts = [at(-40, 820 * far), at(-34, 520 * far, { pause: 8 }), at(-43, 610 * far), at(-52, 880 * far)];
          strider.start(pts, p.strider.scale, p.strider.speed, e.id);
          break;
        }
        case 'shadowRuin': {
          // Just outside the clear zone on the left: the low moon behind it throws its shadow
          // across the marsh, over the boardwalk and the cabin, before you find the body.
          const pts = [at(-46, 560 * far), at(-31, 340 * far), at(-27, 310 * far, { pause: 6 }), at(-30, 380 * far), at(-42, 650 * far)];
          strider.start(pts, p.strider.scale * 1.15, p.strider.speed * 0.9, e.id);
          break;
        }
        case 'treeWalker': {
          const d = calm ? 1.3 : 1;
          const pts = mirrorPath([at(48, 150 * d), at(40, 110 * d), at(34, 92 * d, { pause: 9, look: [EYE.x, EYE.y, EYE.z] }), at(29, 104 * d), at(36, 150 * d), at(44, 230 * d)], side);
          hollow.start(pts, p.hollow.scale, p.hollow.speed, e.id);
          break;
        }
        case 'giantShadow': {
          // Its shadow (the moon is low, behind it) sweeps across the tower, the forest and the marsh.
          const pts = [at(-60, 1250), at(-46, 1080), at(-35, 1020), at(-27, 1150), at(-25, 1750)];
          colossus.start(pts, p.colossus.scale, p.colossus.speed, e.id);
          break;
        }
        case 'swarm': {
          if (!swarm) break;
          const h = (az: number, dist: number, y: number) => {
            const w = at(az, dist);
            return new Vector3(w.x, y, w.z);
          };
          const route = side < 0 ? [h(-74, 620, 50), h(-56, 380, 60), h(-42, 300, 72), h(-32, 330, 62), h(-28, 520, 95), h(-40, 900, 160)] : [h(74, 640, 55), h(58, 400, 62), h(44, 320, 76), h(33, 360, 64), h(28, 560, 100), h(42, 950, 170)];
          swarm.start(route, e.duration, e.id);
          break;
        }
        default:
          break;
      }
    };

    return {
      object: group,
      update(frame) {
        const dt = Math.min(0.1, frame.dt) * s.timeScale;
        const d = director ?? s.director;
        if (d) {
          for (const e of d.active) {
            const owner = e.kind === 'silhouette' || e.kind === 'shadowRuin' ? strider : e.kind === 'treeWalker' ? hollow : e.kind === 'giantShadow' ? colossus : e.kind === 'swarm' ? swarm : null;
            if (owner && owner.eventId !== e.id) startFor(e);
          }
        }
        // A thinner window in the fog around a far walker, so its silhouette can come and go.
        const clearSlot = (slot: number, w: Walker | null, radius: number, amount: number) => {
          const v = s.fog.pocketValues[MAX_POCKETS - 1 - slot]!;
          const a = s.fog.pocketAmounts[MAX_POCKETS - 1 - slot]!;
          if (!w || !w.active || !w.path) {
            v.set(0, -9999, 0, 1);
            a.set(0, 0.5, 1, 0);
            return;
          }
          const k = sstep(0, 12, w.path.time) * (w.path.done ? 0 : 1);
          v.set(w.path.x, terrainHeight(w.path.x, w.path.z) + 30, w.path.z, radius);
          a.set(amount * k, 0.2, 1.4, 0);
        };
        clearSlot(0, strider.active ? strider : null, 260, -0.5);
        clearSlot(1, colossus.active ? colossus : null, 420, -0.25);
        for (const w of [strider, hollow, colossus]) {
          if (!w.active) continue;
          w.update(dt, frame.time);
          // Gone into the deep fog at the end of its path.
          if (w.path?.done && w.path.speed < 0.01) w.stop();
        }
        swarm?.update(dt, frame.time);
      },
      setPresence(v) {
        presence.value = v;
        group.visible = v > 0.02;
      },
      dispose() {
        group.traverse((o) => {
          const mesh = o as { geometry?: { dispose(): void }; material?: { dispose(): void } };
          mesh.geometry?.dispose();
          mesh.material?.dispose();
        });
        for (const m of [p.strider.model, p.hollow.model, p.colossus.model, p.rays.model]) ctx.assets.release(m);
        release(ctx, s);
      },
    };
  },
};
