import { BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, Mesh, MeshBasicNodeMaterial, NormalBlending, type Node } from 'three/webgpu';
import {
  Fn,
  abs,
  atan,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cos,
  cross,
  dot,
  exp,
  float,
  floor,
  instancedBufferAttribute,
  instancedDynamicBufferAttribute,
  length,
  max,
  mix,
  mod,
  normalize,
  positionGeometry,
  screenSize,
  select,
  sin,
  smoothstep,
  uniform,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { z } from 'zod';
import type { CallInfo, ComponentFactory, EnvironmentContext } from '../../../sdk/types';
import { Boids, DEFAULT_WEIGHTS, type BoidsConfig } from '../flocking/boids';
import { Falcon } from '../flocking/falcon';
import { noBloom } from '../../shaders/uniforms';
import { colorUniform, floatUniform, scaledCount, seeded, zColor, zVec3 } from './common';
import { revealMask } from './reveal';

type F = Node<'float'>;
type V3 = Node<'vec3'>;
type Vec3 = [number, number, number];

const DEG = Math.PI / 180;
const GRAVITY = 9.81;

/** A point in the sky as the player sees it: degrees right of the view axis, degrees up, metres away. */
const zSky = z.object({
  azimuth: z.number().min(-180).max(180),
  elevation: z.number().min(-10).max(80),
  distance: z.number().positive().max(850),
});

const view = {
  /** Where the viewer stands (the gameplay camera); sky points are measured from here. */
  eye: zVec3.default([0, 1, 31]),
  /** Half-width (degrees of azimuth) of the clear zone around the board that birds never enter. */
  clear: z.number().min(0).max(60).default(20),
  /** Atmospheric haze: distance (m) at which about 63 % of the bird colour has faded into `hazeColor`. */
  visibility: z.number().positive().default(1000),
  hazeColor: zColor.default('#c8d4e2'),
  seed: z.number().default(1),
};

const murmurationSchema = z.object({
  kind: z.literal('murmuration'),
  /** The airspace over the roost the flock wheels in: its centre, and half-extents (m) across the view, vertical and in depth. */
  roost: z.object({ at: zSky, size: zVec3.default([14, 6, 30]) }),
  /** Birds at high detail (scaled by quality and particle density). */
  count: z.number().int().min(20).max(3000).default(2400),
  /** Cruise, slowest and fastest flight speed (m/s). */
  speed: z.number().positive().default(8),
  minSpeed: z.number().positive().default(5),
  maxSpeed: z.number().positive().default(13),
  /** Topological neighbours each bird follows (about 7 in real starling flocks). */
  neighbours: z.number().int().min(1).max(16).default(7),
  /** Distance birds keep from each other (m). */
  separation: z.number().positive().default(0.8),
  /** Steering weights (see the boids module); unspecified ones keep their defaults. */
  weights: z
    .object({
      separation: z.number().min(0),
      alignment: z.number().min(0),
      cohesion: z.number().min(0),
      cruise: z.number().min(0),
      level: z.number().min(0),
      roost: z.number().min(0),
      bounds: z.number().min(0),
      avoid: z.number().min(0),
      flee: z.number().min(0),
      evade: z.number().min(0),
      wander: z.number().min(0),
    })
    .partial()
    .prefault({}),
  /** Largest steering acceleration in calm flight (m/s²). */
  maxAccel: z.number().positive().default(7),
  /** Wingspan range (m); starlings are about 0.37–0.42. */
  wingspan: z.tuple([z.number().positive(), z.number().positive()]).default([0.36, 0.42]),
  color: zColor.default('#15161a'),
  /** Wingbeats per second at full flapping, and how much of calm, level flight is spent gliding. */
  flapRate: z.number().positive().default(7),
  glide: z.number().min(0).max(1).default(0.35),
  /** A peregrine that stoops on the flock now and then, starting escape waves. `every` ≤ 0 disables it. */
  falcon: z
    .object({
      every: z.number().default(25),
      speed: z.number().positive().default(26),
      radius: z.number().positive().default(11),
      above: z.number().positive().default(45),
      wingspan: z.number().positive().default(1),
    })
    .prefault({}),
  /**
   * An optional smaller group whose roost sweeps in from out of view (`away`, an azimuth) to `at`
   * and back again every `period` seconds, passing nearer than the main flock.
   */
  passing: z
    .object({
      count: z.number().int().min(10).max(800).default(260),
      at: zSky,
      size: zVec3.default([7, 4, 10]),
      away: z.number().min(-180).max(180).default(-55),
      period: z.number().positive().default(80),
    })
    .optional(),
  /** Smallest drawn wingspan in pixels; smaller birds are drawn this size with matching transparency. */
  minPixels: z.number().positive().default(3),
  ...view,
});

const raptorSchema = z.object({
  /** Centre of the thermal the bird circles in. */
  at: zSky,
  /** Circle radius (m). */
  radius: z.number().positive().default(28),
  /** Airspeed (m/s). */
  speed: z.number().positive().default(11),
  /** Slow climb and sink amplitude (m). */
  climb: z.number().min(0).default(6),
  /** How far the thermal drifts with the wind (m). */
  drift: z.number().min(0).default(18),
  clockwise: z.boolean().default(false),
  /** Where on its circle the bird starts (0..1). */
  start: z.number().min(0).max(1).default(0),
  /** Wingspan (m): golden eagle about 2.1, griffon vulture about 2.6. */
  wingspan: z.number().positive().default(2.1),
});

const soaringSchema = z.object({
  kind: z.literal('soaring'),
  birds: z.array(raptorSchema).min(1).max(8),
  /** Plumage: body and upper wing, the paler band of upper-wing coverts, crown and nape, flight feathers, underside. */
  plumage: zColor.default('#544a40'),
  coverts: zColor.default('#968470'),
  nape: zColor.default('#b8a07a'),
  flight: zColor.default('#302c29'),
  under: zColor.default('#4a433c'),
  /** Underside of the flight feathers (a little greyer and paler than the body). */
  underFlight: zColor.default('#6a6660'),
  /** Direction of the sun in the photograph (degrees, as `at`). */
  sun: z.object({ azimuth: z.number(), elevation: z.number() }).prefault({ azimuth: -60, elevation: 45 }),
  sunColor: zColor.default('#fff1de'),
  sunIntensity: z.number().min(0).default(1.6),
  /** Ambient light: the sky above and the ground bounce below. */
  sky: zColor.default('#9db8dc'),
  ground: zColor.default('#8c8a70'),
  ambient: z.number().min(0).default(1.8),
  /** Warm light glowing through backlit flight feathers. */
  translucency: z.number().min(0).default(0.45),
  /** Mean seconds between the rare bouts of flapping. */
  flapEvery: z.number().positive().default(45),
  ...view,
});

const schema = z.discriminatedUnion('kind', [murmurationSchema, soaringSchema]);

type Params = z.infer<typeof schema>;
type Murmuration = z.infer<typeof murmurationSchema>;
type Soaring = z.infer<typeof soaringSchema>;
type SkyPoint = z.infer<typeof zSky>;

// ---------------------------------------------------------------------------------------------
// Placement math (CPU mirrors of the shader formulas, unit tested).
// ---------------------------------------------------------------------------------------------

/** Unit view direction for an azimuth (degrees right of −Z) and elevation (degrees up). */
export function skyDirection(azimuth: number, elevation: number): Vec3 {
  const a = azimuth * DEG;
  const e = elevation * DEG;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

export function skyPoint(eye: Vec3, at: SkyPoint): Vec3 {
  const d = skyDirection(at.azimuth, at.elevation);
  return [eye[0] + d[0] * at.distance, eye[1] + d[1] * at.distance, eye[2] + d[2] * at.distance];
}

/** View-facing frame at a sky point: right (along azimuth), up (along elevation), back (towards the viewer). */
export function skyFrame(at: SkyPoint): { right: Vec3; up: Vec3; back: Vec3 } {
  const a = at.azimuth * DEG;
  const e = at.elevation * DEG;
  const d = skyDirection(at.azimuth, at.elevation);
  return { right: [Math.cos(a), 0, Math.sin(a)], up: [-Math.sin(a) * Math.sin(e), Math.cos(e), Math.cos(a) * Math.sin(e)], back: [-d[0], -d[1], -d[2]] };
}

/** Azimuth (degrees) of a world point seen from the eye. */
export function azimuthOf(eye: Vec3, p: Vec3): number {
  return Math.atan2(p[0] - eye[0], -(p[2] - eye[2])) / DEG;
}

/**
 * Keeps an azimuth (degrees) out of the clear zone on its side (`side` = ±1): unchanged beyond
 * `clear + margin`, then eased smoothly (C1) towards `clear`, which it never crosses.
 */
export function guardAzimuth(azimuth: number, side: number, clear: number, margin: number): number {
  const a = azimuth * side;
  const lim = clear + margin;
  if (a >= lim) return azimuth;
  return side * (clear + margin * Math.exp((a - lim) / margin));
}

export interface RaptorTrack {
  readonly centre: Vec3;
  readonly radius: number;
  /** Signed angular rate (rad/s). */
  readonly omega: number;
  readonly phase: number;
  readonly drift: number;
  readonly climb: number;
  readonly seed: number;
}

export function raptorTrack(eye: Vec3, b: z.infer<typeof raptorSchema>, seed: number): RaptorTrack {
  return { centre: skyPoint(eye, b.at), radius: b.radius, omega: ((b.clockwise ? -1 : 1) * b.speed) / b.radius, phase: b.start * Math.PI * 2, drift: b.drift, climb: b.climb, seed };
}

/** A raptor circling in a drifting thermal: the circle rate and radius breathe slowly (same formula as the shader). */
export function raptorPosition(r: RaptorTrack, t: number): Vec3 {
  const s = r.seed;
  const theta = r.phase + r.omega * t + ((0.16 * r.omega) / 0.05) * Math.sin(0.05 * t + s * 6);
  const rad = r.radius * (1 + 0.15 * Math.sin(0.031 * t + s * 11));
  return [
    r.centre[0] + r.drift * Math.sin(0.011 * t + s * 5) + rad * Math.cos(theta),
    r.centre[1] + r.climb * Math.sin(0.017 * t + s * 3),
    r.centre[2] + r.drift * 0.7 * Math.sin(0.008 * t + s * 9 + 1) + rad * Math.sin(theta),
  ];
}

// ---------------------------------------------------------------------------------------------
// Geometry.
// ---------------------------------------------------------------------------------------------

/** Wrist position (fraction of the wingspan from the centre line) for the two-joint wing fold. */
export const STARLING_WRIST = 0.21;
export const RAPTOR_WRIST = 0.26;
/** Chord fraction where the upper-wing coverts end and the flight feathers begin. */
const COVERT_EDGE = 0.45;

/**
 * A starling in flight, one unit of wingspan, facing −Z with +Y up: a slim spindle body with a
 * pointed bill, short pointed triangular wings swept back at the tips and a short square tail.
 * Attribute `bird` = (part 0 body / 1 wing / 2 tail, chord 0 leading..1 trailing, 0, 0).
 */
export function starlingGeometry(): BufferGeometry {
  const pos: number[] = [];
  const info: number[] = [];
  const idx: number[] = [];
  const v = (x: number, y: number, z: number, part: number, chord: number) => {
    pos.push(x, y, z);
    info.push(part, chord, 0, 0);
    return pos.length / 3 - 1;
  };
  // Body: an elongated octahedron (bill at −Z).
  const nose = v(0, 0, -0.25, 0, 0);
  const tail = v(0, 0, 0.12, 0, 1);
  const l = v(-0.034, 0, -0.04, 0, 0.5);
  const r = v(0.034, 0, -0.04, 0, 0.5);
  const top = v(0, 0.03, -0.05, 0, 0.5);
  const bot = v(0, -0.032, -0.04, 0, 0.5);
  for (const [a, b] of [
    [l, top],
    [top, r],
    [r, bot],
    [bot, l],
  ] as const) {
    idx.push(nose, a, b, tail, b, a);
  }
  // Wings: root, wrist and a swept, pointed tip.
  for (const s of [-1, 1]) {
    const rl = v(s * 0.028, 0, -0.07, 1, 0);
    const rt = v(s * 0.028, 0, 0.06, 1, 1);
    const wl = v(s * STARLING_WRIST, 0, -0.058, 1, 0);
    const wt = v(s * (STARLING_WRIST - 0.015), 0, 0.1, 1, 1);
    const tip = v(s * 0.5, 0, 0.13, 1, 0.5);
    idx.push(rl, wl, wt, rl, wt, rt, wl, tip, wt);
  }
  // Short, square tail.
  const t0 = v(-0.034, 0, 0.1, 2, 0);
  const t1 = v(0.034, 0, 0.1, 2, 0);
  const t2 = v(-0.052, 0, 0.235, 2, 1);
  const t3 = v(0.052, 0, 0.235, 2, 1);
  idx.push(t0, t1, t3, t0, t3, t2);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('bird', new BufferAttribute(new Float32Array(info), 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * Primary feathers spread as fingers at the wing tip: angle back from the span axis (rad) and
 * length. Neighbours overlap at the base, so the slots open only over the outer part.
 */
export const RAPTOR_FINGERS: readonly (readonly [number, number])[] = [
  [-0.06, 0.07],
  [0.03, 0.105],
  [0.12, 0.122],
  [0.21, 0.124],
  [0.3, 0.114],
  [0.39, 0.096],
  [0.48, 0.076],
];

/**
 * A soaring eagle, one unit of wingspan, facing −Z with +Y up: broad wings pinched in at the body
 * with bulging secondaries, a hand with seven slotted primaries spread as fingers, a protruding
 * head, a long rounded tail and a spindle body hanging just below the wing plane.
 * Attributes: `normal` (wing and tail panels +Y), `bird` = (part 0 body / 1 wing / 2 finger / 3 tail,
 * chord 0 leading..1 trailing, distance along a finger (0..1), finger length).
 */
export function raptorGeometry(): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const info: number[] = [];
  const idx: number[] = [];
  const v = (x: number, y: number, z: number, part: number, chord: number, along = 0, flen = 0) => {
    pos.push(x, y, z);
    nrm.push(0, 1, 0);
    info.push(part, chord, along, flen);
    return pos.length / 3 - 1;
  };
  // Body: lofted rings of a slightly flattened spindle, a point at the bill and at the vent.
  const rings: [number, number, number][] = [
    // z, half-width, centre y
    [-0.178, 0.011, -0.006],
    [-0.158, 0.02, -0.004],
    [-0.128, 0.021, -0.006],
    [-0.085, 0.035, -0.012],
    [-0.03, 0.043, -0.016],
    [0.03, 0.038, -0.016],
    [0.08, 0.026, -0.012],
    [0.115, 0.016, -0.008],
  ];
  const AROUND = 6;
  const bodyStart = 0;
  v(0, -0.008, -0.195, 0, 0);
  for (const [zz, hw, yc] of rings) {
    for (let j = 0; j < AROUND; j++) {
      const phi = (j / AROUND) * Math.PI * 2;
      v(Math.cos(phi) * hw, yc + Math.sin(phi) * hw * 0.85, zz, 0, 0);
    }
  }
  const vent = v(0, -0.008, 0.13, 0, 1);
  for (let j = 0; j < AROUND; j++) idx.push(bodyStart, 1 + ((j + 1) % AROUND), 1 + j);
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < AROUND; j++) {
      const a = 1 + i * AROUND + j;
      const b = 1 + i * AROUND + ((j + 1) % AROUND);
      idx.push(a, b, b + AROUND, a, b + AROUND, a + AROUND);
    }
  }
  const lastRing = 1 + (rings.length - 1) * AROUND;
  for (let j = 0; j < AROUND; j++) idx.push(vent, lastRing + j, lastRing + ((j + 1) % AROUND));
  const bodyEnd = pos.length / 3;
  {
    const tmp = new BufferGeometry();
    tmp.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    tmp.setIndex(idx.slice());
    tmp.computeVertexNormals();
    const n = tmp.getAttribute('normal');
    for (let k = 0; k < bodyEnd; k++) nrm.splice(k * 3, 3, n.getX(k), n.getY(k), n.getZ(k));
    tmp.dispose();
  }

  // Wings: stations from the root to the finger bases, three chord rows each (leading edge, the
  // edge of the coverts, trailing edge). The outermost station is the slanted line the primaries
  // spring from.
  const stations: [number, number, number, number, number][] = [
    // x leading, z leading, x trailing, z trailing
    [0.03, -0.072, 0.03, 0.078, 0],
    [0.09, -0.084, 0.09, 0.112, 0],
    [0.15, -0.09, 0.15, 0.128, 0],
    [0.21, -0.093, 0.21, 0.122, 0],
    [RAPTOR_WRIST, -0.095, RAPTOR_WRIST, 0.112, 0],
    [0.315, -0.088, 0.31, 0.098, 0],
    [0.372, -0.074, 0.352, 0.08, 0],
  ];
  for (const s of [-1, 1]) {
    const first = pos.length / 3;
    for (const [xl, zl, xt, zt] of stations) {
      for (const c of [0, COVERT_EDGE, 1]) v(s * (xl + (xt - xl) * c), 0, zl + (zt - zl) * c, 1, c);
    }
    for (let i = 0; i < stations.length - 1; i++) {
      for (let c = 0; c < 2; c++) {
        const a = first + i * 3 + c;
        const b = a + 3;
        idx.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }
    // Fingers: tapering, emarginated primaries fanned from the outer edge of the hand.
    const [xl, zl, xt, zt] = stations[stations.length - 1]!;
    RAPTOR_FINGERS.forEach(([ang, len], i) => {
      const f = i / (RAPTOR_FINGERS.length - 1);
      const bx = xl + (xt - xl) * f - 0.012 * Math.cos(ang);
      const bz = zl + (zt - zl) * f - 0.012 * Math.sin(ang);
      const dx = Math.cos(ang);
      const dz = Math.sin(ang);
      const px = -dz;
      const pz = dx;
      const L = len + 0.012;
      const w0 = 0.016;
      const w1 = 0.0095;
      const w2 = 0.0045;
      const pt = (t: number, w: number, side: number) => v(s * (bx + dx * L * t + px * w * side), 0, bz + dz * L * t + pz * w * side, 2, 1, t, L);
      const a0 = pt(0, w0, -1);
      const a1 = pt(0, w0, 1);
      const b0 = pt(0.55, w1, -1);
      const b1 = pt(0.55, w1, 1);
      const c0 = pt(0.97, w2, -1);
      const c1 = pt(0.97, w2, 1);
      idx.push(a0, b0, b1, a0, b1, a1, b0, c0, c1, b0, c1, b1);
    });
  }
  // Tail: a rounded fan from the vent.
  // Tail: a long fan with a rounded tip, narrow where it leaves the body.
  const tailC = v(0, -0.004, 0.1, 3, 0);
  const fan: number[] = [v(-0.022, -0.004, 0.112, 3, 0.1)];
  const TAIL = 9;
  for (let j = 0; j < TAIL; j++) {
    const f = (2 * j) / (TAIL - 1) - 1;
    const a = 0.3 * f;
    const r = 0.17 * (1 - 0.16 * f * f);
    fan.push(v(Math.sin(a) * r, -0.004, 0.1 + Math.cos(a) * r, 3, 1));
  }
  fan.push(v(0.022, -0.004, 0.112, 3, 0.1));
  for (let j = 0; j < fan.length - 1; j++) idx.push(tailC, fan[j]!, fan[j + 1]!);

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('bird', new BufferAttribute(new Float32Array(info), 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------------------------
// Shared shader helpers.
// ---------------------------------------------------------------------------------------------

/**
 * Two-joint wing fold about the body axis: points out to the wrist turn by `arm` about the
 * shoulder, points beyond it first by `hand` about the wrist. Returns the posed point and the
 * total rotation (for normals).
 */
function foldWing(p: V3, wrist: number, arm: F, hand: F): { p: V3; angle: F } {
  const side = select(p.x.lessThan(0), float(-1), float(1));
  const ax = abs(p.x);
  const outer = ax.greaterThan(wrist);
  // Hand: rotate (ax − wrist, y) by `hand` about the wrist.
  const lx = ax.sub(wrist);
  const hx = lx.mul(cos(hand)).sub(p.y.mul(sin(hand))).add(wrist);
  const hy = lx.mul(sin(hand)).add(p.y.mul(cos(hand)));
  const x1 = select(outer, hx, ax);
  const y1 = select(outer, hy, p.y);
  const x2 = x1.mul(cos(arm)).sub(y1.mul(sin(arm)));
  const y2 = x1.mul(sin(arm)).add(y1.mul(cos(arm)));
  const angle = select(outer, arm.add(hand), arm);
  return { p: vec3(x2.mul(side), y2, p.z) as V3, angle: angle.mul(side) as F };
}

/** Pixel footprint at a world distance (one pixel's world size), from projection[1][1] = 1/tan(fov/2). */
function pixelSize(dist: F): F {
  const p11 = (cameraProjectionMatrix as unknown as { element(i: number): Node<'vec4'> }).element(1).y;
  return dist.mul(2).div(p11.mul(screenSize.y)) as F;
}

/** Eases a world point's azimuth out of the clear zone (shader twin of `guardAzimuth`). */
function guardNode(p: V3, eye: V3, side: F, clearDeg: number, marginDeg: number): V3 {
  const h = vec2(p.x.sub(eye.x), p.z.sub(eye.z));
  const r = length(h);
  const az = atan(h.x, h.y.negate());
  const a = az.mul(side);
  const lim = (clearDeg + marginDeg) * DEG;
  const m = marginDeg * DEG;
  const eased = exp(a.sub(lim).div(m)).mul(m).add(clearDeg * DEG);
  const az2 = select(a.lessThan(lim), eased, a).mul(side);
  return vec3(eye.x.add(sin(az2).mul(r)), p.y, eye.z.sub(cos(az2).mul(r))) as V3;
}

function hazeFactor(dist: F, visibility: number): F {
  return float(1).sub(exp(dist.div(-visibility))) as F;
}

// ---------------------------------------------------------------------------------------------
// Murmuration.
// ---------------------------------------------------------------------------------------------

/**
 * Simulation step (s): fixed, independent of the render frame rate. Between steps the shader flies
 * each bird on along its velocity and advances its wingbeat, so 30 Hz is smooth on screen.
 */
const SIM_STEP = 1 / 30;
const MAX_STEPS_PER_FRAME = 3;

/** Boids configuration for a murmuration (exported for tests and tuning). */
export function murmurationConfig(p: Murmuration, count: number, reduced: boolean, roost: { at: SkyPoint; size: number[] } = p.roost, seedOffset = 0): BoidsConfig {
  const eye = p.eye as Vec3;
  const at = roost.at;
  const centre = skyPoint(eye, at);
  const frame = skyFrame(at);
  const side = at.azimuth < 0 ? -1 : 1;
  // The clear zone's edge as a vertical plane through the eye; the flock steers away from it.
  const edge = side * (p.clear + 2) * DEG;
  const normal: Vec3 = [side * Math.cos(edge), 0, side * Math.sin(edge)];
  // Starlings: loose cohesion and strong alignment (so turns spread from the birds that start them
  // and the flock stretches and folds), a light roost pull and individual wandering.
  const weights = { ...DEFAULT_WEIGHTS, cohesion: 0.35, roost: 0.5, wander: 1.6, ...p.weights };
  if (reduced) {
    weights.evade *= 0.5;
    weights.flee *= 0.6;
  }
  return {
    count,
    seed: p.seed * 7919 + 11 + seedOffset,
    neighbours: p.neighbours,
    perception: p.separation * 8,
    separation: p.separation,
    minSpeed: p.minSpeed,
    maxSpeed: p.maxSpeed,
    cruiseSpeed: p.speed,
    maxAccel: p.maxAccel,
    weights,
    bounds: { center: centre, radii: roost.size as Vec3, axes: [frame.right, frame.up, frame.back] },
    avoid: [{ normal, offset: normal[0] * eye[0] + normal[2] * eye[2], margin: 8 }],
    panic: { duration: 0.6, delay: 0.07, refractory: 2.5, boost: 0.35 },
    spawn: { center: centre, spread: [Math.min(8, roost.size[0]! * 0.6), Math.min(2.5, roost.size[1]! * 0.6), Math.min(8, roost.size[2]! * 0.6)], heading: [frame.right[0] * -side * 0.6 + frame.back[0] * 0.8, 0, frame.right[2] * -side * 0.6 + frame.back[2] * 0.8] },
  };
}

function createMurmuration(ctx: EnvironmentContext, p: Murmuration) {
  const reduced = ctx.quality.reducedMotion;
  const mainCount = Math.min(3000, Math.max(60, scaledCount(p.count, ctx.quality.detail, ctx.quality.particles)));
  const boids = new Boids(murmurationConfig(p, mainCount, reduced));
  // The passing group: its roost sweeps between `away` and `at`.
  const pass = p.passing;
  const passCount = pass ? Math.min(800, scaledCount(pass.count, ctx.quality.detail, ctx.quality.particles)) : 0;
  const passAt = (t: number): SkyPoint => {
    const k = 0.5 - 0.5 * Math.cos((Math.PI * 2 * t) / pass!.period);
    return { azimuth: pass!.away + (pass!.at.azimuth - pass!.away) * k, elevation: pass!.at.elevation, distance: pass!.at.distance };
  };
  const passing = pass && passCount > 0 ? new Boids(murmurationConfig(p, passCount, reduced, { at: passAt(0), size: pass.size }, 977)) : null;
  const groups: { boids: Boids; offset: number }[] = [{ boids, offset: 0 }];
  if (passing) groups.push({ boids: passing, offset: mainCount });
  const count = mainCount + passCount;
  const side = p.roost.at.azimuth < 0 ? -1 : 1;
  const frame = skyFrame(p.roost.at);
  const outward: Vec3 = [frame.right[0] * side, 0, frame.right[2] * side];
  const ol = Math.hypot(outward[0], outward[2]) || 1;
  const falcon = new Falcon({ every: p.falcon.every, stoopSpeed: p.falcon.speed, cruiseSpeed: 16, radius: p.falcon.radius, above: p.falcon.above, side: [outward[0] / ol, 0, outward[2] / ol], seed: p.seed * 131 + 7 });
  const threat = boids.threats[0]!;
  const geometry = starlingGeometry();
  const rand = seeded(p.seed * 4421 + 5);

  // Instance n is the falcon. Per instance: A = position + bank, B = velocity + packed wingbeat
  // (phase + 8 × amplitude level), both rewritten after each simulation step; C = wingspan, seed,
  // kind (0 starling, 1 falcon), wingbeat rate factor.
  const n = count + 1;
  const aArr = new Float32Array(n * 4);
  const bArr = new Float32Array(n * 4);
  const cArr = new Float32Array(n * 4);
  const seeds = new Float32Array(n);
  const amp = new Float32Array(n);
  const phase = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    seeds[i] = rand();
    phase[i] = rand() * Math.PI * 2;
    amp[i] = 0.6;
    const falconRow = i === count;
    cArr.set([falconRow ? p.falcon.wingspan : p.wingspan[0] + (p.wingspan[1] - p.wingspan[0]) * rand(), seeds[i]!, falconRow ? 1 : 0, 0.85 + rand() * 0.3], i * 4);
  }
  const aBuf = new InstancedBufferAttribute(aArr, 4);
  const bBuf = new InstancedBufferAttribute(bArr, 4);
  aBuf.setUsage(DynamicDrawUsage);
  bBuf.setUsage(DynamicDrawUsage);
  const ia = instancedDynamicBufferAttribute<'vec4'>(aBuf, 'vec4');
  const ib = instancedDynamicBufferAttribute<'vec4'>(bBuf, 'vec4');
  const ic = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(cArr, 4), 'vec4');
  const u = { presence: floatUniform(1), lead: floatUniform(0) };
  const eyeU = uniform(vec3(...(p.eye as Vec3)));
  const sideU = floatUniform(side);
  const birdAttr = attribute<'vec4'>('bird', 'vec4');

  const vCover = varyingProperty('float', 'vBirdCover');
  const vDist = varyingProperty('float', 'vBirdDist');
  const posed = Fn(() => {
    // Between simulation steps each bird flies on along its velocity.
    const vel = ib.xyz;
    const speed = max(length(vel), 1e-4);
    const raw = ia.xyz.add(vel.mul(u.lead));
    const pos = guardNode(raw as V3, eyeU, sideU, p.clear, 2);
    const fwd = vel.div(speed);
    const right0 = normalize(vec3(fwd.z.negate(), 0, fwd.x).add(vec3(1e-4, 0, 0)));
    const up0 = cross(right0, fwd);
    // Bank from the lateral acceleration (computed on the CPU), plus a little individual roll.
    const roll = ia.w;
    const right = right0.mul(cos(roll)).sub(up0.mul(sin(roll)));
    const up = up0.mul(cos(roll)).add(right0.mul(sin(roll)));
    // Wingbeat: phase and amplitude packed by the CPU (amplitude 0 = gliding).
    const level = floor(ib.w.div(8));
    const flapSpeed = (reduced ? 0.6 : 1) * p.flapRate * Math.PI * 2;
    const ph = ib.w.sub(level.mul(8)).add(u.lead.mul(select(ic.z.greaterThan(0.5), float(4.5 * Math.PI * 2), ic.w.mul(flapSpeed))));
    const flap = level.div(10);
    const isWing = select(birdAttr.x.equal(1), float(1), float(0));
    const arm = float(0.06).add(flap.mul(sin(ph).mul(0.62).add(0.06))).mul(isWing);
    const hand = float(0.02).add(flap.mul(sin(ph.sub(0.9)).mul(0.4))).mul(isWing);
    // The falcon tucks its wings back in the stoop (when it stops flapping).
    const isFalcon = ic.z.greaterThan(0.5);
    const tuck = select(isFalcon, float(1).sub(flap).mul(isWing), float(0));
    const g = positionGeometry;
    const pre = vec3(g.x.mul(float(1).sub(tuck.mul(0.42))), g.y, g.z.add(abs(g.x).mul(tuck).mul(0.35)));
    const wing = foldWing(pre as V3, STARLING_WRIST, arm as F, hand as F);
    // Tiny birds are drawn at a minimum pixel size, with their coverage carried as opacity.
    const dist = length(pos.sub(cameraPosition));
    const span = ic.x;
    const drawn = max(span, pixelSize(dist as F).mul(p.minPixels));
    const cover = span.div(drawn);
    vCover.assign(cover.mul(cover));
    vDist.assign(dist);
    const l = wing.p.mul(drawn);
    return pos.add(right.mul(l.x)).add(up.mul(l.y)).sub(fwd.mul(l.z));
  })();

  const tone = ic.y.mul(0.16).add(0.92);
  const col = mix(colorUniform(p.color).mul(tone), colorUniform(p.hazeColor), hazeFactor(vDist, p.visibility));
  const material = new MeshBasicNodeMaterial();
  material.positionNode = posed;
  material.colorNode = vec4(col, 1);
  material.opacityNode = vCover.mul(u.presence).min(1);
  material.transparent = true;
  material.blending = NormalBlending;
  material.depthWrite = false;
  material.side = DoubleSide;
  // Flat, uniformly coloured silhouettes: one pass, not the back-then-front pair three.js uses
  // for double-sided transparency.
  material.forceSinglePass = true;
  material.fog = false;
  noBloom(material);
  const mesh = new Mesh(geometry, material);
  mesh.count = n;
  mesh.frustumCulled = false;
  mesh.name = 'murmuration';

  const reactive = { tempo: { value: 1 }, agitation: { value: 1 } };
  const centroid: Vec3 = [0, 0, 0];
  const flockVel: Vec3 = [0, 0, 0];
  let simClock = 0;
  let acc = 0;
  let simMs = 0;
  const glideAt = 1 - 2 * p.glide;

  /** Bank, wingbeat and instance data from the simulation state. */
  const publishGroup = (g: Boids, offset: number) => {
    const pos = g.pos;
    const vel = g.vel;
    const ac = g.acc;
    for (let b = 0; b < g.count; b++) {
      const i3 = b * 3;
      const i = offset + b;
      const vx = vel[i3]!;
      const vy = vel[i3 + 1]!;
      const vz = vel[i3 + 2]!;
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      const fx = vx / sp;
      const fy = vy / sp;
      const fz = vz / sp;
      // Bank: the lift (turn acceleration plus gravity) seen across the flight direction.
      const hl = Math.sqrt(fx * fx + fz * fz) || 1;
      const rx = -fz / hl;
      const rz = fx / hl;
      const ux = -rz * fy;
      const uy = rz * fx - rx * fz;
      const uz = rx * fy;
      const lx = ac[i3]!;
      const ly = ac[i3 + 1]! + GRAVITY;
      const lz = ac[i3 + 2]!;
      const bank = Math.atan2(lx * rx + lz * rz, lx * ux + ly * uy + lz * uz);
      // Wingbeat: faster and fuller when fast, climbing or escaping; gliding when calm and level.
      const panic = g.panic[b]!;
      const drive = Math.min(1, Math.max(0, 0.35 + (sp - p.speed) / (p.speed * 0.4) + vy * 0.15 + panic));
      const seed = seeds[i]!;
      const gliding = Math.sin(simClock * (0.5 + 0.4 * seed) + seed * 31) > glideAt && drive < 0.7;
      const target = gliding ? 0 : 0.55 + 0.45 * drive;
      amp[i] = amp[i]! + (target - amp[i]!) * 0.16;
      phase[i] = (phase[i]! + SIM_STEP * Math.PI * 2 * p.flapRate * cArr[i * 4 + 3]! * (0.85 + 0.3 * drive) * (reduced ? 0.6 : 1)) % (Math.PI * 2);
      aArr[i * 4] = pos[i3]!;
      aArr[i * 4 + 1] = pos[i3 + 1]!;
      aArr[i * 4 + 2] = pos[i3 + 2]!;
      aArr[i * 4 + 3] = bank;
      bArr[i * 4] = vx;
      bArr[i * 4 + 1] = vy;
      bArr[i * 4 + 2] = vz;
      bArr[i * 4 + 3] = phase[i]! + 8 * Math.round(amp[i]! * 10);
    }
  };
  const publish = () => {
    for (const g of groups) publishGroup(g.boids, g.offset);
    // The falcon: wings beating on the approach, tucked in the stoop.
    const f = count * 4;
    const fs = Math.hypot(falcon.vel[0], falcon.vel[1], falcon.vel[2]);
    const stooping = falcon.phase === 'stoop' && fs > p.falcon.speed * 0.7;
    amp[count] = amp[count]! + ((stooping ? 0 : 0.9) - amp[count]!) * 0.2;
    phase[count] = (phase[count]! + SIM_STEP * Math.PI * 2 * 4.5) % (Math.PI * 2);
    aArr[f] = falcon.pos[0];
    aArr[f + 1] = falcon.pos[1];
    aArr[f + 2] = falcon.pos[2];
    aArr[f + 3] = 0;
    bArr[f] = fs > 1e-3 ? falcon.vel[0] : 0;
    bArr[f + 1] = fs > 1e-3 ? falcon.vel[1] : 0;
    bArr[f + 2] = fs > 1e-3 ? falcon.vel[2] : -1;
    bArr[f + 3] = phase[count]! + 8 * Math.round(amp[count]! * 10);
    aBuf.needsUpdate = true;
    bBuf.needsUpdate = true;
  };

  // Spontaneous turns: now and then a bird at the edge swerves and the turn sweeps across the flock.
  let nextTurn = 4 + rand() * 6;
  const startleTurn = () => {
    // The bird farthest out along a random horizontal direction leads the turn.
    const a = rand() * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    let lead = 0;
    let best = -Infinity;
    for (let i = 0; i < mainCount; i += 7) {
      const d = (boids.pos[i * 3]! - centroid[0]) * dx + (boids.pos[i * 3 + 2]! - centroid[2]) * dz;
      if (d > best) {
        best = d;
        lead = i;
      }
    }
    // It turns left or right across its flight, with a little climb or dive.
    const vx = boids.vel[lead * 3]!;
    const vz = boids.vel[lead * 3 + 2]!;
    const turn = rand() < 0.5 ? -1 : 1;
    boids.startle(lead, [-vz * turn, (rand() - 0.5) * 3, vx * turn], reduced ? 0.25 : 0.45);
  };
  // Turns queued by a call-in (a startled flock), each a short while after the last.
  let calledTurns = 0;
  let calledTurnIn = 0;
  const step = () => {
    boids.centroid(centroid, flockVel);
    const rate = reactive.agitation.value * (reduced ? 0.35 : 1);
    falcon.update(SIM_STEP, centroid, flockVel, rate, threat);
    nextTurn -= SIM_STEP * Math.max(0.2, rate);
    if (nextTurn <= 0) {
      startleTurn();
      nextTurn = 5 + rand() * 9;
    }
    if (calledTurns > 0) {
      calledTurnIn -= SIM_STEP;
      if (calledTurnIn <= 0) {
        startleTurn();
        calledTurns--;
        calledTurnIn = 0.45 + rand() * 0.4;
      }
    }
    boids.step(SIM_STEP);
    if (passing) {
      const c = skyPoint(p.eye as Vec3, passAt(simClock));
      const centre = passing.config.bounds.center;
      centre[0] = c[0];
      centre[1] = c[1];
      centre[2] = c[2];
      passing.step(SIM_STEP);
    }
    simClock += SIM_STEP;
  };
  // Let the flock organise before it is first seen (two seconds of flight).
  for (let i = 0; i < 60; i++) step();
  publish();

  // Inspection aid (review captures, tests): simulation cost and the falcon.
  mesh.userData.sim = {
    boids,
    passing,
    falcon,
    get ms() {
      return simMs;
    },
    /** Fast-forwards the simulation (review captures). */
    advance(seconds: number) {
      for (let i = 0; i < seconds / SIM_STEP; i++) step();
      publish();
    },
  };

  return {
    object: mesh,
    reactive,
    /**
     * Event call-ins (since SDK 1.5): `burst` startles the flock, sending waves of turns through it
     * (`params.turns`, default 2 plus one per strength above 1, at most 4; one under reduced motion)
     * and, with `params.falcon` (default true) and a falcon configured, calls the falcon's stoop now.
     */
    onCall(call: CallInfo) {
      if (call.action !== 'burst' && call.action !== 'show') return;
      const asked = typeof call.params.turns === 'number' ? call.params.turns : 2 + Math.max(0, Math.round((call.strength - 1) * 2));
      calledTurns = Math.max(calledTurns, reduced ? 1 : Math.max(0, Math.min(4, Math.round(asked))));
      calledTurnIn = 0;
      if (call.params.falcon !== false) falcon.trigger();
    },
    update(frame: { dt: number }) {
      acc += Math.min(0.1, frame.dt) * reactive.tempo.value * (reduced ? 0.6 : 1);
      let steps = 0;
      const t0 = performance.now();
      while (acc >= SIM_STEP && steps < MAX_STEPS_PER_FRAME) {
        step();
        acc -= SIM_STEP;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) acc = Math.min(acc, SIM_STEP);
      if (steps > 0) {
        publish();
        simMs = simMs * 0.95 + (performance.now() - t0) * 0.05;
      }
      u.lead.value = acc;
    },
    setPresence(v: number) {
      u.presence.value = v;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Soaring raptors.
// ---------------------------------------------------------------------------------------------

function createSoaring(ctx: EnvironmentContext, p: Soaring) {
  const reduced = ctx.quality.reducedMotion;
  const rand = seeded(p.seed * 4253 + 3);
  const geometry = raptorGeometry();
  const eye = p.eye as Vec3;
  const n = p.birds.length;
  const a = new Float32Array(n * 4);
  const b = new Float32Array(n * 4);
  const c = new Float32Array(n * 4);
  const tracks: RaptorTrack[] = [];
  p.birds.forEach((bird, i) => {
    const tr = raptorTrack(eye, bird, rand() * 10);
    tracks.push(tr);
    a.set([tr.centre[0], tr.centre[1], tr.centre[2], tr.radius], i * 4);
    b.set([tr.omega, tr.phase, bird.wingspan, tr.seed], i * 4);
    c.set([tr.drift, tr.climb, p.flapEvery * (0.75 + rand() * 0.5), bird.at.azimuth < 0 ? -1 : 1], i * 4);
  });
  const ia = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(a, 4), 'vec4');
  const ib = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(b, 4), 'vec4');
  const ic = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(c, 4), 'vec4');
  const u = { presence: floatUniform(1), clock: floatUniform(rand() * 200) };
  const eyeU = uniform(vec3(...eye));
  const birdAttr = attribute<'vec4'>('bird', 'vec4');
  const normalAttr = attribute<'vec3'>('normal', 'vec3');

  const vNormal = varyingProperty('vec3', 'vRaptorNormal');
  const vWorld = varyingProperty('vec3', 'vRaptorWorld');
  const vLocalN = varyingProperty('vec3', 'vRaptorLocalN');
  const posed = Fn(() => {
    const t = u.clock;
    const seed = ib.w;
    const track = (tt: F): V3 => {
      const theta = ib.y.add(ib.x.mul(tt)).add(ib.x.mul(0.16 / 0.05).mul(sin(tt.mul(0.05).add(seed.mul(6)))));
      const rad = ia.w.mul(sin(tt.mul(0.031).add(seed.mul(11))).mul(0.15).add(1));
      const pos = vec3(
        ia.x.add(ic.x.mul(sin(tt.mul(0.011).add(seed.mul(5))))).add(rad.mul(cos(theta))),
        ia.y.add(ic.y.mul(sin(tt.mul(0.017).add(seed.mul(3))))),
        ia.z.add(ic.x.mul(0.7).mul(sin(tt.mul(0.008).add(seed.mul(9)).add(1)))).add(rad.mul(sin(theta))),
      ) as V3;
      return guardNode(pos, eyeU, ic.w, p.clear, 2.5);
    };
    const h = 0.25;
    const p0 = track(t.sub(h) as F);
    const p1 = track(t as F);
    const p2 = track(t.add(h) as F);
    const vel = p2.sub(p0).div(2 * h);
    const acc = p2.sub(p1.mul(2)).add(p0).div(h * h);
    const fwd = normalize(vel);
    // Bank: the wings carry the turn, so the bird's up follows lift = turn acceleration + gravity,
    // with the small, constant corrections of a bird riding rough air.
    const lift = acc.add(vec3(0, GRAVITY, 0));
    const up0 = normalize(lift.sub(fwd.mul(dot(lift, fwd))));
    const r0 = cross(fwd, up0);
    const wobble = sin(t.mul(1.7).add(seed.mul(13))).mul(0.045).add(sin(t.mul(3.3).add(seed.mul(7))).mul(0.025));
    const right = r0.mul(cos(wobble)).add(up0.mul(sin(wobble)));
    const up = up0.mul(cos(wobble)).sub(r0.mul(sin(wobble)));
    const bank = abs(atan(dot(acc, r0), float(GRAVITY)));
    // Rare flapping bouts: a few deep, slow beats, otherwise wings held in a shallow V.
    const period = ic.z;
    const tc = mod(t.add(seed.mul(period).mul(0.37)), period);
    const bout = smoothstep(0, 0.35, tc).mul(float(1).sub(smoothstep(2.1, 2.7, tc)));
    const beat = tc.mul(Math.PI * 2 * 1.6);
    const arm = float(0.11).add(bout.mul(sin(beat).mul(0.5).add(0.05))).add(sin(t.mul(2.3).add(seed)).mul(0.012));
    const hand = float(-0.04).add(bout.mul(sin(beat.sub(0.7)).mul(0.3))).add(sin(t.mul(3.1).add(seed.mul(3))).mul(0.02));
    const part = birdAttr.x;
    const isWing = part.equal(1).or(part.equal(2));
    const isTail = part.equal(3);
    const g = positionGeometry;
    // Tail fans out in the turns; finger tips curl up under the load of soaring.
    const fan = bank.mul(0.9).add(0.8).min(1.15);
    const tailP = vec3(g.x.mul(fan), g.y, g.z);
    const curl = birdAttr.z.mul(birdAttr.z).mul(birdAttr.w).mul(float(0.42).sub(bout.mul(0.2)));
    const fingerP = vec3(g.x, g.y.add(curl), g.z);
    const pre = select(isTail, tailP, select(part.equal(2), fingerP, g)) as V3;
    const wing = foldWing(pre, RAPTOR_WRIST, select(isWing, arm, float(0)) as F, select(isWing, hand, float(0)) as F);
    const ang = wing.angle;
    const nWing = vec3(sin(ang).negate(), cos(ang), 0);
    const localN = select(part.equal(0), normalAttr, nWing) as V3;
    const span = ib.z;
    const l = wing.p.mul(span);
    const toWorld = (q: V3): V3 => right.mul(q.x).add(up.mul(q.y)).sub(fwd.mul(q.z)) as V3;
    const world = p1.add(toWorld(l as V3));
    vNormal.assign(toWorld(localN));
    vLocalN.assign(vec3(localN.x, localN.y, birdAttr.y));
    vWorld.assign(world);
    return world;
  })();

  // ---- Shading: two-sided plumage, sun and sky light, feathers glowing when backlit. ----
  const part = birdAttr.x;
  const chord = birdAttr.y;
  const view = normalize(cameraPosition.sub(vWorld));
  const nRaw = normalize(vNormal);
  const facing = dot(nRaw, view);
  const nF = select(facing.lessThan(0), nRaw.negate(), nRaw);
  // Which side we see: for panels the top is +normal; for the body, the upper half by its normal.
  const isBody = part.equal(0);
  const topSide = select(isBody, vLocalN.y.greaterThan(-0.1), facing.greaterThan(0));
  const g = positionGeometry;
  const head = smoothstep(-0.1, -0.135, g.z).mul(select(isBody, float(1), float(0)));
  const coverts = select(part.equal(1), float(1).sub(smoothstep(COVERT_EDGE - 0.08, COVERT_EDGE + 0.04, chord)).mul(smoothstep(0.32, 0.26, abs(g.x))), float(0));
  const isFlight = select(part.equal(2), float(1), select(part.equal(1), smoothstep(COVERT_EDGE, COVERT_EDGE + 0.1, chord), float(0)));
  const upperAlbedo = mix(mix(mix(colorUniform(p.plumage), colorUniform(p.coverts), coverts), colorUniform(p.flight), isFlight), colorUniform(p.nape), head.mul(0.85));
  const trailingBand = smoothstep(0.86, 0.97, chord).mul(select(part.equal(1), float(1), float(0)));
  const underFlight = mix(colorUniform(p.underFlight), colorUniform(p.flight), trailingBand.mul(0.8));
  const lowerAlbedo = mix(colorUniform(p.under), underFlight, isFlight.add(select(part.equal(3), float(0.5), float(0))).min(1));
  const albedo = select(topSide, upperAlbedo, lowerAlbedo);
  const sunDir = skyDirection(p.sun.azimuth, p.sun.elevation);
  const L = vec3(...sunDir);
  const ndl = dot(nF, L);
  const direct = colorUniform(p.sunColor, p.sunIntensity).mul(max(ndl, 0));
  const ambient = mix(colorUniform(p.ground), colorUniform(p.sky), nF.y.mul(0.5).add(0.5)).mul(p.ambient);
  const thin = isFlight.add(select(part.equal(3), float(0.6), float(0))).min(1);
  const glow = colorUniform(p.sunColor, p.sunIntensity).mul(max(ndl.negate(), 0).mul(p.translucency).mul(thin));
  const lit = albedo.mul(direct.add(ambient).add(glow.mul(1.6)));
  const dist = length(cameraPosition.sub(vWorld));
  const shaded = mix(lit, colorUniform(p.hazeColor), hazeFactor(dist as F, p.visibility));
  const material = new MeshBasicNodeMaterial();
  material.positionNode = posed;
  material.colorNode = vec4(shaded, 1);
  material.opacityNode = revealMask(u.presence);
  material.alphaTest = 0.5;
  material.side = DoubleSide;
  material.fog = false;
  noBloom(material);
  const mesh = new Mesh(geometry, material);
  mesh.count = n;
  mesh.frustumCulled = false;
  mesh.name = 'soaring-raptors';
  // Inspection aid (review captures, tests): where each bird's circle puts it right now.
  mesh.userData.positions = () => tracks.map((tr) => raptorPosition(tr, u.clock.value));

  return {
    object: mesh,
    reactive: {},
    update(frame: { dt: number }) {
      u.clock.value += Math.min(0.1, frame.dt) * (reduced ? 0.6 : 1);
    },
    setPresence(v: number) {
      u.presence.value = v;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * Birds in the sky, kept out of the clear zone around the board, one instanced draw call per layer.
 *
 * - `murmuration`: a starling flock simulated as boids on the CPU (see `../flocking/boids.ts`) at a
 *   fixed 30 Hz: each bird follows its 7 nearest neighbours (topological interaction, as measured in
 *   real flocks), the flock wheels over a soft roost in its patch of sky and steers clear of the board,
 *   a peregrine stoops on it now and then (more often in intense music sections, never on beats) and
 *   escape waves sweep across it, flash-compressing and stretching it; spontaneous turns spread from
 *   its edge. Positions, velocities, banks (from lateral acceleration) and wingbeats (by speed, climb
 *   and panic, gliding when calm) are uploaded per step; the shader flies each bird on between steps.
 *   Sub-pixel birds are drawn at a minimum size with their coverage as opacity, so density reads
 *   without shimmer.
 * - `soaring`: a few raptors circling in drifting thermals with broad wings held in a shallow V,
 *   seven fingered primaries curled up at the tips, a fanned tail, banking by the physics of the
 *   turn and flapping only in rare short bouts; posed entirely in the vertex stage from time, lit by
 *   the photograph's sun, dark from below, with flight feathers glowing when backlit.
 */
export const birdFlockComponent: ComponentFactory<Params> = {
  type: 'birdFlock',
  version: 1,
  description: 'Birds in the sky: a boids-simulated starling murmuration with a hunting falcon, or raptors circling on thermals.',
  schema,
  create(ctx, p) {
    return p.kind === 'murmuration' ? createMurmuration(ctx, p) : createSoaring(ctx, p);
  },
};
