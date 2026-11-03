import { BufferAttribute, BufferGeometry, DoubleSide, InstancedBufferAttribute, Mesh, MeshBasicNodeMaterial, Vector4, type Node } from 'three/webgpu';
import {
  Fn,
  abs,
  attribute,
  cameraPosition,
  cos,
  cross,
  dot,
  float,
  fract,
  instancedBufferAttribute,
  length,
  max,
  mix,
  mrt,
  mx_noise_vec3,
  normalGeometry,
  normalize,
  positionGeometry,
  reflect,
  select,
  sin,
  smoothstep,
  uniformArray,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { vec4At } from '../../creatures/rig';
import { colorUniform, floatUniform, seeded, zColor, zVec3 } from './common';
import { revealMask } from './reveal';

const schoolSchema = z.object({
  /** Centre of the school's loop. */
  center: zVec3,
  /** Loop half-extents: x and z radii of the horizontal loop, y = vertical undulation. */
  radius: zVec3.default([40, 4, 18]),
  /** Swimming speed (world units per second). */
  speed: z.number().positive().default(6),
  /** Share of the fish in this school (relative weight). */
  share: z.number().positive().default(1),
  clockwise: z.boolean().default(false),
  /** Where on its loop the school starts (0..1). */
  start: z.number().min(0).max(1).default(0),
});

const schema = z.object({
  /** Fish in total, spread over the schools by share. */
  count: z.number().int().min(1).max(800).default(260),
  schools: z.array(schoolSchema).min(1).max(4),
  /** School extent: length along the travel direction, height, width (world units). */
  shape: zVec3.default([22, 6, 12]),
  /** Fish body length range (world units). */
  length: z.tuple([z.number().positive(), z.number().positive()]).default([1.5, 2.1]),
  /** Countershading: dark back, silver flanks, white belly. */
  back: zColor.default('#1d3644'),
  flank: zColor.default('#a6b8c2'),
  belly: zColor.default('#dfe9ee'),
  /** Water colours the silver flanks mirror: the dark depths below and the lit surface above. */
  deep: zColor.default('#03121a'),
  surface: zColor.default('#7cc2d8'),
  /** Downwelling light on the bodies. */
  light: z.number().min(0).default(0.7),
  /** Strength of the silver flash when a flank turns to catch the light. */
  flash: z.number().min(0).default(1.6),
  flashColor: zColor.default('#e6fbff'),
  /** Patchiness of the scale reflections (0 = mirror-smooth flanks). */
  shimmer: z.number().min(0).max(1).default(0.5),
  /** Bank into turns (radians per unit of curvature × loop size). */
  bank: z.number().min(0).default(1),
  /** Tail beats per body length travelled. */
  beat: z.number().positive().default(1.4),
  bloom: z.number().min(0).default(0.12),
  seed: z.number().default(1),
});

type Params = z.infer<typeof schema>;
type School = z.infer<typeof schoolSchema>;
type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Body profile of a herring-like fish, unit length: (a along 0 snout..1 tail, half height, half width, centre y). */
const PROFILE: [number, number, number, number][] = [
  [0, 0, 0, -0.012],
  [0.02, 0.017, 0.011, -0.013],
  [0.06, 0.042, 0.026, -0.011],
  [0.13, 0.073, 0.042, -0.009],
  [0.22, 0.097, 0.054, -0.01],
  [0.34, 0.101, 0.053, -0.011],
  [0.48, 0.09, 0.045, -0.008],
  [0.62, 0.066, 0.031, -0.003],
  [0.74, 0.041, 0.018, 0.001],
  [0.82, 0.027, 0.012, 0.002],
  [0.86, 0.025, 0.011, 0.002],
];

/** Catmull-Rom through the profile stations. */
function profileAt(a: number): [number, number, number] {
  const n = PROFILE.length;
  let i = 0;
  while (i < n - 2 && a > PROFILE[i + 1]![0]) i++;
  const p0 = PROFILE[Math.max(0, i - 1)]!;
  const p1 = PROFILE[i]!;
  const p2 = PROFILE[i + 1]!;
  const p3 = PROFILE[Math.min(n - 1, i + 2)]!;
  const t = Math.min(1, Math.max(0, (a - p1[0]) / (p2[0] - p1[0])));
  const cr = (k: 1 | 2 | 3): number => {
    const v0 = p0[k];
    const v1 = p1[k];
    const v2 = p2[k];
    const v3 = p3[k];
    return 0.5 * (2 * v1 + (-v0 + v2) * t + (2 * v0 - 5 * v1 + 4 * v2 - v3) * t * t + (-v0 + 3 * v1 - 3 * v2 + v3) * t * t * t);
  };
  return [Math.max(0, cr(1)), Math.max(0, cr(2)), cr(3)];
}

/**
 * One fish of unit length facing −Z, +Y up. Vertex attribute `fish` = (along 0 snout..1 tail tip,
 * part, height, 0): part 0 body, 1 tail fin, 2 other fins; height −1 belly .. 1 back on the body.
 */
export function fishGeometry(): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const fish: number[] = [];
  const idx: number[] = [];
  const RINGS = 24;
  const AROUND = 14;
  const z = (a: number) => a - 0.5;
  // Body: lofted elliptical rings, a single vertex at the snout.
  pos.push(0, profileAt(0)[2], z(0));
  nrm.push(0, 0, -1);
  fish.push(0, 0, 0, 0);
  for (let i = 1; i <= RINGS; i++) {
    // Rings bunch up at the rounded snout.
    const a = 0.86 * Math.pow(i / RINGS, 1.35);
    const [hh, hw, yc] = profileAt(a);
    for (let j = 0; j < AROUND; j++) {
      const phi = (j / AROUND) * Math.PI * 2;
      // A slightly deeper, keeled belly and a rounder back.
      const sy = Math.sin(phi);
      const yy = sy < 0 ? sy * 1.04 : sy;
      pos.push(Math.cos(phi) * hw, yc + yy * hh, z(a));
      nrm.push(0, 0, 0);
      fish.push(a, 0, sy, 0);
    }
  }
  for (let j = 0; j < AROUND; j++) idx.push(0, 1 + ((j + 1) % AROUND), 1 + j);
  for (let i = 0; i < RINGS - 1; i++) {
    for (let j = 0; j < AROUND; j++) {
      const a = 1 + i * AROUND + j;
      const b = 1 + i * AROUND + ((j + 1) % AROUND);
      idx.push(a, b, b + AROUND, a, b + AROUND, a + AROUND);
    }
  }
  // Close the peduncle with a cap.
  const capCentre = pos.length / 3;
  const [, , ycEnd] = profileAt(0.86);
  pos.push(0, ycEnd, z(0.86));
  nrm.push(0, 0, 1);
  fish.push(0.86, 0, 0, 0);
  const last = 1 + (RINGS - 1) * AROUND;
  for (let j = 0; j < AROUND; j++) idx.push(capCentre, last + j, last + ((j + 1) % AROUND));
  const bodyEnd = pos.length / 3;
  // Smooth body normals from the faces.
  const geoBody = new BufferGeometry();
  geoBody.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geoBody.setIndex(idx.slice());
  geoBody.computeVertexNormals();
  const bn = geoBody.getAttribute('normal');
  for (let v = 0; v < bodyEnd; v++) nrm.splice(v * 3, 3, bn.getX(v), bn.getY(v), bn.getZ(v));
  geoBody.dispose();

  /** A flat fin as a fan around its first point; every vertex gets the plane normal. */
  const fin = (points: [number, number, number][], part: number) => {
    const p0 = points[0]!;
    const p1 = points[1]!;
    const p2 = points[2]!;
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const start = pos.length / 3;
    for (const [x, y, zz] of points) {
      pos.push(x, y, zz);
      nrm.push(nx, ny, nz);
      fish.push(Math.min(1, Math.max(0, zz + 0.5)), part, 0, 0);
    }
    for (let k = 1; k < points.length - 1; k++) idx.push(start, start + k, start + k + 1);
  };
  // Forked tail fin (vertical plane), fanned from the peduncle.
  fin(
    [
      [0, 0.002, 0.345],
      [0, -0.024, 0.355],
      [0, -0.07, 0.42],
      [0, -0.128, 0.505],
      [0, -0.1, 0.5],
      [0, -0.05, 0.465],
      [0, 0.002, 0.43],
      [0, 0.055, 0.468],
      [0, 0.108, 0.502],
      [0, 0.138, 0.508],
      [0, 0.075, 0.422],
      [0, 0.028, 0.355],
    ],
    1,
  );
  // Dorsal fin, swept back, on the highest part of the back.
  const top = (a: number) => {
    const [hh, , yc] = profileAt(a);
    return yc + hh * 0.96;
  };
  fin(
    [
      [0, top(0.4) - 0.01, z(0.4)],
      [0, top(0.4) + 0.075, z(0.44)],
      [0, top(0.5) + 0.03, z(0.53)],
      [0, top(0.55) - 0.01, z(0.55)],
    ],
    2,
  );
  // Anal fin under the rear body.
  const bottom = (a: number) => {
    const [hh, , yc] = profileAt(a);
    return yc - hh * 1.0;
  };
  fin(
    [
      [0, bottom(0.66) + 0.008, z(0.66)],
      [0, bottom(0.78) + 0.006, z(0.78)],
      [0, bottom(0.77) - 0.022, z(0.775)],
      [0, bottom(0.68) - 0.03, z(0.7)],
    ],
    2,
  );
  // Pectoral and pelvic fins, angled down and back from the lower flanks.
  for (const side of [-1, 1]) {
    const [hh, hw, yc] = profileAt(0.2);
    fin(
      [
        [side * hw * 0.9, yc - hh * 0.45, z(0.19)],
        [side * hw * 0.85, yc - hh * 0.55, z(0.23)],
        [side * (hw + 0.035), yc - hh * 0.95, z(0.33)],
        [side * (hw + 0.03), yc - hh * 0.75, z(0.31)],
      ],
      2,
    );
    const [hh2, hw2, yc2] = profileAt(0.5);
    fin(
      [
        [side * hw2 * 0.5, yc2 - hh2 * 0.9, z(0.49)],
        [side * hw2 * 0.45, yc2 - hh2 * 0.92, z(0.53)],
        [side * (hw2 * 0.6 + 0.012), yc2 - hh2 - 0.03, z(0.58)],
      ],
      2,
    );
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('fish', new BufferAttribute(new Float32Array(fish), 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Loop point and tangent (the same formula as the shader). */
export function loopPoint(s: School, phaseA: number, phaseB: number, tau: number): { p: [number, number, number]; d: [number, number, number] } {
  const [rx, ry, rz] = s.radius;
  const [cx, cy, cz] = s.center;
  return {
    p: [cx + rx * (Math.cos(tau) + 0.18 * Math.cos(2 * tau + phaseA)), cy + ry * Math.sin(2 * tau + phaseB), cz + rz * (Math.sin(tau) + 0.12 * Math.sin(3 * tau + phaseA + phaseB))],
    d: [rx * (-Math.sin(tau) - 0.36 * Math.sin(2 * tau + phaseA)), 2 * ry * Math.cos(2 * tau + phaseB), rz * (Math.cos(tau) + 0.36 * Math.cos(3 * tau + phaseA + phaseB))],
  };
}

/**
 * Schools of silver fish with real bodies: a lofted, laterally compressed body with a herring's side
 * profile, a forked tail, dorsal, anal, pectoral and pelvic fins. Countershaded (dark back, white
 * belly) with mirror-like silver flanks that reflect the dark depths or the lit surface and flash
 * when a flank turns into the light; scale patches make the flash ripple along the body.
 *
 * Every fish swims with a travelling body wave whose amplitude grows towards the tail and whose
 * rate follows the distance swum. A school follows a smooth loop: each fish follows the same loop
 * a little behind or ahead of the school centre according to its place in the school, so the whole
 * school flows through turns like a ribbon, every fish aligned with its own direction of travel and
 * banking into the turn. One instanced draw call; the CPU only advances one loop parameter per school.
 */
export const fishSchoolComponent: ComponentFactory<Params> = {
  type: 'fishSchool',
  version: 1,
  description: 'Schools of silver 3D fish with countershading, flank flashes, swimming body waves and flowing turns.',
  schema,
  create(ctx, p) {
    const detail = ctx.quality.detail === 'low' ? 0.45 : ctx.quality.detail === 'medium' ? 0.75 : 1;
    const count = Math.max(p.schools.length, Math.round(p.count * detail));
    const rand = seeded(p.seed * 6151 + 7);
    const geometry = fishGeometry();
    // Fish per school by share.
    const totalShare = p.schools.reduce((t, s) => t + s.share, 0);
    const schoolOf: number[] = [];
    p.schools.forEach((s, k) => {
      const n = k === p.schools.length - 1 ? count - schoolOf.length : Math.round((count * s.share) / totalShare);
      for (let i = 0; i < n; i++) schoolOf.push(k);
    });
    // Per fish: place in the school (along, up, side in -1..1, denser towards the core), seed;
    // length, school, beat factor, tone.
    const a = new Float32Array(count * 4);
    const b = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      let x: number;
      let y: number;
      let zz: number;
      do {
        x = rand() * 2 - 1;
        y = rand() * 2 - 1;
        zz = rand() * 2 - 1;
      } while (x * x + y * y + zz * zz > 1);
      // Thinner at the head and tail of the school, a little denser towards the core.
      const core = 0.75 + 0.25 * Math.sqrt(x * x + y * y + zz * zz);
      a.set([x * core, y * core * (1 - 0.35 * x * x), zz * core * (1 - 0.3 * x * x), rand()], i * 4);
      b.set([p.length[0] + (p.length[1] - p.length[0]) * rand(), schoolOf[i] ?? 0, 0.9 + rand() * 0.2, rand()], i * 4);
    }
    const fa = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(a, 4), 'vec4');
    const fb = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(b, 4), 'vec4');

    // Per school: loop parameter, distance swum, direction, metres per radian; centre + phase A;
    // radii + phase B.
    const phases = p.schools.map(() => [rand() * Math.PI * 2, rand() * Math.PI * 2] as [number, number]);
    const metresPerRadian = p.schools.map((s, k) => {
      let sum = 0;
      const n = 64;
      for (let i = 0; i < n; i++) {
        const d = loopPoint(s, phases[k]![0], phases[k]![1], (i / n) * Math.PI * 2).d;
        sum += Math.hypot(d[0], d[1], d[2]);
      }
      return sum / n;
    });
    const stateValues = p.schools.map((s, k) => new Vector4(s.start * Math.PI * 2, rand() * 50, s.clockwise ? -1 : 1, metresPerRadian[k]));
    const centreValues = p.schools.map((s, k) => new Vector4(s.center[0], s.center[1], s.center[2], phases[k]![0]));
    const radiusValues = p.schools.map((s, k) => new Vector4(s.radius[0], s.radius[1], s.radius[2], phases[k]![1]));
    const schoolState = uniformArray(stateValues, 'vec4');
    const schoolCentre = uniformArray(centreValues, 'vec4');
    const schoolRadius = uniformArray(radiusValues, 'vec4');
    const u = { presence: floatUniform(1), flash: floatUniform(p.flash), tempo: floatUniform(1) };
    const time = ctx.uniforms.time;
    const fishAttr = attribute<'vec4'>('fish', 'vec4');

    const vNormal = varyingProperty('vec3', 'vFishNormal');
    const vWorld = varyingProperty('vec3', 'vFishWorld');
    const posed = Fn(() => {
      const t = time as unknown as F;
      const k = fb.y.toInt();
      const st = vec4At(schoolState, k);
      const ce = vec4At(schoolCentre, k);
      const ra = vec4At(schoolRadius, k);
      const seed = fa.w;
      const len = fb.x;
      const dir = st.z;
      const [shapeL, shapeH, shapeW] = p.shape;
      // Each fish follows the loop ahead of or behind the school centre by its place in the school.
      const tau = st.x.add(dir.mul(fa.x.mul(shapeL * 0.5).div(st.w)));
      const loopAt = (tt: F): { p: V3; d: V3 } => ({
        p: vec3(
          ce.x.add(ra.x.mul(cos(tt).add(cos(tt.mul(2).add(ce.w)).mul(0.18)))),
          ce.y.add(ra.y.mul(sin(tt.mul(2).add(ra.w)))),
          ce.z.add(ra.z.mul(sin(tt).add(sin(tt.mul(3).add(ce.w).add(ra.w)).mul(0.12)))),
        ) as V3,
        d: vec3(
          ra.x.mul(sin(tt).negate().sub(sin(tt.mul(2).add(ce.w)).mul(0.36))),
          ra.y.mul(2).mul(cos(tt.mul(2).add(ra.w))),
          ra.z.mul(cos(tt).add(cos(tt.mul(3).add(ce.w).add(ra.w)).mul(0.36))),
        ) as V3,
      });
      const here = loopAt(tau as F);
      const ahead = loopAt(tau.add(dir.mul(0.06)) as F);
      const fwd0 = normalize(here.d.mul(dir));
      const fwd1 = normalize(ahead.d.mul(dir));
      // Signed turn rate → bank into the turn.
      const turn = cross(fwd0, fwd1).y.div(st.w.mul(0.06));
      const up = vec3(0, 1, 0);
      const side0 = normalize(cross(fwd0, up));
      const up0 = cross(side0, fwd0);
      // The school breathes and each fish weaves a little around its slot.
      const breathe = sin(t.mul(0.19).add(fa.x.mul(2.1)).add(fb.y.mul(1.7))).mul(0.12).add(1);
      const weave = vec3(sin(t.mul(0.37).add(seed.mul(31))), sin(t.mul(0.29).add(seed.mul(17))), sin(t.mul(0.33).add(seed.mul(47)))).mul(len.mul(0.35));
      const centre = here.p
        .add(side0.mul(fa.z.mul(shapeW * 0.5).mul(breathe)))
        .add(up0.mul(fa.y.mul(shapeH * 0.5).mul(breathe)))
        .add(weave);
      // Heading: the loop direction with a small individual yaw wobble.
      const wobble = sin(t.mul(0.53).add(seed.mul(9))).mul(0.12).add(sin(t.mul(1.3).add(seed.mul(23))).mul(0.04));
      const fwd = normalize(fwd0.add(side0.mul(wobble)));
      const roll = max(float(-0.6), turn.mul(-p.bank).mul(st.w).min(0.6)).add(sin(t.mul(0.7).add(seed.mul(5))).mul(0.06));
      const right0 = normalize(cross(fwd, up));
      const upF0 = cross(right0, fwd);
      const right = right0.mul(cos(roll)).add(upF0.mul(sin(roll)));
      const upF = upF0.mul(cos(roll)).sub(right0.mul(sin(roll)));
      // Swimming wave: amplitude grows towards the tail; phase advances with distance swum.
      const g = positionGeometry;
      const along = fishAttr.x;
      const part = fishAttr.y;
      const beatPhase = st.y.mul(p.beat * Math.PI * 2).div(len).mul(fb.z).add(seed.mul(Math.PI * 2));
      const k2 = Math.PI * 2 * 0.95;
      const wave = along.mul(k2).sub(beatPhase);
      const ampMax = 0.075;
      const amp = along.mul(along).mul(ampMax * 0.9).add(ampMax * 0.12);
      const tailFlex = select(part.equal(1), along.sub(0.84).max(0).mul(0.6), float(0));
      const sway = amp.mul(sin(wave)).add(tailFlex.mul(cos(wave)));
      const slope = along.mul(ampMax * 1.8).mul(sin(wave)).add(amp.mul(k2).mul(cos(wave)));
      const local = vec3(g.x.add(sway), g.y, g.z);
      const n0 = normalGeometry;
      const localN = normalize(vec3(n0.x, n0.y, n0.z.sub(slope.mul(n0.x))));
      // Fish space (x right, y up, z back) → world.
      const toWorld = (v: V3): V3 => right.mul(v.x).add(upF.mul(v.y)).sub(fwd.mul(v.z)) as V3;
      const world = centre.add(toWorld(local.mul(len) as V3)) as V3;
      vNormal.assign(toWorld(localN as V3));
      vWorld.assign(world);
      return world;
    })();

    // ---- Shading: countershading, downwelling light, silver mirror, flash, scale patches. ----
    const along = fishAttr.x;
    const part = fishAttr.y;
    const nLocal = normalGeometry;
    const seed = fa.w;
    const view = normalize(cameraPosition.sub(vWorld));
    const n1 = normalize(vNormal);
    const n = select(dot(n1, view).lessThan(0), n1.negate(), n1);
    const isBody = part.lessThan(0.5);
    // Countershading by height on the body: a dark back above a fairly sharp line, silver flanks,
    // a white belly (normals tilt up quickly on a deep, narrow body, so height reads truer).
    const height = fishAttr.z;
    const bodyMask = select(isBody, float(1), float(0));
    const dorsal = smoothstep(0.42, 0.72, height).mul(bodyMask);
    const belly = smoothstep(-0.35, -0.8, height).mul(bodyMask);
    const albedo = mix(mix(colorUniform(p.flank), colorUniform(p.back), dorsal), colorUniform(p.belly), belly).mul(fb.w.mul(0.2).add(0.9));
    // Fins: thin and dusky (a hint of the back colour), no mirror.
    const finTone = mix(colorUniform(p.back), colorUniform(p.flank), 0.55).mul(0.75);
    const hemi = mix(float(0.3), float(1), n.y.mul(0.5).add(0.5));
    const diffuse = select(isBody, albedo, finTone).mul(hemi).mul(p.light);
    // Silver flanks mirror the water: dark depths below the horizon, the lit surface above. Scale
    // patches tilt the mirror a little, so reflections break up and ripple along a bending body.
    const silver = float(1).sub(dorsal.mul(0.85)).mul(select(isBody, float(1), float(0.15)));
    const patches = mx_noise_vec3(vec3(along.mul(9), height.mul(3), seed.mul(17))).mul(p.shimmer * 0.5);
    const ns = normalize(n.add(patches));
    const r = reflect(view.negate(), ns);
    const env = mix(colorUniform(p.deep), colorUniform(p.surface), smoothstep(-0.6, 0.85, r.y));
    const ndv = abs(dot(n, view));
    const mirror = env.mul(silver).mul(float(1).sub(ndv).mul(0.35).add(0.65));
    // Flash: a flank turned to send the light (from above, over the viewer's shoulder) back to the
    // viewer. Broadside fish catch it along the upper flank; turning away kills it, so a turning
    // school flashes in a wave.
    const lightDir = normalize(vec3(0.1, 0.8, 0.6));
    const half = normalize(view.add(lightDir));
    const glint = max(dot(ns, half), 0).pow(16);
    const flash = colorUniform(p.flashColor).mul(glint.mul(u.flash).mul(silver));
    // A row of faint dark spots on the upper flank (sardine-like) and the eye.
    const g = positionGeometry;
    const spotUV = vec3(fract(along.mul(24)).sub(0.5).mul(2), height.sub(0.36).mul(8), 0);
    const spots = smoothstep(0.75, 0.35, length(spotUV)).mul(smoothstep(0.18, 0.24, along)).mul(smoothstep(0.62, 0.5, along)).mul(0.3).mul(bodyMask);
    const eyeD = length(vec3(g.y.sub(0.01), g.z.sub(-0.44), 0));
    const eye = smoothstep(0.02, 0.014, eyeD).mul(abs(nLocal.x).greaterThan(0.35).select(float(1), float(0))).mul(bodyMask);
    const pupil = smoothstep(0.009, 0.006, eyeD);
    const markings = float(1).sub(spots).mul(float(1).sub(eye.mul(0.8)));
    const iris = colorUniform(p.flashColor).mul(eye.sub(pupil).max(0).mul(0.12));
    const shaded = diffuse.add(mirror).mul(markings).add(flash.mul(float(1).sub(eye))).add(iris);
    const material = new MeshBasicNodeMaterial();
    material.positionNode = posed;
    material.colorNode = vec4(shaded, 1);
    material.opacityNode = revealMask(u.presence);
    material.alphaTest = 0.5;
    material.side = DoubleSide;
    material.mrtNode = mrt({ emissive: vec4(flash.mul(p.bloom), 1) });
    const mesh = new Mesh(geometry, material);
    mesh.count = count;
    mesh.frustumCulled = false;

    const reduced = ctx.quality.reducedMotion;
    const dLoop = (k: number, tau: number): number => {
      const d = loopPoint(p.schools[k]!, phases[k]![0], phases[k]![1], tau).d;
      return Math.hypot(d[0], d[1], d[2]);
    };
    return {
      object: mesh,
      reactive: { flash: u.flash, tempo: u.tempo },
      update(frame) {
        const dt = Math.min(0.1, frame.dt) * (reduced ? 0.5 : 1) * u.tempo.value;
        p.schools.forEach((s, k) => {
          const st = stateValues[k]!;
          // Constant swimming speed along the loop.
          st.x += (st.z * dt * s.speed) / Math.max(1e-3, dLoop(k, st.x));
          st.y += dt * s.speed;
        });
      },
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
