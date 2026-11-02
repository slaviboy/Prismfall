import { AdditiveBlending, InstancedBufferAttribute, NormalBlending, Sprite, SpriteNodeMaterial, type Node } from 'three/webgpu';
import { cos, dot, float, fract, instancedBufferAttribute, length, mix, mrt, sin, smoothstep, uv, vec2, vec3, vec4 } from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { colorUniform, floatUniform, seeded, zColor, zVec3 } from './common';

const schema = z.object({
  count: z.number().int().min(1).max(400).default(40),
  center: zVec3.default([0, 0, -160]),
  spread: zVec3.default([400, 120, 200]),
  size: z.tuple([z.number(), z.number()]).default([60, 140]),
  color: zColor.default('#3a2a7a'),
  colorB: zColor.default('#1a5a8a'),
  opacity: z.number().default(0.35),
  drift: zVec3.default([1.5, 0, 0]),
  additive: z.boolean().default(true),
  seed: z.number().default(11),
});

/** Large soft billboards for nebulae, haze, steam or murk. Cheap hashed-noise texture in the shader. */
export const cloudsComponent: ComponentFactory<z.infer<typeof schema>> = {
  type: 'clouds',
  version: 1,
  description: 'Drifting soft billboard clouds (nebula depth, haze, steam).',
  schema,
  create(ctx, p) {
    const count = ctx.quality.detail === 'low' ? Math.ceil(p.count * 0.4) : p.count;
    const rand = seeded(p.seed);
    const data = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      data[i * 4] = (rand() - 0.5) * p.spread[0];
      data[i * 4 + 1] = (rand() - 0.5) * p.spread[1];
      data[i * 4 + 2] = (rand() - 0.5) * p.spread[2];
      data[i * 4 + 3] = rand();
    }
    const a = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(data, 4), 'vec4');
    const u = { opacity: floatUniform(p.opacity), presence: floatUniform(1) };
    const t = ctx.uniforms.time;
    const pos = a.xyz.add(vec3(...p.center)).add(vec3(...p.drift).mul(t).mul(a.w.mul(0.6).add(0.4)));
    const size = mix(float(p.size[0]), float(p.size[1]), a.w);
    const q = uv().sub(0.5);
    // Two octaves of cheap rotating hash-noise give a cloudy, non-repeating silhouette.
    const rot = (k: number) => vec2(q.x.mul(cos(a.w.mul(k))).sub(q.y.mul(sin(a.w.mul(k)))), q.x.mul(sin(a.w.mul(k))).add(q.y.mul(cos(a.w.mul(k)))));
    const n = (v: Node<'vec2'>, s: number) => fract(sin(dot(v.mul(s).floor(), vec2(12.9898, 78.233))).mul(43758.5453));
    const blob = smoothstep(0.5, 0.05, length(q)).mul(float(0.7).add(n(rot(7).add(a.w), 6).mul(0.15)).add(sin(rot(3).x.mul(9).add(t.mul(0.05))).mul(0.15)));
    const tint = mix(colorUniform(p.color), colorUniform(p.colorB), a.w);
    const alpha = blob.mul(u.opacity).mul(u.presence);
    const material = new SpriteNodeMaterial();
    material.positionNode = pos;
    material.scaleNode = size;
    material.colorNode = p.additive ? vec4(tint.mul(alpha), 1) : vec4(tint, alpha);
    material.transparent = true;
    material.depthWrite = false;
    material.blending = p.additive ? AdditiveBlending : NormalBlending;
    material.mrtNode = mrt({ emissive: vec4(tint.mul(alpha).mul(0.15), 1) });
    const sprite = new Sprite(material);
    sprite.count = count;
    sprite.frustumCulled = false;
    sprite.renderOrder = -12;
    return {
      object: sprite,
      reactive: { opacity: u.opacity },
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
