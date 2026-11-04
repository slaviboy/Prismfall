import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import { attribute, clamp, exp, float, mix, mx_fractal_noise_float, mx_noise_float, smoothstep, vec3, vec4 } from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { noBloom } from '../../shaders/uniforms';
import { clearFront } from '../../shaders/clearFront';
import { colorUniform, floatUniform, seeded, zColor } from './common';

const layerSchema = z.object({
  /** Distance from the viewer (world units). */
  distance: z.number().positive(),
  /** Height of the highest peaks above `base`. */
  height: z.number().positive(),
  /** Elevation of the mountain foot. */
  base: z.number().default(-15),
  /** Peak frequency (higher = more, narrower peaks). */
  scale: z.number().positive().default(1),
  /** 0 = rounded hills, 1 = jagged alpine ridges. */
  roughness: z.number().min(0).max(1).default(0.6),
  seed: z.number().default(1),
  rock: zColor.default('#05080c'),
  snow: zColor.default('#5a6e82'),
  /** Share of the face covered by snow, more of it higher up. */
  snowAmount: z.number().min(0).max(1).default(0.5),
  /** Blend towards the haze colour (aerial perspective for far layers). */
  haze: z.number().min(0).max(1).default(0),
  /** Light catching the ridge line, in the rim colour. */
  rim: z.number().min(0).default(0),
});

const schema = z.object({
  layers: z.array(layerSchema).min(1).max(6),
  /** Azimuth range in degrees (0 = straight ahead, negative = left). */
  span: z.tuple([z.number(), z.number()]).default([-110, 110]),
  hazeColor: zColor.default('#0b1822'),
  rimColor: zColor.default('#7fffc8'),
  /** Side light from the ridge slopes: side -1 = light from the left, 1 = from the right. */
  light: z.object({ side: z.number().min(-1).max(1).default(-1), strength: z.number().min(0).max(1).default(0.35) }).prefault({}),
  /**
   * The world clear wave (since SDK 1.5; 0 = off): when a big clear's front reaches the ranges it
   * catches their snowfields by `sheen`, in `color` (default `rimColor`), less through haze.
   */
  clearWave: z.object({ sheen: z.number().min(0).default(0), color: zColor.optional() }).prefault({}),
});

type Params = z.infer<typeof schema>;

/** Smooth 1D value noise with a seeded lattice. */
function noise1(seed: number): (x: number) => number {
  const rand = seeded(seed);
  const lattice = Array.from({ length: 512 }, () => rand() * 2 - 1);
  return (x) => {
    const i = Math.floor(x);
    const f = x - i;
    const a = lattice[((i % 512) + 512) % 512] as number;
    const b = lattice[(((i + 1) % 512) + 512) % 512] as number;
    const s = f * f * (3 - 2 * f);
    return a + (b - a) * s;
  };
}

/** Ridge profile in 0..1: ridged octaves (sharp crests) blended with smooth ones. */
function profile(seed: number, roughness: number): (x: number) => number {
  const n = noise1(seed);
  return (x) => {
    let ridged = 0;
    let smooth = 0;
    let amp = 0.5;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < 6; o++) {
      const v = n(x * freq + o * 17.3);
      ridged += (1 - Math.abs(v)) ** 2 * amp;
      smooth += (v * 0.5 + 0.5) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return Math.max(0, Math.min(1, ((ridged * roughness + smooth * (1 - roughness)) / norm - 0.25) / 0.6));
  };
}

/**
 * Distant mountain ranges as layered silhouettes around the viewer, like the depth planes of a
 * matte painting: dark rock with snowfields that catch a little sky light, gullies, an optional
 * lit ridge line, and haze that lifts the far layers. Seen in water reflections like any geometry.
 */
