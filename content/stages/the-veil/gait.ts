import { Quaternion, Vector3, type Bone, type Object3D } from 'three/webgpu';

/**
 * Procedural locomotion for the Veil's rigged creatures (CPU, a few dozen bones each; the GPU does
 * the skinning). Feet are planted on the real terrain and only move when their leg steps: a leg
 * lifts when its foot has fallen behind where it would rest under the moving body and its turn in
 * the gait comes round, swings along a lifted arc to where the body will be when it lands, and
 * plants again. Legs are posed by two-bone IK with the knee or elbow bending the way the rest pose
 * bends it; the metatarsal keeps its rest slope. Bodies ride on their feet (height and pitch from
 * the ground under them, a dip as weight comes off a leg), and spines, necks, heads and tails get
 * secondary motion that lags the body.
 */

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _q = new Quaternion();
const _pq = new Quaternion();
const _pqi = new Quaternion();

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Smooth 1D value noise in -1..1 (for drifting looks, speeds and sways). */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n: number) => {
    const s = Math.sin((n + seed * 131.7) * 127.1) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}

/** Rotates `bone` (in world space) so the direction to `child` points at `target`. */
export function aim(bone: Bone, child: Object3D, target: Vector3, weight = 1): void {
  bone.getWorldPosition(_a);
  child.getWorldPosition(_b);
  const cur = _b.sub(_a);
  const want = _c.copy(target).sub(_a);
  if (cur.lengthSq() < 1e-10 || want.lengthSq() < 1e-10) return;
  cur.normalize();
  want.normalize();
  _q.setFromUnitVectors(cur, want);
  if (weight < 1) _q.slerp(new Quaternion(), 1 - weight);
  const parent = bone.parent;
  if (parent) parent.getWorldQuaternion(_pq);
  else _pq.identity();
  _pqi.copy(_pq).invert();
  bone.quaternion.premultiply(_pqi.multiply(_q).multiply(_pq));
  bone.updateWorldMatrix(false, true);
}

/** Adds a world-space rotation (axis-angle) to a bone, keeping its parent frame. */
export function rotateWorld(bone: Bone, axis: Vector3, angle: number): void {
  if (Math.abs(angle) < 1e-6) return;
  _q.setFromAxisAngle(axis, angle);
  const parent = bone.parent;
  if (parent) parent.getWorldQuaternion(_pq);
  else _pq.identity();
  _pqi.copy(_pq).invert();
  bone.quaternion.premultiply(_pqi.multiply(_q).multiply(_pq));
  bone.updateWorldMatrix(false, true);
}

export interface Leg {
  readonly name: string;
  /** upper, lower, foot bones and the tip joint (contact point). */
  readonly upper: Bone;
  readonly lower: Bone;
  readonly foot: Bone;
  readonly tip: Object3D;
  /** Segment lengths at scale 1. */
  readonly l1: number;
  readonly l2: number;
  /** Rest offsets (body frame, scale 1): contact point and the foot segment (ankle to tip). */
  readonly restContact: Vector3;
  readonly footVec: Vector3;
  /** Rest bend direction of the middle joint (body frame). */
  readonly pole: Vector3;
  /** Gait offset 0..1 (when in the cycle this leg steps). */
  readonly offset: number;
  readonly front: boolean;
  readonly side: number;
  plant: Vector3;
  swing: { from: Vector3; to: Vector3; t: number; dur: number } | null;
  /** Last stepped gait cycle (so a leg steps once per cycle). */
  lastCycle: number;
}

export interface RigInfo {
  readonly bones: Map<string, Bone>;
  readonly rest: Map<Bone, { q: Quaternion; p: Vector3 }>;
}

export function rigOf(root: Object3D): RigInfo {
  const bones = new Map<string, Bone>();
  const rest = new Map<Bone, { q: Quaternion; p: Vector3 }>();
  root.traverse((o) => {
    const b = o as Bone;
    if (b.isBone) {
      bones.set(b.name, b);
      rest.set(b, { q: b.quaternion.clone(), p: b.position.clone() });
    }
  });
  return { bones, rest };
}

export function resetPose(rig: RigInfo): void {
  for (const [b, r] of rig.rest) {
    b.quaternion.copy(r.q);
    b.position.copy(r.p);
  }
}

/**
 * Builds a leg from bone names; rest measurements are taken in the body frame of `body` (the
 * creature's root object at identity transform and scale 1).
 */
