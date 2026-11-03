import { DoubleSide, InstancedBufferAttribute, Mesh, MeshBasicNodeMaterial, Vector4 } from 'three/webgpu';
import {
  Fn,
  abs,
  acos,
  atan,
  attribute,
  cameraPosition,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  instancedBufferAttribute,
  int,
  max,
  mix,
  mrt,
  mx_noise_float,
  mx_noise_vec3,
  normalGeometry,
  normalize,
  positionGeometry,
  pow,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  uniformArray,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { floatUniform, linear, seeded, z, zVec3, type ComponentFactory } from '@prismfall/sdk';
import { figureGeometry, JOINTS, LIMB } from './figure';
import { backdropSampler, backdropTexture, fogDepth, hash, lampLight, release, revealMask, shared, zBackdrop, zFog, ORIGIN_Z, type F, type V3, type V4 } from './shared';

const schema = z.object({
  /** Figures at full strength (high detail); the `horde` value (0..1) decides how many walk. */
  count: z.number().int().min(1).max(160).default(90),
  /** Ground height (world y) and the point the figures walk towards (the viewer). */
  ground: z.number().default(-1.05),
  origin: zVec3.default([0, 0, ORIGIN_Z]),
  /** Azimuth bands (degrees from straight ahead) the paths keep to, mirrored left and right. */
  bands: z.array(z.tuple([z.number(), z.number(), z.number()])).default([
    [22.5, 33, 0.65],
    [33, 46, 0.35],
  ]),
  /** They appear this far away (metres) and walk to a point this far beside the viewer (range). */
  far: z.number().positive().default(105),
  pass: z.tuple([z.number().positive(), z.number().positive()]).default([3.5, 7]),
  /** Walking speed range (m/s). */
  speed: z.tuple([z.number().positive(), z.number().positive()]).default([0.34, 0.72]),
  /** Height range in metres. */
  height: z.tuple([z.number().positive(), z.number().positive()]).default([1.6, 1.86]),
  /** Share of figures with a limp, a dragged foot, a reaching arm, and a long coat. */
  limping: z.number().min(0).max(1).default(0.45),
  dragging: z.number().min(0).max(1).default(0.3),
  reaching: z.number().min(0).max(1).default(0.3),
  coats: z.number().min(0).max(1).default(0.4),
  hoods: z.number().min(0).max(1).default(0.22),
  /** Baseline population (0..1 of count); bind `horde` to raise it. */
  horde: z.number().min(0).max(1).default(0.4),
  backdrop: zBackdrop,
  fog: zFog,
  /** Rim light from the glowing fog behind the figures, ambient fill, lamp response. */
  rim: z.number().min(0).default(1.6),
  ambient: z.number().min(0).default(0.5),
  lamps: z.number().min(0).default(1),
  seed: z.number().default(1),
});

type Params = z.infer<typeof schema>;

const L1 = Math.hypot(JOINTS.hip[1] - JOINTS.knee[1], JOINTS.knee[2] - JOINTS.hip[2]);
const L2 = Math.hypot(JOINTS.knee[1] - JOINTS.ankle[1], JOINTS.ankle[2] - JOINTS.knee[2]);
const THIGH_REST = Math.atan2(JOINTS.knee[2] - JOINTS.hip[2], JOINTS.hip[1] - JOINTS.knee[1]);
const SHIN_REST = Math.atan2(JOINTS.ankle[2] - JOINTS.knee[2], JOINTS.knee[1] - JOINTS.ankle[1]);
const KNEE_REST = THIGH_REST - SHIN_REST;
const TAU = Math.PI * 2;

/** Rotation that swings a downward-pointing vector forward (+z) for positive angles. */
const pitch = (v: V3, a: F): V3 => {
  const c = cos(a);
  const s = sin(a);
  return vec3(v.x, v.y.mul(c).add(v.z.mul(s)), v.z.mul(c).sub(v.y.mul(s))) as V3;
};
/** Rotation that swings a downward-pointing vector towards +x for positive angles. */
const roll = (v: V3, a: F): V3 => {
  const c = cos(a);
  const s = sin(a);
  return vec3(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)), v.z) as V3;
};
/** Rotation that turns +z towards +x for positive angles. */
const yaw = (v: V3, a: F): V3 => {
  const c = cos(a);
  const s = sin(a);
  return vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s))) as V3;
};

