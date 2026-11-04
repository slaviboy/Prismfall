import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, Vector4, type Node } from 'three/webgpu';
import {
  abs,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  clamp,
  cross,
  exp,
  float,
  fract,
  length,
  max,
  mix,
  mrt,
  mx_noise_float,
  normalize,
  positionGeometry,
  screenSize,
  smoothstep,
  step,
  uniform,
  uniformArray,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory, EnvironmentComponent } from '../../../sdk/types';
import { vec4At } from '../../creatures/rig';
import { additiveFog } from '../../shaders/uniforms';
import { floatUniform, seeded, zVec3 } from './common';
import { MeteorScheduler, type MeteorPlan, type MeteorSkyConfig } from './meteorPlan';

const schema = z.object({
  /** Mean seconds between meteors in calm music (random gaps, never on the beat). */
  interval: z.number().positive().default(9),
  /** How much more often they come in intense sections (rate × (1 + this) at full intensity). */
  intensityBoost: z.number().min(0).default(0.6),
  /** Fraction of meteors that are fireballs (none with flash reduction). */
  fireballs: z.number().min(0).max(1).default(0.03),
  /** Every so often (mean `every` seconds) a shower: for about `duration` s, `rate` × as many, from one radiant. */
  showers: z
    .object({ enabled: z.boolean().default(true), every: z.number().positive().default(180), duration: z.number().positive().default(30), rate: z.number().min(1).default(3) })
    .prefault({}),
  /** Distance from the viewer (world units): beyond the world's scenery, in front of the sky dome. */
  distance: z.number().positive().default(800),
  /** |azimuth| range in degrees, mirrored left and right; the inner edge keeps the board's clear zone free. */
  azimuth: z.tuple([z.number().min(0), z.number().max(180)]).default([24, 58]),
  /** Elevation range in degrees (paths may start above the screen). */
  elevation: z.tuple([z.number(), z.number().max(89)]).default([3, 32]),
  /** Where the bright second half of each path must lie: the sky the screen shows beside the board. */
  view: z.object({ azimuth: z.tuple([z.number(), z.number()]).default([24, 38]), elevation: z.tuple([z.number(), z.number()]).default([3, 15]) }).prefault({}),
  /** A photo horizon's skyline as [azimuth, elevation] degree points; paths stay above it. */
  skyline: z.array(z.tuple([z.number(), z.number()])).default([]),
  /** Clearance above the skyline (degrees). */
  margin: z.number().min(0).default(1.2),
  /** Directions paths keep clear of (a moon disc and its halo), radius in degrees. */
  avoid: z.array(z.object({ direction: zVec3, radius: z.number().positive() })).default([]),
  /** Path length range of ordinary meteors (degrees). */
  length: z.tuple([z.number().positive(), z.number().positive()]).default([5, 16]),
  /** Angular speed range (degrees per second). */
  speed: z.tuple([z.number().positive(), z.number().positive()]).default([10, 28]),
  /** Shares of bright meteors tinted green (fast ones) or orange (slow ones). */
  colors: z.object({ green: z.number().min(0).max(1).default(0.45), orange: z.number().min(0).max(1).default(0.35) }).prefault({}),
  brightness: z.number().min(0).default(1),
  bloom: z.number().min(0).default(0.2),
  seed: z.number().default(1),
});

type Params = z.infer<typeof schema>;
type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Seconds a fireball's glowing train stays visible after the fireball. */
const TRAIN_LIFE = 7;
const DEG = Math.PI / 180;

/** Debug and capture controls on top of the component interface. */
export interface MeteorsComponent extends EnvironmentComponent {
  /**
   * Launches a meteor now (tests and captures): `at` starts it that many seconds into its flight
   * (`phase`: that fraction of its flight); `mag` and `tint` override its brightness and colour.
   * Returns its plan, or null if none fits.
   */
  spawn(o?: { fireball?: boolean; shower?: boolean; at?: number; phase?: number; mag?: number; tint?: number }): MeteorPlan | null;
  /** Stops the meteor clock (still frames of a meteor in flight) or restarts it. */
  freeze(on: boolean): void;
  /** Removes every meteor in flight. */
  clear(): void;
}

const gauss = (d2: F, w: F): F => exp(d2.div(w.mul(w).mul(-2))) as F;

