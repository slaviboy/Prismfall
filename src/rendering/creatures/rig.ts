import { Vector4 } from 'three/webgpu';
import { abs, cos, cross, dot, float, int, max, mix, select, sign, sin, uniformArray, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { z } from 'zod';

const vec3Tuple = z.tuple([z.number(), z.number(), z.number()]);

/**
 * Creature rig file (<name>.rig.json, written by assets/blender/scripts/creatures.py).
 * Pivots and axes are in glTF y-up space; the body faces `forward`. Each vertex carries a primary
 * joint (_JA) and an optional parent joint (_JB, -1 = none) so a two-bone chain (hip then knee) bends.
 */
export const rigSchema = z.object({
  name: z.string(),
  forward: z.enum(['-z', '+z', '-x', '+x']).default('-z'),
  height: z.number().positive(),
  /** Ground distance covered by one gait cycle at scale 1 (metres). */
  stride: z.number().positive(),
  /** Vertical body bob amplitude (twice per cycle). */
  bob: z.number().default(0),
  /** Side-to-side roll amplitude in radians (pacing gaits sway). */
  sway: z.number().default(0.025),
  joints: z
    .array(
      z.object({
        name: z.string(),
        pivot: vec3Tuple,
        axis: vec3Tuple,
        amp: z.number(),
        phase: z.number(),
        freq: z.number().default(1),
        bias: z.number().default(0),
        /** 0 = swing both ways; ±1 = bend only to one side (knees, hocks). */
        rectify: z.number().min(-1).max(1).default(0),
      }),
    )
    .max(16),
});

export type CreatureRig = z.infer<typeof rigSchema>;
export type RigJoint = CreatureRig['joints'][number];

const TAU = Math.PI * 2;

/** Joint angle (radians) at gait phase 0..1, scaled by `gait` (0 = standing). Mirrors the shader. */
export function jointAngle(j: RigJoint, phase: number, gait = 1): number {
  const s = Math.sin((phase * j.freq + j.phase) * TAU);
  const r = j.rectify;
  const shaped = (1 - Math.abs(r)) * s + Math.abs(r) * Math.sign(r) * Math.max(0, s);
  return j.bias + j.amp * shaped * gait;
}

/** Vertical bob at gait phase (two lifts per cycle). */
export function bodyBob(rig: CreatureRig, phase: number, gait = 1): number {
  return rig.bob * (0.5 - 0.5 * Math.cos(phase * TAU * 2)) * gait;
}

type V3 = Node<'vec3'>;
type F = Node<'float'>;

/** Typed element access for vec4 uniform arrays (the r187 typings return an untyped node). */
export function vec4At(arr: { element(i: Node<'int'> | Node<'uint'>): unknown }, i: Node<'int'> | Node<'uint'>): Node<'vec4'> {
  return arr.element(i) as Node<'vec4'>;
}

export interface RigNodes {
  /**
   * Poses a rest-space point (and normal) for gait `phase`, chaining the vertex's primary joint
   * then its parent joint, then applying bob and sway. Returns rig-space results.
   */
  pose(p: V3, n: V3 | null, ja: F, jb: F, phase: F, gait: F): { position: V3; normal: V3 | null };
}

/** Builds the TSL rig evaluator; joint data lives in small uniform arrays shared by every instance. */
export function createRigNodes(rig: CreatureRig): RigNodes {
  const joints = rig.joints.length > 0 ? rig.joints : [{ name: 'none', pivot: [0, 0, 0], axis: [1, 0, 0], amp: 0, phase: 0, freq: 1, bias: 0, rectify: 0 } as RigJoint];
  const pivots = uniformArray(joints.map((j) => new Vector4(j.pivot[0], j.pivot[1], j.pivot[2], 0)), 'vec4');
  const axes = uniformArray(
    joints.map((j) => {
      const l = Math.hypot(j.axis[0], j.axis[1], j.axis[2]) || 1;
      return new Vector4(j.axis[0] / l, j.axis[1] / l, j.axis[2] / l, j.rectify);
    }),
    'vec4',
  );
  const params = uniformArray(joints.map((j) => new Vector4(j.amp, j.phase, j.freq, j.bias)), 'vec4');

  const angleOf = (idx: Node<'int'>, phase: F, gait: F): F => {
    const prm = vec4At(params, idx);
    const r = vec4At(axes, idx).w;
    const s = sin(phase.mul(prm.z).add(prm.y).mul(TAU));
    const shaped = mix(s, max(s, 0).mul(sign(r)), abs(r));
    return prm.w.add(prm.x.mul(shaped).mul(gait)) as F;
  };
  // Rodrigues rotation of v about unit axis k.
  const rotate = (v: V3, k: V3, c: F, s: F): V3 => v.mul(c).add(cross(k, v).mul(s)).add(k.mul(dot(k, v).mul(float(1).sub(c)))) as V3;

  const applyJoint = (p: V3, n: V3 | null, j: F, phase: F, gait: F): { p: V3; n: V3 | null } => {
    const idx = int(max(j, 0));
    const valid = j.greaterThanEqual(0);
    const a = angleOf(idx, phase, gait);
    const c = cos(a);
    const s = sin(a);
    const k = vec4At(axes, idx).xyz as V3;
    const pivot = vec4At(pivots, idx).xyz as V3;
    const rp = rotate(p.sub(pivot) as V3, k, c, s).add(pivot) as V3;
    const outP = select(valid, rp, p) as V3;
    const outN = n ? (select(valid, rotate(n, k, c, s), n) as V3) : null;
    return { p: outP, n: outN };
  };

  return {
    pose(p, n, ja, jb, phase, gait) {
      const a = applyJoint(p, n, ja, phase, gait);
      const b = applyJoint(a.p, a.n, jb, phase, gait);
      // Body: bob twice per cycle, slight roll about the forward axis once per cycle.
      const bob = float(rig.bob).mul(float(0.5).sub(cos(phase.mul(TAU * 2)).mul(0.5))).mul(gait);
      const roll = sin(phase.mul(TAU)).mul(rig.sway).mul(gait);
      const forwardAxis = rig.forward.endsWith('z') ? vec3(0, 0, 1) : vec3(1, 0, 0);
      const cr = cos(roll);
      const sr = sin(roll);
      const hip = vec3(0, rig.height * 0.6, 0);
      const rolled = rotate(b.p.sub(hip) as V3, forwardAxis as V3, cr, sr).add(hip).add(vec3(0, bob, 0)) as V3;
      const normal = b.n ? rotate(b.n, forwardAxis as V3, cr, sr) : null;
      return { position: rolled, normal };
    },
  };
}

/**
 * Yaw offset for the rig's forward axis: a creature moving along (dx, dz) is turned by
 * atan2(-dx, -dz) + forwardYaw(rig) about +y (three.js rotation convention).
 */
export function forwardYaw(rig: CreatureRig): number {
  switch (rig.forward) {
    case '-z':
      return 0;
    case '+z':
      return Math.PI;
    case '-x':
      return -Math.PI / 2;
    case '+x':
      return Math.PI / 2;
  }
}