/** Picks a palette colour by a 0..1 value. */
function paletteAt(colours: string[], k: F): V3 {
  const arr = uniformArray(
    colours.map((c) => {
      const l = linear(c);
      return new Vector4(l.x, l.y, l.z, 1);
    }),
    'vec4',
  );
  const i = int(floor(k.mul(colours.length - 0.001)));
  return (arr.element(i) as unknown as V4).rgb as V3;
}

/**
 * The horde: figures that shamble out of the fog towards the viewer and dissolve back into it.
 *
 * One body mesh (figure.ts) is instanced. Every figure's pose is solved in the vertex shader from
 * the time alone: a walk cycle with planted feet (two-bone leg IK onto a stance/swing foot path),
 * pelvis bob, sway and roll, a hunched and side-bent spine, a lolling head and hanging, swinging
 * or reaching arms. Each figure has its own build, speed, cadence and impairments: a limp (a short,
 * painful stance with a lurch over the bad leg), a dragged foot (toe down, sliding, swung out), a
 * tilted or hanging head, a reaching arm, a coat or none.
 *
 * Paths run straight at the viewer inside azimuth bands outside the playfield's clear zone. The
 * shading is mostly silhouette: dark clothes and skin under a dim ambient from the fog, rim light
 * taken from the glowing photo behind each figure, warm light from the sodium lamps nearby, and
 * height fog that matches the photo exactly, so far figures are lost in it. They emerge head first
 * as the fog falls away and sink back into rising fog at the end of their walk.
 */
