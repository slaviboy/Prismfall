import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import { attribute, mix, mrt, mx_fractal_noise_float, mx_noise_float, positionLocal, sin, smoothstep, vec3, vec4 } from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { additiveFog } from '../../shaders/uniforms';
import { colorUniform, floatUniform, seeded, zColor } from './common';

const schema = z.object({
  ribbons: z.number().int().min(1).max(12).default(4),
  /** Distance range from the viewer (world units). */
  distance: z.tuple([z.number(), z.number()]).default([380, 620]),
  /** Bottom edge height and curtain height. */
  base: z.number().default(40),
  height: z.tuple([z.number(), z.number()]).default([90, 170]),
  /** Horizontal extent of each ribbon. */
  width: z.number().default(900),
  low: zColor.default('#3dff9a'),
  high: zColor.default('#b45cff'),
  /** Fraction of ribbons using the alternate colour pair. */
  alt: z.object({ low: zColor.default('#4ad8ff'), high: zColor.default('#ff6ad5'), share: z.number().min(0).max(1).default(0.3) }).prefault({}),
  intensity: z.number().min(0).default(1),
  speed: z.number().default(1),
  seed: z.number().default(3),
});

type Params = z.infer<typeof schema>;

/**
 * Aurora curtains: long ribbons hanging in the sky with fine vertical rays, slow folds that travel
 * along them and a green-to-violet height gradient. Additive light, fogged by transmittance.
 */
export const auroraComponent: ComponentFactory<Params> = {
  type: 'aurora',
  version: 1,
  description: 'Aurora borealis curtains with travelling folds and vertical rays.',
  schema,
  create(ctx, p) {
    const rand = seeded(p.seed * 131);
    const segs = ctx.quality.detail === 'low' ? 80 : 180;
    const positions: number[] = [];
    const data: number[] = [];
    const index: number[] = [];
    for (let r = 0; r < p.ribbons; r++) {
      const dist = p.distance[0] + (p.distance[1] - p.distance[0]) * rand();
      const h = p.height[0] + (p.height[1] - p.height[0]) * rand();
      const bend = (rand() - 0.5) * 0.6;
      const xOff = (rand() - 0.5) * p.width * 0.4;
      const altPair = rand() < p.alt.share ? 1 : 0;
      const seed = rand() * 100;
      const start = positions.length / 3;
      for (let i = 0; i <= segs; i++) {
        const u = i / segs;
        const x = xOff + (u - 0.5) * p.width;
        const z = -dist - Math.sin(u * Math.PI * 1.3 + seed) * 60 - bend * (u - 0.5) * (u - 0.5) * 900;
        for (const v of [0, 1]) {
          positions.push(x, p.base + v * h, z);
          data.push(u, v, seed, altPair);
        }
      }
      for (let i = 0; i < segs; i++) {
        const a = start + i * 2;
        index.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('ribbon', new BufferAttribute(new Float32Array(data), 4));
    geometry.setIndex(index);
    geometry.computeBoundingSphere();

    const u = { intensity: floatUniform(p.intensity), presence: floatUniform(1), speed: floatUniform(p.speed) };
    const t = ctx.uniforms.time.mul(u.speed);
    const rib = attribute<'vec4'>('ribbon', 'vec4');
    const ru = rib.x;
    const rv = rib.y;
    const seed = rib.z;
    // Folds travel along the ribbon; the curtain sways in depth and sideways.
    const fold = mx_noise_float(vec3(ru.mul(5).add(t.mul(0.04)), seed, t.mul(0.03)));
    const sway = vec3(mx_noise_float(vec3(ru.mul(3), seed.add(5), t.mul(0.02))).mul(40), rv.mul(rv).mul(fold).mul(12), fold.mul(70));
    const material = new MeshBasicNodeMaterial();
    material.positionNode = positionLocal.add(sway);
    // Fine vertical rays drifting sideways, brighter at the lower edge, fading towards the top.
    const rays = mx_fractal_noise_float(vec3(ru.mul(160).add(t.mul(0.6)), seed, t.mul(0.15)), 3, 2, 0.5).mul(0.5).add(0.5);
    const edgeLow = smoothstep(0, 0.06, rv);
    const fadeUp = smoothstep(1, 0.25, rv).pow(1.4);
    const ends = smoothstep(0, 0.12, ru).mul(smoothstep(1, 0.88, ru));
    const pulse = sin(t.mul(0.5).add(seed).add(ru.mul(8))).mul(0.25).add(0.75);
    const lowC = mix(colorUniform(p.low), colorUniform(p.alt.low), rib.w);
    const highC = mix(colorUniform(p.high), colorUniform(p.alt.high), rib.w);
    const grad = mix(lowC, highC, smoothstep(0.15, 0.85, rv));
    const brightness = rays.pow(2.2).mul(1.6).add(0.15).mul(edgeLow).mul(fadeUp).mul(ends).mul(pulse).mul(fold.mul(0.4).add(0.8));
    const light = grad.mul(brightness).mul(u.intensity).mul(u.presence).mul(0.55);
    material.colorNode = vec4(additiveFog(light), 1);
    material.transparent = true;
    material.depthWrite = false;
    material.blending = AdditiveBlending;
    material.side = DoubleSide;
    material.fog = false;
    material.mrtNode = mrt({ emissive: vec4(light.mul(0.5), 1) });
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -15;
    return {
      object: mesh,
      reactive: { intensity: u.intensity, speed: u.speed },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        geometry.dispose();
        material.dispose();
      },
    };
  },
};
