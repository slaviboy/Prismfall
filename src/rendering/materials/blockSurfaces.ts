import {
  abs,
  clamp,
  dot,
  float,
  floor,
  fract,
  length,
  max,
  mix,
  mx_cell_noise_float,
  mx_fractal_noise_float,
  mx_noise_float,
  mx_worley_noise_float,
  mx_worley_noise_vec2,
  sin,
  smoothstep,
  step,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';

/**
 * Procedural block surfaces for stage block themes. Every surface keeps the piece colour as its
 * identity (tint, glow or crack colour), so the seven pieces stay distinguishable in any theme.
 */
export const BLOCK_SURFACES = ['plain', 'wood', 'ice', 'sandstone', 'obsidian', 'emerald', 'cosmic', 'aquatic', 'neon', 'mineral', 'aurora', 'paper'] as const;
export type BlockSurface = (typeof BLOCK_SURFACES)[number];

type F = Node<'float'>;
type V3 = Node<'vec3'>;

export interface SurfaceInputs {
  /** Position in the block's own geometry space (about ±0.47). */
  readonly p: V3;
  /** Stable per-cell offset (different blocks get different patterns). */
  readonly seed: V3;
  /** Piece colour (linear). */
  readonly base: V3;
  /** View alignment (1 facing the camera). */
  readonly ndv: F;
  /** Bevel edge mask (1 on edges). */
  readonly edge: F;
  readonly time: F;
  /** Music energy for living details (0..1, already scaled by reactivity). */
  readonly music: F;
}

export interface SurfaceOutputs {
  readonly albedo: V3;
  readonly emissive: V3;
  readonly roughness: F | null;
}

const cast = <T>(n: unknown): T => n as T;

/** Builds the TSL nodes for one surface kind. */
export function buildSurface(kind: BlockSurface, i: SurfaceInputs): SurfaceOutputs {
  const { p, seed, base, ndv, edge, time, music } = i;
  const q = p.add(seed.mul(7.31));
  const zero = cast<V3>(vec3(0, 0, 0));
  switch (kind) {
    case 'wood': {
      // Rings around the grain axis, fine fibres, a carved inset line and darker worn edges.
      const warp = mx_noise_float(q.mul(vec3(0.7, 2.2, 2.2))).mul(0.45);
      const r = length(q.yz.mul(vec3(5.5, 4.2, 0).xy)).add(warp);
      const ring = fract(r.mul(3.1));
      const rings = smoothstep(0.0, 0.18, ring).mul(smoothstep(1.0, 0.55, ring));
      const fibre = mx_noise_float(q.mul(vec3(2.5, 46, 46))).mul(0.5).add(0.5);
      const front = max(abs(p.x), abs(p.y));
      const groove = smoothstep(0.012, 0.0, abs(front.sub(0.355))).mul(step(0.43, abs(p.z)));
      // Knots: a few darker swirls per block.
      const knot = smoothstep(0.85, 1.0, mx_worley_noise_float(q.mul(vec3(1.2, 2.4, 2.4)))).mul(0.35);
      const tone = mix(float(0.42), float(1.18), rings.mul(0.6).add(fibre.mul(0.4))).mul(float(1).sub(knot));
      const albedo = base.mul(tone).mul(1.15).mul(mix(float(1), float(0.6), edge)).mul(float(1).sub(groove.mul(0.5)));
      return { albedo: cast<V3>(albedo), emissive: zero, roughness: cast<F>(float(0.58).sub(rings.mul(0.16))) };
    }
    case 'ice': {
      // Frosted patches, internal fracture planes lit from within, frozen pale edges.
      const frost = mx_fractal_noise_float(q.mul(5.5), 3, 2, 0.5).mul(0.5).add(0.5);
      const cells = mx_worley_noise_vec2(q.mul(3.6));
      const crack = smoothstep(0.07, 0.0, cells.y.sub(cells.x));
      const albedo = base.mul(0.38).add(vec3(0.55, 0.72, 0.85).mul(frost.mul(0.22))).add(vec3(0.75, 0.88, 1).mul(edge.mul(0.25)));
      const emissive = base.mul(ndv.pow(2).mul(0.2)).add(vec3(0.55, 0.85, 1).mul(crack.mul(0.32)));
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(emissive), roughness: cast<F>(mix(float(0.08), float(0.55), frost)) };
    }
    case 'sandstone': {
      // Wind-laid strata, fine grain, eroded pits and the odd golden glint.
      const strata = sin(q.y.mul(26).add(mx_noise_float(q.mul(2)).mul(3))).mul(0.5).add(0.5);
      const grain = mx_noise_float(q.mul(48)).mul(0.5).add(0.5);
      const grit = mx_cell_noise_float(floor(q.mul(110)));
      const pits = smoothstep(0.66, 1.0, mx_worley_noise_float(q.mul(4.5)));
      const albedo = base
        .mul(float(0.68).add(strata.mul(0.3)))
        .mul(float(0.78).add(grain.mul(0.3)).add(grit.mul(0.12)))
        .mul(float(1).sub(pits.mul(0.45)))
        .mul(mix(float(1), float(0.72), edge));
      const glint = step(0.986, mx_cell_noise_float(floor(q.mul(70)))).mul(sin(time.mul(2.5).add(mx_cell_noise_float(floor(q.mul(70))).mul(40))).mul(0.5).add(0.5));
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(vec3(1, 0.78, 0.35).mul(glint.mul(0.55))), roughness: cast<F>(float(0.86)) };
    }
    case 'obsidian': {
      // Black volcanic glass; cracks glow in the piece colour and breathe with the music.
      const w = mx_worley_noise_vec2(q.mul(3.1));
      const w2 = mx_worley_noise_vec2(q.mul(7.3).add(2.1));
      const crack = max(smoothstep(0.06, 0.0, w.y.sub(w.x)), smoothstep(0.035, 0.0, w2.y.sub(w2.x)).mul(0.55));
      const albedo = base.mul(0.1).add(0.015);
      const emissive = base.mul(crack.mul(float(0.9).add(music.mul(0.5)))).add(base.mul(0.03));
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(emissive), roughness: cast<F>(float(0.1)) };
    }
    case 'emerald': {
      // Faceted crystal: per-facet brightness, organic veins, a soft inner light.
      const facetId = mx_cell_noise_float(floor(q.mul(3.2)));
      const veins = smoothstep(0.08, 0.0, abs(mx_noise_float(q.mul(4)).sub(0.1)));
      const albedo = base.mul(float(0.55).add(facetId.mul(0.4))).add(base.mul(veins.mul(0.25)));
      const emissive = base.mul(ndv.pow(2.5).mul(0.16)).add(base.mul(veins.mul(0.12)));
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(emissive), roughness: cast<F>(float(0.12)) };
    }
    case 'cosmic': {
      // Deep space inside each block: drifting nebula in the piece colour and twinkling stars.
      const neb = mx_fractal_noise_float(q.mul(2.4).add(vec3(0, 0, time.mul(0.03))), 4, 2, 0.55).mul(0.5).add(0.5);
      const cell = floor(q.mul(52));
      const star = step(0.993, mx_cell_noise_float(cell)).mul(sin(time.mul(3).add(mx_cell_noise_float(cell.add(3)).mul(50))).mul(0.4).add(0.6));
      const albedo = base.mul(0.08);
      const emissive = base.mul(neb.pow(2).mul(0.32)).add(vec3(0.9, 0.95, 1).mul(star.mul(0.9)));
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(emissive), roughness: cast<F>(float(0.08)) };
    }
    case 'aquatic': {
      // Glassy water with bubbles rising inside and a slow caustic shimmer.
      const bq = q.mul(8).add(vec3(0, time.mul(0.55), 0));
      const f1 = mx_worley_noise_float(bq);
      const bubble = smoothstep(0.11, 0.08, f1).sub(smoothstep(0.075, 0.045, f1));
      const caustic = mx_worley_noise_float(q.mul(3.5).add(vec3(time.mul(0.25), 0, time.mul(0.2)))).pow(3);
      const albedo = base.mul(0.42);
      const emissive = base.mul(ndv.pow(2).mul(0.14)).add(vec3(0.75, 0.95, 1).mul(clamp(bubble, 0, 1).mul(0.45))).add(base.mul(caustic.mul(0.18)));
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(emissive), roughness: cast<F>(float(0.06)) };
    }
    case 'neon': {
      // Dark smoked glass with fine lit grid lines in the piece colour.
      const g = vec3(abs(sin(q.x.mul(Math.PI * 4))), abs(sin(q.y.mul(Math.PI * 4))), abs(sin(q.z.mul(Math.PI * 4))));
      const lines = smoothstep(0.985, 1.0, max(g.x, max(g.y, g.z)));
      return { albedo: cast<V3>(base.mul(0.07)), emissive: cast<V3>(base.mul(lines.mul(0.45).add(0.02))), roughness: cast<F>(float(0.14)) };
    }
    case 'mineral': {
      // Polished stone with flowing veins.
      const veinField = abs(sin(q.x.mul(3).add(mx_fractal_noise_float(q.mul(1.8), 4, 2, 0.5).mul(4))));
      const vein = smoothstep(0.16, 0.0, veinField);
      const speck = mx_noise_float(q.mul(30)).mul(0.5).add(0.5);
      const albedo = base.mul(float(0.7).add(speck.mul(0.18))).add(vec3(0.85, 0.85, 0.9).mul(vein.mul(0.22)));
      return { albedo: cast<V3>(albedo), emissive: zero, roughness: cast<F>(mix(float(0.22), float(0.4), speck)) };
    }
    case 'aurora': {
      // Translucent crystal whose inner light drifts between the piece colour and a cooler hue.
      const band = sin(p.y.mul(3.2).add(p.x.mul(1.3)).add(time.mul(0.5)).add(seed.x.mul(5))).mul(0.5).add(0.5);
      const cool = vec3(dot(base, vec3(0.2, 0.3, 0.5)), dot(base, vec3(0.3, 0.6, 0.4)), dot(base, vec3(0.5, 0.4, 0.8)));
      const albedo = base.mul(0.3);
      const emissive = mix(base, cool, band).mul(ndv.pow(1.5).mul(0.24));
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(emissive), roughness: cast<F>(float(0.1)) };
    }
    case 'paper': {
      // Washi: soft fibres and a faint deckled edge.
      const fibres = mx_noise_float(q.mul(vec3(40, 6, 40))).mul(0.5).add(0.5);
      const albedo = base.mul(float(0.86).add(fibres.mul(0.12))).mul(mix(float(1), float(0.88), edge));
      return { albedo: cast<V3>(albedo), emissive: zero, roughness: cast<F>(float(0.95)) };
    }
    default:
      return { albedo: base, emissive: zero, roughness: null };
  }
}
