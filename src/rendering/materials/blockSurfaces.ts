import {
  abs,
  atan,
  clamp,
  cos,
  dot,
  float,
  floor,
  fract,
  length,
  max,
  min,
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
export const BLOCK_SURFACES = ['plain', 'wood', 'ice', 'sandstone', 'obsidian', 'emerald', 'cosmic', 'aquatic', 'neon', 'mineral', 'aurora', 'paper', 'lumen', 'dichroic', 'ingot', 'ribbon', 'gel', 'rosette', 'marble', 'lantern', 'basalt', 'veil', 'jade', 'machined', 'frontier', 'storm'] as const;
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
const HALF = 0.47;
const LUMA = vec3(0.2126, 0.7152, 0.0722);

/** Coordinates on the block face this point belongs to (the axis of its largest component). */
function faceUV(p: V3): Node<'vec2'> {
  const a = abs(p);
  const onZ = step(max(a.x, a.y), a.z);
  const onY = step(max(a.x, a.z), a.y).mul(onZ.oneMinus());
  return cast<Node<'vec2'>>(mix(mix(p.yz, p.xz, onY), p.xy, onZ));
}

/** Distance from the face border (0 on the block's edges, HALF at a face centre). */
function borderDistance(p: V3): F {
  const a = abs(p);
  const m1 = max(a.x, max(a.y, a.z));
  const mn = min(a.x, min(a.y, a.z));
  return cast<F>(float(HALF).sub(a.x.add(a.y).add(a.z).sub(m1).sub(mn)));
}

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
    case 'lumen': {
      // Dark smoked tile with one crisp lit line inset around every face, like a lit glass edge.
      const d = borderDistance(p);
      const line = smoothstep(0.026, 0.01, abs(d.sub(0.06)));
      const fill = smoothstep(0.08, 0.22, d).mul(ndv.pow(2)).mul(0.06);
      const albedo = base.mul(0.05).add(0.004);
      const emissive = base.mul(line.mul(float(1.7).add(music.mul(0.4)))).add(base.mul(fill));
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(emissive), roughness: cast<F>(float(0.16)) };
    }
    case 'dichroic': {
      // Dichroic glass: a thin-film sheen that shifts hue with the viewing angle over the piece colour.
      // The coating's thickness varies across the glass (soft swirls), and the hue also shifts with angle.
      const thickness = mx_fractal_noise_float(q.mul(1.25), 3, 2, 0.5).mul(0.75);
      const film = ndv.mul(1.3).add(thickness).add(seed.x.mul(0.13));
      const tau = Math.PI * 2;
      const rainbow = vec3(cos(film.mul(tau)), cos(film.mul(tau).sub(2.094)), cos(film.mul(tau).sub(4.189))).mul(0.5).add(0.5);
      const sheen = ndv.oneMinus().pow(1.4).mul(0.6).add(0.28);
      const albedo = mix(base.mul(0.34), rainbow.mul(dot(base, LUMA).mul(0.45).add(0.2)), sheen.mul(0.6));
      const emissive = base.mul(ndv.pow(2.2).mul(0.1)).add(rainbow.mul(sheen.mul(0.07)));
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(emissive), roughness: cast<F>(float(0.05)) };
    }
    case 'ingot': {
      // Polished, anodised metal in the piece colour: a brushed grain and an engraved inset panel.
      const d = borderDistance(p);
      const groove = smoothstep(0.012, 0.0, abs(d.sub(0.085)));
      const brushed = mx_noise_float(q.mul(vec3(2.5, 90, 90))).mul(0.5).add(0.5);
      const metal = mix(base, vec3(dot(base, LUMA)), 0.15).mul(0.92).add(0.05);
      const albedo = metal.mul(float(1).sub(groove.mul(0.55))).mul(float(0.92).add(brushed.mul(0.08)));
      return { albedo: cast<V3>(albedo), emissive: zero, roughness: cast<F>(float(0.16).add(brushed.mul(0.12)).add(groove.mul(0.3))) };
    }
    case 'ribbon': {
      // Candy glass with diagonal ribbons: deep bands of colour between clear, brighter glass.
      const s = fract(p.x.add(p.y).add(p.z.mul(0.5)).mul(3.4));
      const band = smoothstep(0.02, 0.06, s).mul(smoothstep(0.52, 0.48, s));
      const albedo = mix(base.mul(1.05).add(0.06), base.mul(0.4), band);
      const emissive = base.mul(ndv.pow(2).mul(mix(float(0.12), float(0.05), band)));
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(emissive), roughness: cast<F>(mix(float(0.06), float(0.12), band)) };
    }
    case 'gel': {
      // Jelly: deep colour, light scattering out of the edges, a darker core and a few suspended bubbles.
      // Light travels further through the jelly at grazing angles: bright edges, a deep centre.
      const scatter = ndv.oneMinus().pow(2);
      const depth = ndv.pow(3);
      const f1 = mx_worley_noise_float(q.mul(6.5));
      const bubble = smoothstep(0.075, 0.055, f1).sub(smoothstep(0.045, 0.02, f1));
      const albedo = base.mul(mix(float(0.3), float(0.14), depth));
      const emissive = base.mul(scatter.mul(0.55).add(0.03)).add(base.mul(0.5).add(0.25).mul(clamp(bubble, 0, 1).mul(0.22)));
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(emissive), roughness: cast<F>(float(0.04)) };
    }
    case 'rosette': {
      // Lacquered tile with a gilded eight-petal rosette pressed into each face.
      const uv = faceUV(p);
      const r = length(uv);
      const ang = atan(uv.y, uv.x);
      const edgeR = float(0.24).add(cos(ang.mul(8)).mul(0.045));
      const petal = smoothstep(edgeR.add(0.008), edgeR.sub(0.008), r);
      const outline = smoothstep(0.012, 0.0, abs(r.sub(edgeR)));
      const centre = smoothstep(0.075, 0.06, r);
      const veins = smoothstep(0.08, 0.0, abs(sin(ang.mul(8)))).mul(petal).mul(smoothstep(0.07, 0.12, r)).mul(0.3);
      const gold = mix(base, vec3(1, 0.82, 0.45), 0.55).mul(1.05);
      const lacquer = base.mul(0.78).mul(mix(float(1), float(0.82), edge));
      const gild = petal.sub(centre.mul(0.9)).clamp(0, 1);
      const albedo = mix(lacquer, gold.mul(float(1).sub(veins)), gild).mul(float(1).sub(outline.mul(0.5))).add(base.mul(centre.mul(0.12)));
      return { albedo: cast<V3>(albedo), emissive: zero, roughness: cast<F>(mix(float(0.42), float(0.2), petal)) };
    }
    case 'marble': {
      // A glass marble: clear tinted glass around a twisted ribbon of colour.
      const twist = sin(atan(p.z, p.x).mul(2).add(p.y.mul(7)).add(seed.x.mul(3.1)).add(mx_noise_float(q.mul(2)).mul(1.2)));
      const ribbon = smoothstep(0.55, 0.9, twist).mul(smoothstep(0.42, 0.15, length(p.xz)));
      const albedo = mix(base.mul(0.22), base.mul(0.95).add(0.08), ribbon);
      const emissive = base.mul(ndv.pow(2.5).mul(0.14)).add(base.mul(ribbon.mul(0.06)));
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(emissive), roughness: cast<F>(float(0.03)) };
    }
    case 'lantern': {
      // A paper lantern: thin paper on bamboo ribs, lit warmly from inside; the light breathes with the music.
      const rib = smoothstep(0.05, 0.02, abs(fract(p.y.mul(3.2).add(0.5)).sub(0.5)));
      const fibres = mx_noise_float(q.mul(vec3(30, 8, 30))).mul(0.5).add(0.5);
      const warm = mix(base, vec3(1, 0.8, 0.55), 0.35);
      const albedo = mix(base.mul(0.62).add(0.05), vec3(0.08, 0.05, 0.03), rib).mul(mix(float(1), float(0.6), edge));
      // Lit from a flame inside: brightest in the middle of each face, dim towards the frame.
      const centre = smoothstep(0.03, 0.32, borderDistance(p));
      const light = ndv.pow(2).mul(centre).mul(float(0.36).add(music.mul(0.08))).mul(float(0.82).add(fibres.mul(0.18))).mul(rib.oneMinus());
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(warm.mul(light)), roughness: cast<F>(float(0.88)) };
    }
    case 'basalt': {
      // Dark volcanic stone in the piece colour: fine grain and mottling, a few hairline cracks lit
      // by molten energy (the piece colour heated towards orange), iron-dark bevels that catch
      // reflections. The stone tint keeps the seven pieces apart.
      const grain = mx_noise_float(q.mul(14)).mul(0.5).add(0.5);
      const mottle = mx_fractal_noise_float(q.mul(2.2), 3, 2, 0.5).mul(0.5).add(0.5);
      const cells = mx_worley_noise_vec2(q.mul(2.6));
      const reach = smoothstep(0.3, 0.65, mx_noise_float(q.mul(1.3).add(5.1)).mul(0.5).add(0.5));
      const crack = smoothstep(0.045, 0.0, cells.y.sub(cells.x)).mul(reach).mul(edge.oneMinus());
      const stone = base.mul(float(0.36).add(mottle.mul(0.14)).add(grain.mul(0.06)));
      const iron = vec3(0.09, 0.08, 0.075).add(base.mul(0.06));
      const albedo = mix(stone, iron, edge.mul(0.7)).mul(float(1).sub(crack.mul(0.5)));
      const heat = mix(base, vec3(1.0, 0.36, 0.1), 0.45);
      const emissive = heat.mul(crack.mul(float(0.5).add(music.mul(0.3)))).add(base.mul(ndv.pow(2.5).mul(0.03)));
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(emissive), roughness: cast<F>(mix(float(0.34).add(grain.mul(0.12)), float(0.2), edge)) };
    }
    case 'veil': {
      // Smoked glass holding a slow drift of mist: charcoal and blue-grey glass tinted by the
      // piece colour, frosted faces with a faint inner light where the mist thickens, and one fine
      // lit line just inside every edge. Dense enough that the seven colours stay apart.
      const drift = vec3(time.mul(0.021), time.mul(0.034), time.mul(-0.017));
      const mist = mx_fractal_noise_float(q.mul(1.7).add(drift), 3, 2, 0.5).mul(0.5).add(0.5);
      const d = borderDistance(p);
      const core = smoothstep(0.03, 0.3, d);
      const tint = mix(vec3(dot(base, LUMA)), base, 0.9);
      const smoke = vec3(0.03, 0.036, 0.046);
      const albedo = mix(smoke, tint.mul(0.46), float(0.58).add(mist.mul(0.22))).mul(mix(float(1), float(0.72), edge));
      const line = smoothstep(0.022, 0.006, abs(d.sub(0.034)));
      const inner = tint.mul(mist.mul(core).mul(ndv.pow(1.6)).mul(float(0.16).add(music.mul(0.05))));
      const emissive = tint.mul(line.mul(0.42)).add(inner);
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(emissive), roughness: cast<F>(mix(float(0.3).sub(mist.mul(0.06)), float(0.07), edge)) };
    }
    case 'jade': {
      // Carved jade (The Lost Kingdom): polished stone in the piece colour with cloudy mineral
      // mottling and fine fibrous grain, a carved inset border around each face with a thin gold
      // inlay in the groove, small stepped-fret notches at the corners, a faint translucent inner
      // light and fine pitting. The colour stays saturated so the seven pieces read apart.
      const uv = faceUV(p);
      const d = borderDistance(p);
      const cloud = mx_fractal_noise_float(q.mul(2.4), 4, 2, 0.55).mul(0.5).add(0.5);
      const fibre = mx_noise_float(q.mul(vec3(26, 7, 26))).mul(0.5).add(0.5);
      const pits = smoothstep(0.8, 1.0, mx_worley_noise_float(q.mul(9.0))).mul(0.35);
      const groove = smoothstep(0.016, 0.004, abs(d.sub(0.07)));
      const inlay = smoothstep(0.007, 0.0, abs(d.sub(0.07)));
      const corner = max(abs(uv.x), abs(uv.y));
      const fret = step(0.29, min(abs(uv.x), abs(uv.y))).mul(step(corner, 0.36)).mul(step(0.3, corner));
      const stone = base.mul(float(0.52).add(cloud.mul(0.34)).add(fibre.mul(0.08))).mul(float(1).sub(pits));
      const carved = stone.mul(float(1).sub(groove.mul(0.45)).sub(fret.mul(0.3)));
      const gold = vec3(0.82, 0.6, 0.26);
      const albedo = mix(carved, gold, inlay.mul(0.75)).mul(mix(float(1), float(0.78), edge));
      const glow = base.mul(ndv.pow(2.2).mul(smoothstep(0.05, 0.3, d)).mul(cloud.mul(0.06).add(0.03).add(music.mul(0.02))));
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(glow), roughness: cast<F>(mix(float(0.18).add(fibre.mul(0.08)), float(0.42), groove.max(pits))) };
    }
    case 'machined': {
      // Machined gunmetal (Red Horizon): an anodised face plate in the piece colour carrying
      // fly-cut tool arcs and a brushed grain, bright bare-metal chamfers, an engraved groove with a
      // fine red-lit line, a small indicator lamp in one corner and the odd fine scratch. Dark
      // metal, but the colour stays saturated so the seven pieces read apart.
      const uv = faceUV(p);
      const d = borderDistance(p);
      const arcs = sin(length(uv.sub(0.95)).mul(330)).mul(0.5).add(0.5);
      const brushed = mx_noise_float(q.mul(vec3(2.2, 70, 70))).mul(0.5).add(0.5);
      const scratch = smoothstep(0.86, 0.95, mx_noise_float(q.mul(vec3(36, 2.5, 36)).add(seed.mul(3.3)))).mul(0.6);
      const groove = smoothstep(0.014, 0.005, abs(d.sub(0.088)));
      const line = smoothstep(0.006, 0.0015, abs(d.sub(0.088)));
      const lampD = length(uv.sub(0.29));
      const lamp = smoothstep(0.03, 0.017, lampD);
      const bezel = smoothstep(0.05, 0.036, lampD).sub(lamp).max(0);
      const plate = mix(base, vec3(dot(base, LUMA)), 0.2).mul(0.6).add(0.025);
      const bare = vec3(0.34, 0.34, 0.36).add(base.mul(0.08));
      const face = plate.mul(float(0.9).add(arcs.mul(0.06)).add(brushed.mul(0.06))).add(scratch.mul(0.08));
      const albedo = mix(face, bare, edge.mul(0.85)).mul(float(1).sub(groove.mul(0.7)).sub(bezel.mul(0.6)));
      const red = mix(base, vec3(1, 0.1, 0.04), 0.6);
      const emissive = red.mul(line.mul(float(0.42).add(music.mul(0.12)))).add(mix(base, vec3(1, 0.95, 0.9), 0.35).mul(lamp.mul(0.9)));
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(emissive), roughness: cast<F>(mix(float(0.24).add(brushed.mul(0.1)).add(scratch.mul(0.1)), float(0.14), edge).add(groove.mul(0.3))) };
    }
    case 'frontier': {
      // Frontier timber (The Last Frontier): weathered oak planks painted in the piece colour, two
      // boards per face with a seam, open grain and the odd knot, paint worn back to bare wood on
      // the arrises, forged-iron corner straps with brass rivet heads. No glow: lit like the town.
      const uv = faceUV(p);
      const d = borderDistance(p);
      const board = fract(uv.y.mul(2.13).add(0.5));
      const seam = smoothstep(0.04, 0.0, min(board, float(1).sub(board)));
      const grain = mx_noise_float(q.mul(vec3(3, 3, 3)).add(vec3(uv.x.mul(1.5), uv.y.mul(38), 0))).mul(0.5).add(0.5);
      const fibre = mx_noise_float(vec3(uv.x.mul(4), uv.y.mul(90), seed.x.mul(9))).mul(0.5).add(0.5);
      const knot = smoothstep(0.9, 1.0, mx_worley_noise_float(q.mul(2.2))).mul(0.4);
      const wear = smoothstep(0.7, 0.86, mx_fractal_noise_float(q.mul(4.5), 3, 2, 0.5).mul(0.5).add(0.5).mul(0.6).add(smoothstep(0.07, 0.0, d).mul(0.55)));
      const wood = vec3(0.3, 0.19, 0.11).mul(float(0.75).add(grain.mul(0.4)));
      const paint = base.mul(float(0.74).add(fibre.mul(0.18)).add(grain.mul(0.12)));
      let albedo = cast<V3>(mix(paint, wood, wear.mul(0.8)).mul(float(1).sub(seam.mul(0.55))).mul(float(1).sub(knot)));
      // Iron straps across each corner (an L of flat bar) with a brass rivet at the knee.
      const ax = abs(uv.x);
      const ay = abs(uv.y);
      const strap = step(0.335, max(ax, ay)).mul(step(0.24, min(ax, ay)));
      const rivet = smoothstep(0.03, 0.018, length(vec3(ax.sub(0.4), ay.sub(0.4), 0)));
      const iron = vec3(0.055, 0.05, 0.047).add(vec3(0.12, 0.06, 0.03).mul(smoothstep(0.7, 1.0, fibre).mul(0.6)));
      albedo = cast<V3>(mix(albedo, iron, strap.mul(0.92)));
      albedo = cast<V3>(mix(albedo, vec3(0.78, 0.55, 0.24), rivet).mul(mix(float(1), float(0.8), edge)));
      const rough = mix(mix(float(0.7).sub(grain.mul(0.08)), float(0.85), wear), float(0.42), strap).sub(rivet.mul(0.25));
      return { albedo: cast<V3>(albedo), emissive: zero, roughness: cast<F>(rough) };
    }
    case 'storm': {
      // Storm crystal (Dark Storm): deep, polished crystal in the piece colour over graphite, faint
      // charge filaments far inside it (a slow, steady glow, never a flicker), a fine silver bevel
      // on every edge and beads of rain standing on the faces. The colour stays saturated and the
      // glow low, so the seven pieces read as solid, distinct cubes in the dark.
      const uv = faceUV(p);
      const d = borderDistance(p);
      const depth = mx_fractal_noise_float(q.mul(1.9), 3, 2, 0.5).mul(0.5).add(0.5);
      const graphite = vec3(0.022, 0.025, 0.03);
      const crystal = mix(graphite, base.mul(0.84), float(0.8).add(depth.mul(0.16)));
      // Charge filaments: thin cell boundaries deep in the crystal, drifting very slowly.
      const cells = mx_worley_noise_vec2(q.mul(2.6).add(vec3(0, time.mul(0.012), 0)));
      const filament = smoothstep(0.045, 0.0, cells.y.sub(cells.x)).mul(smoothstep(0.04, 0.2, d));
      // Silver edges: a fine bright metal line along the bevel.
      const silver = smoothstep(0.035, 0.012, d);
      // Rain beads: small round drops on the faces, each with a bright rim and a tiny highlight.
      const beadCells = mx_worley_noise_vec2(vec3(uv.x.mul(7.5), uv.y.mul(7.5), seed.x.mul(3.7).add(seed.y.mul(1.3))));
      const beadR = mx_cell_noise_float(floor(vec3(uv.x.mul(7.5), uv.y.mul(7.5), seed.z.mul(5.1)))).mul(0.12).add(0.06);
      const bead = smoothstep(beadR, beadR.mul(0.7), beadCells.x).mul(step(0.62, mx_cell_noise_float(floor(vec3(uv.x.mul(7.5).add(0.5), uv.y.mul(7.5), seed.x)))));
      const beadRim = smoothstep(beadR.mul(0.55), beadR.mul(0.95), beadCells.x).mul(bead);
      const albedo = mix(mix(crystal, vec3(0.62, 0.65, 0.7), silver.mul(0.85)), crystal.mul(1.25).add(0.02), beadRim.mul(0.6)).mul(mix(float(1), float(0.85), edge.mul(float(1).sub(silver))));
      const inner = mix(base, vec3(0.75, 0.85, 1), 0.35).mul(filament.mul(float(0.1).add(music.mul(0.04)))).add(base.mul(ndv.pow(2).mul(depth).mul(0.03)));
      const glint = vec3(0.8, 0.86, 1).mul(beadRim.mul(ndv.pow(4)).mul(0.08)).add(vec3(0.6, 0.66, 0.74).mul(silver.mul(0.05)));
      const rough = mix(mix(float(0.13).add(depth.mul(0.05)), float(0.07), silver), float(0.02), bead);
      return { albedo: cast<V3>(albedo), emissive: cast<V3>(inner.add(glint)), roughness: cast<F>(rough) };
    }
    default:
      return { albedo: base, emissive: zero, roughness: null };
  }
}
