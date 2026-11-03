import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicNodeMaterial, type Texture } from 'three/webgpu';
import {
  Fn,
  atan,
  attribute,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  max,
  mix,
  mx_noise_float,
  mx_worley_noise_vec2,
  normalize,
  normalWorld,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  refract,
  sin,
  smoothstep,
  texture,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { colorUniform, floatUniform, noBloom, z, zColor, type ComponentFactory } from '@prismfall/sdk';
import { loadTexture, palmShade, sampleEnvironment, sampleEnvironmentLevel, skyDirection, windVector, zEnvironment, zSkyDirection, zWind, type F, type V2, type V3 } from './env';

/**
 * Tradewind Cove's shore and lagoon: low sand islands with wet margins, a wrack line and scrub, and
 * a living lagoon over a sand floor: clear turquoise shallows with caustics, deepening to blue,
 * a reef line where the ocean swell breaks, and deep water beyond that hands over to the
 * photograph's own sea at the horizon. The floor is one analytic height function, shared by the
 * island meshes (CPU), the water's depth colour (GPU) and the ground the palms stand on.
 */

const DEG = Math.PI / 180;
const sq = (x: F): F => x.mul(x) as F;

const islandSchema = z.object({
  center: z.tuple([z.number(), z.number()]),
  /** Semi-axes of the island's shoreline ellipse (m). */
  radius: z.tuple([z.number().positive(), z.number().positive()]),
  /** Rotation of the ellipse (degrees). */
  angle: z.number().default(0),
  /** Height of the beach crest above the water (m). */
  height: z.number().positive().default(1.6),
  /** Distance over which the beach rises from the water (m). */
  beach: z.number().positive().default(12),
  /** Shoreline irregularity (fraction of the radius). */
  wobble: z.number().min(0).max(0.3).default(0.06),
  /** Low scrub covering the interior beyond the beach (0 bare sand .. 1 dense). */
  scrub: z.number().min(0).max(1).default(0),
  seed: z.number().default(1),
});
type Island = z.infer<typeof islandSchema>;

const schema = z.object({
  /** Water level (m). Bindable `tide` raises it (m). */
  y: z.number().default(-12),
  /** Where the viewer stands on the ground plane (x, z): the lagoon deepens and the reef curves around it. */
  viewer: z.tuple([z.number(), z.number()]).default([0, 30]),
  islands: z.array(islandSchema).max(8).default([]),
  lagoon: z
    .object({
      /** Depth near the viewer and in the middle of the lagoon (m), reached at `deepAt` m. */
      shallow: z.number().positive().default(0.9),
      deep: z.number().positive().default(6),
      deepAt: z.number().positive().default(220),
    })
    .prefault({}),
  reef: z
    .object({
      /** Distance of the reef crest from the viewer (m); the ocean swell breaks on it. */
      distance: z.number().positive().default(300),
      /** Breaker and surf strength (0 = no reef). */
      surf: z.number().min(0).max(2).default(1),
      /** Ocean swell height outside the reef (m). */
      swell: z.number().min(0).default(0.35),
    })
    .prefault({}),
  water: z
    .object({
      /** Absorption per metre of path (r, g, b): red goes first, which leaves the shallows turquoise. */
      absorption: z.tuple([z.number(), z.number(), z.number()]).default([0.42, 0.07, 0.045]),
      /** Colour of the light the water scatters back (deep water). */
      scatter: zColor.default('#0b4a7c'),
      foam: zColor.default('#f4f7f6'),
      /** Lagoon swell height (m) and the strength of the wind ripples (bindable `chop`). */
      swell: z.number().min(0).default(0.05),
      chop: z.number().min(0).default(1),
      /** Strength of the sun glints on the ripples. */
      glint: z.number().min(0).default(1),
      /** Distance (m) over which the 3D water fades into the photograph's sea. */
      fade: z.tuple([z.number(), z.number()]).default([700, 1700]),
    })
    .prefault({}),
  sand: z
    .object({
      color: zColor.default('#ddd5c6'),
      /** Wet sand darkening (fraction of the dry colour). */
      wet: z.number().min(0).max(1).default(0.62),
      /** Normal map of rippled beach sand and its tile size (m). */
      normal: z.string().optional(),
      tile: z.number().positive().default(22),
    })
    .prefault({}),
  scrub: zColor.default('#4f6a2c'),
  environment: zEnvironment,
  sun: zSkyDirection.prefault({ azimuth: 170, elevation: 25 }),
  sunColor: zColor.default('#fff4e6'),
  sunIntensity: z.number().min(0).default(2.4),
  skyLight: z.number().min(0).default(1),
  wind: zWind.prefault({}),
});
type Params = z.infer<typeof schema>;

// ---------------------------------------------------------------------------------------------
// The floor: CPU and GPU versions of the same function (keep them in step).
// ---------------------------------------------------------------------------------------------

function islandFrame(isl: Island): { c: number; s: number; short: number } {
  return { c: Math.cos(isl.angle * DEG), s: Math.sin(isl.angle * DEG), short: Math.min(isl.radius[0], isl.radius[1]) };
}

/** Metres inland from the island's shoreline (negative offshore). */
function inlandCPU(isl: Island, x: number, z: number): number {
  const { c, s, short } = islandFrame(isl);
  const dx = x - isl.center[0];
  const dz = z - isl.center[1];
  const u = (dx * c + dz * s) / isl.radius[0];
  const v = (-dx * s + dz * c) / isl.radius[1];
  const ang = Math.atan2(v, u);
  const rw = 1 + isl.wobble * (0.6 * Math.sin(3 * ang + isl.seed) + 0.4 * Math.sin(7 * ang + 2.3 * isl.seed) + 0.25 * Math.sin(13 * ang + 1.7 * isl.seed));
  return (rw - Math.hypot(u, v)) * short;
}

function riseCPU(isl: Island, inland: number): number {
  return isl.height * (1 - Math.exp(-Math.max(inland, -40) / isl.beach));
}

function lagoonDepthCPU(p: Params, x: number, z: number): number {
  const [vx, vz] = p.viewer;
  const dC = Math.hypot(x - vx, z - vz);
  const az = Math.atan2(x - vx, -(z - vz));
  const R = p.reef.distance * (1 + 0.08 * Math.sin(3 * az + 1.3) + 0.04 * Math.sin(7 * az + 0.4));
  const ss = (a: number, b: number, t: number) => {
    const k = Math.min(1, Math.max(0, (t - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };
  const bars = 0.6 * Math.sin(x * 0.045 + 1.1) * Math.sin(z * 0.052 - 0.7);
  const inner = p.lagoon.shallow + (p.lagoon.deep - p.lagoon.shallow) * ss(30, p.lagoon.deepAt, dC) + bars * ss(20, 80, dC);
  const depth = inner + (0.45 - inner) * ss(R - 80, R - 8, dC) + Math.max(0, dC - R) * 0.8;
  return Math.max(0.25, depth);
}

function floorCPU(p: Params, x: number, z: number): number {
  let h = p.y - lagoonDepthCPU(p, x, z);
  for (const isl of p.islands) h = Math.max(h, p.y + riseCPU(isl, inlandCPU(isl, x, z)));
  return h;
}

function inlandGPU(isl: Island, xz: V2): F {
  const { c, s, short } = islandFrame(isl);
  const d = xz.sub(vec2(isl.center[0], isl.center[1]));
  const u = d.x.mul(c).add(d.y.mul(s)).div(isl.radius[0]);
  const v = d.x.mul(-s).add(d.y.mul(c)).div(isl.radius[1]);
  const ang = atan(v, u);
  const rw = float(1)
    .add(sin(ang.mul(3).add(isl.seed)).mul(0.6 * isl.wobble))
    .add(sin(ang.mul(7).add(2.3 * isl.seed)).mul(0.4 * isl.wobble))
    .add(sin(ang.mul(13).add(1.7 * isl.seed)).mul(0.25 * isl.wobble));
  return rw.sub(vec2(u, v).length()).mul(short) as F;
}

function riseGPU(isl: Island, inland: F): F {
  return float(isl.height).mul(float(1).sub(exp(inland.max(-40).div(-isl.beach)))) as F;
}

/** Reef geometry seen from the viewer: distance to the viewer, azimuth and the reef radius there. */
function reefGPU(p: Params, xz: V2): { dC: F; az: F; R: F } {
  const [vx, vz] = p.viewer;
  const rel = xz.sub(vec2(vx, vz));
  const dC = rel.length() as F;
  const az = atan(rel.x, rel.y.negate()) as F;
  const R = float(p.reef.distance).mul(float(1).add(sin(az.mul(3).add(1.3)).mul(0.08)).add(sin(az.mul(7).add(0.4)).mul(0.04))) as F;
  return { dC, az, R };
}

function floorGPU(p: Params, xz: V2): F {
  const { dC, R } = reefGPU(p, xz);
  const bars = sin(xz.x.mul(0.045).add(1.1)).mul(sin(xz.y.mul(0.052).sub(0.7))).mul(0.6);
  const inner = float(p.lagoon.shallow)
    .add(smoothstep(30, p.lagoon.deepAt, dC).mul(p.lagoon.deep - p.lagoon.shallow))
    .add(bars.mul(smoothstep(20, 80, dC)));
  const depth = mix(inner, float(0.45), smoothstep(R.sub(80), R.sub(8), dC)).add(dC.sub(R).max(0).mul(0.8)).max(0.25);
  let h: F = float(p.y).sub(depth) as F;
  for (const isl of p.islands) h = max(h, riseGPU(isl, inlandGPU(isl, xz)).add(p.y)) as F;
  return h;
}

// ---------------------------------------------------------------------------------------------
// Meshes
// ---------------------------------------------------------------------------------------------

/** Small deterministic value noise (CPU) for the scrub canopy. */
function valueNoise(x: number, y: number): number {
  const hash = (i: number, j: number) => {
    const h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** An island's surface: an elliptical polar grid, dense near the waterline, reaching just under water. */
function islandGeometry(p: Params, isl: Island, rings: number, segments: number): BufferGeometry {
  const { c, s, short } = islandFrame(isl);
  const pos: number[] = [];
  const info: number[] = [];
  const index: number[] = [];
  // Normalised radius where the beach has sunk 0.9 m under water, per direction.
  const under = (isl.beach * Math.log(1 + 0.9 / isl.height)) / short;
  for (let j = 0; j < segments; j++) {
    const ang = (j / segments) * Math.PI * 2;
    const rw = 1 + isl.wobble * (0.6 * Math.sin(3 * ang + isl.seed) + 0.4 * Math.sin(7 * ang + 2.3 * isl.seed) + 0.25 * Math.sin(13 * ang + 1.7 * isl.seed));
    const rMax = rw + under;
    for (let i = 0; i <= rings; i++) {
      const f = i / rings;
      // Dense towards the shoreline: most rings sit in the outer part.
      const rho = rMax * (1 - Math.pow(1 - f, 2.2));
      const u = rho * Math.cos(ang) * isl.radius[0];
      const v = rho * Math.sin(ang) * isl.radius[1];
      const x = isl.center[0] + u * c - v * s;
      const zz = isl.center[1] + u * s + v * c;
      const inland = inlandCPU(isl, x, zz);
      const ground = floorCPU(p, x, zz);
      const scrubStart = short < 30 ? Math.min(isl.beach * 2.4, short * 0.4) : isl.beach * 2.4;
      const veg = isl.scrub * Math.min(1, Math.max(0, (inland - scrubStart) / 10));
      const canopy = veg > 0 ? veg * (1.1 + 1.6 * valueNoise(x * 0.09, zz * 0.09) + 0.6 * valueNoise(x * 0.31, zz * 0.31)) : 0;
      pos.push(x, ground + canopy, zz);
      info.push(veg, inland, isl.seed, canopy);
    }
  }
  const row = rings + 1;
  for (let j = 0; j < segments; j++) {
    const a = j * row;
    const b = ((j + 1) % segments) * row;
    for (let i = 0; i < rings; i++) {
      index.push(a + i, b + i, a + i + 1, b + i, b + i + 1, a + i + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('land', new BufferAttribute(new Float32Array(info), 4));
  g.setIndex(index);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** The water: a polar grid around the viewer, rings closer together near the viewer. */
function waterGeometry(p: Params, maxR: number, segments: number, density: number): BufferGeometry {
  const radii: number[] = [];
  for (let r = 0.5; r < maxR; r += (0.35 + r * 0.012) / density) radii.push(r);
  radii.push(maxR);
  const pos = new Float32Array((radii.length * (segments + 1) + 1) * 3);
  let k = 0;
  pos[k++] = p.viewer[0];
  pos[k++] = p.y;
  pos[k++] = p.viewer[1];
  for (const r of radii) {
    for (let j = 0; j <= segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      pos[k++] = p.viewer[0] + Math.sin(a) * r;
      pos[k++] = p.y;
      pos[k++] = p.viewer[1] - Math.cos(a) * r;
    }
  }
  const index: number[] = [];
  const row = segments + 1;
  for (let j = 0; j < segments; j++) index.push(0, 1 + j + 1, 1 + j);
  for (let i = 0; i < radii.length - 1; i++) {
    const a = 1 + i * row;
    const b = 1 + (i + 1) * row;
    for (let j = 0; j < segments; j++) index.push(a + j, a + j + 1, b + j, a + j + 1, b + j + 1, b + j);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------------------------

export const tradewindCove: ComponentFactory<Params> = {
  type: 'tradewindCove',
  version: 1,
  description: 'Sand islands and a living lagoon: clear turquoise shallows with caustics, a breaking reef line, deep blue water fading into the photograph.',
  schema,
  async create(ctx, p) {
    const detail = ctx.quality.detail;
    const reduced = ctx.quality.reducedMotion;
    const [env, sandNormal] = await Promise.all([loadTexture(ctx, p.environment.src, 'color'), p.sand.normal ? loadTexture(ctx, p.sand.normal, 'data') : Promise.resolve(null)]);
    const u = {
      presence: floatUniform(1),
      tide: floatUniform(0),
      chop: floatUniform(p.water.chop),
      clock: floatUniform(0),
    };
    const t = u.clock;
    const sun = skyDirection(p.sun.azimuth, p.sun.elevation);
    const L = vec3(...sun);
    const sunLight = colorUniform(p.sunColor, p.sunIntensity);
    const level = float(p.y).add(u.tide);
    const [wx, wz] = windVector(p.wind);
    const sky = (n: V3): V3 => (env ? sampleEnvironment(env, n, p.environment, 6).mul(p.skyLight) : vec3(0.3, 0.4, 0.55).mul(p.skyLight)) as V3;
    const reflection = (r: V3, level: number | F = 1): V3 => (env ? sampleEnvironmentLevel(env, r, p.environment, level) : vec3(0.35, 0.45, 0.6)) as V3;

    // Sand shared by the islands and the lagoon floor, so the waterline is seamless.
    const sandAlbedo = (xz: V2): V3 => {
      const broad = mx_noise_float(vec3(xz.mul(0.035), 1.7)).mul(0.07);
      const fine = mx_noise_float(vec3(xz.mul(0.6), 4.1)).mul(0.035);
      return colorUniform(p.sand.color).mul(float(0.97).add(broad).add(fine)) as V3;
    };
    const sandNormalAt = (xz: V2, base: V3, strength: number): V3 => {
      if (!sandNormal) return base;
      const a = texture(sandNormal, xz.div(p.sand.tile)).xyz.mul(2).sub(1);
      const b = texture(sandNormal, xz.div(p.sand.tile * 0.27).add(vec2(0.37, 0.71))).xyz.mul(2).sub(1);
      const tn = a.add(b.mul(0.5));
      return normalize(base.add(vec3(tn.x, 0, tn.y.negate()).mul(strength))) as V3;
    };
    const litSand = (n: V3, albedo: V3, shade: F): V3 => {
      const ndl = max(dot(n, L), 0);
      return albedo.mul(sunLight.mul(ndl).mul(shade).add(sky(n))) as V3;
    };

    // ---- Islands ----
    const group = new Group();
    const land = attribute<'vec4'>('land', 'vec4');
    const above = positionWorld.y.sub(land.w).sub(level);
    const xzW = positionWorld.xz;
    const nGeo = normalize(normalWorld);
    const nSand = sandNormalAt(xzW, nGeo, 0.38);
    const dryWet = smoothstep(0.08, 0.5, above.add(sin(t.mul(0.5).add(xzW.x.mul(0.05))).mul(0.04)));
    const wrack = smoothstep(0.1, 0.0, above.sub(0.78).abs()).mul(smoothstep(0.15, 0.6, mx_noise_float(vec3(xzW.mul(0.45), 2.2)).mul(0.5).add(0.5)));
    let sandCol: V3 = mix(sandAlbedo(xzW).mul(p.sand.wet), sandAlbedo(xzW), dryWet) as V3;
    sandCol = mix(sandCol, vec3(0.32, 0.25, 0.17), wrack.mul(0.55)) as V3;
    // Scrub canopy: clumped greens with darker gaps, on the islands' interiors.
    const clump = mx_noise_float(vec3(xzW.mul(0.22), 6.3)).mul(0.5).add(0.5);
    const leafy = mx_noise_float(vec3(xzW.mul(1.7), 9.1)).mul(0.5).add(0.5);
    const scrubCol = colorUniform(p.scrub).mul(clump.mul(0.6).add(0.55)).mul(leafy.mul(0.35).add(0.75));
    const veg = smoothstep(0.05, 0.5, land.x);
    const albedoLand = mix(sandCol, scrubCol, veg);
    const shadeLand = palmShade(positionWorld, sun);
    const nLand = mix(nSand, nGeo, veg) as V3;
    const occl = mix(float(1), clamp(land.w.mul(0.25).add(0.45), 0.45, 1), veg);
    let landLit = litSand(nLand, albedoLand as V3, shadeLand).mul(occl) as V3;
    // Wet sand catches a little sky.
    const vLand = normalize(cameraPosition.sub(positionWorld));
    const wetSheen = float(1).sub(dryWet).mul(pow(float(1).sub(max(dot(nGeo, vLand), 0)), 4)).mul(0.5);
    landLit = landLit.add(reflection(reflect(vLand.negate(), nGeo)).mul(wetSheen)) as V3;
    const landMat = new MeshBasicNodeMaterial();
    landMat.colorNode = vec4(landLit.mul(u.presence), 1);
    noBloom(landMat);
    const rings = detail === 'low' ? 36 : detail === 'medium' ? 56 : 80;
    const segs = detail === 'low' ? 96 : detail === 'medium' ? 144 : 200;
    const landGeos = p.islands.map((isl) => islandGeometry(p, isl, rings, segs));
    for (const g of landGeos) {
      const m = new Mesh(g, landMat);
      m.frustumCulled = false;
      group.add(m);
    }

    // ---- Water ----
    const lagoonSwell = (xz: V2): { h: F; dx: F; dz: F } => {
      const waves = [
        { d: [wx, wz], k: (Math.PI * 2) / 23, w: 0.9, a: 1 },
        { d: [0.6, -0.8], k: (Math.PI * 2) / 37, w: 0.7, a: 0.7 },
        { d: [-0.9, -0.43], k: (Math.PI * 2) / 13, w: 1.3, a: 0.45 },
      ];
      let h: F = float(0);
      let dx: F = float(0);
      let dz: F = float(0);
      for (const wv of waves) {
        const ph = xz.x.mul(wv.d[0] as number).add(xz.y.mul(wv.d[1] as number)).mul(wv.k).sub(t.mul(wv.w));
        h = h.add(sin(ph).mul(wv.a)) as F;
        const c = sin(ph.add(Math.PI / 2)).mul(wv.a * wv.k);
        dx = dx.add(c.mul(wv.d[0] as number)) as F;
        dz = dz.add(c.mul(wv.d[1] as number)) as F;
      }
      const a = p.water.swell;
      return { h: h.mul(a) as F, dx: dx.mul(a) as F, dz: dz.mul(a) as F };
    };
    // Ocean swell rolling in towards the viewer; each crest breaks when it reaches the reef.
    const swellPhase = (dC: F, az: F): F => dC.mul(0.055).add(t.mul(0.75)).add(sin(az.mul(2).add(0.5)).mul(1.5)).add(sin(az.mul(5.3)).mul(0.6)) as F;
    const vReef = varyingProperty('vec3', 'vCoveReef');
    const position = Fn(() => {
      const g = positionGeometry;
      const { dC, az, R } = reefGPU(p, g.xz);
      const ph = swellPhase(dC, az);
      const outside = smoothstep(R.sub(4), R.add(30), dC);
      const crest = pow(max(sin(ph), 0), 3);
      const breaker = crest.mul(exp(sq(dC.sub(R).sub(5).div(7)).negate())).mul(0.9 * p.reef.surf);
      const ocean = sin(ph).mul(p.reef.swell).mul(outside);
      const atten = exp(dC.mul(-0.002));
      const h = lagoonSwell(g.xz).h.mul(float(1).sub(outside)).add(ocean).mul(atten).add(breaker).add(u.tide);
      vReef.assign(vec3(dC, R, ph));
      return vec3(g.x, g.y.add(h), g.z);
    })();

    const P = positionWorld;
    const V = normalize(cameraPosition.sub(P));
    const dist = P.xz.sub(cameraPosition.xz).length();
    const dC = vReef.x;
    const R = vReef.y;
    const ph = vReef.z;
    const outside = smoothstep(R.sub(4), R.add(30), dC);
    const sw = lagoonSwell(P.xz);
    // Wind ripples: two drifting noise octaves stretched across the wind, fading with distance.
    const along = P.x.mul(wx).add(P.z.mul(wz));
    const across = P.x.mul(-wz).add(P.z.mul(wx));
    const ripple = (o: V2): F => {
      const q = vec2(along.add(o.x), across.add(o.y));
      const a = mx_noise_float(vec3(q.x.mul(0.5).sub(t.mul(0.9)), q.y.mul(0.22), t.mul(0.21)));
      const b = mx_noise_float(vec3(q.x.mul(1.5).sub(t.mul(1.6)), q.y.mul(0.8), t.mul(0.35).add(4)));
      return a.mul(0.6).add(b.mul(0.28)) as F;
    };
    const e = 0.15;
    const r0 = ripple(vec2(0, 0));
    const ra = ripple(vec2(e, 0)).sub(r0).div(e);
    const rc = ripple(vec2(0, e)).sub(r0).div(e);
    const chopAmt = u.chop.mul(exp(dist.mul(-0.0045))).mul(0.32).add(u.chop.mul(0.05).mul(smoothstep(1300, 350, dist)));
    // Back from the wind frame to world x/z slopes.
    const rdx = ra.mul(wx).sub(rc.mul(wz)).mul(chopAmt);
    const rdz = ra.mul(wz).add(rc.mul(wx)).mul(chopAmt);
    const oceanSlope = sin(ph.add(Math.PI / 2)).mul(p.reef.swell * 0.055).mul(outside);
    const N = normalize(vec3(sw.dx.mul(float(1).sub(outside)).add(rdx).negate(), 1, sw.dz.mul(float(1).sub(outside)).add(rdz).add(oceanSlope).negate()));

    // Depth of water over the analytic floor, and the floor seen through the refracting surface.
    const floorHere = floorGPU(p, P.xz);
    const depth = P.y.sub(floorHere).max(0);
    // Refract through a calmer normal: at grazing angles the ripples would scatter the floor
    // sample across metres from pixel to pixel.
    const Ncalm = normalize(mix(N, vec3(0, 1, 0), 0.6));
    const refr = refract(V.negate(), Ncalm, 1 / 1.333);
    const floorXZ = P.xz.add(refr.xz.div(refr.y.abs().max(0.35)).mul(depth.min(4)));
    const floorPos = vec3(floorXZ.x, P.y.sub(depth), floorXZ.y);
    // Caustics: two drifting cell networks, strongest in the shallows and near the viewer.
    const cq = floorXZ.mul(0.42);
    const w1 = mx_worley_noise_vec2(vec3(cq.x, cq.y, t.mul(0.35)));
    const w2 = mx_worley_noise_vec2(vec3(cq.x.mul(1.37).add(3.1), cq.y.mul(1.37), t.mul(0.42).add(2)));
    const net = exp(w1.y.sub(w1.x).mul(-7)).add(exp(w2.y.sub(w2.x).mul(-7)).mul(0.6)).mul(smoothstep(-0.4, 0.6, mx_noise_float(vec3(floorXZ.mul(0.08), t.mul(0.05)))));
    const causticAmt = exp(depth.mul(-0.35)).mul(exp(dist.mul(-0.01))).mul(smoothstep(0.02, 0.3, depth));
    const caustic = float(0.86).add(net.mul(0.5).mul(causticAmt));
    // Coral heads and seagrass: darker patches on the lagoon floor away from the beaches.
    const patchN = mx_noise_float(vec3(floorXZ.mul(0.06), 8.8)).add(mx_noise_float(vec3(floorXZ.mul(0.19), 2.4)).mul(0.5));
    const coral = smoothstep(0.35, 0.75, patchN).mul(smoothstep(1.2, 3, depth)).mul(float(1).sub(outside));
    const floorAlbedo = mix(sandAlbedo(floorXZ).mul(0.86), vec3(0.16, 0.15, 0.09), coral.mul(0.75));
    // Shadows on the floor soften and fade with depth (light scatters in the water).
    const floorShade = mix(float(1), palmShade(floorPos, sun), exp(depth.mul(-0.7)).mul(0.75).mul(smoothstep(500, 150, dist)));
    const floorLit = litSand(vec3(0, 1, 0), floorAlbedo as V3, floorShade.mul(caustic) as F);
    // Light travels down to the floor and back up to the eye: absorption along that path.
    const sinSun = Math.max(0.2, Math.sin((Math.asin(sun[1]) + Math.PI / 2) / 2));
    const path = depth.mul(float(1).div(refr.y.abs().max(0.15)).add(1 / sinSun));
    const T = exp(vec3(...p.water.absorption).mul(path).negate());
    const scatterCol = colorUniform(p.water.scatter).mul(sky(vec3(0, 1, 0)).mul(1.6).add(sunLight.mul(0.18)));
    const under = floorLit.mul(T).add(scatterCol.mul(vec3(1).sub(T)));
    // Sky reflection from the photograph (never below the horizon), Schlick fresnel for water.
    const Rv = reflect(V.negate(), N);
    // Grazing reflections skip the photo's thin strip of distant shore (it would sparkle as the
    // ripples scatter the samples) and blur with distance, as the ripples average out.
    const Rdir = vec3(Rv.x, Rv.y.abs().max(0.035), Rv.z);
    const reflLevel = clamp(dist.div(25).max(1).log2().add(1), 1, 5.5) as F;
    const cosV = clamp(dot(N, V), 0, 1);
    const fresnel = float(0.02).add(float(0.98).mul(pow(float(1).sub(cosV), 5)));
    let color: V3 = mix(under, reflection(Rdir, reflLevel), fresnel) as V3;
    // Sun glints on the ripple facets (the sun stands behind the viewer: sparse, crisp sparkles).
    const H = normalize(L.add(V));
    const nh = max(dot(N, H), 0);
    const glint = pow(nh, 1400).mul(24).mul(smoothstep(320, 90, dist)).add(pow(nh, 90).mul(0.12).mul(smoothstep(1200, 300, dist))).mul(p.water.glint);
    // Foam: lapping lines at the shore, the breaking reef, and the lingering white water behind it.
    const foamTex = smoothstep(0.38, 0.8, mx_noise_float(vec3(P.xz.mul(0.7), t.mul(0.12))).mul(0.5).add(0.5).add(mx_noise_float(vec3(P.xz.mul(2.6), t.mul(0.2).add(3))).mul(0.25)));
    const lap = sin(depth.mul(26).sub(t.mul(1.3)).add(mx_noise_float(vec3(P.xz.mul(0.12), 1.3)).mul(4))).mul(0.5).add(0.5);
    const shore = float(1).sub(smoothstep(0.0, 0.2, depth)).mul(smoothstep(0.6, 0.95, lap).mul(0.45).add(smoothstep(0.035, 0.0, depth).mul(0.8)).mul(foamTex.mul(0.7).add(0.3)));
    const crest = pow(max(sin(ph), 0), 4).mul(exp(sq(dC.sub(R).sub(5).div(9)).negate()));
    const white = exp(sq(dC.sub(R).add(6).div(13)).negate()).mul(pow(max(sin(ph.add(0.8)), 0), 2).mul(0.7).add(0.3));
    // The surf breaks in sets along the reef, not as one unbroken strip.
    const vReefAz = atan(P.x.sub(p.viewer[0]), P.z.sub(p.viewer[1]).negate());
    const sets = smoothstep(-0.35, 0.55, mx_noise_float(vec3(vReefAz.mul(38), t.mul(0.07), 5.5))).mul(0.75).add(0.25);
    const reefFoam = clamp(crest.mul(1.2).add(white.mul(foamTex.mul(0.8).add(0.2))), 0, 1).mul(sets).mul(p.reef.surf).min(1);
    const foam = clamp(shore.add(reefFoam), 0, 1);
    const foamLit = colorUniform(p.water.foam).mul(sunLight.mul(max(dot(N, L), 0.2)).mul(0.85).add(sky(vec3(0, 1, 0))));
    color = mix(color.add(sunLight.mul(glint).mul(float(1).sub(foam))), foamLit, foam.mul(0.92)) as V3;
    const fade = float(1).sub(smoothstep(p.water.fade[0], p.water.fade[1], dist));

    const waterMat = new MeshBasicNodeMaterial();
    waterMat.positionNode = position;
    waterMat.colorNode = vec4(color.mul(u.presence), 1);
    waterMat.opacityNode = fade;
    waterMat.transparent = true;
    waterMat.depthWrite = true;
    waterMat.fog = false;
    noBloom(waterMat);
    const maxR = p.water.fade[1] + 60;
    const waterGeo = waterGeometry(p, maxR, detail === 'low' ? 180 : detail === 'medium' ? 270 : 360, detail === 'low' ? 0.55 : detail === 'medium' ? 0.8 : 1);
    const water = new Mesh(waterGeo, waterMat);
    water.frustumCulled = false;
    water.renderOrder = -8;
    group.add(water);

    ctx.ground.provide((x, zz) => floorCPU(p, x, zz));
    ctx.ground.setWaterLevel(p.y);
    const textures: (Texture | null)[] = [env, sandNormal];
    return {
      object: group,
      reactive: { tide: u.tide, chop: u.chop },
      update(frame) {
        u.clock.value += Math.min(0.1, frame.dt) * (reduced ? 0.35 : 1);
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        ctx.ground.provide(null);
        ctx.ground.setWaterLevel(null);
        for (const g of landGeos) g.dispose();
        waterGeo.dispose();
        landMat.dispose();
        waterMat.dispose();
        for (const tex of textures) tex?.dispose();
      },
    };
  },
};
