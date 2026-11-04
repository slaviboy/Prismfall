import { AdditiveBlending, InstancedBufferAttribute, Sprite, SpriteNodeMaterial } from 'three/webgpu';
import { cos, float, instancedBufferAttribute, length, mix, mrt, sin, smoothstep, uv, vec3, vec4 } from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { additiveFog } from '../../shaders/uniforms';
import { colorUniform, floatUniform, scaledCount, seeded, zColor, zVec3 } from './common';

const schema = z.object({
  count: z.number().int().min(100).max(200000).default(40000),
  position: zVec3.default([-180, 140, -700]),
  /** Tilt of the galactic plane (radians, x then z). */
  tilt: z.tuple([z.number(), z.number()]).default([1.1, 0.35]),
  radius: z.number().positive().default(260),
  arms: z.number().int().min(1).max(6).default(3),
  /** Arm winding (higher = tighter spiral). */
  twist: z.number().default(3.2),
  thickness: z.number().default(0.06),
  core: zColor.default('#fff1d6'),
  arm: zColor.default('#7fa8ff'),
  dust: zColor.default('#ff7ab8'),
  brightness: z.number().default(1),
  /** Rotation speed (radians per second at the rim; the core turns faster). */
  spin: z.number().default(0.004),
  size: z.tuple([z.number(), z.number()]).default([0.6, 2.2]),
  seed: z.number().default(5),
});

type Params = z.infer<typeof schema>;

/** A distant spiral galaxy of particles with a bright core, blue arms and pink star-forming knots. */
export const galaxyComponent: ComponentFactory<Params> = {
  type: 'galaxy',
  version: 1,
  description: 'Particle spiral galaxy with differential rotation.',
  schema,
  create(ctx, p) {
    const count = scaledCount(p.count, ctx.quality.detail, Math.min(1.5, ctx.quality.particles));
    const rand = seeded(p.seed * 3331);
    const gauss = (): number => (rand() + rand() + rand() - 1.5) / 1.5;
    const data = new Float32Array(Math.max(1, count) * 4);
    const extra = new Float32Array(Math.max(1, count) * 4);
    for (let i = 0; i < count; i++) {
      const coreStar = rand() < 0.22;
      const r = coreStar ? Math.abs(gauss()) * 0.18 : Math.pow(rand(), 0.7);
      const arm = Math.floor(rand() * p.arms);
      const theta = (arm / p.arms) * Math.PI * 2 + Math.log(1 + r * 9) * p.twist + gauss() * (0.35 - r * 0.15);
      const h = gauss() * p.thickness * (1 - r * 0.6) * (coreStar ? 2.5 : 1);
      // Radius, base angle, height, kind (0 core, 1 arm, 2 knot).
      data.set([r, theta, h, coreStar ? 0 : rand() < 0.06 ? 2 : 1], i * 4);
      extra.set([rand(), rand(), rand(), rand()], i * 4);
    }
    const a = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(data, 4), 'vec4');
    const b = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(extra, 4), 'vec4');
    const u = { brightness: floatUniform(p.brightness), presence: floatUniform(1), spin: floatUniform(p.spin) };
    // Differential rotation: inner stars complete orbits faster. The turn is integrated on the CPU
    // (spin is reactive: a change of spin must not jump the stars).
    const turn = floatUniform(0);
    const t = ctx.uniforms.time;
    const angle = a.y.add(turn.div(a.x.add(0.15)));
    const r = a.x.mul(p.radius);
    const local = vec3(cos(angle).mul(r), a.z.mul(p.radius), sin(angle).mul(r));
    const [tx, tz] = p.tilt;
    const y1 = local.y.mul(Math.cos(tx)).sub(local.z.mul(Math.sin(tx)));
    const z1 = local.y.mul(Math.sin(tx)).add(local.z.mul(Math.cos(tx)));
    const x2 = local.x.mul(Math.cos(tz)).sub(y1.mul(Math.sin(tz)));
    const y2 = local.x.mul(Math.sin(tz)).add(y1.mul(Math.cos(tz)));
    const world = vec3(x2, y2, z1).add(vec3(...p.position));
    const kind = a.w;
    const core = smoothstep(0.5, 0, kind);
    const knot = smoothstep(1.5, 2, kind);
    const tint = mix(mix(colorUniform(p.arm), colorUniform(p.core), core.add(smoothstep(0.35, 0, a.x).mul(0.7)).clamp(0, 1)), colorUniform(p.dust), knot);
    const twinkle = sin(t.mul(b.y.mul(3).add(1)).add(b.z.mul(30))).mul(0.2).add(0.8);
    const q = uv().sub(0.5).mul(2);
    const shape = smoothstep(1, 0, length(q)).pow(2.2);
    const bright = float(0.35).add(core.mul(1.2)).add(knot.mul(0.8)).mul(b.x.mul(0.8).add(0.4));
    const light = tint.mul(shape).mul(bright).mul(twinkle).mul(u.brightness).mul(u.presence);
    const material = new SpriteNodeMaterial();
    material.positionNode = world;
    material.scaleNode = mix(float(p.size[0]), float(p.size[1]), b.w.pow(3)).mul(knot.mul(1.5).add(1));
    material.colorNode = vec4(additiveFog(light), 1);
    material.transparent = true;
    material.depthWrite = false;
    material.blending = AdditiveBlending;
    material.fog = false;
    material.mrtNode = mrt({ emissive: vec4(light.mul(0.5), 1) });
    const sprite = new Sprite(material);
    sprite.count = Math.max(1, count);
    sprite.frustumCulled = false;
    sprite.renderOrder = -16;
    return {
      object: sprite,
      reactive: { brightness: u.brightness, spin: u.spin },
      update(frame) {
        turn.value += frame.dt * u.spin.value;
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
