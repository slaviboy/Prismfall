import { AdditiveBlending, InstancedBufferAttribute, Sprite, SpriteNodeMaterial, type Node } from 'three/webgpu';
import {
  abs,
  cameraPosition,
  cameraProjectionMatrix,
  exp,
  float,
  floor,
  fract,
  hash,
  instancedBufferAttribute,
  length,
  max,
  mix,
  mrt,
  screenSize,
  select,
  sin,
  smoothstep,
  uint,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { additiveFog } from '../../shaders/uniforms';
import { colorUniform, floatUniform, scaledCount, seeded, zColor, zVec3 } from './common';

const range = z.tuple([z.number(), z.number()]);

const schema = z.object({
  count: z.number().int().min(1).max(400).default(64),
  /**
   * Where the fireflies live, as view angles from the eye (degrees): azimuth from the view axis
   * (mirrored either side), elevation above the eye's horizon, and distance (world units, spread
   * evenly in log distance so every depth is populated). Nothing comes within `clearance` degrees
   * of the view axis, wander included.
   */
  area: z
    .object({
      azimuth: range.default([24, 44]),
      elevation: range.default([-18, -2]),
      distance: range.default([8, 120]),
      eye: zVec3.default([0, 1, 30.5]),
      clearance: z.number().min(0).max(80).default(21),
    })
    .prefault({}),
  /** Lantern diameter (world units): the lit tip of the abdomen. */
  lantern: z.number().positive().default(0.09),
  /** Halo colour (the yellow-green of the light) and the hot core. */
  color: zColor.default('#c8e848'),
  core: zColor.default('#fff6c4'),
  brightness: z.number().min(0).default(1),
  /** Fraction flashing in synchronised bursts; the rest patrol with single J-shaped flashes. */
  synchrony: z.number().min(0).max(1).default(0.55),
  /** Burst cycle of the synchronous fireflies (s), flashes per burst and their spacing (s). */
  burstPeriod: z.number().positive().default(10),
  burstFlashes: range.default([4, 7]),
  burstGap: z.number().positive().default(0.5),
  /** Single-flash cycle range (s) of the patrolling fireflies. */
  flashPeriod: range.default([5, 6.8]),
  /** Share of the population taking part in each cycle (reactive: follows section intensity). */
  activity: z.number().min(0).max(1).default(0.6),
  /** Fraction resting low on the ferns, barely moving, answering with slower flashes. */
  perched: z.number().min(0).max(1).default(0.15),
  /** Wander amplitude as a view angle (degrees) and the flight rate. */
  wander: z.number().min(0).max(10).default(2.2),
  speed: z.number().min(0).default(1),
  /** Depth of field: lens aperture (world units; near lights blur into soft discs) and focus distance. */
  aperture: z.number().min(0).default(0.32),
  focus: z.number().positive().default(30.5),
  /** Mist: the glow halo strength and the extinction per world unit. */
  halo: z.number().min(0).default(1),
  mist: z.number().min(0).default(0.005),
  bloom: z.number().min(0).default(0.25),
  seed: z.number().default(1),
});

type Params = z.infer<typeof schema>;
type F = Node<'float'>;
type V3 = Node<'vec3'>;

const DEG = Math.PI / 180;
/** Flash lengths (s): a patroller's single flash and one pulse of a synchronous burst. */
const SINGLE_FLASH = 0.5;
const BURST_FLASH = 0.14;
/** Speed of the synchrony wave across the swarm (radians of azimuth per second). */
const WAVE_SPEED = 0.7;
/** Radiance of a resolved lantern at full flash (linear, before tone mapping). */
const CORE_RADIANCE = 6;
/** Local time starts here, so cycle indices stay positive (they seed the per-cycle hashes). */
const T0 = 600;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * One flash of a firefly lantern, `x` seconds after it starts: a quick rise and a slower fade
 * (`dur` long). Under flash reduction (`soft` 1) it rises and fades more gently and peaks lower.
 */
export function flashPulse(x: number, dur: number, soft: number): number {
  const d = dur * (1 + soft * 1.5);
  return smooth(0, 0.35 * d, x) * (1 - smooth(0.35 * d, d, x)) * (1 - 0.4 * soft);
}

/** A patroller's light: one flash per `period` (Photinus pyralis style), `phase` in cycles. */
export function singleFlash(t: number, period: number, phase: number, soft: number): number {
  const x = (((t / period + phase) % 1) + 1) % 1;
  return flashPulse(x * period, SINGLE_FLASH, soft);
}

/**
 * A synchronous firefly's light (Photinus carolinus style): a burst of `flashes` short pulses
 * `gap` seconds apart at the start of each `period`, then darkness. `t` is already shifted by the
 * firefly's place in the synchrony wave.
 */
export function burstFlash(t: number, period: number, flashes: number, gap: number, soft: number): number {
  const x = (((t / period) % 1) + 1) % 1 * period;
  const j = Math.floor(x / gap);
  if (j >= flashes) return 0;
  return flashPulse(x - j * gap, BURST_FLASH, soft);
}

/**
 * The patroller's J-stroke: it climbs while it flashes, then sinks slowly through the dark part of
 * the cycle (fraction of the climb, 0 at the start and the end of every cycle).
 */
export function jStroke(x: number, period: number): number {
  return smooth(-0.05, SINGLE_FLASH + 0.1, x) - x / period;
}

export interface FireflyHome {
  x: number;
  y: number;
  z: number;
  /** View angles (radians) and distance from the eye. */
  az: number;
  el: number;
  dist: number;
  /** Wander amplitude (world units). */
  wander: number;
  seed: number;
  sync: boolean;
  perched: boolean;
  period: number;
  phase: number;
  flashes: number;
  /** 1 for entrained synchronous fireflies; otherwise its own cycle as a multiple of the burst period. */
  ratio: number;
  gain: number;
}

/** Worst-case wander offset of the flight path along each axis, in units of the wander amplitude. */
export const WANDER_REACH: readonly [number, number, number] = [1, 0.45 + 0.6, 1];

/** Smallest azimuth (radians) a firefly can reach while wandering around its home. */
export function minReach(h: Pick<FireflyHome, 'x' | 'z' | 'wander'>, eyeZ: number): number {
  const x = Math.abs(h.x) - h.wander * WANDER_REACH[0];
  const depth = eyeZ - h.z + h.wander * WANDER_REACH[2];
  return Math.atan2(x, depth);
}

/** Deterministic homes in view angles, alternating sides, outside the clear zone. */
export function placeFireflies(p: Params, count: number, rand: () => number): FireflyHome[] {
  const a = p.area;
  const [ex, ey, ez] = a.eye;
  const homes: FireflyHome[] = [];
  const firstSide = rand() < 0.5 ? -1 : 1;
  for (let i = 0; i < count; i++) {
    const side = i % 2 === 0 ? firstSide : -firstSide;
    const perched = rand() < p.perched;
    const dist = a.distance[0] * Math.pow(a.distance[1] / a.distance[0], rand());
    const wanderDeg = p.wander * (perched ? 0.06 : 0.7 + rand() * 0.6);
    const wander = dist * Math.tan(wanderDeg * DEG);
    // Clearance plus the wander (and the extra angle it gains when it comes towards the eye).
    const azMin = Math.max(a.azimuth[0], a.clearance + wanderDeg * 1.6 + 0.5);
    const azMax = Math.max(azMin, a.azimuth[1]);
    const az = side * (azMin + (azMax - azMin) * rand()) * DEG;
    // Mostly low among the ferns; the perched ones lowest.
    const r = rand();
    const el = (perched ? a.elevation[0] + (a.elevation[1] - a.elevation[0]) * 0.3 * r : a.elevation[0] + (a.elevation[1] - a.elevation[0]) * Math.pow(r, 1.4)) * DEG;
    const sync = !perched && rand() < p.synchrony;
    const fp = p.flashPeriod;
    homes.push({
      x: ex + dist * Math.cos(el) * Math.sin(az),
      y: ey + dist * Math.sin(el),
      z: ez - dist * Math.cos(el) * Math.cos(az),
      az,
      el,
      dist,
      wander,
      seed: rand(),
      sync,
      perched,
      period: (fp[0] + (fp[1] - fp[0]) * rand()) * (perched ? 1.4 : 1),
      phase: rand(),
      flashes: Math.round(p.burstFlashes[0] + (p.burstFlashes[1] - p.burstFlashes[0]) * rand()),
      // A fifth of the synchronous ones are not (yet) entrained and run on their own clock.
      ratio: rand() < 0.2 ? 0.88 + rand() * 0.24 : 1,
      gain: (0.65 + rand() * 0.55) * (perched ? 0.7 : 1),
    });
  }
  return homes;
}

/**
 * Fireflies: small warm yellow-green lanterns that drift slowly low among the trees and flash in
 * real species patterns. Patrollers flash once every five to seven seconds, climbing while lit
 * (the J-stroke of Photinus pyralis); synchronous fireflies flash in bursts of short pulses with
 * dark gaps, then stay dark, loosely in step: a wave rolls across the swarm from a slowly moving
 * origin, each firefly a little early or late and a few on their own clock. A few rest low on
 * the ferns. Section intensity sets how many take part in each cycle (smoothed over seconds,
 * never on beats).
 *
 * Every light is a camera-facing sprite sized for its distance: a resolved core with a faint mist
 * halo, never smaller than about two pixels (far ones dim as point sources do), and near ones
 * blur into soft discs as if the lens were focused on the board, keeping their total light.
 * All motion and flashing runs in the vertex shader from time and per-firefly data: one draw
 * call, no per-frame CPU work beyond a clock.
 */
export const firefliesComponent: ComponentFactory<Params> = {
  type: 'fireflies',
  version: 1,
  description: 'Fireflies drifting low among the trees, flashing in real species patterns (single J-flashes and synchronised bursts), with depth of field.',
  schema,
  create(ctx, p) {
    const count = Math.max(1, scaledCount(p.count, ctx.quality.detail, ctx.quality.particles));
    const rand = seeded(p.seed * 5297 + 3);
    const homes = placeFireflies(p, count, rand);
    // Per firefly: home + seed; azimuth, period, phase, sync flag; gain, wander, flashes, ratio.
    const a = new Float32Array(count * 4);
    const b = new Float32Array(count * 4);
    const c = new Float32Array(count * 4);
    homes.forEach((h, i) => {
      a.set([h.x, h.y, h.z, h.seed], i * 4);
      b.set([h.az, h.period, h.phase, h.sync ? 1 : 0], i * 4);
      c.set([h.gain, h.wander, h.flashes, h.ratio], i * 4);
    });
    const fa = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(a, 4), 'vec4');
    const fb = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(b, 4), 'vec4');
    const fc = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(c, 4), 'vec4');

    const u = {
      time: floatUniform(T0),
      presence: floatUniform(1),
      brightness: floatUniform(p.brightness),
      activity: floatUniform(p.activity),
    };
    const t = u.time as unknown as F;
    const tm = t.mul((ctx.quality.reducedMotion ? 0.5 : 1) * p.speed);
    // Flash reduction (flashLimit 0.45): gentler, lower flashes.
    const soft = float(1).sub(ctx.uniforms.flashLimit).div(0.55).clamp(0, 1);
    const seed = fa.w;
    const wander = fc.y;
    const period = fb.y;
    const isSync = fb.w.greaterThan(0.5);

    const pulse = (x: F, dur: number): F => {
      const d = soft.mul(1.5).add(1).mul(dur);
      return smoothstep(0, d.mul(0.35), x)
        .mul(float(1).sub(smoothstep(d.mul(0.35), d, x)))
        .mul(float(1).sub(soft.mul(0.4))) as F;
    };
    /** Whether this firefly takes part in cycle k (fades across the threshold, never pops). */
    const takesPart = (k: F): F => {
      const h = hash(k.toUint().mul(uint(1664525)).add(seed.mul(1e6).toUint()));
      return smoothstep(h.sub(0.04), h.add(0.04), u.activity) as F;
    };
    // Patroller: one flash per period, climbing while lit.
    const cs = t.div(period).add(fb.z);
    const xs = fract(cs).mul(period);
    const single = pulse(xs, SINGLE_FLASH).mul(takesPart(floor(cs)));
    const climb = smoothstep(-0.05, SINGLE_FLASH + 0.1, xs).sub(xs.div(period));
    // Synchronous: a wave from a slowly wandering origin; each firefly a little early or late.
    const origin = sin(t.mul(0.043).add(p.seed * 3.1)).mul(1.0);
    const delay = abs(fb.x.sub(origin)).div(WAVE_SPEED).add(fb.z.sub(0.5).mul(0.5));
    const ownClock = fc.w.notEqual(1);
    const cb = select(ownClock, t.div(fc.w.mul(p.burstPeriod)).add(fb.z.mul(7.3)), t.sub(delay).div(p.burstPeriod)) as F;
    const xb = fract(cb).mul(select(ownClock, fc.w.mul(p.burstPeriod), float(p.burstPeriod)));
    const j = floor(xb.div(p.burstGap));
    const burst = pulse(xb.sub(j.mul(p.burstGap)), BURST_FLASH)
      .mul(select(j.lessThan(fc.z), float(1), float(0)))
      .mul(takesPart(floor(cb).add(1)));
    const lit = select(isSync, burst, single) as F;

    // Slow wandering flight (worst-case reach per axis: WANDER_REACH × wander).
    const wx = sin(tm.mul(0.25).add(seed.mul(40))).mul(0.6).add(sin(tm.mul(0.53).add(seed.mul(13))).mul(0.3)).add(sin(tm.mul(1.1).add(seed.mul(7))).mul(0.1));
    const wy = sin(tm.mul(0.31).add(seed.mul(21))).mul(0.6).add(sin(tm.mul(0.71).add(seed.mul(5))).mul(0.4)).mul(0.45);
    const wz = sin(tm.mul(0.21).add(seed.mul(31))).mul(0.6).add(sin(tm.mul(0.47).add(seed.mul(3))).mul(0.4));
    const rise = select(isSync, float(0), climb.mul(0.6)) as F;
    const position = fa.xyz.add(vec3(wx, wy.add(rise), wz).mul(wander)) as V3;

    // Size for distance: resolved core, mist halo, depth-of-field disc for near lights.
    const dist = length(position.sub(cameraPosition));
    const p11 = (cameraProjectionMatrix as unknown as { element(i: number): Node<'vec4'> }).element(1).y;
    const pixel = dist.mul(2).div(p11.mul(screenSize.y));
    const lantern = float(p.lantern);
    const coreD = max(lantern, pixel.mul(1.6));
    const haloD = max(lantern.mul(6), pixel.mul(9));
    const cocD = max(float(1).sub(dist.div(p.focus)), 0).mul(p.aperture);
    const spriteD = max(max(haloD, coreD.mul(3)), cocD.mul(1.15));
    const mist = exp(dist.mul(-p.mist));
    const intensity = lit.mul(fc.x).mul(u.brightness).mul(u.presence).mul(mist).mul(CORE_RADIANCE);
    const vCore = varying(coreD.div(spriteD));
    const vHalo = varying(haloD.div(spriteD));
    const vCoc = varying(max(cocD, coreD).div(spriteD));
    const vDefocus = varying(smoothstep(coreD.mul(1.5), coreD.mul(4), cocD));
    // Radiance of each part: the same flux spread over its area (point sources dim with distance).
    const vCoreI = varying(intensity.mul(lantern.div(coreD).pow(2)));
    const vHaloI = varying(intensity.mul(lantern.div(haloD).pow(2)).mul(p.halo * 2.2));
    const vDiscI = varying(intensity.mul(lantern.div(max(cocD, coreD)).pow(2)).mul(0.7));

    const r = length(uv().sub(0.5).mul(2));
    const core = exp(r.div(vCore).pow(2).mul(-2.2));
    const halo = exp(r.div(vHalo).pow(2).mul(-3));
    // A lens disc: nearly flat with a soft edge (no bright rim, which reads as a bubble).
    const rc = r.div(vCoc);
    const disc = smoothstep(1, 0.62, rc);
    const coreC = colorUniform(p.core);
    const haloC = colorUniform(p.color);
    const focused = mix(haloC, coreC, core).mul(core.mul(vCoreI)).add(haloC.mul(halo.mul(vHaloI)));
    const blurred = mix(haloC, coreC, 0.35).mul(disc.mul(vDiscI));
    const light = mix(focused, blurred, vDefocus) as V3;

    const material = new SpriteNodeMaterial();
    material.positionNode = position;
    material.scaleNode = spriteD;
    material.colorNode = vec4(additiveFog(light), 1);
    material.mrtNode = mrt({ emissive: vec4(light.mul(p.bloom), 1) });
    material.blending = AdditiveBlending;
    material.transparent = true;
    material.depthWrite = false;
    material.fog = false;
    const sprite = new Sprite(material);
    sprite.count = count;
    sprite.frustumCulled = false;
    sprite.renderOrder = -3;

    let clock = T0;
    return {
      object: sprite,
      reactive: { activity: u.activity, brightness: u.brightness },
      update(frame) {
        clock += Math.min(0.1, Math.max(0, frame.dt));
        u.time.value = clock;
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        material.dispose();
        sprite.geometry.dispose();
      },
    };
  },
};