export function makeLeg(rig: RigInfo, body: Object3D, names: [string, string, string, string], offset: number, front: boolean, side: number): Leg {
  const [u, l, f, t] = names.map((n) => {
    const b = rig.bones.get(n);
    if (!b) throw new Error(`missing bone ${n}`);
    return b;
  }) as [Bone, Bone, Bone, Bone];
  body.updateMatrixWorld(true);
  const inv = body.matrixWorld.clone().invert();
  const pu = u.getWorldPosition(new Vector3()).applyMatrix4(inv);
  const pl = l.getWorldPosition(new Vector3()).applyMatrix4(inv);
  const pf = f.getWorldPosition(new Vector3()).applyMatrix4(inv);
  const pt = t.getWorldPosition(new Vector3()).applyMatrix4(inv);
  const axis = pf.clone().sub(pu).normalize();
  const mid = pl.clone().sub(pu);
  const pole = mid.sub(axis.clone().multiplyScalar(mid.dot(axis))).normalize();
  return {
    name: names[0],
    upper: u,
    lower: l,
    foot: f,
    tip: t,
    l1: pl.distanceTo(pu),
    l2: pf.distanceTo(pl),
    restContact: pt.clone(),
    footVec: pt.clone().sub(pf),
    pole,
    offset,
    front,
    side,
    plant: new Vector3(),
    swing: null,
    lastCycle: -1,
  };
}

/** Two-bone IK: places the leg's ankle at `ankle`, bending towards `pole` (world), then aims the foot at `contact`. */
export function solveLeg(leg: Leg, scale: number, ankle: Vector3, contact: Vector3, pole: Vector3): void {
  const hip = leg.upper.getWorldPosition(_d);
  const l1 = leg.l1 * scale;
  const l2 = leg.l2 * scale;
  const toT = _a.copy(ankle).sub(hip);
  let d = toT.length();
  d = Math.min(Math.max(d, Math.abs(l1 - l2) + 1e-3), l1 + l2 - 1e-3);
  toT.normalize();
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const perp = _b.copy(pole).sub(_c.copy(toT).multiplyScalar(pole.dot(toT)));
  if (perp.lengthSq() < 1e-8) perp.set(0, 1, 0);
  perp.normalize();
  const knee = new Vector3().copy(hip).addScaledVector(toT, a).addScaledVector(perp, h);
  const target = new Vector3().copy(hip).addScaledVector(toT, d);
  aim(leg.upper, leg.lower, knee);
  aim(leg.lower, leg.foot, target);
  aim(leg.foot, leg.tip, contact);
}

export interface Waypoint {
  readonly x: number;
  readonly z: number;
  /** Pause here (seconds) before going on. */
  readonly pause?: number;
  /** Speed towards this point (m/s at the creature's scale). */
  readonly speed?: number;
  /** While paused, look at this world point. */
  readonly look?: readonly [number, number, number];
}

/** Steering along waypoints: speed with gentle variation, a turn-rate limit, pauses. */
export class PathFollower {
  x: number;
  z: number;
  heading: number;
  speed = 0;
  index = 1;
  pausedFor = 0;
  done = false;
  /** Elapsed time and the current pause's look target. */
  time = 0;
  look: readonly [number, number, number] | null = null;

  constructor(
    readonly points: readonly Waypoint[],
    readonly baseSpeed: number,
    readonly turnRate: number,
    readonly accel: number,
    readonly seed: number,
  ) {
    const p0 = points[0]!;
    const p1 = points[1] ?? p0;
    this.x = p0.x;
    this.z = p0.z;
    this.heading = Math.atan2(p1.x - p0.x, p1.z - p0.z);
  }

  update(dt: number): void {
    this.time += dt;
    if (this.done) {
      this.speed = Math.max(0, this.speed - this.accel * dt);
      return;
    }
    const target = this.points[this.index];
    if (!target) {
      this.done = true;
      return;
    }
    if (this.pausedFor > 0) {
      this.pausedFor -= dt;
      this.speed = Math.max(0, this.speed - this.accel * 1.5 * dt);
      if (this.pausedFor <= 0) {
        this.look = null;
        this.index++;
        if (this.index >= this.points.length) this.done = true;
      }
      return;
    }
    const dx = target.x - this.x;
    const dz = target.z - this.z;
    const dist = Math.hypot(dx, dz);
    const want = Math.atan2(dx, dz);
    let dh = want - this.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    this.heading += Math.max(-this.turnRate * dt, Math.min(this.turnRate * dt, dh));
    // Slow for sharp turns and on arrival; the pace drifts a little.
    const turning = 1 - 0.65 * smoothstep(0.2, 1.4, Math.abs(dh));
    const arriving = target.pause ? smoothstep(0, this.baseSpeed * 4, dist) * 0.85 + 0.15 : 1;
    const vary = 1 + 0.18 * noise1(this.time * 0.09, this.seed);
    const goal = (target.speed ?? this.baseSpeed) * turning * arriving * vary;
    this.speed += Math.max(-this.accel * dt, Math.min(this.accel * dt, goal - this.speed));
    this.x += Math.sin(this.heading) * this.speed * dt;
    this.z += Math.cos(this.heading) * this.speed * dt;
    if (dist < Math.max(2, this.baseSpeed * 1.5)) {
      if (target.pause) {
        this.pausedFor = target.pause;
        this.look = target.look ?? null;
      } else {
        this.index++;
        if (this.index >= this.points.length) this.done = true;
      }
    }
  }
}
