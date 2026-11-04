import { AdditiveBlending, InstancedBufferAttribute, NormalBlending, Sprite, SpriteNodeMaterial } from 'three/webgpu';
import {
  abs,
  cos,
  float,
  instancedBufferAttribute,
  length,
  mix,
  mod,
  mrt,
  sin,
  smoothstep,
  step,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { additiveFog, frameUniforms } from '../../shaders/uniforms';
import { clearFront, clearFrontMotion } from '../../shaders/clearFront';
import { colorUniform, floatUniform, scaledCount, seeded, zColor, zVec3 } from './common';

const SHAPES = { soft: 0, star: 1, spark: 2, snow: 3, bubble: 4, streak: 5, petal: 6 } as const;

const schema = z.object({
  count: z.number().int().min(1).max(200000).default(4000),
  center: zVec3.default([0, 0, -20]),
  size: zVec3.default([120, 60, 80]),
  color: zColor.default('#9fb8ff'),
  colorB: zColor.optional(),
  minSize: z.number().default(0.05),
  maxSize: z.number().default(0.18),
  velocity: zVec3.default([0, 0.2, 0]),
  turbulence: z.number().default(0.4),
  twinkle: z.number().min(0).max(1).default(0.5),
  brightness: z.number().default(1),
  shape: z.enum(['soft', 'star', 'spark', 'snow', 'bubble', 'streak', 'petal']).default('soft'),
  /** Streak orientation in degrees (0 = vertical), e.g. driving snow or meteors. */
  angle: z.number().default(0),
  /** Tumbling (radians/second) for petals and leaves. */
  spin: z.number().default(0),
  additive: z.boolean().default(true),
  /** Fraction of particles shown (density modulation, reactive). */
  density: z.number().min(0).max(1).default(1),
  seed: z.number().default(1),
  bloom: z.number().default(0.6),
  /**
   * The world clear wave (since SDK 1.5; 0 = off): as a clear's front passes, the particles flare
   * by `brightness` (x their light) and are stirred: pushed outward from the board and whirled,
   * `stir` world units at the front's peak.
   */
  clearWave: z.object({ brightness: z.number().min(0).default(0), stir: z.number().min(0).default(0) }).prefault({}),
});

export type ParticleFieldParams = z.infer<typeof schema>;

/**
 * Ambient particle volume (dust, plankton, stars, embers, snow, pollen, rain).
 * Positions are static per particle; drift, wrap-around, turbulence and twinkle run in the shader.
 */
export const particlesComponent: ComponentFactory<ParticleFieldParams> = {
  type: 'particles',
  version: 1,
  description: 'Ambient GPU particle volume with drift, turbulence, twinkle and music-reactive brightness.',
  schema,
  create(ctx, p) {
    const count = scaledCount(p.count, ctx.quality.detail, ctx.quality.particles);
    const rand = seeded(p.seed * 7919 + count);
    const seeds = new Float32Array(Math.max(1, count) * 4);
    for (let i = 0; i < count; i++) {
      seeds[i * 4] = rand();
      seeds[i * 4 + 1] = rand();
      seeds[i * 4 + 2] = rand();
      seeds[i * 4 + 3] = rand();
    }
    const attr = new InstancedBufferAttribute(seeds, 4);
    const s = instancedBufferAttribute<'vec4'>(attr, 'vec4');
    const u = {
      brightness: floatUniform(p.brightness),
      speed: floatUniform(1),
      size: floatUniform(1),
      turbulence: floatUniform(p.turbulence),
      density: floatUniform(p.density),
      presence: floatUniform(1),
    };
    const colorA = colorUniform(p.color);
    const colorB = colorUniform(p.colorB ?? p.color);
    const time = ctx.uniforms.time;
    const vol = vec3(...p.size);
    const center = vec3(...p.center);
    // Drift with wrap-around inside the volume (speed is reactive, so drift accumulates via time*speed).
    const travel = vec3(...p.velocity).mul(time).mul(u.speed);
    const base = s.xyz.mul(vol).add(travel);
    const wrapped = mod(base, vol).sub(vol.mul(0.5)).add(center);
    const ph = s.w.mul(6.283).add(time.mul(0.35));
    const wobble = vec3(sin(ph.add(s.x.mul(20))), cos(ph.mul(0.8).add(s.y.mul(17))), sin(ph.mul(0.6).add(s.z.mul(13)))).mul(u.turbulence);
    let pos = wrapped.add(wobble);
    const cw = p.clearWave;
    if (cw.stir > 0) {
      // A gust front: pushed away from the board and lifted a little as it passes, then a whirl
      // that settles in its soft tail.
      const push = clearFrontMotion(wrapped);
      const away = wrapped.sub(frameUniforms.waveOrigin).mul(vec3(1, 0, 1)).normalize();
      const whirl = vec3(sin(ph.mul(3.1).add(s.y.mul(31))), cos(ph.mul(2.7).add(s.x.mul(29))).mul(0.6).add(0.4), cos(ph.mul(3.3).add(s.z.mul(23))));
      pos = pos.add(away.add(vec3(0, 0.35, 0)).mul(push.mul(cw.stir)).add(whirl.mul(push.mul(cw.stir * 0.45))));
    }
    // Fade out near the volume's faces so wrapping is invisible.
    const local = mod(base, vol).div(vol);
    const edge = smoothstep(0, 0.08, local.x).mul(smoothstep(1, 0.92, local.x)).mul(smoothstep(0, 0.08, local.y)).mul(smoothstep(1, 0.92, local.y)).mul(smoothstep(0, 0.08, local.z)).mul(smoothstep(1, 0.92, local.z));
    const visible = step(s.w, u.density);
    const twinkle = mix(float(1), sin(time.mul(s.x.mul(2).add(0.6)).add(s.y.mul(40))).mul(0.5).add(0.5), p.twinkle);
    const size = mix(float(p.minSize), float(p.maxSize), s.z.pow(2)).mul(u.size).mul(visible).mul(edge);

    const q = uv().sub(0.5).mul(2);
    const r = length(q);
    const shapeMask = (() => {
      switch (SHAPES[p.shape]) {
        case SHAPES.star:
          return smoothstep(1, 0, r).pow(5).add(smoothstep(0.1, 0, abs(q.x)).mul(smoothstep(1, 0, abs(q.y))).add(smoothstep(0.1, 0, abs(q.y)).mul(smoothstep(1, 0, abs(q.x)))).mul(0.5));
        case SHAPES.spark:
          return smoothstep(1, 0, r).pow(3);
        case SHAPES.snow:
          return smoothstep(1, 0.4, r);
        case SHAPES.bubble:
          return smoothstep(1, 0.8, r).mul(smoothstep(0.5, 0.8, r)).add(smoothstep(0.3, 0, length(q.sub(vec2(-0.3, 0.3)))).mul(0.5));
        case SHAPES.streak:
          return smoothstep(0.25, 0, abs(q.x)).mul(smoothstep(1, 0.2, abs(q.y)));
        case SHAPES.petal:
          return smoothstep(1, 0.7, length(vec2(q.x.mul(1.8), q.y.add(q.x.mul(q.x).mul(0.4)))));
        default:
          return smoothstep(1, 0, r).pow(1.8);
      }
    })();
    const tint = mix(colorA, colorB, s.y);
    const flare = cw.brightness > 0 ? float(1).add(clearFront(wrapped).mul(cw.brightness)) : float(1);
    const light = tint.mul(shapeMask).mul(twinkle).mul(u.brightness).mul(flare).mul(u.presence);

    const material = new SpriteNodeMaterial();
    material.positionNode = pos;
    material.scaleNode = p.shape === 'streak' ? vec2(size.mul(0.35), size.mul(3)) : size;
    if (p.angle !== 0 || p.spin !== 0) material.rotationNode = float((p.angle * Math.PI) / 180).add(time.mul(p.spin).mul(s.x.sub(0.5).mul(2)));
    material.colorNode = p.additive ? vec4(additiveFog(light), 1) : vec4(light, shapeMask.mul(u.presence));
    material.transparent = true;
    material.depthWrite = false;
    material.blending = p.additive ? AdditiveBlending : NormalBlending;
    material.fog = !p.additive;
    material.mrtNode = p.additive ? mrt({ emissive: vec4(light.mul(p.bloom), 1) }) : mrt({ emissive: vec4(tint.mul(twinkle).mul(u.brightness).mul(p.bloom), shapeMask.mul(u.presence)) });
    const sprite = new Sprite(material);
    sprite.count = count;
    sprite.frustumCulled = false;
    sprite.renderOrder = -5;
    return {
      object: sprite,
      reactive: u,
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