export const ridgesComponent: ComponentFactory<Params> = {
  type: 'ridges',
  version: 1,
  description: 'Layered mountain silhouettes with snowfields, gullies, ridge light and aerial haze.',
  schema,
  create(ctx, p) {
    const group = new Group();
    const presence = floatUniform(1);
    const haze = colorUniform(p.hazeColor);
    const rimColor = colorUniform(p.rimColor);
    const segs = ctx.quality.detail === 'low' ? 360 : 900;
    const a0 = (p.span[0] * Math.PI) / 180;
    const a1 = (p.span[1] * Math.PI) / 180;
    const materials: MeshBasicNodeMaterial[] = [];
    p.layers.forEach((layer, li) => {
      const ridge = profile(layer.seed * 977 + li * 31, layer.roughness);
      const positions: number[] = [];
      const info: number[] = [];
      const index: number[] = [];
      const span = (a1 - a0) * layer.distance;
      // Feature size in world units, so near and far layers get comparable peak spacing. The raw
      // profile is stretched to its own range so the highest peak reaches `height`, and a broad
      // envelope groups the peaks into massifs with saddles between them.
      const envelope = noise1(layer.seed * 131 + li);
      const raw = Array.from({ length: segs + 1 }, (_, i) => {
        const x = ((i / segs) * span * layer.scale) / 260;
        return ridge(x) * (0.55 + 0.45 * (envelope(x * 0.22) * 0.5 + 0.5));
      });
      const lo = Math.min(...raw);
      const hi = Math.max(...raw);
      const heights = raw.map((r) => Math.pow((r - lo) / Math.max(1e-6, hi - lo), 1.35) * layer.height + 2);
      // Silhouette slope, smoothed over a few columns: where the ridge line rises towards the
      // light, the face below it turns towards the light.
      const dx = ((a1 - a0) * layer.distance) / segs;
      const facingCols = heights.map((_, i) => {
        const k = 9;
        const l = heights[Math.max(0, i - k)] as number;
        const r = heights[Math.min(segs, i + k)] as number;
        return Math.max(-1, Math.min(1, ((r - l) / (2 * k * dx)) * -p.light.side * 1.4));
      });
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const az = a0 + (a1 - a0) * t;
        const h = heights[i] as number;
        const x = Math.sin(az) * layer.distance;
        const z = -Math.cos(az) * layer.distance;
        positions.push(x, layer.base - 60, z, x, layer.base + h, z);
        info.push(t, -60, h, facingCols[i] as number, t, h, h, facingCols[i] as number);
      }
      // Counter-clockwise as seen from the viewer at the centre of the ring (front faces).
      for (let i = 0; i < segs; i++) {
        const a = i * 2;
        index.push(a, a + 3, a + 1, a, a + 2, a + 3);
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
      geometry.setAttribute('ridge', new BufferAttribute(new Float32Array(info), 4));
      geometry.setIndex(index);
      geometry.computeBoundingSphere();

      const r = attribute<'vec4'>('ridge', 'vec4');
      const along = r.x.mul(span * layer.scale);
      const y = r.y;
      const top = r.z.max(0.001);
      const rel = clamp(y.div(top), 0, 1);
      // Gullies and ribs run down the faces (noise stretched vertically); snow lies higher up and
      // between the ribs, rock shows on the ribs and lower down.
      const ribs = mx_fractal_noise_float(vec3(along.mul(0.22), y.mul(0.012), layer.seed), 4, 2.1, 0.5);
      const fine = mx_noise_float(vec3(along.mul(0.9), y.mul(0.05), layer.seed + 7));
      const snowline = float(1).sub(layer.snowAmount).mul(0.9);
      const snowMask = smoothstep(0.42, 0.58, rel.add(ribs.mul(0.38)).add(fine.mul(0.08)).sub(snowline).add(0.25));
      // Side light from the silhouette slope, plus a little facet variation along the range.
      const facing = r.w;
      const sun = float(1).add(facing.mul(p.light.strength)).mul(mx_noise_float(vec3(along.mul(0.03), layer.seed + 3, 0)).mul(0.12).add(0.94));
      const footShade = smoothstep(-10, top.mul(0.5), y).mul(0.5).add(0.5);
      let color = mix(colorUniform(layer.rock), colorUniform(layer.snow), snowMask).mul(sun).mul(footShade);
      if (layer.rim > 0) color = color.add(rimColor.mul(exp(top.sub(y).mul(-0.45)).mul(layer.rim)));
      color = mix(color, haze, layer.haze * 1);
      if (p.clearWave.sheen > 0) {
        const catchLight = snowMask.mul(0.75).add(0.12).mul(1 - layer.haze * 0.6);
        color = color.add(colorUniform(p.clearWave.color ?? p.rimColor).mul(clearFront().mul(catchLight).mul(p.clearWave.sheen * 0.3)));
      }
      const material = new MeshBasicNodeMaterial();
      material.colorNode = vec4(color.mul(presence), 1);
      material.fog = false;
      noBloom(material);
      materials.push(material);
      const mesh = new Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = -12 + li;
      group.add(mesh);
    });
    return {
      object: group,
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        group.traverse((o) => (o as Mesh).geometry?.dispose());
        for (const m of materials) m.dispose();
      },
    };
  },
};
