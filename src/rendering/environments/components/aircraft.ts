import { AdditiveBlending, DataTexture, InstancedBufferAttribute, LinearFilter, RGBAFormat, Sprite, SpriteNodeMaterial, type Node } from 'three/webgpu';
import { asin, atan, cameraPosition, cameraProjectionMatrix, cos, cross, dot, exp, float, floor, fract, hash, instancedBufferAttribute, length, max, mix, mrt, normalize, pow, screenSize, select, sin, smoothstep, step, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { colorUniform, floatUniform, seeded, zColor } from './common';

/** [azimuth from the view axis (degrees, + right), elevation (degrees), distance] from the viewer. */
const zSight = z.tuple([z.number(), z.number(), z.number().positive()]);

// Colours go through colorUniform like every component (manifest hex is linearised twice).
const schema = z.object({
  /**
   * Flight paths, each flown over and over by one aircraft with small variations: straight from
   * `from` to `to` in `duration` seconds, then out of sight until the next pass (`period`).
   * Keep them outside the clear cone around the board (|azimuth| above about 22 degrees).
   */
  routes: z
    .array(
      z.object({
        from: zSight,
        to: zSight,
        duration: z.number().positive(),
        period: z.number().positive(),
        /** On approach: a bright landing light shining ahead. */
        landing: z.boolean().default(false),
        /** Seconds into the cycle at time 0. */
        offset: z.number().default(0),
      }),
    )
    .min(1)
    .max(6)
    .default([
      { from: [40, 13, 2000], to: [27, 8.5, 1350], duration: 95, period: 150, landing: true, offset: 20 },
      { from: [-66, 15, 1750], to: [-27, 17, 1900], duration: 85, period: 130, landing: false, offset: 75 },
    ]),
  /**
   * A panorama's skyline, so aircraft pass behind its buildings: the skyline's elevation (degrees)
   * sampled evenly over `uRange` (fractions of the panorama's width), and the panorama's `offset`
   * (as in the sky layer). Outside `uRange` nothing hides them.
   */
  skyline: z
    .object({
      uRange: z.tuple([z.number(), z.number()]),
      offset: z.number(),
      elevations: z.array(z.number()).min(2).max(2048),
    })
    .optional(),
  /** Where the viewer's eye is (x, y, z). */
  viewer: z.tuple([z.number(), z.number(), z.number()]).default([0, 1, 30]),
  /** Variation of each pass (degrees). */
  jitter: z.number().min(0).default(2),
  /** Wingspan and length (world units; the paths are scaled-down distances). */
  wingspan: z.number().positive().default(30),
  length: z.number().positive().default(32),
  red: zColor.default('#ff6a5a'),
  green: zColor.default('#b0ffc4'),
  white: zColor.default('#fffbf2'),
  brightness: z.number().min(0).default(1),
  /** Fraction of the scene fog applied: aircraft fly above the low haze. */
  fog: z.number().min(0).max(1).default(0.1),
  bloom: z.number().min(0).default(0.12),
  seed: z.number().default(1),
});

type Params = z.infer<typeof schema>;
type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Lights per aircraft: nav red (left tip), nav green (right tip), tail white, beacon, two strobes, landing light. */
const LIGHTS = 7;
/** Elevation range of the skyline texture (degrees). */
const SKY_LO = -10;
const SKY_HI = 50;
const DEG = Math.PI / 180;

/** World position of a sight [azimuth, elevation, distance] from the viewer, looking down -z. */
export function sightToWorld(viewer: readonly [number, number, number], s: readonly [number, number, number]): [number, number, number] {
  const [az, el, d] = s;
  return [viewer[0] + Math.sin(az * DEG) * Math.cos(el * DEG) * d, viewer[1] + Math.sin(el * DEG) * d, viewer[2] - Math.cos(az * DEG) * Math.cos(el * DEG) * d];
}

/**
 * Distant airliners crossing the night sky slowly, seen only by their lights: red and green
 * navigation lights on the left and right wingtips and a white tail light (each seen only from
 * its own side, as the real lights are screened), a red anti-collision beacon flashing about once
 * a second, white wingtip strobes giving a double flash, and on approach a bright landing light
 * that grows as the aircraft heads towards the viewer. Towers hide them as they pass behind.
 *
 * Each flies a route over and over with hashed variations; everything is computed on the GPU from
 * time. One draw call.
 */
export const aircraftComponent: ComponentFactory<Params> = {
  type: 'aircraft',
  version: 1,
  description: 'Distant aircraft at night: directional navigation lights, red beacon, double-flash strobes, landing lights on approach.',
  schema,
  create(ctx, p) {
    const rand = seeded(p.seed * 3571 + 9);
    const data = { a: [] as number[], b: [] as number[], c: [] as number[] };
    p.routes.forEach((r, k) => {
      const seed = rand();
      for (let light = 0; light < LIGHTS; light++) {
        data.a.push(r.from[0] * DEG, r.from[1] * DEG, r.from[2], r.duration);
        data.b.push(r.to[0] * DEG, r.to[1] * DEG, r.to[2], r.period);
        data.c.push(light, seed, r.landing ? 1 : 0, r.offset + k * 0.37);
      }
    });
    const A = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(new Float32Array(data.a), 4), 'vec4');
    const B = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(new Float32Array(data.b), 4), 'vec4');
    const C = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(new Float32Array(data.c), 4), 'vec4');
    const u = { presence: floatUniform(1), brightness: floatUniform(p.brightness), strobe: uniform(1) };
    const time = ctx.uniforms.time;
    const viewer = vec3(...p.viewer);

    const local = time.add(C.w);
    const cycle = floor(local.div(B.w));
    const k = local.sub(cycle.mul(B.w)).div(A.w);
    const seedKey = C.y.mul(7919).floor().add(cycle.mul(131));
    const jit = (n: number): F => hash(seedKey.add(n)).sub(0.5).mul(2 * p.jitter * DEG) as F;
    const sight = (az: F, el: F, d: F): V3 => vec3(sin(az).mul(cos(el)).mul(d), sin(el).mul(d), cos(az).mul(cos(el)).mul(d).negate()).add(viewer) as V3;
    const start = sight(A.x.add(jit(1)) as F, A.y.add(jit(2)) as F, A.z);
    const end = sight(B.x.add(jit(3)) as F, B.y.add(jit(4)) as F, B.z);
    const t = k.clamp(0, 1);
    const centre = mix(start, end, t);
    const forward = normalize(end.sub(start));
    const right = normalize(cross(forward, vec3(0, 1, 0)));
    const up = cross(right, forward);
    const light = C.x;
    const half = p.wingspan * 0.5;
    const offsetFor = (i: number): V3 => {
      switch (i) {
        case 0:
          return right.mul(-half) as V3;
        case 1:
          return right.mul(half) as V3;
        case 2:
          return forward.mul(-p.length * 0.5).add(up.mul(3)) as V3;
        case 3:
          return up.mul(1.6) as V3;
        case 4:
          return right.mul(-half * 0.98).sub(forward.mul(0.6)) as V3;
        case 5:
          return right.mul(half * 0.98).sub(forward.mul(0.6)) as V3;
        default:
          return forward.mul(p.length * 0.3).sub(up.mul(1.2)) as V3;
      }
    };
    let offset: V3 = offsetFor(LIGHTS - 1);
    for (let i = LIGHTS - 2; i >= 0; i--) offset = select(light.lessThan(i + 0.5), offsetFor(i), offset) as V3;
    const pos = centre.add(offset) as V3;

    // Where the viewer sits around the aircraft: 0 straight ahead, +90 degrees off the right wing.
    const toCam = normalize(cameraPosition.sub(centre));
    const ahead = dot(toCam, forward);
    const bearing = atan(dot(toCam, right), ahead);
    const absB = bearing.abs();
    // Screens: red covers dead ahead to 110 degrees left, green the same to the right, white the rear.
    const redVis = smoothstep(0.08, -0.08, bearing).mul(smoothstep(2.0, 1.85, absB));
    const greenVis = smoothstep(-0.08, 0.08, bearing).mul(smoothstep(2.0, 1.85, absB));
    const tailVis = smoothstep(1.85, 2.0, absB);
    // Beacon: a short red flash about once a second; strobes: a double flash every 1.2 s.
    const phase = time.add(C.y.mul(11));
    const beacon = smoothstep(0.14, 0.0, fract(phase.mul(0.95)));
    const sp = fract(phase.div(1.2).add(0.37));
    const pulse = (at: number): F => {
      const d = sp.sub(at).div(0.02);
      return exp(d.mul(d).negate()) as F;
    };
    const strobe = pulse(0.03).add(pulse(0.15)).mul(u.strobe);
    const landing = pow(max(ahead, 0), 8).mul(C.z);
    const red = colorUniform(p.red);
    const green = colorUniform(p.green);
    const white = colorUniform(p.white);
    const lightColor = (i: number): V3 => {
      switch (i) {
        case 0:
          return red.mul(redVis).mul(9) as V3;
        case 1:
          return green.mul(greenVis).mul(8) as V3;
        case 2:
          return white.mul(tailVis.mul(7).add(0.6)) as V3;
        case 3:
          return red.mul(beacon).mul(16) as V3;
        case 4:
        case 5:
          return white.mul(strobe).mul(36) as V3;
        default:
          return white.mul(landing).mul(70) as V3;
      }
    };
    let color: V3 = lightColor(LIGHTS - 1);
    for (let i = LIGHTS - 2; i >= 0; i--) color = select(light.lessThan(i + 0.5), lightColor(i), color) as V3;
    const trueSize = select(light.greaterThan(5.5), float(2.4), float(1.2));
    const fade = smoothstep(0, 0.06, k).mul(smoothstep(1, 0.94, k)).mul(step(k, 1));

    const dist = length(cameraPosition.sub(pos));
    const p11 = (cameraProjectionMatrix as unknown as { element(i: number): Node<'vec4'> }).element(1).y;
    const pixel = dist.mul(2).div(p11.mul(screenSize.y));
    const draw = max(trueSize, pixel.mul(1.6));
    const cover = trueSize.div(draw);
    // Haze thins with altitude: only a fraction of the scene fog.
    const fd = length(pos.sub(cameraPosition)).mul(ctx.uniforms.fogDensity).mul(p.fog);
    const haze = exp(fd.mul(fd).negate());
    // Behind the panorama's buildings: compare this fragment's elevation with the skyline's.
    let behind: F = float(1);
    let skylineTex: DataTexture | null = null;
    if (p.skyline) {
      const sk = p.skyline;
      const bytes = new Uint8Array(sk.elevations.length * 4);
      sk.elevations.forEach((e, i) => {
        const v = Math.round(((Math.min(SKY_HI, Math.max(SKY_LO, e)) - SKY_LO) / (SKY_HI - SKY_LO)) * 255);
        bytes.set([v, v, v, 255], i * 4);
      });
      skylineTex = new DataTexture(bytes, sk.elevations.length, 1, RGBAFormat);
      skylineTex.minFilter = LinearFilter;
      skylineTex.magFilter = LinearFilter;
      skylineTex.needsUpdate = true;
      const look = normalize(pos.sub(cameraPosition));
      const turn = fract(atan(look.x, look.z.negate()).div(Math.PI * 2).add(sk.offset));
      const q = turn.sub(sk.uRange[0]).div(sk.uRange[1] - sk.uRange[0]);
      const inside = step(0, q).mul(step(q, 1));
      const skyEl = texture(skylineTex, vec2(q.clamp(0, 1), 0.5)).r.mul(SKY_HI - SKY_LO).add(SKY_LO);
      const el = asin(look.y.clamp(-1, 1)).mul(180 / Math.PI);
      behind = mix(float(1), smoothstep(skyEl.sub(0.05), skyEl.add(0.15), el), inside) as F;
    }
    const r = length(uv().sub(0.5).mul(2));
    const shape = exp(r.div(0.24).pow(2).negate()).add(exp(r.div(0.7).pow(2).negate()).mul(0.05));
    const lit = color.mul(cover.mul(cover)).mul(shape).mul(fade).mul(haze).mul(behind).mul(u.brightness).mul(u.presence) as V3;

    const material = new SpriteNodeMaterial();
    material.positionNode = pos;
    material.scaleNode = draw.mul(4);
    material.colorNode = vec4(lit, 1);
    material.mrtNode = mrt({ emissive: vec4(lit.mul(p.bloom), 1) });
    material.transparent = true;
    material.depthWrite = false;
    material.blending = AdditiveBlending;
    material.fog = false;
    const sprite = new Sprite(material);
    sprite.count = p.routes.length * LIGHTS;
    sprite.frustumCulled = false;
    sprite.renderOrder = -6;
    return {
      object: sprite,
      reactive: { brightness: u.brightness },
      update() {
        // Flash reduction: strobes become a soft blink.
        u.strobe.value = ctx.uniforms.flashLimit.value < 0.99 ? 0.35 : 1;
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        material.dispose();
        sprite.geometry.dispose();
        skylineTex?.dispose();
      },
    };
  },
};