/** Wake decay time (seconds): a fraction of a second, longer for bright meteors and fireballs. */
const wakeTau = (m01: F, fire: F): F => m01.mul(0.05).add(0.03).add(fire.mul(0.12)) as F;
const wakeTauCpu = (mag: number, fireball: boolean) => Math.min(1, mag) * 0.05 + 0.03 + (fireball ? 0.12 : 0);

/**
 * Light curve along the path (0..1): meteors start faint, brighten as they enter denser air, peak
 * late and go out quickly; bright ones flare where they fragment (knots that stay in the wake) and
 * fireballs end in a terminal burst.
 */
function lightCurve(x: F, seed: F, m01: F, fire: F): F {
  const xc = clamp(x, 0.0001, 0.9999);
  const inside = step(0, x).mul(step(x, 1));
  const base = xc.pow(1.6).mul(float(1).sub(xc).pow(0.55)).mul(1 / 0.295);
  const knots = mx_noise_float(vec3(xc.mul(9).add(seed.mul(17)), seed.mul(5), 0)).mul(m01.mul(0.45)).add(1).max(0.35);
  const flareAt = fract(seed.mul(7.31)).mul(0.1).add(0.8);
  const df = xc.sub(flareAt).div(0.035);
  const flare = exp(df.mul(df).negate()).mul(fire.mul(0.7).add(smoothstep(0.8, 1, m01).mul(0.4))).add(1);
  return base.mul(knots).mul(flare).mul(inside) as F;
}

/** Atmospheric extinction towards the horizon (more air): dimmer and redder low down. */
function extinction(sinEl: F): V3 {
  const airmass = float(1).div(max(sinEl, 0).add(0.03));
  const e = exp(airmass.sub(1).mul(-0.1));
  return mix(vec3(1, 0.72, 0.5), vec3(1, 1, 1), e).mul(e) as V3;
}

/**
 * Meteors: brief thin streaks with a bright head and a wake that fades within a fraction of a
 * second, timed at random (a Poisson process; a little more often in intense music, never on the
 * beat). Each moves away from its radiant, so a shower's meteors all trace back to one point.
 * Bright ones can be green (fast) or orange (slow); rare fireballs fragment, flare at the end and
 * leave a faint green train that drifts and twists in the upper-atmosphere wind for a few seconds.
 * Paths stay in the sky either side of the board's clear zone and above a photo's skyline;
 * scenery in front hides them through the depth buffer.
 *
 * The CPU only picks a path when a meteor starts and writes it to three vec4s; the head, wake,
 * flares and train are all computed in the shaders from the meteor clock.
 */
