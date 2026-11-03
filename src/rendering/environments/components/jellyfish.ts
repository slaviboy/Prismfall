import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, type Node } from 'three/webgpu';
import {
  Fn,
  abs,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cos,
  cross,
  dot,
  exp,
  float,
  fract,
  length,
  max,
  mix,
  mod,
  mrt,
  mx_noise_float,
  normalize,
  positionGeometry,
  screenSize,
  select,
  sin,
  smoothstep,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { additiveFog } from '../../shaders/uniforms';
import { colorUniform, floatUniform, seeded, zColor, zVec3 } from './common';

const schema = z.object({
  count: z.number().int().min(1).max(12).default(5),
  /** Bell diameter range (world units). */
  size: z.tuple([z.number().positive(), z.number().positive()]).default([3.5, 5.5]),
  /**
   * Where the jellies live: a box whose x range is mirrored either side of the view axis. Homes
   * stay outside the cone |x| < clearance × (viewZ − z), so jellies never drift over the board.
   */
  area: z
    .object({
      center: zVec3.default([0, 2, -50]),
      size: zVec3.default([120, 18, 50]),
      clearance: z.number().min(0).default(0.42),
      viewZ: z.number().default(33),
    })
    .prefault({}),
  /** Bell tissue tint, the fresnel rim (thin membrane seen edge-on), bioluminescence, gonads. */
  bell: zColor.default('#a4cde6'),
  rim: zColor.default('#d6f2ff'),
  glow: zColor.default('#5ad6ff'),
  gonad: zColor.default('#b8a2e6'),
  /** Bell contractions per second (every jelly varies around it). */
  pulseRate: z.number().positive().default(0.8),
  /** How far the margin pulls in on a contraction (fraction of the bell radius). */
  pulse: z.number().min(0).max(0.45).default(0.2),
  tentacles: z.number().int().min(0).max(48).default(28),
  /** Tentacle length in bell diameters. */
  tentacleLength: z.number().min(0).default(2.2),
  /** Oral arm length in bell diameters. */
  armLength: z.number().min(0).default(0.85),
  /** Height climbed during the active part of each swim cycle (world units) and the cycle length (s). */
  rise: z.number().min(0).default(6),
  cycle: z.number().positive().default(34),
  /** Horizontal wander amplitude (world units). */
  wander: z.number().min(0).default(3),
  brightness: z.number().min(0).default(1),
  /** Bioluminescence along the margin and canals; flares softly on each contraction. */
  glowStrength: z.number().min(0).default(0.5),
  bloom: z.number().min(0).default(0.3),
  seed: z.number().default(1),
});

type Params = z.infer<typeof schema>;
type F = Node<'float'>;
type V3 = Node<'vec3'>;

const BELL_RINGS = 28;
const BELL_SEGS = 72;
const ARM_ALONG = 40;
const ARM_ACROSS = 6;
const TENTACLE_SEGS = 36;
/** Dome height over bell radius. */
const DOME = 0.68;
const TAU = Math.PI * 2;

export interface JellyHome {
  x: number;
  y: number;
  z: number;
  radius: number;
  seed: number;
  freq: number;
}

/**
 * A jelly's footprint as seen from the viewer, in view-tangent units: centre x, half width (bell,
 * flare and wander) and the vertical span from the top of the bell to the visible tentacles.
 */
function footprint(h: Pick<JellyHome, 'x' | 'y' | 'z' | 'radius'>, p: Params): { x: number; half: number; top: number; bottom: number } {
  const d = Math.max(1, p.area.viewZ - h.z);
  return {
    x: h.x / d,
    half: (h.radius * 1.2 + p.wander) / d,
    top: (h.y + h.radius * 0.8 + p.rise * 0.25) / d,
    bottom: (h.y - p.rise * 0.25 - h.radius * 2 * p.tentacleLength * 0.6) / d,
  };
}

/** Clearance between two jellies' footprints on screen (negative when they overlap). */
export function screenGap(a: Pick<JellyHome, 'x' | 'y' | 'z' | 'radius'>, b: Pick<JellyHome, 'x' | 'y' | 'z' | 'radius'>, p: Params): number {
  const fa = footprint(a, p);
  const fb = footprint(b, p);
  const gx = Math.abs(fa.x - fb.x) - fa.half - fb.half;
  const gy = Math.max(fb.bottom - fa.top, fa.bottom - fb.top);
  return Math.max(gx, gy);
}

/**
 * Deterministic homes, alternating sides, outside the clear cone, and not overlapping on screen
 * (far jellies are small, so they can sit in the gaps between near ones).
 */
export function placeJellies(p: Params, rand: () => number): JellyHome[] {
  const [cx, cy, cz] = p.area.center;
  const [sx, sy, sz] = p.area.size;
  const homes: JellyHome[] = [];
  const firstSide = rand() < 0.5 ? -1 : 1;
  for (let i = 0; i < p.count; i++) {
    const side = i % 2 === 0 ? firstSide : -firstSide;
    const radius = (p.size[0] + (p.size[1] - p.size[0]) * rand()) * 0.5;
    let best: JellyHome | null = null;
    let bestGap = -Infinity;
    for (let attempt = 0; attempt < 64; attempt++) {
      const z = cz + (rand() - 0.5) * sz;
      const y = cy + (rand() - 0.5) * sy;
      // Keep the bell, its sway and the wander outside the cone around the view axis.
      const minX = Math.max(0, p.area.clearance * (p.area.viewZ - z)) + radius * 1.6 + p.wander * 1.3;
      const maxX = Math.max(minX, Math.abs(cx) + sx * 0.5);
      const x = side * (minX + (maxX - minX) * rand());
      const gap = homes.reduce((g, h) => Math.min(g, screenGap(h, { x, y, z, radius }, p)), Infinity);
      if (gap > bestGap) {
        bestGap = gap;
        best = { x, y, z, radius, seed: 0, freq: 0 };
      }
      if (gap > 0.01) break;
    }
    const home = best as JellyHome;
    home.seed = rand();
    home.freq = p.pulseRate * (0.8 + rand() * 0.4);
    homes.push(home);
  }
  return homes;
}

/**
 * Realistic translucent jellyfish (moon-jelly style with deep-sea bioluminescence). Each jelly is a
 * lathe bell with a flared margin that contracts quickly and relaxes slowly (the margin moves
 * more than the apex), shaded as thin glowing tissue: a fresnel rim, radial and ring canals, four
 * horseshoe gonads and a luminous margin with sense organs. Four frilled oral arms and 20–40 hair-thin
 * tentacles trail from it: every point down a tentacle replays where the margin was a moment
 * earlier, so they lag behind each pulse and drift, with waves travelling down their length.
 * Jellies climb in steps on their pulses, then rest and sink, and wander slowly.
 *
 * All animation runs in the vertex shader from time and per-jelly seeds baked into the vertices;
 * the whole bloom is two draw calls (bells with arms, tentacles) and no per-frame CPU work.
 * Tentacles are camera-facing ribbons kept at least ~1.4 px wide, with brightness scaled by true
 * width over drawn width, so they stay smooth and steady at any distance.
 */
export const jellyfishComponent: ComponentFactory<Params> = {
  type: 'jellyfish',
  version: 1,
  description: 'Translucent pulsing jellyfish: lathe bells with canals and gonads, frilled oral arms, trailing tentacles.',
  schema,
  create(ctx, p) {
    const rand = seeded(p.seed * 9173 + 11);
    const homes = placeJellies(p, rand);
    const lowDetail = ctx.quality.detail === 'low';
    const tentacleCount = lowDetail ? Math.ceil(p.tentacles * 0.5) : p.tentacles;
    const tentacleSegs = lowDetail ? 24 : TENTACLE_SEGS;

    // ---- Geometry: bells + oral arms in one mesh, tentacles in another. ----
    const bellPos: number[] = [];
    const bellJelly: number[] = [];
    const bellInfo: number[] = [];
    const bellIndex: number[] = [];
    const tentPos: number[] = [];
    const tentJelly: number[] = [];
    const tentInfo: number[] = [];
    const tentIndex: number[] = [];
    for (const h of homes) {
      const diameter = h.radius * 2;
      // Bell: (s, theta) grid, the seam column duplicated so angles interpolate cleanly.
      let base = bellPos.length / 3;
      for (let i = 0; i <= BELL_RINGS; i++) {
        const s = i / BELL_RINGS;
        for (let j = 0; j <= BELL_SEGS; j++) {
          bellPos.push(s, (j / BELL_SEGS) * TAU, 0);
          bellJelly.push(h.x, h.y, h.z, h.seed);
          bellInfo.push(h.radius, h.freq, p.armLength * diameter, 0);
        }
      }
      for (let i = 0; i < BELL_RINGS; i++) {
        for (let j = 0; j < BELL_SEGS; j++) {
          const a = base + i * (BELL_SEGS + 1) + j;
          const b = a + BELL_SEGS + 1;
          bellIndex.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
      // Oral arms: (u along, v across, angle) ribbons hanging from the mouth.
      for (let k = 0; k < 4; k++) {
        const angle = (k + 0.5) * (Math.PI / 2) + (rand() - 0.5) * 0.3;
        const armLen = p.armLength * diameter * (0.8 + rand() * 0.4);
        base = bellPos.length / 3;
        for (let i = 0; i <= ARM_ALONG; i++) {
          for (let j = 0; j <= ARM_ACROSS; j++) {
            bellPos.push(i / ARM_ALONG, (j / ARM_ACROSS) * 2 - 1, angle);
            bellJelly.push(h.x, h.y, h.z, h.seed);
            bellInfo.push(h.radius, h.freq, armLen, 1);
          }
        }
        for (let i = 0; i < ARM_ALONG; i++) {
          for (let j = 0; j < ARM_ACROSS; j++) {
            const a = base + i * (ARM_ACROSS + 1) + j;
            const b = a + ARM_ACROSS + 1;
            bellIndex.push(a, b, a + 1, a + 1, b, b + 1);
          }
        }
      }
      // Tentacles: (u along, side, root angle) camera-facing ribbons from the margin.
      for (let k = 0; k < tentacleCount; k++) {
        const angle = ((k + 0.5 + (rand() - 0.5) * 0.5) / tentacleCount) * TAU;
        const len = p.tentacleLength * diameter * (0.4 + Math.pow(rand(), 0.7) * 0.6);
        const tSeed = rand();
        base = tentPos.length / 3;
        for (let i = 0; i <= tentacleSegs; i++) {
          // Denser near the root, where the bend from the margin is.
          const u = Math.pow(i / tentacleSegs, 1.25);
          for (const side of [-1, 1]) {
            tentPos.push(u, side, angle);
            tentJelly.push(h.x, h.y, h.z, h.seed);
            tentInfo.push(h.radius, h.freq, len, tSeed);
          }
        }
        for (let i = 0; i < tentacleSegs; i++) {
          const a = base + i * 2;
          tentIndex.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }
    }
    const bellGeo = new BufferGeometry();
    bellGeo.setAttribute('position', new BufferAttribute(new Float32Array(bellPos), 3));
    bellGeo.setAttribute('jelly', new BufferAttribute(new Float32Array(bellJelly), 4));
    bellGeo.setAttribute('jellyInfo', new BufferAttribute(new Float32Array(bellInfo), 4));
    bellGeo.setIndex(bellIndex);
    const tentGeo = new BufferGeometry();
    tentGeo.setAttribute('position', new BufferAttribute(new Float32Array(tentPos), 3));
    tentGeo.setAttribute('jelly', new BufferAttribute(new Float32Array(tentJelly), 4));
    tentGeo.setAttribute('jellyInfo', new BufferAttribute(new Float32Array(tentInfo), 4));
    tentGeo.setIndex(tentIndex);

    // ---- Shared motion model (TSL). ----
    const u = { presence: floatUniform(1), glow: floatUniform(p.glowStrength), brightness: floatUniform(p.brightness), music: floatUniform(0) };
    // Reduced motion: everything (pulses, drift, tentacle waves) runs at a calmer pace.
    const time = ctx.quality.reducedMotion ? ctx.uniforms.time.mul(0.5) : ctx.uniforms.time;
    const jelly = attribute<'vec4'>('jelly', 'vec4');
    const info = attribute<'vec4'>('jellyInfo', 'vec4');
    const seed = jelly.w;
    const radius = info.x;
    const freq = info.y;
    const pg = positionGeometry;

    /** Contraction 0..1 over one pulse phase: quick squeeze, slow relaxation. */
    const contraction = (ph: F): F => smoothstep(0, 0.27, ph).mul(float(1).sub(smoothstep(0.27, 0.96, ph))) as F;
    /** Fraction of a pulse's forward push delivered by phase ph. */
    const thrust = (ph: F): F => smoothstep(0.03, 0.55, ph) as F;

    interface State {
      centre: V3;
      tiltX: F;
      tiltZ: F;
      phase: F;
      active: F;
    }
    const climbRate = p.rise / (0.62 * p.cycle);
    const state = (t: F): State => {
      const phase = t.mul(freq).add(seed.mul(17.3)) as F;
      const pulse = fract(phase);
      const q = fract(t.div(p.cycle).add(seed.mul(5.71)));
      // Swims up for most of the cycle, then rests (weak pulses) and sinks back.
      const resting = smoothstep(0.6, 0.68, q).mul(float(1).sub(smoothstep(0.9, 1, q)));
      const active = float(1).sub(resting.mul(0.7)) as F;
      const climb = select(q.lessThan(0.62), q.div(0.62), float(1).sub(smoothstep(0.62, 1, q)));
      // Per-pulse surge sized so that, while climbing, the jelly only moves during its thrust.
      const surge = thrust(pulse).sub(pulse).mul(float(climbRate).div(freq)).mul(active);
      const w = p.wander;
      const wx = sin(t.mul(0.031).add(seed.mul(41))).mul(w).add(sin(t.mul(0.083).add(seed.mul(13))).mul(w * 0.35));
      const wz = sin(t.mul(0.026).add(seed.mul(29))).mul(w * 0.8).add(sin(t.mul(0.071).add(seed.mul(7))).mul(w * 0.3));
      const wy = sin(t.mul(0.058).add(seed.mul(19))).mul(0.5);
      const centre = vec3(jelly.x.add(wx), jelly.y.add(climb.sub(0.5).mul(p.rise)).add(surge).add(wy), jelly.z.add(wz)) as V3;
      const tiltX = sin(t.mul(0.047).add(seed.mul(23))).mul(0.13).add(sin(t.mul(0.11).add(seed.mul(3))).mul(0.04)) as F;
      const tiltZ = sin(t.mul(0.039).add(seed.mul(11))).mul(0.13).add(sin(t.mul(0.097).add(seed.mul(5))).mul(0.04)) as F;
      return { centre, tiltX, tiltZ, phase, active };
    };
    const tilt = (v: V3, st: State): V3 => {
      const cx = cos(st.tiltX);
      const sx = sin(st.tiltX);
      const v1 = vec3(v.x, v.y.mul(cx).sub(v.z.mul(sx)), v.y.mul(sx).add(v.z.mul(cx)));
      const cz = cos(st.tiltZ);
      const sz = sin(st.tiltZ);
      return vec3(v1.x.mul(cz).sub(v1.y.mul(sz)), v1.x.mul(sz).add(v1.y.mul(cz)), v1.z) as V3;
    };
    /** Contraction at a delay (in pulse phase) behind the apex: the squeeze travels to the margin. */
    const contractionAt = (st: State, lag: F | number): F => contraction(fract(st.phase.sub(lag))).mul(st.active) as F;
    /** Bell profile (unit radius): radial distance and height at s (0 apex .. 1 margin). */
    const profile = (s: F, c: F, theta: F): { r: F; y: F } => {
      const k = c.mul(p.pulse);
      const flare = smoothstep(0.74, 1, s);
      const flare2 = flare.mul(flare);
      const phi = s.mul(1.6);
      const squeeze = float(1).sub(k.mul(s.mul(s).mul(0.85).add(0.15)));
      // Eight shallow lappets along the margin.
      const lappets = float(1).add(flare2.mul(abs(sin(theta.mul(4))).mul(0.035)));
      const r = sin(phi).add(flare2.mul(0.09)).mul(squeeze).sub(flare2.mul(k).mul(0.25)).mul(lappets) as F;
      const y = cos(phi).mul(DOME).add(flare2.mul(0.035)).sub(k.mul(s.mul(s)).mul(0.42)).add(k.mul(float(1).sub(s)).mul(0.1)) as F;
      return { r, y };
    };

    // ---- Bells and oral arms. ----
    const vNormal = varyingProperty('vec3', 'vJellyNormal');
    const vWorld = varyingProperty('vec3', 'vJellyWorld');
    const vPulse = varyingProperty('float', 'vJellyPulse');
    const bellPosition = Fn(() => {
      const t = time as unknown as F;
      const st = state(t);
      // Bell vertex.
      const s = pg.x;
      const theta = pg.y;
      const c = contractionAt(st, s.mul(0.07));
      const a = profile(s, c, theta);
      const b = profile(s.add(0.015), c, theta);
      const ct = cos(theta);
      const stn = sin(theta);
      const bellLocal = vec3(a.r.mul(ct), a.y, a.r.mul(stn)).mul(radius) as V3;
      const dr = b.r.sub(a.r);
      const dy = b.y.sub(a.y);
      const bellN = normalize(vec3(dy.negate().mul(ct), dr, dy.negate().mul(stn))) as V3;
      const bellWorld = st.centre.add(tilt(bellLocal, st));
      // Oral-arm vertex: hangs from the mouth, replaying the bell's motion with a delay down its length.
      const along = pg.x;
      const across = pg.y;
      const angle = pg.z;
      const armLen = info.z;
      const late = state(t.sub(along.mul(1.1)) as F);
      const root = late.centre.add(tilt(vec3(0, radius.mul(0.24), 0) as V3, late));
      const radial = vec3(cos(angle), 0, sin(angle));
      const tangent = vec3(sin(angle).negate(), 0, cos(angle));
      // A curtain of tissue, broad at the mouth and narrowing irregularly, turning only slowly; its
      // edges are ruffled (two incommensurate ripples that drift), the middle stays smooth.
      const twist = along.mul(0.9).add(sin(t.mul(0.31).add(angle.mul(3)).add(seed.mul(9))).mul(0.4)).add(sin(along.mul(3.1).add(angle.mul(7))).mul(0.3));
      const wDir = tangent.mul(cos(twist)).add(radial.mul(sin(twist)));
      const nDir = radial.mul(cos(twist)).sub(tangent.mul(sin(twist)));
      const lobes = sin(along.mul(5.3).add(seed.mul(7)).add(angle.mul(2))).mul(0.2).add(sin(along.mul(11.7).add(angle.mul(5))).mul(0.1)).add(0.75);
      const width = radius.mul(0.26).mul(float(1).sub(along.mul(0.65))).mul(smoothstep(0, 0.1, along).mul(0.5).add(0.5)).mul(lobes);
      const ruffle = sin(along.mul(26).add(across.mul(1.5)).sub(t.mul(1.1)).add(angle.mul(5))).add(sin(along.mul(47).sub(t.mul(1.7)).add(angle.mul(3))).mul(0.6));
      const frill = ruffle.mul(radius.mul(0.055)).mul(across.mul(across)).mul(along.add(0.5));
      const sway = vec3(sin(along.mul(4.1).sub(t.mul(1.0)).add(angle)), 0, cos(along.mul(3.3).sub(t.mul(0.8)).add(angle.mul(2)))).mul(radius.mul(0.3).mul(along).mul(along.add(0.3)));
      const bulge = sin(along.mul(Math.PI * 0.85)).mul(radius.mul(0.32));
      const armWorld = root
        .add(vec3(0, armLen.mul(along).negate(), 0))
        .add(radial.mul(bulge))
        .add(wDir.mul(across.mul(width)))
        .add(nDir.mul(frill))
        .add(sway) as V3;
      const isArm = info.w.greaterThan(0.5);
      const world = select(isArm, armWorld, bellWorld) as V3;
      vNormal.assign(select(isArm, nDir, tilt(bellN, st)));
      vWorld.assign(world);
      vPulse.assign(contractionAt(st, 0.07));
      return world;
    })();

    // Each jelly leans a little towards the gonad tint, so a bloom is not uniformly coloured.
    const bellC = mix(colorUniform(p.bell), colorUniform(p.gonad), fract(seed.mul(7.31)).mul(0.3));
    const rimC = colorUniform(p.rim);
    const glowC = colorUniform(p.glow);
    const gonadC = colorUniform(p.gonad);
    const view = normalize(cameraPosition.sub(vWorld));
    const ndv = abs(dot(normalize(vNormal), view));
    const fres = float(1).sub(ndv).pow(2.4);
    // Bell surface pattern in (s, theta).
    const s = pg.x;
    const theta = pg.y;
    const thick = mix(float(1), float(0.25), smoothstep(0, 0.9, s));
    // Canals meander a little (thin tubes in soft tissue, not ribs).
    const meander = sin(s.mul(23).add(theta.mul(5)).add(seed.mul(13))).mul(0.012).add(sin(s.mul(9).sub(theta.mul(3))).mul(0.01));
    const canalAt = (n: number, width: number): F => {
      const d = abs(fract(theta.add(meander.div(s.add(0.15))).mul(n / TAU).add(0.5)).sub(0.5)).mul(TAU / n).mul(s);
      return exp(d.div(width).pow(2).negate()) as F;
    };
    const canals = canalAt(8, 0.016)
      .mul(smoothstep(0.22, 0.4, s))
      .add(canalAt(16, 0.012).mul(smoothstep(0.42, 0.6, s)))
      .add(canalAt(32, 0.009).mul(smoothstep(0.7, 0.86, s)).mul(0.7))
      .mul(smoothstep(1, 0.92, s));
    const ringCanal = exp(s.sub(0.93).div(0.014).pow(2).negate());
    // Four horseshoe gonads around the apex, open towards the margin.
    const folded = mod(theta.add(Math.PI / 4), Math.PI / 2).sub(Math.PI / 4);
    const q = vec2(s.mul(cos(folded)), s.mul(sin(folded)));
    const toLobe = q.sub(vec2(0.24, 0));
    const lobeD = length(toLobe);
    const open = smoothstep(0.35, 0.95, toLobe.x.div(lobeD.add(1e-4)));
    const lumpy = mx_noise_float(vec3(q.x.mul(28), q.y.mul(28), seed.mul(7))).mul(0.3).add(0.85);
    const gonadRing = exp(lobeD.sub(0.082).div(0.03).pow(2).negate()).mul(float(1).sub(open.mul(0.8))).mul(lumpy);
    const gonadFill = exp(lobeD.div(0.085).pow(2).negate());
    const mottling = mx_noise_float(vec3(cos(theta).mul(s).mul(7), sin(theta).mul(s).mul(7), seed.mul(31))).mul(0.25).add(0.85);
    const marginBand = exp(float(1).sub(s).div(0.03).pow(2).negate());
    const organ = abs(fract(theta.mul(8 / TAU)).sub(0.5)).mul(TAU / 8);
    const organs = exp(organ.div(0.035).pow(2).add(float(1).sub(s).div(0.035).pow(2)).negate());
    const glowAmt = u.glow.mul(vPulse.mul(0.9).add(0.55)).mul(u.music.mul(0.4).add(1));
    const bellLight = bellC
      .mul(thick.mul(0.055).add(0.022).mul(mottling))
      .add(rimC.mul(fres).mul(0.5))
      .add(glowC.mul(canals.mul(0.085).add(ringCanal.mul(0.16))))
      .add(gonadC.mul(gonadRing.mul(0.3).add(gonadFill.mul(0.08))).mul(smoothstep(0.6, 0.3, s)))
      .add(glowC.mul(marginBand.mul(0.35).add(organs.mul(1.2))).mul(glowAmt));
    // Oral arms: translucent frills, brighter along their folded edges.
    const across = abs(pg.y);
    const armFade = smoothstep(1, 0.6, pg.x);
    const armLight = mix(bellC, gonadC, 0.35)
      .mul(0.04)
      .add(gonadC.mul(exp(across.div(0.2).pow(2).negate()).mul(0.035)))
      .add(rimC.mul(smoothstep(0.6, 1, across).mul(0.11)))
      .add(rimC.mul(fres).mul(0.16))
      .mul(armFade.mul(0.85).add(0.15));
    const tone = seed.mul(0.4).add(0.8);
    const light = select(info.w.greaterThan(0.5), armLight, bellLight).mul(tone).mul(u.brightness).mul(u.presence) as V3;
    const bellMat = new MeshBasicNodeMaterial();
    bellMat.positionNode = bellPosition;
    bellMat.colorNode = vec4(additiveFog(light), 1);
    bellMat.mrtNode = mrt({ emissive: vec4(light.mul(p.bloom), 1) });
    bellMat.transparent = true;
    bellMat.depthWrite = false;
    bellMat.blending = AdditiveBlending;
    bellMat.side = DoubleSide;
    bellMat.fog = false;
    const bells = new Mesh(bellGeo, bellMat);
    bells.frustumCulled = false;
    bells.renderOrder = -3;

    // ---- Tentacles. ----
    const vCover = varyingProperty('float', 'vTentacleCover');
    const tentacleLen = info.z;
    const tSeed = info.w;
    const rootAngle = pg.z;
    const centreline = (t: F, along: F): V3 => {
      const late = state(t.sub(along.mul(1.7)) as F);
      const c = contractionAt(late, 0.07);
      const m = profile(float(0.985) as F, c, rootAngle);
      const radial = vec3(cos(rootAngle), 0, sin(rootAngle));
      const root = late.centre.add(tilt(vec3(m.r.mul(cos(rootAngle)), m.y, m.r.mul(sin(rootAngle))).mul(radius) as V3, late));
      const hang = tentacleLen.mul(along);
      const ph = tSeed.mul(TAU);
      // Travelling waves (stronger towards the tip), a gentle per-tentacle curl and a slow current.
      const amp = tentacleLen.mul(tSeed.mul(0.04).add(0.04)).mul(along.pow(0.9));
      const waveX = sin(along.mul(8.5).sub(t.mul(1.9)).add(ph)).mul(amp).add(sin(along.mul(3.1).sub(t.mul(0.7)).add(ph.mul(2))).mul(amp.mul(0.9)));
      const waveZ = cos(along.mul(6.3).sub(t.mul(1.4)).add(ph.mul(1.7))).mul(amp.mul(0.8)).add(cos(along.mul(2.6).sub(t.mul(0.55)).add(ph.mul(3))).mul(amp.mul(0.8)));
      // They leave the margin heading outward, then curve down; each has its own curl.
      const kick = smoothstep(0, 0.12, along).mul(radius).mul(tSeed.mul(0.18).add(0.1)).mul(float(1).sub(c.mul(0.6)));
      const spread = radius.mul(along).mul(tSeed.mul(0.4).add(0.02)).mul(float(1).sub(along.mul(0.5))).add(kick);
      const curl = vec3(sin(tSeed.mul(47)), 0, cos(tSeed.mul(31))).mul(sin(along.mul(tSeed.mul(2).add(1.6)).add(tSeed.mul(9))).mul(tentacleLen.mul(0.09)).mul(along));
      const current = vec3(sin(t.mul(0.05).add(seed.mul(9))), 0, cos(t.mul(0.043).add(seed.mul(4)))).mul(along.mul(along).mul(tentacleLen).mul(0.12));
      return root.add(vec3(waveX, hang.negate(), waveZ)).add(radial.mul(spread)).add(curl).add(current) as V3;
    };
    const tentPosition = Fn(() => {
      const t = time as unknown as F;
      const along = pg.x;
      const side = pg.y;
      const p0 = centreline(t, along);
      const p1 = centreline(t, along.add(0.02) as F);
      const tangent = normalize(p1.sub(p0));
      const toCam = cameraPosition.sub(p0);
      const dist = length(toCam);
      const across = normalize(cross(tangent, toCam));
      // Projection [1][1] = 1 / tan(fov / 2): world size of one pixel at this distance.
      const p11 = (cameraProjectionMatrix as unknown as { element(i: number): Node<'vec4'> }).element(1).y;
      const pixel = dist.mul(2).div(p11.mul(screenSize.y));
      const trueWidth = radius.mul(0.018).mul(float(1).sub(along.mul(0.7)));
      const drawWidth = max(trueWidth, pixel.mul(1.4));
      vCover.assign(trueWidth.div(drawWidth));
      return p0.add(across.mul(side.mul(drawWidth).mul(0.5)));
    })();
    const crossSection = float(1).sub(pg.y.mul(pg.y));
    const tipFade = smoothstep(1, 0.55, pg.x).mul(smoothstep(0, 0.03, pg.x).mul(0.5).add(0.5));
    // Faint beading (nematocyst clusters) along each tentacle.
    const beads = sin(pg.x.mul(tentacleLen).mul(9).add(tSeed.mul(40))).mul(0.2).add(0.85);
    const tentLight = mix(rimC, glowC, 0.35)
      .mul(0.32)
      .mul(vCover)
      .mul(crossSection)
      .mul(tipFade)
      .mul(beads)
      .mul(seed.mul(0.4).add(0.8))
      .mul(u.brightness)
      .mul(u.presence) as V3;
    const tentMat = new MeshBasicNodeMaterial();
    tentMat.positionNode = tentPosition;
    tentMat.colorNode = vec4(additiveFog(tentLight), 1);
    tentMat.mrtNode = mrt({ emissive: vec4(tentLight.mul(p.bloom), 1) });
    tentMat.transparent = true;
    tentMat.depthWrite = false;
    tentMat.blending = AdditiveBlending;
    tentMat.side = DoubleSide;
    tentMat.fog = false;
    const tentacles = new Mesh(tentGeo, tentMat);
    tentacles.frustumCulled = false;
    tentacles.renderOrder = -3;

    const group = new Group();
    group.add(bells);
    if (tentacleCount > 0) group.add(tentacles);
    return {
      object: group,
      reactive: { glow: u.glow, brightness: u.brightness },
      update(frame) {
        u.music.value = frame.audio.bass * 0.6 + frame.audio.beatPulse * 0.4;
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        bellGeo.dispose();
        tentGeo.dispose();
        bellMat.dispose();
        tentMat.dispose();
      },
    };
  },
};