export const hordeComponent: ComponentFactory<Params> = {
  type: 'deadAcreHorde',
  version: 1,
  description: 'Shambling human figures that walk out of the fog towards the viewer, posed and lit on the GPU.',
  schema,
  async create(ctx, p) {
    const s = shared(ctx);
    const detailScale = ctx.quality.detail === 'low' ? 0.4 : ctx.quality.detail === 'medium' ? 0.7 : ctx.quality.detail === 'high' ? 1 : 1.2;
    const count = Math.max(4, Math.round(p.count * detailScale));
    const geometry = figureGeometry(ctx.quality.detail);
    const backdropTex = await backdropTexture(ctx, s, p.backdrop.src);

    // ---- Per-figure data (deterministic).
    const rand = seeded(p.seed * 7919 + 13);
    const A = new Float32Array(count * 4);
    const B = new Float32Array(count * 4);
    const C = new Float32Array(count * 4);
    const D = new Float32Array(count * 4);
    const bandTotal = p.bands.reduce((t, b) => t + b[2], 0);
    for (let i = 0; i < count; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      let r = rand() * bandTotal;
      let band = p.bands[0]!;
      for (const b of p.bands) {
        if (r <= b[2]) {
          band = b;
          break;
        }
        r -= b[2];
      }
      const az = side * (band[0] + (band[1] - band[0]) * rand()) * (Math.PI / 180);
      const speed = p.speed[0] + (p.speed[1] - p.speed[0]) * Math.pow(rand(), 1.3);
      const h = (p.height[0] + (p.height[1] - p.height[0]) * rand()) / 1.75;
      const girth = 0.98 + rand() * 0.3;
      // Hood up on some (packed into the girth: +10).
      const hood = rand() < p.hoods ? 10 : 0;
      const limp = rand() < p.limping ? (rand() < 0.5 ? -1 : 1) * (0.45 + rand() * 0.55) : 0;
      const drag = limp === 0 && rand() < p.dragging / Math.max(0.01, 1 - p.limping) ? (rand() < 0.5 ? -1 : 1) * (0.55 + rand() * 0.45) : 0;
      // Arms: hanging (most), one reaching, both half raised, or one hanging dead from a dropped shoulder.
      let raiseL = 0.05 + rand() * 0.08;
      let raiseR = 0.05 + rand() * 0.08;
      let bendL = 0.12 + rand() * 0.25;
      let bendR = 0.12 + rand() * 0.25;
      const armRoll = rand();
      if (armRoll < p.reaching * 0.7) {
        // One arm lifted towards the viewer, never straight out: a heavy, half-raised reach.
        if (rand() < 0.5) {
          raiseL = 0.55 + rand() * 0.4;
          bendL = 0.35 + rand() * 0.4;
        } else {
          raiseR = 0.55 + rand() * 0.4;
          bendR = 0.35 + rand() * 0.4;
        }
      } else if (armRoll < p.reaching) {
        // Both forearms carried a little forward, elbows bent, hands hanging.
        raiseL = 0.22 + rand() * 0.22;
        raiseR = 0.2 + rand() * 0.22;
        bendL = 0.45 + rand() * 0.35;
        bendR = 0.45 + rand() * 0.35;
      } else if (armRoll < p.reaching + 0.12) {
        // One arm hanging dead straight from a dropped shoulder.
        if (rand() < 0.5) bendL = 0.02;
        else bendR = 0.02;
      }
      const headRoll = (rand() < 0.5 ? -1 : 1) * (rand() < 0.4 ? 0.22 + rand() * 0.3 : rand() * 0.14);
      const headPitch = rand() < 0.3 ? -0.15 - rand() * 0.15 : 0.12 + rand() * 0.38;
      // Long coats, or a jacket or shirt hanging loose over the belt.
      const coat = rand() < p.coats ? 0.55 + rand() * 0.5 : 0.2 + rand() * 0.12;
      A.set([az, rand(), speed, rand()], i * 4);
      B.set([h, girth + hood, limp, drag], i * 4);
      C.set([raiseL, raiseR, bendL, bendR], i * 4);
      // Rank: who walks first as the horde grows (a shuffled order).
      D.set([headRoll, headPitch, coat, (i + rand() * 0.5) / count], i * 4);
    }
    const iA = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(A, 4), 'vec4');
    const iB = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(B, 4), 'vec4');
    const iC = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(C, 4), 'vec4');
    const iD = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(D, 4), 'vec4');

    const u = {
      presence: floatUniform(1),
      horde: floatUniform(p.horde),
      fog: floatUniform(1),
      dusk: floatUniform(0),
      tempo: floatUniform(1),
      ambient: floatUniform(1),
    };
    const backdrop = backdropSampler(backdropTex, p.backdrop, u.dusk as unknown as F);
    const reduced = ctx.quality.reducedMotion;
    // The figures keep their own clock so `tempo` (and reduced motion) can slow them smoothly.
    const clock = floatUniform(0);
    const t = clock as unknown as F;
    const rig = attribute<'vec4'>('rig', 'vec4');
    const g = p.ground;
    const [ox, , oz] = p.origin;

    const vWorld = varyingProperty('vec3', 'vHordeWorld');
    const vNormal = varyingProperty('vec3', 'vHordeNormal');
    const vPath = varyingProperty('vec2', 'vHordePath');

    const posed = Fn(() => {
      const seed = iA.w;
      const speed = iA.z;
      // ---- Gait timing.
      const T = float(1.25).add(float(0.75).sub(speed).mul(2)).add(hash(seed, 3.1).sub(0.5).mul(0.3));
      const phi = fract(t.div(T).add(hash(seed, 5.7)));
      const stride = speed.mul(0.64).mul(T);
      const limp = iB.z;
      const drag = iB.w;
      const lam = abs(limp);
      const lameL = lam.mul(step(1e-4, limp));
      const lameR = lam.mul(step(1e-4, limp.negate()));
      const dragL = abs(drag).mul(step(1e-4, drag));
      const dragR = abs(drag).mul(step(1e-4, drag.negate()));
      const phiL = phi;
      const phiR = fract(phi.add(0.5));
      const dutyL = float(0.64).sub(lameL.mul(0.12)).add(lameR.mul(0.06));
      const dutyR = float(0.64).sub(lameR.mul(0.12)).add(lameL.mul(0.06));
      const stanceL = float(1).sub(step(dutyL, phiL));
      const stanceR = float(1).sub(step(dutyR, phiR));
      const lameSign = limp.sign();
      const stanceLame = select(limp.greaterThan(0), stanceL, stanceR);
      // ---- Pelvis: bob (lowest in double support), a dip and lurch over a lame leg, sway, roll.
      const bob = float(-0.022)
        .mul(cos(phi.mul(2 * TAU)).mul(0.5).add(0.5))
        .sub(lam.mul(0.035).mul(stanceLame))
        .sub(abs(drag).mul(0.012));
      const sideCycle = cos(phi.sub(0.32).mul(TAU));
      const sway = sideCycle.mul(0.028).add(lameSign.mul(lam).mul(0.03).mul(stanceLame));
      const rootRoll = sideCycle.mul(-0.034).sub(lameSign.mul(lam).mul(0.09).mul(stanceLame));
      const rootYaw = sin(phi.mul(TAU)).mul(0.05);

      // ---- Legs: a foot path (planted stance, lifted or dragged swing) solved by two-bone IK.
      const legPose = (ph: F, duty: F, stance: F, lame: F, dragW: F) => {
        const ust = ph.div(duty).clamp(0, 1);
        const usw = ph.sub(duty).div(float(1).sub(duty)).clamp(0, 1);
        const sm = usw.mul(usw).mul(usw).mul(usw.mul(usw.mul(6).sub(15)).add(10));
        const st = stride.mul(float(1).sub(dragW.mul(0.3)));
        const fz = mix(st.mul(-0.5).add(st.mul(sm)), st.mul(0.5).sub(st.mul(ust)), stance);
        const liftH = float(0.075).mul(float(1).sub(dragW.mul(0.92))).add(lame.mul(0.025));
        const lift = sin(usw.mul(Math.PI)).mul(liftH).mul(float(1).sub(stance));
        const heelOff = smoothstep(duty.sub(0.14), duty, ph).mul(stance).mul(-0.42);
        const swingPitch = mix(float(-0.45), float(0.12), smoothstep(0.15, 0.85, usw)).mul(float(1).sub(stance));
        const fp = mix(heelOff.add(swingPitch), float(-0.62).add(sin(ph.mul(TAU)).mul(0.08)), dragW);
        const ankleY = float(JOINTS.ankle[1]).add(lift).add(max(sin(fp.negate()), 0).mul(0.14)).add(max(sin(fp), 0).mul(0.05));
        const dy = ankleY.sub(float(JOINTS.hip[1]).add(bob));
        const dz = fz.add(JOINTS.ankle[2]);
        const Dl = sqrt(dz.mul(dz).add(dy.mul(dy))).clamp(0.32, L1 + L2 - 0.004);
        const kneeAbs = float(Math.PI).sub(acos(float(L1 * L1 + L2 * L2).sub(Dl.mul(Dl)).div(2 * L1 * L2).clamp(-1, 1)));
        const alpha = acos(float(L1 * L1 - L2 * L2).add(Dl.mul(Dl)).div(Dl.mul(2 * L1)).clamp(-1, 1));
        const thighAbs = atan(dz, dy.negate()).add(alpha);
        const thigh = thighAbs.sub(THIGH_REST);
        const knee = kneeAbs.sub(KNEE_REST);
        const ankle = fp.sub(thigh).add(knee);
        const abd = float(0.035).add(dragW.mul(0.13).mul(float(1).sub(stance)).mul(sin(usw.mul(Math.PI)))).add(lame.mul(0.03));
        return { thigh, knee, ankle, abd };
      };
      const legL = legPose(phiL, dutyL, stanceL, lameL, dragL);
      const legR = legPose(phiR, dutyR, stanceR, lameR, dragR);

      // ---- Decode the vertex's limb.
      const limb = floor(rig.x.div(8).add(0.01));
      const is = (k: number) => float(1).sub(step(0.5, abs(limb.sub(k))));
      const armL = is(LIMB.armL);
      const armR = is(LIMB.armR);
      const legLm = is(LIMB.legL);
      const legRm = is(LIMB.legR);
      const isArm = armL.add(armR);
      const isLeg = legLm.add(legRm);
      const isHead = is(LIMB.head);
      const isTorso = is(LIMB.torso);
      const isSkirt = is(LIMB.skirt);
      const side = armL.add(legLm).sub(armR).sub(legRm); // +1 left, −1 right, 0 centre
      const w1 = rig.y;
      const w2 = rig.z;
      const w3 = rig.w;
      const hooded = step(5, iB.y);
      const girth = iB.y.sub(hooded.mul(10));

      // ---- Arms.
      const raise = mix(iC.y, iC.x, armL);
      const bend = mix(iC.w, iC.z, armL);
      const armPhase = mix(phiR, phiL, armL);
      const loose = float(1).sub(smoothstep(0.2, 0.9, raise));
      const reachK = smoothstep(0.3, 1.0, raise);
      const hunch = float(0.08).add(hash(seed, 11).mul(0.3)).add(sin(phi.mul(2 * TAU).add(0.3)).mul(0.025));
      // Hanging arms hang plumb whatever the hunch; a reaching arm is held against it.
      const armPitch = raise
        .add(hunch.mul(float(1).sub(reachK.mul(0.6))))
        .sub(cos(armPhase.mul(TAU)).mul(0.16).mul(loose))
        .add(sin(t.mul(1.3).add(seed.mul(9)).add(side)).mul(0.05).mul(reachK))
        .add(sin(phi.mul(2 * TAU).add(0.6)).mul(0.035));
      const armAbd = float(0.07).add(reachK.mul(0.1)).add(sin(armPhase.mul(TAU).add(1.1)).mul(0.03).mul(loose));
      const elbow = bend.add(sin(armPhase.mul(TAU).add(1)).mul(0.08).mul(loose));
      const droop = float(0.12).add(smoothstep(0.4, 1.2, raise).mul(0.45));

      // ---- Head and spine.
      const headRoll = iD.x.add(sin(phi.mul(TAU).add(0.5)).mul(0.05));
      const headPitch = iD.y.add(sin(phi.mul(2 * TAU).add(1.2)).mul(0.04));
      const headYaw = sin(t.mul(0.21).add(seed.mul(31))).mul(0.18).mul(hash(seed, 9));
      const sideBend = hash(seed, 13).sub(0.5).mul(0.2).add(lameSign.mul(lam).mul(0.08));
      const twist = sin(phi.mul(TAU)).mul(0.07);

      // ---- Pose the rest vertex: distal joints first, each a rotation about its rest pivot.
      const gs = (j: readonly [number, number, number], sx: F): V3 => vec3(float(j[0]).mul(sx).mul(girth), j[1], float(j[2]).mul(girth)) as V3;
      const rest = positionGeometry;
      const coat = iD.z;
      // Coat skirt length (and none at all) and the overall build.
      const skirtY = mix(rest.y, float(1.02).sub(float(1.02).sub(rest.y).mul(coat)), isSkirt);
      // Without a hood, its shell shrinks inside the head.
      const hoodV = float(1).sub(step(0.5, abs(floor(rig.x.sub(limb.mul(8)).add(0.5)).sub(6))));
      const hoodK = mix(float(1), hooded.mul(0.93).add(0.07), hoodV);
      const restH = mix(rest, vec3(0, 1.65, 0.012).add(rest.sub(vec3(0, 1.65, 0.012)).mul(hoodK)), hoodV);
      let pos: V3 = vec3(restH.x.mul(girth), mix(skirtY, restH.y, hoodV), restH.z.mul(girth)) as V3;
      let nrm: V3 = normalize(vec3(normalGeometry.x.div(girth), normalGeometry.y, normalGeometry.z.div(girth))) as V3;
      const joint = (pivot: V3, f: (v: V3) => V3) => {
        pos = pivot.add(f(pos.sub(pivot) as V3)) as V3;
        nrm = f(nrm);
      };
      // 1: wrist / ankle.
      joint(select(isArm.greaterThan(0.5), gs(JOINTS.wrist, side), gs(JOINTS.ankle, side)) as V3, (v) =>
        pitch(v, droop.negate().mul(isArm).add(mix(legR.ankle, legL.ankle, legLm).mul(isLeg)).mul(w3) as F),
      );
      // 2: elbow / knee.
      joint(select(isArm.greaterThan(0.5), gs(JOINTS.elbow, side), gs(JOINTS.knee, side)) as V3, (v) =>
        pitch(v, elbow.mul(isArm).sub(mix(legR.knee, legL.knee, legLm).mul(isLeg)).mul(w2) as F),
      );
      // 3: shoulder / hip (the skirt follows the nearer thigh) / neck.
      const skirtThigh = mix(legR.thigh, legL.thigh, smoothstep(-0.07, 0.07, pos.x)).mul(isSkirt).mul(w1);
      const p3Pitch = armPitch.mul(isArm).mul(w1).add(mix(legR.thigh, legL.thigh, legLm).mul(isLeg).mul(w1)).add(skirtThigh).sub(headPitch.mul(isHead).mul(w1));
      const p3Roll = armAbd.mul(side).mul(isArm).mul(w1).add(mix(legR.abd, legL.abd, legLm).mul(side).mul(isLeg).mul(w1)).add(headRoll.mul(isHead).mul(w1));
      const p3Yaw = headYaw.mul(isHead).mul(w1);
      const pivot3 = select(isArm.greaterThan(0.5), gs(JOINTS.shoulder, side), select(isHead.greaterThan(0.5), gs(JOINTS.neck, float(0)), gs(JOINTS.hip, side))) as V3;
      joint(pivot3, (v) => pitch(roll(yaw(v, p3Yaw as F), p3Roll as F), p3Pitch as F));
      // 4: spine (torso graded, head and arms fully).
      const spineW = isTorso.mul(w1).add(isHead).add(isArm);
      joint(gs(JOINTS.spine, float(0)), (v) => pitch(roll(yaw(v, twist.mul(spineW) as F), sideBend.mul(spineW) as F), hunch.negate().mul(spineW) as F));
      // 5: pelvis.
      joint(vec3(0, JOINTS.hip[1], 0) as V3, (v) => yaw(roll(v, rootRoll as F), rootYaw as F));
      pos = pos.add(vec3(sway, bob, 0)) as V3;

      // ---- Path: from the far field towards a point a few metres beside the viewer, so a figure
      // grows as it comes and finally passes out of view at the side (never into the clear zone:
      // its azimuth only increases).
      const az = iA.x;
      // (Linear in the seed, so review tools on the CPU can follow a figure exactly.)
      const farD = float(p.far).sub(fract(seed.mul(5.77).add(0.41)).mul(12));
      const lat = float(p.pass[0]).add(fract(seed.mul(7.31).add(0.17)).mul(p.pass[1] - p.pass[0])).mul(az.sign());
      const fromX = sin(az).mul(farD);
      const fromZ = cos(az).negate().mul(farD);
      const dX = lat.sub(fromX);
      const dZ = float(-1).sub(fromZ);
      const len = sqrt(dX.mul(dX).add(dZ.mul(dZ)));
      const sPath = fract(t.mul(speed).div(len).add(iA.y));
      const wob = sin(t.mul(0.035).add(seed.mul(50))).mul(0.9).mul(float(1).sub(sPath));
      const fwdX = dX.div(len);
      const fwdZ = dZ.div(len);
      const base = vec3(fromX.add(dX.mul(sPath)).add(fwdZ.mul(wob)).add(ox), g, fromZ.add(dZ.mul(sPath)).sub(fwdX.mul(wob)).add(oz));
      const heading = atan(fwdX, fwdZ).add(sin(t.mul(0.09).add(seed.mul(21))).mul(0.07));
      // Population: figures beyond the current horde size collapse to a point (no fragments).
      const vis = smoothstep(iD.w, iD.w.add(0.04), u.horde);
      const scale = iB.x.mul(step(0.003, vis));
      const world = base.add(yaw(pos.mul(scale) as V3, heading as F)) as V3;
      vWorld.assign(world);
      vNormal.assign(yaw(nrm, heading as F));
      vPath.assign(vec2(sPath, vis));
      return world;
    })();

    // ---- Shading.
    const limbF = floor(rig.x.div(8).add(0.01));
    const matF = floor(rig.x.sub(limbF.mul(8)).add(0.5));
    const isMat = (k: number) => float(1).sub(step(0.5, abs(matF.sub(k))));
    const seed = iA.w;
    const restP = positionGeometry;
    const toCam = cameraPosition.sub(vWorld);
    const view = normalize(toCam);
    const n0 = normalize(vNormal);
    const n1 = select(dot(n0, view).lessThan(0), n0.negate(), n0);
    // Cloth folds and weave (in rest space, so they stay on the cloth); skin stays smooth.
    const skin = isMat(0);
    const hair = isMat(4);
    const fold = mx_noise_vec3(restP.mul(vec3(16, 38, 16)).add(seed.mul(7))).mul(float(0.32).sub(skin.mul(0.26)).add(hair.mul(0.4)));
    const fine = mx_noise_vec3(restP.mul(vec3(90, 120, 90))).mul(0.08);
    const n = normalize(n1.add(fold).add(fine));
    // Albedo: muted, worn clothes; a pallid, greyed skin; dirt rising from the ground.
    const top = paletteAt(['#3b3a2c', '#4a3a2c', '#2c2c2e', '#262c38', '#4a2c2a', '#4c4c4a', '#56492f', '#283634'], hash(seed, 23));
    const coatC = paletteAt(['#3a3226', '#2a2a28', '#3c3b34', '#2e2620', '#423f37', '#20232a'], hash(seed, 29));
    const trousers = paletteAt(['#2a3442', '#1d1d1f', '#3a2e24', '#3c3c3a', '#4a4434', '#33342a'], hash(seed, 31));
    const skinC = paletteAt(['#8c877e', '#7b7871', '#958a80', '#6c6964'], hash(seed, 37));
    const hairC = paletteAt(['#1a1612', '#2a221a', '#3c3834', '#121212', '#4a3e30'], hash(seed, 41));
    const hasCoat = step(0.45, iD.z);
    const topC = mix(top, coatC, hasCoat);
    let albedo: V3 = mix(mix(mix(mix(mix(skinC.mul(0.3), topC, isMat(1)), trousers, isMat(2)), vec3(0.012, 0.011, 0.01), isMat(3)), hairC, hair), topC, isMat(5).add(isMat(6)).clamp(0, 1)) as V3;
    const stain = smoothstep(0.1, 0.75, mx_noise_float(restP.mul(9).add(seed.mul(13))).mul(0.5).add(0.5));
    const dirt = smoothstep(0.62, 0.02, restP.y).mul(0.75).add(stain.mul(0.35)).mul(float(1).sub(skin.mul(0.6))).clamp(0, 1);
    albedo = mix(albedo, albedo.mul(vec3(0.55, 0.5, 0.42)).add(vec3(0.006, 0.005, 0.003)), dirt.mul(0.8)) as V3;
    // Skin: blotchy, darker around the eyes and mouth (cavities), no gore.
    const blotch = mx_noise_float(restP.mul(60)).mul(0.5).add(0.5);
    albedo = albedo.mul(mix(float(1), blotch.mul(0.3).add(0.75), skin)) as V3;
    // Sunken, shadowed eye sockets (from the rest pose).
    const eyes = smoothstep(0.024, 0.006, abs(restP.y.sub(1.656))).mul(smoothstep(0.006, 0.02, abs(restP.x))).mul(smoothstep(0.052, 0.024, abs(restP.x))).mul(smoothstep(0.07, 0.095, restP.z));
    albedo = albedo.mul(float(1).sub(eyes.mul(0.45).mul(skin))) as V3;
    // Worn cloth: faded patches, darker seams of grime, and a coarse weave.
    const wear = mx_noise_float(restP.mul(vec3(5, 3, 5)).add(seed.mul(3))).mul(0.5).add(0.5);
    const weave = mx_noise_float(restP.mul(260)).mul(0.5).add(0.5);
    const cloth = float(1).sub(skin).sub(hair).clamp(0, 1);
    albedo = albedo.mul(mix(float(1), wear.mul(0.6).add(0.7).mul(weave.mul(0.25).add(0.88)), cloth)) as V3;
    // Occlusion: under the arms, between the legs, inside the coat, the lower legs.
    const occl = float(1)
      .sub(smoothstep(0.15, 0.6, restP.y).oneMinus().mul(0.35))
      .mul(select(dot(n0, view).lessThan(0), float(0.35), float(1)));

    // Light: the fog glow behind (rim), a dim ambient from the fog all round, the sodium lamps.
    const toP = vWorld.sub(cameraPosition);
    const dirP = normalize(toP);
    const turn = backdrop.turnOf(dirP);
    const behind = backdrop.at(turn, float(1.5));
    const above = backdrop.at(turn, float(16));
    const ndv = abs(dot(n, view));
    const rimShape = pow(float(1).sub(ndv).clamp(0, 1), 2.6);
    // Light comes from behind the figure: edges facing away from the viewer catch it most.
    // (Only surfaces turned towards the light behind; tops of shoulders and shoes stay dark.)
    const backDir = normalize(vec3(dirP.x, 0.08, dirP.z));
    const backWrap = dot(n, backDir).add(0.45).div(1.45).clamp(0, 1).pow(1.2).mul(float(1).sub(n.y.max(0).pow(2).mul(0.85)));
    const sheen = mix(float(0.5), float(0.85), isMat(1).add(isMat(5)).add(isMat(2)).clamp(0, 1)).mul(mix(float(1), float(0.6), skin));
    const rim = behind.mul(rimShape.mul(backWrap).mul(p.rim).mul(sheen));
    const hemi = mix(behind.mul(0.18), above, n.y.mul(0.5).add(0.5)).mul(p.ambient * 0.5).mul(u.ambient);
    const lamps = lampLight(s, vWorld, n, 0.35).mul(p.lamps);
    const lit0 = albedo.mul(hemi.add(lamps)).mul(occl).add(rim.mul(occl.mul(0.6).add(0.4)));
    // Review aid: `ambient` above 1 adds a plain key light (never set by the manifest).
    const review = u.ambient.sub(1).max(0);
    const lit = lit0.add(albedo.mul(dot(n, normalize(vec3(-0.5, 0.7, 0.6))).max(0).mul(0.9).add(0.25)).mul(review).mul(occl));

    // Fog: exact height fog towards the photo's own colour behind the figure, plus the walk's
    // start (fog falling away, head first) and end (fog rising from the ground).
    const tau = fogDepth(vWorld, g, p.fog, u.fog as unknown as F);
    const sP = vPath.x;
    const vis = vPath.y;
    const yLocal = vWorld.y.sub(g);
    const startLine = float(1).sub(smoothstep(0.0, 0.11, sP)).mul(2.4).sub(0.25);
    const endLine = smoothstep(0.95, 0.995, sP).mul(2.4).sub(0.25);
    const line = max(startLine, endLine);
    const wisp = mx_noise_float(vWorld.mul(vec3(1.6, 2.4, 1.6)).add(vec3(t.mul(0.3), 0, 0))).mul(0.18);
    const engulf = float(1).sub(smoothstep(line.sub(0.45), line.add(0.05), yLocal.add(wisp)));
    const clearAmt = exp(tau.negate()).mul(float(1).sub(engulf)).mul(vis);
    const fogCol = backdrop.dir(dirP);
    const color = mix(fogCol, lit, clearAmt);

    const material = new MeshBasicNodeMaterial();
    material.positionNode = posed;
    material.colorNode = vec4(color, 1);
    // Ragged, torn hems on coats and jackets.
    const hemK = float(1.02).sub(restP.y).div(0.5);
    const tear = mx_noise_float(vec3(restP.x.mul(38), restP.z.mul(38), seed.mul(11))).mul(0.5).add(0.5);
    const ragged = step(tear.mul(0.16).add(0.86), hemK).mul(isMat(5));
    material.opacityNode = revealMask(u.presence as unknown as F).mul(step(0.004, clearAmt)).mul(float(1).sub(ragged));
    material.alphaTest = 0.5;
    material.side = DoubleSide;
    material.fog = false;
    material.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
    const mesh = new Mesh(geometry, material);
    mesh.count = count;
    mesh.frustumCulled = false;
    // Read-only description of the walkers for review tools (where each figure is at a given time).
    mesh.userData.deadAcreHorde = { paths: A, ranks: D, pass: p.pass, far: p.far, origin: p.origin, ground: g, clock: () => clock.value, horde: () => u.horde.value };

    return {
      object: mesh,
      reactive: { horde: u.horde, fog: u.fog, dusk: u.dusk, tempo: u.tempo, ambient: u.ambient },
      update(frame) {
        clock.value += Math.min(0.1, frame.dt) * u.tempo.value * (reduced ? 0.6 : 1);
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        geometry.dispose();
        material.dispose();
        release(ctx, s);
      },
    };
  },
};
