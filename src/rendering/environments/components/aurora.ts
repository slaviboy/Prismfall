import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import {
  abs,
  attribute,
  cameraPosition,
  clamp,
  cross,
  dFdx,
  dFdy,
  dot,
  exp,
  float,
  mix,
  modelWorldMatrix,
  mrt,
  mx_fractal_noise_float,
  mx_noise_float,
  normalize,
  positionLocal,
  sin,
  smoothstep,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { additiveFog } from '../../shaders/uniforms';
import { clearFront } from '../../shaders/clearFront';
import { colorUniform, floatUniform, seeded, zColor } from './common';

const schema = z.object({
  ribbons: z.number().int().min(1).max(12).default(4),
  /** Distance range from the viewer (world units). */
  distance: z.tuple([z.number(), z.number()]).default([380, 620]),
  /** Bottom edge height and curtain height. */
  base: z.number().default(40),
  height: z.tuple([z.number(), z.number()]).default([90, 170]),
  /** Horizontal extent of each ribbon (used when `span` is not given). */
  width: z.number().default(900),
  /** Angular length of each curtain in degrees; curtains are placed around the viewer. */
  span: z.tuple([z.number(), z.number()]).optional(),
  /** Azimuth range (degrees, 0 = ahead) the curtain centres are spread over. */
  azimuth: z.tuple([z.number(), z.number()]).default([-50, 50]),
  /** Height change of the lower edge from one end of a curtain to the other (diagonal sweep). */
  rise: z.number().default(0),
  /** Lower-edge colour and the faint colour the curtain fades to at the top. */
  low: zColor.default('#3dff9a'),
  high: zColor.default('#b45cff'),
  /** Fraction of ribbons using the alternate colour pair. */
  alt: z.object({ low: zColor.default('#4ad8ff'), high: zColor.default('#ff6ad5'), share: z.number().min(0).max(1).default(0.3) }).prefault({}),
  intensity: z.number().min(0).default(1),
  speed: z.number().default(1),
  seed: z.number().default(3),
  /** How far each ribbon bends towards or away from the viewer along its length. */
  arc: z.number().min(0).max(2).default(0.6),
  /** Depth of the travelling folds (world units). */
  folds: z.number().min(0).default(45),
  /** Ray structure: 0 = smooth glow, 1 = strongly rayed. */
  rays: z.number().min(0).max(1).default(0.75),
  /** Number of ray cycles across a ribbon. */
  rayScale: z.number().min(10).default(110),
  /** Patchiness along the ribbon: 0 = even, 1 = bright sections separated by dark gaps. */
  gaps: z.number().min(0).max(1).default(0.55),
  /** Height fraction over which the bright lower edge fades in (smaller = sharper). */
  edge: z.number().min(0.005).max(0.3).default(0.035),
  /**
   * The world clear wave (since SDK 1.5; 0 = off): when a big clear's front reaches the curtains it
   * runs along them as a surge, brightening the lower edge and rays by `surge` (x their light).
   */
  clearWave: z.object({ surge: z.number().min(0).default(0) }).prefault({}),
});

type Params = z.infer<typeof schema>;

/**
 * Aurora curtains modelled on the real thing: a sharp bright lower edge, vertical rays that drift
 * along the curtain, green light fading up into a faint violet or red top, bright sections with
 * dark gaps between them, and slow folds. A sheet seen edge-on (inside a fold) glows brighter,
 * as a thin emitting layer does. Additive light, attenuated by fog transmittance.
 */
export const auroraComponent: ComponentFactory<Params> = {
  type: 'aurora',
  version: 2,
  description: 'Aurora curtains: sharp lower edge, drifting rays, height colour gradient, folds and gaps.',
  schema,
  create(ctx, p) {
    const rand = seeded(p.seed * 131);
    const segs = ctx.quality.detail === 'low' ? 120 : 260;
    const rows = 6;
    const positions: number[] = [];
    const data: number[] = [];
    const index: number[] = [];
    const deg = Math.PI / 180;
    for (let r = 0; r < p.ribbons; r++) {
      const dist = p.distance[0] + (p.distance[1] - p.distance[0]) * rand();
      const h = p.height[0] + (p.height[1] - p.height[0]) * rand();
      const bend = (rand() - 0.5) * 2 * p.arc;
      const xOff = (rand() - 0.5) * p.width * 0.35;
      const lift = (rand() - 0.5) * p.base * 0.5;
      const altPair = rand() < p.alt.share ? 1 : 0;
      const seed = rand() * 100;
      const centre = (p.azimuth[0] + (p.azimuth[1] - p.azimuth[0]) * (p.ribbons > 1 ? (r + 0.2 + rand() * 0.6) / p.ribbons : 0.5)) * deg;
      const span = p.span ? (p.span[0] + (p.span[1] - p.span[0]) * rand()) * deg : 0;
      const rise = p.rise * (rand() < 0.5 ? -1 : 1) * (0.6 + rand() * 0.4);
      const start = positions.length / 3;
      for (let i = 0; i <= segs; i++) {
        const u = i / segs;
        let x: number;
        let z: number;
        if (span > 0) {
          // Around the viewer; the middle bows closer, so the curtain arcs up across the sky.
          const az = centre + (u - 0.5) * span;
          const d = dist * (1 - p.arc * 0.3 * Math.sin(Math.PI * u)) + Math.sin(u * Math.PI * 1.7 + seed) * dist * 0.05;
          x = Math.sin(az) * d;
          z = -Math.cos(az) * d;
        } else {
          x = xOff + (u - 0.5) * p.width;
          z = -dist - Math.sin(u * Math.PI * 1.2 + seed) * dist * 0.08 - bend * (u - 0.5) * (u - 0.5) * dist * 1.6;
        }
        const y0 = p.base + lift + rise * (u - 0.5);
        for (let j = 0; j <= rows; j++) {
          const v = j / rows;
          positions.push(x, y0 + v * h, z);
          data.push(u, v, seed, altPair);
        }
      }
      for (let i = 0; i < segs; i++) {
        for (let j = 0; j < rows; j++) {
          const a = start + i * (rows + 1) + j;
          const b = a + rows + 1;
          index.push(a, a + 1, b + 1, a, b + 1, b);
        }
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

    // Folds: large slow ones plus smaller ones travelling the other way; the top sways further.
    const foldA = mx_noise_float(vec3(ru.mul(3.2).add(t.mul(0.018)), seed, t.mul(0.012)));
    const foldB = mx_noise_float(vec3(ru.mul(11).sub(t.mul(0.04)), seed.add(3), t.mul(0.03))).mul(0.35);
    const fold = foldA.add(foldB);
    const sway = vec3(foldA.mul(p.folds * 0.35), rv.mul(rv).mul(foldA).mul(10), fold.mul(p.folds).mul(rv.mul(0.5).add(0.75)));
    const displaced = positionLocal.add(sway);
    const material = new MeshBasicNodeMaterial();
    material.positionNode = displaced;
    const world = varying(modelWorldMatrix.mul(vec4(displaced, 1)).xyz);

    // Edge-on parts of the sheet are brighter (longer path through the emitting layer).
    const normal = normalize(cross(dFdx(world), dFdy(world)));
    const facing = abs(dot(normal, normalize(cameraPosition.sub(world))));
    const edgeOn = mix(float(1), float(2.4), clamp(float(1).sub(facing), 0, 1).pow(3));

    // Rays: a few octaves of noise across the ribbon only (slightly sheared), so they stay vertical.
    const rayU = ru.mul(p.rayScale).add(rv.mul(0.8));
    const rayA = mx_noise_float(vec3(rayU.add(t.mul(0.22)), seed, t.mul(0.08))).mul(0.5).add(0.5);
    const rayB = mx_noise_float(vec3(rayU.mul(2.6).sub(t.mul(0.35)), seed.add(9), t.mul(0.15))).mul(0.5).add(0.5);
    // Broad soft rays with finer ones riding on them, so spacing and width vary.
    const rayField = clamp(rayA.mul(0.75).add(rayB.mul(0.4)), 0, 1).pow(2.2).mul(2);
    const rayed = smoothstep(0.25, 0.7, mx_noise_float(vec3(ru.mul(5).add(t.mul(0.01)), seed.add(40), 0)).mul(0.5).add(0.5));
    const rays = mix(float(1), rayField, rayed.mul(p.rays));

    // Bright sections with gaps between them, drifting slowly.
    const patch = smoothstep(0.3, 0.75, mx_fractal_noise_float(vec3(ru.mul(2.4).add(t.mul(0.008)), seed.add(20), t.mul(0.01)), 3, 2, 0.5).mul(0.5).add(0.5));
    const along = mix(float(1), patch, p.gaps).mul(smoothstep(0, 0.1, ru)).mul(smoothstep(1, 0.9, ru));

    // Height profile: ragged sharp lower edge with a bright rim, green decaying upwards, and a
    // faint high band in the upper colour.
    // The lower edge follows smooth folds (a ragged edge would read as a mountain ridge).
    const edgeAt = mx_noise_float(vec3(ru.mul(6).add(t.mul(0.03)), seed.add(30), 0)).mul(0.035).add(0.04);
    const lower = smoothstep(edgeAt, edgeAt.add(p.edge), rv);
    const rim = exp(abs(rv.sub(edgeAt).sub(p.edge)).mul(-1.6 / p.edge)).mul(0.6);
    const green = exp(rv.sub(edgeAt).max(0).mul(-4.2));
    const upper = smoothstep(0.3, 0.6, rv).mul(smoothstep(1, 0.72, rv)).mul(0.16);
    const profile = lower.mul(green.add(rim).add(upper));

    const lowC = mix(colorUniform(p.low), colorUniform(p.alt.low), rib.w);
    const highC = mix(colorUniform(p.high), colorUniform(p.alt.high), rib.w);
    // The densest emission at the lower edge reads paler, close to white-green.
    const color = mix(mix(lowC, lowC.mul(0.55).add(0.45), rim.mul(0.6)), highC, smoothstep(0.2, 0.65, rv));
    const breathe = sin(ru.mul(7).sub(t.mul(0.3)).add(seed)).mul(0.15).add(0.85);
    // A surge where the clear front crosses the curtain: strongest at the lower edge, carried up the rays.
    const surge = p.clearWave.surge > 0 ? float(1).add(clearFront(world).mul(p.clearWave.surge).mul(lower.mul(rim.add(0.6)).mul(rays.mul(0.5).add(0.5)))) : float(1);
    const light = color.mul(profile).mul(rays).mul(along).mul(edgeOn).mul(breathe).mul(surge).mul(u.intensity).mul(u.presence).mul(0.42);
    material.colorNode = vec4(additiveFog(light), 1);
    material.transparent = true;
    material.depthWrite = false;
    material.blending = AdditiveBlending;
    material.side = DoubleSide;
    material.fog = false;
    material.mrtNode = mrt({ emissive: vec4(light.mul(0.35), 1) });
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
