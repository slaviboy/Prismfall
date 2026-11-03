import { BackSide, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3 } from 'three/webgpu';
import {
  abs,
  dot,
  exp,
  floor,
  fract,
  max,
  mix,
  mx_fractal_noise_float,
  normalize,
  positionWorldDirection,
  sin,
  smoothstep,
  step,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { noBloom } from '../../shaders/uniforms';
import { colorUniform, floatUniform, zColor, zVec3 } from './common';

const schema = z.object({
  top: zColor.default('#05071a'),
  horizon: zColor.default('#1b1440'),
  bottom: zColor.default('#020208'),
  /** Optional middle colour stop (dusk and dawn skies), reached at `midHeight` above the horizon. */
  mid: zColor.optional(),
  midHeight: z.number().min(0.02).max(0.8).default(0.22),
  horizonGlow: z.number().default(0.6),
  horizonWidth: z.number().default(0.18),
  stars: z.number().min(0).max(1).default(0.5),
  starSize: z.number().default(1),
  nebula: z.number().min(0).default(0),
  nebulaA: zColor.default('#4a2aa0'),
  nebulaB: zColor.default('#1aa0c8'),
  nebulaScale: z.number().default(2.2),
  nebulaDrift: z.number().default(0.004),
  disc: z
    .object({ direction: zVec3, color: zColor, size: z.number(), halo: z.number(), intensity: z.number().default(1) })
    .optional(),
  bloom: z.boolean().default(false),
});

export type SkyParams = z.infer<typeof schema>;

/** Procedural sky dome: gradient, horizon glow, hashed stars, drifting fBm nebula, optional sun/moon disc. */
export const skyComponent: ComponentFactory<SkyParams> = {
  type: 'sky',
  version: 1,
  description: 'Gradient sky dome with stars, nebula and an optional sun or moon disc.',
  schema,
  create(ctx, p) {
    const u = {
      top: colorUniform(p.top),
      horizon: colorUniform(p.horizon),
      bottom: colorUniform(p.bottom),
      glow: floatUniform(p.horizonGlow),
      stars: floatUniform(p.stars),
      nebula: floatUniform(p.nebula),
      nebulaA: colorUniform(p.nebulaA),
      nebulaB: colorUniform(p.nebulaB),
      discIntensity: floatUniform(p.disc?.intensity ?? 0),
      presence: floatUniform(1),
    };
    const dir = normalize(positionWorldDirection);
    const y = dir.y;
    const up = smoothstep(0, 0.9, y);
    const down = smoothstep(0, -0.6, y);
    const upper = p.mid
      ? mix(mix(u.horizon, colorUniform(p.mid), smoothstep(0, p.midHeight, y)), u.top, smoothstep(p.midHeight, 0.9, y))
      : mix(u.horizon, u.top, up);
    let color = mix(upper, u.bottom, down);
    const band = exp(abs(y).div(p.horizonWidth).negate()).mul(u.glow);
    color = color.add(u.horizon.mul(band));

    if (p.nebula > 0) {
      const t = ctx.uniforms.time.mul(p.nebulaDrift);
      const n1 = mx_fractal_noise_float(dir.mul(p.nebulaScale).add(vec3(t, 0, t.mul(0.5))), 4, 2.0, 0.5).mul(0.5).add(0.5);
      const n2 = mx_fractal_noise_float(dir.mul(p.nebulaScale * 2.3).add(vec3(0, t.mul(1.3), 0)), 3, 2.0, 0.5).mul(0.5).add(0.5);
      const cloud = smoothstep(0.42, 0.95, n1).mul(smoothstep(0.3, 0.8, n2));
      color = color.add(mix(u.nebulaA, u.nebulaB, n2).mul(cloud.mul(u.nebula)));
    }

    if (p.stars > 0) {
      const cells = dir.mul(220 / p.starSize);
      const id = floor(cells);
      const h = fract(sin(dot(id, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
      const local = fract(cells).sub(0.5);
      const d = local.length();
      const twinkle = sin(ctx.uniforms.time.mul(h.mul(3).add(0.5)).add(h.mul(60))).mul(0.35).add(0.65);
      const star = step(1 - p.stars * 0.06, h).mul(smoothstep(0.22, 0.0, d)).mul(twinkle).mul(smoothstep(-0.15, 0.1, y));
      color = color.add(vec3(0.9, 0.93, 1).mul(star.mul(2.2)));
    }

    if (p.disc) {
      // size and halo are angular radii in degrees.
      const dDir = new Vector3(...p.disc.direction).normalize();
      const sd = uniform(dDir);
      const cosA = max(dot(dir, sd), 0);
      const r = (p.disc.size * Math.PI) / 180;
      const disc = smoothstep(Math.cos(r * 1.06), Math.cos(r), cosA);
      const haloR = (Math.max(0.1, p.disc.halo) * Math.PI) / 180;
      const halo = exp(cosA.oneMinus().mul(-2 / (haloR * haloR))).mul(0.45);
      const discColor = colorUniform(p.disc.color);
      color = color.add(discColor.mul(disc.mul(2.2).add(halo)).mul(u.discIntensity));
    }

    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec4(color.mul(u.presence), 1);
    material.side = BackSide;
    material.depthWrite = false;
    material.fog = false;
    if (!p.bloom) noBloom(material);
    const mesh = new Mesh(new SphereGeometry(900, 64, 32), material);
    mesh.renderOrder = -20;
    mesh.frustumCulled = false;
    return {
      object: mesh,
      reactive: { glow: u.glow, stars: u.stars, nebula: u.nebula, disc: u.discIntensity },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        mesh.geometry.dispose();
        material.dispose();
      },
    };
  },
};