export const meteorsComponent: ComponentFactory<Params> = {
  type: 'meteors',
  version: 1,
  description: 'Rare, randomly timed meteors: thin fast streaks with fading wakes, occasional showers and fireballs with glowing trains.',
  schema,
  create(ctx, p) {
    const detail = ctx.quality.detail;
    const slots = detail === 'low' ? 3 : detail === 'medium' ? 4 : detail === 'high' ? 6 : 8;
    const segs = detail === 'low' ? 12 : 20;
    const trainSegs = detail === 'low' ? 16 : 32;
    const cfg: MeteorSkyConfig = {
      interval: p.interval,
      intensityBoost: p.intensityBoost,
      fireballs: p.fireballs,
      showers: p.showers,
      azimuth: p.azimuth,
      elevation: p.elevation,
      view: p.view,
      skyline: [...p.skyline].sort((a, b) => a[0] - b[0]),
      margin: p.margin,
      avoid: p.avoid.map((o) => {
        const l = Math.hypot(...o.direction) || 1;
        return { direction: [o.direction[0] / l, o.direction[1] / l, o.direction[2] / l] as [number, number, number], radius: o.radius };
      }),
      length: p.length,
      speed: p.speed,
      colors: p.colors,
    };
    const rand = seeded(p.seed * 7919 + 13);
    const scheduler = new MeteorScheduler(cfg, rand, { reduced: ctx.quality.reducedMotion, density: ctx.quality.particles });

    // ---- Geometry: per slot a streak ribbon (x along 0..1, y side, z end pad) and a train ribbon. ----
    const ribbon = (n: number, pad: boolean) => {
      const pos: number[] = [];
      const slot: number[] = [];
      const index: number[] = [];
      for (let k = 0; k < slots; k++) {
        const base = pos.length / 3;
        for (let i = 0; i <= n; i++) {
          const end = pad ? (i === 0 ? -1 : i === n ? 1 : 0) : 0;
          for (const side of [-1, 1]) {
            pos.push(i / n, side, end);
            slot.push(k);
          }
        }
        for (let i = 0; i < n; i++) {
          const a = base + i * 2;
          index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute('slot', new BufferAttribute(new Float32Array(slot), 1));
      g.setIndex(index);
      return g;
    };
    const streakGeo = ribbon(segs, true);
    const trainGeo = ribbon(trainSegs, false);

    // ---- Per-meteor data: A = start direction + start time, B = end direction + duration, C = mag, tint, fireball, seed. ----
    const valuesA = Array.from({ length: slots }, () => new Vector4(0, 1, 0, -1e5));
    const valuesB = Array.from({ length: slots }, () => new Vector4(0.01, 1, 0, 1));
    const valuesC = Array.from({ length: slots }, () => new Vector4(0, 0, 0, 0));
    const dataA = uniformArray(valuesA, 'vec4');
    const dataB = uniformArray(valuesB, 'vec4');
    const dataC = uniformArray(valuesC, 'vec4');
    const u = { clock: uniform(0), presence: floatUniform(1), brightness: floatUniform(p.brightness) };
    const rate = { value: 1 };
    const D = p.distance;

    const slotIndex = attribute<'float'>('slot', 'float').toInt();
    const A = vec4At(dataA, slotIndex);
    const B = vec4At(dataB, slotIndex);
    const C = vec4At(dataC, slotIndex);
    const t = u.clock.sub(A.w);
    const dur = B.w;
    const mag = C.x;
    const fire = C.z;
    const seed = C.w;
    const m01 = clamp(mag, 0, 1);
    const chord = B.xyz.sub(A.xyz);
    const along = normalize(chord);
    // Projection [1][1] = 1 / tan(fov / 2): world size of one pixel at distance D.
    const p11 = (cameraProjectionMatrix as unknown as { element(i: number): Node<'vec4'> }).element(1).y;
    const pixel = float(2 * D).div(p11.mul(screenSize.y));
    const res = clamp(screenSize.y.div(1080), 0.75, 2.5);
    const info = varying(vec4(dur, mag, C.y, seed));
    const vFire = varying(fire);
    const vT = varying(t);
    const vRes = varying(res);

    // ---- Streak: a camera-facing ribbon along the path, a few pixels wide. ----
    const g = positionGeometry;
    const live = step(0, t).mul(step(t, dur.add(wakeTau(m01, fire).mul(7))));
    const dirS = normalize(mix(A.xyz, B.xyz, g.x));
    const acrossS = normalize(cross(along, dirS));
    const halfPx = m01.mul(6).add(fire.mul(10)).add(4).mul(res).mul(live);
    const lenPx = length(chord).mul(D).div(pixel);
    const streakPos = cameraPosition
      .add(dirS.mul(D))
      .add(acrossS.mul(g.y.mul(halfPx).mul(pixel)))
      .add(along.mul(g.z.mul(halfPx).mul(pixel)));
    const vSigma = varying(g.x.add(g.z.mul(halfPx).div(lenPx.max(1))));
    const vAcross = varying(g.y.mul(halfPx));
    const vLen = varying(lenPx);
    const vExt = varying(extinction(dirS.y));

    const durF = info.x;
    const magF = info.y;
    const tintF = info.z;
    const seedF = info.w;
    const m01F = clamp(magF, 0, 1);
    const curve = (x: F): F => lightCurve(x, seedF, m01F, vFire);
    const s = vT.div(durF);
    const sh = clamp(s, 0, 1);
    const ahead = vSigma.sub(sh).mul(vLen);
    const coreW = m01F.mul(0.45).add(0.55).add(vFire.mul(0.5)).mul(vRes);
    const across2 = vAcross.mul(vAcross);
    const r2 = ahead.mul(ahead).add(across2);
    // The head: a point source (slightly wider when bright) with a faint glow around bright ones.
    const headI = curve(sh).mul(magF).mul(step(0, s));
    const halo = m01F.mul(0.04).add(vFire.mul(0.035));
    const head = headI.mul(gauss(r2, coreW.mul(1.15)).add(halo.mul(gauss(r2, coreW.mul(2.8)))));
    // The wake: the air the head passed glows for a fraction of a second, spreading a little.
    const age = vT.sub(vSigma.mul(durF)).max(0);
    const behind = float(1).sub(smoothstep(-1, 1.5, ahead));
    const trailW = coreW.mul(age.mul(0.6).add(0.9));
    const wake = curve(vSigma).mul(magF).mul(0.85).mul(exp(age.negate().div(wakeTau(m01F, vFire)))).mul(behind).mul(gauss(across2, trailW)).mul(coreW.mul(0.9).div(trailW));
    // Fireballs break up late in their flight: fragments fall behind the main body.
    const breakAt = fract(seedF.mul(3.17)).mul(0.2).add(0.55);
    const broken = s.sub(breakAt).max(0).mul(step(s, 1)).mul(vFire);
    let fragments: F = float(0);
    for (const [k, lagRate, offset] of [
      [1, 0.11, 5],
      [2, 0.16, -7],
    ] as const) {
      const sk = sh.sub(broken.mul(lagRate));
      const dk = vSigma.sub(sk).mul(vLen);
      const ak = vAcross.sub(broken.mul(offset).mul(vRes));
      fragments = fragments.add(curve(sk).mul(magF).mul(0.45 / k).mul(gauss(dk.mul(dk).add(ak.mul(ak)), coreW)).mul(step(0.0001, broken))) as F;
    }
    // Colour: faint meteors look white; bright fast ones green, bright slow ones orange (the wake
    // more saturated than the overexposed head).
    const green = vec3(0.38, 1, 0.48);
    const orange = vec3(1, 0.58, 0.24);
    const tintAmt = abs(tintF).mul(smoothstep(0.2, 0.9, magF));
    const tintCol = mix(orange, green, step(0, tintF));
    const white = mix(vec3(1, 0.9, 0.78), vec3(0.84, 0.92, 1), clamp(tintF.mul(1.5).add(0.5), 0, 1));
    const headCol = mix(white, tintCol, tintAmt.mul(0.5));
    const wakeCol = mix(white, tintCol, tintAmt.min(0.8));
    const streakLight = headCol
      .mul(head.add(fragments))
      .add(wakeCol.mul(wake))
      .mul(vExt)
      .mul(u.brightness.mul(3))
      .mul(u.presence) as V3;

    const material = (light: V3, pos: V3) => {
      const m = new MeshBasicNodeMaterial();
      m.positionNode = pos;
      m.colorNode = vec4(additiveFog(light), 1);
      // Bloom only from a capped share of the light, so bright heads do not halo.
      m.mrtNode = mrt({ emissive: vec4(light.min(vec3(1.2, 1.2, 1.2)).mul(p.bloom), 1) });
      m.transparent = true;
      m.depthWrite = false;
      m.blending = AdditiveBlending;
      m.side = DoubleSide;
      m.fog = false;
      return m;
    };
    const streakMat = material(streakLight, streakPos as V3);

    // ---- Fireball train: a faint ribbon along the path that widens, drifts and twists. ----
    const liveT = step(0.5, fire).mul(step(0, t)).mul(step(t, dur.add(TRAIN_LIFE)));
    const dir0 = normalize(mix(A.xyz, B.xyz, g.x));
    const normal = normalize(cross(along, dir0));
    const ageT = t.sub(g.x.mul(dur)).max(0);
    const wind = mx_noise_float(vec3(g.x.mul(3.2).add(seed.mul(11)), seed.mul(7), ageT.mul(0.08)))
      .mul(0.0045)
      .add(mx_noise_float(vec3(g.x.mul(9).add(seed.mul(5)), seed.mul(3).add(1), ageT.mul(0.15))).mul(0.0015))
      .add(0.0012)
      .mul(ageT);
    const dirT = normalize(dir0.add(normal.mul(wind)));
    const width = ageT.mul(0.1).add(0.03).mul(DEG);
    const trainPos = cameraPosition.add(dirT.mul(D)).add(normal.mul(g.y.mul(width).mul(D).mul(liveT)));
    const vTAge = varying(ageT);
    const vTSide = varying(g.y);
    const vTAlong = varying(g.x);
    const vTExt = varying(extinction(dirT.y));
    const trainAmp = curve(vTAlong)
      .mul(magF)
      .mul(0.12)
      .mul(smoothstep(0.4, 1.4, vTAge))
      .mul(exp(vTAge.div(-3)))
      // Surface brightness drops as the train spreads.
      .mul(float(0.13).div(vTAge.mul(0.1).add(0.03)).min(1));
    const knots = mx_noise_float(vec3(vTAlong.mul(24).add(seedF.mul(13)), vTAge.mul(0.25), seedF)).mul(0.35).add(0.85);
    const trainCol = mix(vec3(0.3, 1, 0.55), vec3(0.55, 0.75, 0.7), smoothstep(1, 4, vTAge));
    const trainLight = trainCol
      .mul(trainAmp.mul(knots).mul(exp(vTSide.mul(vTSide).mul(-4))))
      .mul(vTExt)
      .mul(u.brightness.mul(3))
      .mul(u.presence) as V3;
    const trainMat = material(trainLight, trainPos as V3);

    const streaks = new Mesh(streakGeo, streakMat);
    const trains = new Mesh(trainGeo, trainMat);
    for (const m of [streaks, trains]) {
      m.frustumCulled = false;
      m.renderOrder = -14;
    }
    const group = new Group();
    group.add(trains, streaks);

    // ---- Timing (CPU): a meteor clock, the scheduler, and slot bookkeeping. ----
    const busyUntil = new Float64Array(slots).fill(-Infinity);
    let clock = 0;
    let epoch: number | null = null;
    let frozen = false;
    let intensity = 0.5;
    const launch = (plan: MeteorPlan | null, at = 0): boolean => {
      if (!plan) return false;
      const k = busyUntil.findIndex((b) => b <= clock);
      if (k < 0) return false;
      const start = clock - at;
      (valuesA[k] as Vector4).set(plan.a[0], plan.a[1], plan.a[2], start);
      (valuesB[k] as Vector4).set(plan.b[0], plan.b[1], plan.b[2], plan.duration);
      (valuesC[k] as Vector4).set(plan.mag, plan.tint, plan.fireball ? 1 : 0, plan.seed);
      busyUntil[k] = start + plan.duration + Math.max(wakeTauCpu(plan.mag, plan.fireball) * 7, plan.fireball ? TRAIN_LIFE : 0) + 0.1;
      return true;
    };
    const flashSafe = () => ctx.uniforms.flashLimit.value < 0.99;

    const component: MeteorsComponent = {
      object: group,
      reactive: { rate, brightness: u.brightness },
      update(frame) {
        if (frozen) return;
        epoch ??= frame.time;
        const dt = Math.min(0.25, Math.max(0, frame.dt));
        clock = frame.time - epoch;
        u.clock.value = clock;
        // Section intensity, smoothed over seconds: the rate follows the music's shape, not its beats.
        intensity += (frame.audio.sectionIntensity - intensity) * (1 - Math.exp(-dt / 4));
        if (frame.presence < 0.5) return;
        launch(scheduler.step(clock, dt, intensity, rate.value, flashSafe()));
      },
      setPresence(v) {
        u.presence.value = v;
      },
      // Event call-ins (since SDK 1.5): `burst` (or `show`) sends `params.count` meteors (1..6),
      // spaced a little apart, and with `params.shower` starts a shower from one radiant.
      onCall(call) {
        if ((call.action !== 'burst' && call.action !== 'show') || frozen || u.presence.value < 0.5) return;
        if (call.params.shower === true) scheduler.startShower(clock);
        const n = Math.max(1, Math.min(6, Math.round(typeof call.params.count === 'number' ? call.params.count : 1)));
        for (let i = 0; i < n; i++) launch(scheduler.plan(clock, flashSafe(), { fireball: call.params.fireball === true && i === 0 && !flashSafe() }), -(i * 0.45 + Math.random() * 0.35));
      },
      spawn(o = {}) {
        if (o.shower) scheduler.startShower(clock);
        const plan = scheduler.plan(clock, flashSafe(), { fireball: o.fireball ?? false });
        if (plan && o.mag !== undefined) plan.mag = o.mag;
        if (plan && o.tint !== undefined) plan.tint = o.tint;
        return launch(plan, (o.at ?? 0) + (o.phase ?? 0) * (plan?.duration ?? 0)) ? plan : null;
      },
      freeze(on) {
        frozen = on;
      },
      clear() {
        busyUntil.fill(-Infinity);
        for (const v of valuesA) v.w = -1e5;
      },
      dispose() {
        streakGeo.dispose();
        trainGeo.dispose();
        streakMat.dispose();
        trainMat.dispose();
      },
    };
    return component;
  },
};
