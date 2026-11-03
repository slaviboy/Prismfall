import { AdditiveBlending, DataTexture, DoubleSide, DynamicDrawUsage, Group, InstancedBufferAttribute, LinearFilter, Mesh, MeshBasicNodeMaterial, NormalBlending, PlaneGeometry, RGBAFormat, RepeatWrapping, UnsignedByteType, Vector3 } from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  exp,
  float,
  instancedBufferAttribute,
  length,
  mix,
  mrt,
  mx_fractal_noise_float,
  mx_noise_float,
  normalize,
  positionGeometry,
  smoothstep,
  texture,
  uv,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { additiveFog, floatUniform, linear, seeded, z, zColor, zVec3, type ComponentFactory, type EnvironmentContext } from '@prismfall/sdk';
import { GROUND_Y, VIEWER, backdropDir, backdropTexture, claimLight, hazeDepth, lin, notice, release, setLight, world, zHaze, type F, type Haze, type V3, type World } from './shared';

/**
 * Battlefield atmosphere for Red Horizon: smoke, fire, explosions, sparks and electrical arcs.
 *
 * Smoke is a pool of camera-facing puffs spawned on the CPU (columns from burning ruins, the
 * factory's chimneys, the walkers' stacks, explosion clouds) whose motion is analytic on the GPU:
 * they rise, slow, spread and drift on the wind, thin out as they age, and are shaded as dense
 * soot lit orange from below near their fire and by the photo's sky colour from behind, fogged
 * into the horizon like everything else.
 */

interface Puff {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  size0: number;
  size1: number;
  life: number;
  heat: number;
  dark: number;
}

let noiseTex: DataTexture | null = null;
/** A 128 x 128 tiling value-noise fBm (three independent octave sets in RGB), shared by all smoke. */
function smokeNoise(): DataTexture {
  if (noiseTex) return noiseTex;
  const N = 128;
  const data = new Uint8Array(N * N * 4);
  const rnd = seeded(4242);
  const field = new Float32Array(N * N);
  for (let ch = 0; ch < 3; ch++) {
    field.fill(0);
    let amp = 1;
    let total = 0;
    for (const period of [4, 8, 16, 32]) {
      const lattice = Array.from({ length: period * period }, rnd);
      const cell = N / period;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const fx = x / cell;
          const fy = y / cell;
          const x0 = Math.floor(fx);
          const y0 = Math.floor(fy);
          const tx = fx - x0;
          const ty = fy - y0;
          const sx = tx * tx * (3 - 2 * tx);
          const sy = ty * ty * (3 - 2 * ty);
          const at = (i: number, j: number) => lattice[((j % period) * period + (i % period)) % lattice.length]!;
          const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
          const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
          field[y * N + x]! += (a + (b - a) * sy) * amp;
        }
      }
      total += amp;
      amp *= 0.55;
    }
    for (let i = 0; i < N * N; i++) data[i * 4 + ch] = Math.round((field[i]! / total) * 255);
  }
  for (let i = 0; i < N * N; i++) data[i * 4 + 3] = 255;
  const tex = new DataTexture(data, N, N, RGBAFormat, UnsignedByteType);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  noiseTex = tex;
  return tex;
}

export class SmokePool {
  readonly mesh: Mesh;
  private readonly a: InstancedBufferAttribute;
  private readonly b: InstancedBufferAttribute;
  private readonly c: InstancedBufferAttribute;
  private cursor = 0;
  readonly capacity: number;
  private dirty = false;

  constructor(ctx: EnvironmentContext, capacity: number, backdrop: DataTexture | null, haze: Haze, wind: [number, number]) {
    this.capacity = capacity;
    const geo = new PlaneGeometry(1, 1);
    const mk = () => {
      const x = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      x.setUsage(DynamicDrawUsage);
      return x;
    };
    this.a = mk();
    this.b = mk();
    this.c = mk();
    // Unused slots start long dead.
    for (let i = 0; i < capacity; i++) this.b.setW(i, -1e6);
    const ia = instancedBufferAttribute<'vec4'>(this.a, 'vec4'); // x y z size0
    const ib = instancedBufferAttribute<'vec4'>(this.b, 'vec4'); // vx vy vz t0
    const ic = instancedBufferAttribute<'vec4'>(this.c, 'vec4'); // size1 life heat dark
    const t = ctx.uniforms.time;
    const vAge = varyingProperty('float', 'vPuffAge');
    const vWorld = varyingProperty('vec3', 'vPuffWorld');
    const vSeed = varyingProperty('float', 'vPuffSeed');
    const vHeat = varyingProperty('float', 'vPuffHeat');
    const vDark = varyingProperty('float', 'vPuffDark');
    const vUv = varyingProperty('vec2', 'vPuffUv');
    const vRise = varyingProperty('float', 'vPuffRise');
    const m = new MeshBasicNodeMaterial();
    const windV = vec3(wind[0], 0, wind[1]);
    // Where a puff is after tt seconds: buoyant rise that keeps going but slows with height, initial
    // spread that dies off quickly, and a wind that strengthens with height (the column shears).
    const T0 = 3.0;
    const placeAt = (tt: F): V3 => {
      const riseK = float(1).add(tt.div(T0)).pow(0.6).sub(1).div(0.6).mul(T0);
      const spreadK = float(1).sub(exp(tt.div(-2.2))).mul(2.2);
      const up = ib.y.mul(riseK);
      const drift = vec3(ib.x, 0, ib.z).mul(spreadK);
      return ia.xyz.add(drift).add(vec3(0, up, 0)).add(windV.mul(tt.mul(0.55).add(up.mul(0.12)))) as V3;
    };
    m.vertexNode = Fn(() => {
      const age = t.sub(ib.w).div(ic.y).max(0);
      const tt = t.sub(ib.w).max(0);
      const pw = placeAt(tt as F);
      // The puff is stretched along its own motion on screen (rising and shearing), so a column of
      // overlapping puffs reads as one continuous, wind-bent plume rather than a stack of discs.
      const ahead = placeAt(tt.add(1.5) as F);
      const v0 = cameraViewMatrix.mul(vec4(pw, 1));
      const v1 = cameraViewMatrix.mul(vec4(ahead, 1));
      const sd = v1.xy.sub(v0.xy);
      const along = normalize(sd.add(vec2(0, 1e-3)));
      const across = vec2(along.y, along.x.negate());
      const grow = smoothstep(0, 1, age.sqrt());
      const width = mix(ia.w, ic.x, grow);
      const stretch = width.mul(float(1.35).add(age.mul(1.1)));
      const q = positionGeometry.xy;
      const offset = across.mul(q.x.mul(width)).add(along.mul(q.y.mul(stretch)));
      vAge.assign(age);
      vWorld.assign(pw);
      vSeed.assign(ib.w);
      vHeat.assign(ic.z);
      vDark.assign(ic.w);
      vUv.assign(q.mul(2));
      vRise.assign(pw.y.sub(ia.y));
      return cameraProjectionMatrix.mul(vec4(v0.xy.add(offset), v0.z, 1));
    })();
    // Soft, ragged density: a domain-warped fBm cut by a soft elongated falloff, so the outline is
    // always torn and never circular; the noise slowly boils as the puff ages.
    const c = vUv;
    // Density from a small tiling fBm texture (two fetches: a warp, then the warped shape) instead
    // of procedural noise: smoke covers a lot of screen in many layers, so it must be cheap.
    const nt = smokeNoise();
    const o1 = vec2(vSeed.mul(0.137), vSeed.mul(0.311)).add(vec2(vAge.mul(0.05), vAge.mul(-0.08)));
    const wq = texture(nt, c.mul(0.32).add(o1));
    const warp = wq.xy.sub(0.5);
    const n = texture(nt, c.mul(0.46).add(warp.mul(0.42)).add(o1.mul(1.7)).add(vec2(0.37, 0.11))).z.mul(1.25).sub(0.12);
    const radial = length(c.mul(vec2(1.0, 0.85)));
    const core = float(1).sub(radial.mul(radial)).max(0);
    const density = smoothstep(0.38, 0.78, n.mul(0.7).add(core.mul(0.62)).sub(0.12)).mul(smoothstep(1.0, 0.72, radial));
    const alive = smoothstep(0, 0.08, vAge).mul(smoothstep(1, 0.55, vAge));
    // Thick near the fire, thinning out as it spreads and rises.
    const alpha = density.mul(alive).mul(mix(float(0.62), float(0.14), vAge.sqrt())).clamp(0, 1);
    // Light: warm from the fire below while young and low; cooler and greyer as it rises; the sky
    // glow from behind on the thin edges.
    const dir = normalize(vWorld.sub(cameraPosition)) as unknown as V3;
    const sky = backdropDir(backdrop, dir);
    const young = mix(lin('#1a1410'), lin('#080605'), vDark);
    const old = mix(lin('#3a3634'), lin('#1e1c1b'), vDark);
    const soot = mix(young, old, smoothstep(0.05, 0.6, vAge));
    const edge = float(1).sub(density).mul(0.5).add(0.15);
    const lowK = exp(vRise.div(-7));
    const fireK = vHeat.mul(exp(vAge.mul(-9))).mul(lowK).mul(smoothstep(0.3, 1, n)).mul(c.y.mul(-0.35).add(0.75));
    const col = soot.mul(n.mul(0.5).add(0.6)).add(sky.mul(edge).mul(0.16)).add(lin('#ff6a24').mul(fireK.mul(0.42)));
    const tau = hazeDepth(vWorld as unknown as V3, haze);
    const fogged = mix(sky, col, exp(tau.negate()));
    m.colorNode = vec4(fogged, alpha.mul(exp(tau.mul(-0.3))));
    m.transparent = true;
    m.blending = NormalBlending;
    m.depthWrite = false;
    m.side = DoubleSide;
    m.fog = false;
    m.mrtNode = mrt({ emissive: vec4(lin('#ff6a24').mul(fireK.mul(0.12)).mul(alpha), 1) });
    this.mesh = new Mesh(geo, m);
    this.mesh.count = capacity;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  emit(p: Puff, now: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.a.setXYZW(i, p.x, p.y, p.z, p.size0);
    this.b.setXYZW(i, p.vx, p.vy, p.vz, now);
    this.c.setXYZW(i, p.size1, p.life, p.heat, p.dark);
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) return;
    this.a.needsUpdate = true;
    this.b.needsUpdate = true;
    this.c.needsUpdate = true;
    this.dirty = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
  }
}

/** Shared smoke pool of the environment (created by the smoke layer, used by machines and the factory). */
const pools = new WeakMap<World, SmokePool>();
export function smokePool(w: World): SmokePool | null {
  return pools.get(w) ?? null;
}

const sourceSchema = z.object({
  at: zVec3,
  /** Puffs per second, puff size at birth and when old (metres), rise speed, lifetime. */
  rate: z.number().positive().default(1.2),
  size: z.tuple([z.number().positive(), z.number().positive()]).default([6, 28]),
  rise: z.number().default(4),
  life: z.number().positive().default(26),
  spread: z.number().min(0).default(2),
  /** Orange underlight from the fire below (0..1) and soot darkness (0..1). */
  heat: z.number().min(0).max(1).default(0.7),
  dark: z.number().min(0).max(1).default(0.6),
});

const smokeSchema = z.object({
  sources: z.array(sourceSchema).default([]),
  wind: z.tuple([z.number(), z.number()]).default([1.6, -0.4]),
  capacity: z.number().int().min(64).max(4000).default(1600),
  haze: zHaze,
  seed: z.number().default(5),
});

export const smokeComponent: ComponentFactory<z.infer<typeof smokeSchema>> = {
  type: 'redHorizonSmoke',
  version: 1,
  description: 'Rising soot columns lit by their fires, drifting on the wind (shared smoke pool).',
  schema: smokeSchema,
  async create(ctx, p) {
    const w = world(ctx);
    const backdrop = await backdropTexture(w);
    const k = ctx.quality.detail === 'low' ? 0.5 : ctx.quality.detail === 'medium' ? 0.75 : 1;
    const pool = new SmokePool(ctx, Math.round(p.capacity * k), backdrop, p.haze, p.wind);
    pools.set(w, pool);
    const rand = seeded(p.seed * 911 + 3);
    const carry = p.sources.map(() => rand());
    const rate = floatUniform(1);
    const reduced = ctx.quality.reducedMotion;
    // Pre-fill: a column already standing when the world appears.
    const prefill = (now: number) => {
      p.sources.forEach((s) => {
        const n = Math.floor(s.rate * s.life * k * 0.9);
        for (let i = 0; i < n; i++) spawn(s, now - rand() * s.life);
      });
    };
    const spawn = (s: z.infer<typeof sourceSchema>, now: number) => {
      const a = rand() * Math.PI * 2;
      const r = rand() * s.spread;
      pool.emit(
        {
          x: s.at[0] + Math.cos(a) * r,
          y: GROUND_Y + s.at[1],
          z: s.at[2] + Math.sin(a) * r,
          vx: (rand() - 0.5) * 0.8,
          vy: s.rise * (0.7 + rand() * 0.6),
          vz: (rand() - 0.5) * 0.8,
          size0: s.size[0] * (0.7 + rand() * 0.6),
          size1: s.size[1] * (0.7 + rand() * 0.6),
          life: s.life * (0.75 + rand() * 0.5),
          heat: s.heat,
          dark: Math.min(1, s.dark * (0.8 + rand() * 0.4)),
        },
        now,
      );
    };
    let started = false;
    return {
      object: pool.mesh,
      reactive: { rate },
      update(frame) {
        if (!started) {
          prefill(frame.time);
          started = true;
        }
        const dt = Math.min(0.1, frame.dt) * (reduced ? 0.6 : 1);
        p.sources.forEach((s, i) => {
          carry[i]! += dt * s.rate * k * rate.value;
          while (carry[i]! >= 1) {
            carry[i]! -= 1;
            spawn(s, frame.time);
          }
        });
        pool.flush();
      },
      dispose() {
        pool.dispose();
        pools.delete(w);
        release(w);
      },
    };
  },
};

// ------------------------------------------------------------------ fires

const fireSchema = z.object({
  fires: z
    .array(
      z.object({
        at: zVec3,
        /** Flame height (metres) and width. */
        size: z.number().positive().default(3),
        /** Light cast on nearby machines and ruins (local light slot). */
        light: z.number().min(0).default(0),
        range: z.number().positive().default(60),
        color: zColor.default('#ff7a2a'),
        /** A soft glow pool on the yard around it. */
        pool: z.number().min(0).default(1),
      }),
    )
    .default([]),
  brightness: z.number().min(0).default(1),
  bloom: z.number().min(0).default(0.12),
  seed: z.number().default(9),
});

/**
 * Fires burning in the ruins and in wrecks: layered flame sprites that lick and flicker (noise in
 * the shader, never on the beat), a glow pool on the ground, and for the larger ones a local light
 * that moves over nearby machines and walls.
 */
export const firesComponent: ComponentFactory<z.infer<typeof fireSchema>> = {
  type: 'redHorizonFires',
  version: 1,
  description: 'Flickering fires in ruins and wrecks with ground glow and local light.',
  schema: fireSchema,
  create(ctx, p) {
    const w = world(ctx);
    const n = p.fires.length;
    const tongues = 5;
    const count = Math.max(1, n * tongues);
    const ia = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
    const ib = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
    const rand = seeded(p.seed * 313 + 1);
    p.fires.forEach((f, i) => {
      const c = linear(f.color);
      for (let k = 0; k < tongues; k++) {
        const j = i * tongues + k;
        const s = f.size * (k === 0 ? 1 : 0.45 + rand() * 0.5);
        ia.setXYZW(j, f.at[0] + (rand() - 0.5) * f.size * 0.5, GROUND_Y + f.at[1], f.at[2] + (rand() - 0.5) * f.size * 0.3, s);
        ib.setXYZW(j, c.x, c.y, c.z, rand() * 100);
      }
    });
    const a = instancedBufferAttribute<'vec4'>(ia, 'vec4');
    const b = instancedBufferAttribute<'vec4'>(ib, 'vec4');
    const t = ctx.uniforms.time;
    const vUv = varyingProperty('vec2', 'vFlameUv');
    const vCol = varyingProperty('vec4', 'vFlameCol');
    const m = new MeshBasicNodeMaterial();
    m.vertexNode = Fn(() => {
      // Upright billboard: faces the camera about the vertical axis, origin at the base.
      const base = a.xyz;
      const toCam = normalize(vec3(cameraPosition.x.sub(base.x), 0, cameraPosition.z.sub(base.z)));
      const side = vec3(toCam.z, 0, toCam.x.negate());
      const q = positionGeometry.xy;
      const sway = mx_noise_float(vec3(t.mul(0.9), b.w, 0)).mul(0.25).mul(q.y.add(0.5));
      const wp = base.add(side.mul(q.x.add(sway).mul(a.w.mul(0.6)))).add(vec3(0, q.y.add(0.5).mul(a.w), 0));
      vUv.assign(q.add(0.5));
      vCol.assign(b);
      return cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(wp, 1)));
    })();
    const u = vUv;
    const seed = vCol.w;
    const flick = mx_fractal_noise_float(vec3(u.x.mul(3), u.y.mul(2.2).sub(t.mul(1.8)), seed), 3, 2, 0.5).mul(0.5).add(0.5);
    const width = float(0.5).mul(float(1).sub(u.y).max(0).pow(0.7)).mul(flick.mul(0.6).add(0.6)).max(0.03);
    const body = smoothstep(width, width.mul(0.35), u.x.sub(0.5).abs()).mul(smoothstep(0, 0.08, u.y)).mul(smoothstep(1, 0.55, u.y.add(flick.mul(0.35))));
    const pulse = mx_noise_float(vec3(t.mul(2.4), seed, 3)).mul(0.25).add(0.85);
    const core = mix(vCol.rgb, lin('#ffd890'), smoothstep(0.55, 0.95, body).mul(smoothstep(0.6, 0.1, u.y)));
    const glow = core.mul(body).mul(pulse).mul(p.brightness * 1.4);
    const col = additiveFog(glow as unknown as V3);
    m.colorNode = vec4(col, 1);
    m.blending = AdditiveBlending;
    m.transparent = true;
    m.depthWrite = false;
    m.side = DoubleSide;
    m.fog = false;
    m.mrtNode = mrt({ emissive: vec4(col.mul(p.bloom), 1) });
    const mesh = new Mesh(new PlaneGeometry(1, 1), m);
    mesh.count = count;
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    // Glow pools on the yard.
    const pa = new InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 4), 4);
    const pb = new InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 4), 4);
    p.fires.forEach((f, i) => {
      const c = linear(f.color);
      pa.setXYZW(i, f.at[0], GROUND_Y + 0.04, f.at[2], f.size * 4 * f.pool);
      pb.setXYZW(i, c.x * f.pool, c.y * f.pool, c.z * f.pool, rand() * 100);
    });
    const qa = instancedBufferAttribute<'vec4'>(pa, 'vec4');
    const qb = instancedBufferAttribute<'vec4'>(pb, 'vec4');
    const pm = new MeshBasicNodeMaterial();
    // A low glow hugging the yard around the fire, facing the camera (a flat decal on a photo
    // ground would collapse into a hairline at this eye height).
    pm.vertexNode = Fn(() => {
      const view = cameraViewMatrix.mul(vec4(qa.xyz.add(vec3(0, qa.w.mul(0.08), 0)), 1));
      return cameraProjectionMatrix.mul(vec4(view.xy.add(positionGeometry.xy.mul(vec2(qa.w, qa.w.mul(0.22)))), view.z, 1));
    })();
    const pd = length(uv().sub(0.5).mul(vec2(2, 2))).mul(1);
    const breathe = mx_noise_float(vec3(t.mul(1.6), qb.w, 7)).mul(0.25).add(0.8);
    const poolCol = additiveFog(qb.rgb.mul(exp(pd.mul(pd).mul(-5))).mul(smoothstep(1, 0.6, pd)).mul(breathe).mul(0.12) as unknown as V3);
    pm.colorNode = vec4(poolCol, 1);
    pm.blending = AdditiveBlending;
    pm.transparent = true;
    pm.depthWrite = false;
    pm.side = DoubleSide;
    pm.fog = false;
    pm.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
    const poolMesh = new Mesh(new PlaneGeometry(1, 1), pm);
    poolMesh.count = Math.max(1, n);
    poolMesh.frustumCulled = false;
    poolMesh.renderOrder = 5;
    const group = new Group();
    group.add(mesh, poolMesh);
    // Local lights for the bigger fires (flickering on the CPU).
    const lit = p.fires.map((f, i) => ({ f, i, slot: f.light > 0 ? claimLight(w) : -1, c: linear(f.color) }));
    return {
      object: group,
      update(frame) {
        for (const l of lit) {
          if (l.slot < 0) continue;
          const tt = frame.time;
          const flicker = 0.78 + 0.14 * Math.sin(tt * 7.3 + l.i * 1.7) * Math.sin(tt * 3.1 + l.i) + 0.08 * Math.sin(tt * 17 + l.i * 3);
          setLight(w, l.slot, l.f.at[0], GROUND_Y + l.f.at[1] + l.f.size * 0.6, l.f.at[2], l.f.light * flicker, l.c.x, l.c.y, l.c.z, l.f.range);
        }
      },
      dispose() {
        mesh.geometry.dispose();
        m.dispose();
        poolMesh.geometry.dispose();
        pm.dispose();
        for (const l of lit) if (l.slot >= 0) setLight(w, l.slot, 0, -1000, 0, 0, 0, 0, 0, 1);
        release(w);
      },
    };
  },
};

// ------------------------------------------------------------------ explosions

const zoneSchema = z.object({
  /** Azimuth (degrees from straight ahead, + right) and distance ranges from the viewer. */
  azimuth: z.tuple([z.number(), z.number()]),
  distance: z.tuple([z.number(), z.number()]),
  /** Height above the yard range (in a tower, on the ground). */
  height: z.tuple([z.number(), z.number()]).default([0, 6]),
  weight: z.number().positive().default(1),
});

const explosionSchema = z.object({
  zones: z.array(zoneSchema).min(1),
  /** Mean seconds between explosions (Poisson), with a minimum gap. */
  interval: z.number().positive().default(16),
  minGap: z.number().positive().default(5),
  /** Chance that an explosion is followed by one or two more nearby (a salvo). */
  salvo: z.number().min(0).max(1).default(0.2),
  size: z.tuple([z.number().positive(), z.number().positive()]).default([14, 40]),
  fireball: zColor.default('#ffb060'),
  flash: z.number().min(0).default(1),
  light: z.number().min(0).default(9000),
  bloom: z.number().min(0).default(0.2),
  seed: z.number().default(21),
});

interface Blast {
  x: number;
  y: number;
  z: number;
  t0: number;
  size: number;
  slot: number;
}

/**
 * Distant explosions at natural, irregular intervals (a Poisson process with a minimum gap,
 * occasional salvos, slightly more often in intense music sections, never on the beat): a fireball
 * that blooms and cools from white-yellow to deep red, a flash that lights the smoke around it and
 * nearby ruins and machines (softened and slowed with flash reduction), a rolling smoke cloud,
 * glowing debris thrown out, and every sensor in earshot may turn to look.
 */
export const explosionsComponent: ComponentFactory<z.infer<typeof explosionSchema>> = {
  type: 'redHorizonExplosions',
  version: 1,
  description: 'Irregular distant explosions with fireball, flash in the smoke, smoke cloud and debris.',
  schema: explosionSchema,
  create(ctx, p) {
    const w = world(ctx);
    const rand = seeded(p.seed * 7717 + 9);
    const cap = 6;
    const ia = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const ib = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    ia.setUsage(DynamicDrawUsage);
    ib.setUsage(DynamicDrawUsage);
    for (let i = 0; i < cap; i++) ib.setXYZW(i, -1e6, 0, 0, 0);
    const a = instancedBufferAttribute<'vec4'>(ia, 'vec4');
    const b = instancedBufferAttribute<'vec4'>(ib, 'vec4');
    const t = ctx.uniforms.time;
    const flashSoft = ctx.uniforms.flashLimit;
    const vUv = varyingProperty('vec2', 'vBlastUv');
    const vAge = varyingProperty('float', 'vBlastAge');
    const m = new MeshBasicNodeMaterial();
    m.vertexNode = Fn(() => {
      const age = t.sub(b.x).max(0);
      const grow = float(1).sub(exp(age.mul(-6))).mul(0.8).add(age.mul(0.05));
      const size = a.w.mul(grow.max(0.05));
      const centre = a.xyz.add(vec3(0, size.mul(0.35), 0));
      const view = cameraViewMatrix.mul(vec4(centre, 1));
      vUv.assign(positionGeometry.xy.add(0.5));
      vAge.assign(age);
      return cameraProjectionMatrix.mul(vec4(view.xy.add(positionGeometry.xy.mul(size)), view.z, 1));
    })();
    const d = length(vUv.sub(0.5)).mul(2);
    const n = mx_fractal_noise_float(vec3(vUv.mul(3.5), vAge.mul(0.8)), 3, 2, 0.5).mul(0.5).add(0.5);
    const shape = smoothstep(1, 0.3, d.add(n.sub(0.5).mul(0.6)));
    // Cooling: white-yellow, orange, deep red, gone in about two seconds.
    const cool = smoothstep(0, 1.8, vAge);
    const colA = mix(lin('#fff2c8', 3), lin(p.fireball, 1.8), smoothstep(0, 0.35, vAge));
    const colB = mix(colA, lin('#7a1806', 0.6), cool);
    const rise = smoothstep(0, 0.06, vAge).mul(smoothstep(2.4, 0.6, vAge));
    // Flash reduction: a lower, softer peak.
    const soft = float(1).sub(flashSoft).div(0.55).clamp(0, 1);
    const peak = mix(float(1), float(0.4), soft);
    const glow = colB.mul(shape).mul(rise).mul(n.mul(0.5).add(0.6)).mul(peak);
    const col = additiveFog(glow as unknown as V3);
    m.colorNode = vec4(col, 1);
    m.blending = AdditiveBlending;
    m.transparent = true;
    m.depthWrite = false;
    m.side = DoubleSide;
    m.fog = false;
    m.mrtNode = mrt({ emissive: vec4(col.mul(p.bloom), 1) });
    const mesh = new Mesh(new PlaneGeometry(1, 1), m);
    mesh.count = cap;
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    const slots = [claimLight(w), claimLight(w)];
    const blasts: Blast[] = [];
    let next = 4 + rand() * 6;
    let cursor = 0;
    let salvoLeft = 0;
    let salvoAt: Vector3 | null = null;
    const rate = floatUniform(1);
    const reduced = ctx.quality.reducedMotion;
    const totalWeight = p.zones.reduce((s, zz) => s + zz.weight, 0);
    const pickPoint = (): Vector3 => {
      let r = rand() * totalWeight;
      let zone = p.zones[0]!;
      for (const zz of p.zones) {
        if (r <= zz.weight) {
          zone = zz;
          break;
        }
        r -= zz.weight;
      }
      const az = ((zone.azimuth[0] + (zone.azimuth[1] - zone.azimuth[0]) * rand()) * Math.PI) / 180;
      const dist = zone.distance[0] + (zone.distance[1] - zone.distance[0]) * rand();
      const h = zone.height[0] + (zone.height[1] - zone.height[0]) * rand();
      return new Vector3(VIEWER.x + Math.sin(az) * dist, GROUND_Y + h, VIEWER.z - Math.cos(az) * dist);
    };
    const detonate = (pos: Vector3, now: number) => {
      const size = p.size[0] + (p.size[1] - p.size[0]) * Math.pow(rand(), 1.6);
      const i = cursor++ % cap;
      ia.setXYZW(i, pos.x, pos.y, pos.z, size);
      ib.setXYZW(i, now, 0, 0, 0);
      ia.needsUpdate = true;
      ib.needsUpdate = true;
      const slot = slots[cursor % slots.length] ?? -1;
      blasts.push({ x: pos.x, y: pos.y, z: pos.z, t0: now, size, slot });
      if (blasts.length > 4) blasts.shift();
      // Sky glow towards it, and machines notice.
      const dir = new Vector3(pos.x - VIEWER.x, pos.y + size * 0.4 - VIEWER.y, pos.z - VIEWER.z).normalize();
      (w.flashDir as unknown as { value: Vector3 }).value.copy(dir);
      notice(w, pos.x, pos.y + size * 0.3, pos.z, Math.min(1, size / 30));
      // Smoke cloud and debris.
      const pool = smokePool(w);
      if (pool) {
        const puffs = Math.round(22 + size * 0.7);
        for (let k = 0; k < puffs; k++) {
          const ang = rand() * Math.PI * 2;
          const sp = rand() * size * 0.12;
          pool.emit({ x: pos.x + Math.cos(ang) * size * 0.15, y: pos.y + rand() * size * 0.3, z: pos.z + Math.sin(ang) * size * 0.15, vx: Math.cos(ang) * sp, vy: size * (0.06 + rand() * 0.12), vz: Math.sin(ang) * sp, size0: size * 0.18, size1: size * (0.5 + rand() * 0.35), life: 18 + rand() * 14, heat: 1, dark: 0.55 + rand() * 0.35 }, now + rand() * 0.6);
        }
      }
      if (!reduced) {
        const nDebris = ctx.bursts.budget(30 + size);
        for (let k = 0; k < nDebris; k++) {
          const ang = rand() * Math.PI * 2;
          const up = 0.4 + rand() * 0.9;
          const sp = size * (0.5 + rand() * 0.9);
          const hot = 0.5 + rand() * 1.5;
          ctx.bursts.emit({ x: pos.x, y: pos.y + size * 0.2, z: pos.z, vx: Math.cos(ang) * sp * (1 - up * 0.5), vy: sp * up, vz: Math.sin(ang) * sp * (1 - up * 0.5), r: 1.4 * hot, g: 0.5 * hot, b: 0.15 * hot, size: 0.5 + rand() * 1.2, life: 1.2 + rand() * 1.6, gravity: -9.8, drag: 0.3, shape: 'spark', swirl: 0 }, now);
        }
      }
    };
    return {
      object: mesh,
      reactive: { rate },
      update(frame) {
        const now = frame.time;
        next -= Math.min(0.1, frame.dt) * rate.value;
        if (next <= 0) {
          if (salvoLeft > 0 && salvoAt) {
            const off = new Vector3((rand() - 0.5) * 60, 0, (rand() - 0.5) * 60);
            detonate(salvoAt.clone().add(off), now);
            salvoLeft--;
            next = salvoLeft > 0 ? 0.6 + rand() * 1.8 : p.minGap + -Math.log(1 - rand()) * Math.max(0.1, p.interval - p.minGap);
          } else {
            const pos = pickPoint();
            detonate(pos, now);
            if (rand() < p.salvo) {
              salvoLeft = 1 + Math.floor(rand() * 2);
              salvoAt = pos;
              next = 0.5 + rand() * 1.5;
            } else {
              next = p.minGap + -Math.log(1 - rand()) * Math.max(0.1, p.interval - p.minGap);
            }
          }
        }
        // Flash in the sky and on nearby surfaces: quick rise, slower decay (softer with flash reduction).
        const soft = ctx.uniforms.flashLimit.value < 0.99;
        let skyFlash = 0;
        for (const bl of blasts) {
          const age = now - bl.t0;
          if (age < 0 || age > 4) continue;
          const riseT = soft ? 0.35 : 0.06;
          const env = Math.min(1, age / riseT) * Math.exp(-age / (soft ? 1.1 : 0.7));
          const k = (bl.size / 30) * env * p.flash * (soft ? 0.35 : 1);
          skyFlash = Math.max(skyFlash, k);
          if (bl.slot >= 0) setLight(w, bl.slot, bl.x, bl.y + bl.size * 0.4, bl.z, p.light * k, 1, 0.55, 0.25, bl.size * 9);
        }
        for (const s of slots) if (s >= 0 && !blasts.some((bl) => bl.slot === s && now - bl.t0 < 4)) setLight(w, s, 0, -1000, 0, 0, 0, 0, 0, 1);
        w.flash.value = skyFlash * 0.6;
      },
      dispose() {
        mesh.geometry.dispose();
        m.dispose();
        for (const s of slots) if (s >= 0) setLight(w, s, 0, -1000, 0, 0, 0, 0, 0, 1);
        release(w);
      },
    };
  },
};

// ------------------------------------------------------------------ sparks and electrical arcs

const sparkSchema = z.object({
  /** Hot spark showers dripping from broken steel (bursts at random intervals). */
  showers: z.array(z.object({ at: zVec3, every: z.tuple([z.number(), z.number()]).default([2, 7]), count: z.number().int().min(1).default(26) })).default([]),
  /** Electrical arcs jumping between two points of a broken line or mast. */
  arcs: z.array(z.object({ from: zVec3, to: zVec3, every: z.tuple([z.number(), z.number()]).default([4, 14]) })).default([]),
  arcColor: zColor.default('#cfd8ff'),
  sparkColor: zColor.default('#ffb060'),
  bloom: z.number().min(0).default(0.25),
  seed: z.number().default(17),
});

/**
 * Sparks and electrical discharges: showers of hot sparks falling from cut steel, and short
 * crackling arcs between broken conductors (a jagged bolt redrawn several times in a fraction of a
 * second, with a spray of sparks). With flash reduction arcs are dim and slower; at random,
 * irregular intervals, never on the beat.
 */
export const sparksComponent: ComponentFactory<z.infer<typeof sparkSchema>> = {
  type: 'redHorizonSparks',
  version: 1,
  description: 'Spark showers from cut steel and short electrical arcs between broken conductors.',
  schema: sparkSchema,
  create(ctx, p) {
    const w = world(ctx);
    const rand = seeded(p.seed * 4441 + 5);
    const segs = 14;
    const capacity = Math.max(1, p.arcs.length) * segs;
    const ia = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    const ib = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    ia.setUsage(DynamicDrawUsage);
    ib.setUsage(DynamicDrawUsage);
    const a = instancedBufferAttribute<'vec4'>(ia, 'vec4');
    const b = instancedBufferAttribute<'vec4'>(ib, 'vec4');
    const arcCol = linear(p.arcColor);
    const vUv = varyingProperty('vec2', 'vArcUv');
    const vI = varyingProperty('float', 'vArcI');
    const m = new MeshBasicNodeMaterial();
    // Each instance is one bolt segment from a.xyz to b.xyz, drawn as a camera-facing ribbon.
    m.vertexNode = Fn(() => {
      const p0 = cameraViewMatrix.mul(vec4(a.xyz, 1));
      const p1 = cameraViewMatrix.mul(vec4(b.xyz, 1));
      const t = positionGeometry.x.add(0.5);
      const pv = mix(p0, p1, t);
      const dirv = normalize(p1.xy.sub(p0.xy).add(vec2(1e-5, 0)));
      const nrm = vec2(dirv.y.negate(), dirv.x);
      const width = a.w;
      vUv.assign(positionGeometry.xy.add(0.5));
      vI.assign(b.w);
      return cameraProjectionMatrix.mul(vec4(pv.xy.add(nrm.mul(positionGeometry.y.mul(width))), pv.z, 1));
    })();
    const across = vUv.y.sub(0.5).abs().mul(2);
    const core = exp(across.mul(across).mul(-14)).add(exp(across.mul(-3)).mul(0.25));
    const glow = vec3(arcCol.x, arcCol.y, arcCol.z).mul(core).mul(vI).mul(ctx.uniforms.flashLimit.mul(0.8).add(0.2));
    const col = additiveFog(glow as unknown as V3);
    m.colorNode = vec4(col, 1);
    m.blending = AdditiveBlending;
    m.transparent = true;
    m.depthWrite = false;
    m.side = DoubleSide;
    m.fog = false;
    m.mrtNode = mrt({ emissive: vec4(col.mul(p.bloom), 1) });
    const mesh = new Mesh(new PlaneGeometry(1, 1), m);
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    const sc = linear(p.sparkColor);
    const showerNext = p.showers.map((s) => s.every[0] + rand() * (s.every[1] - s.every[0]));
    const arcState = p.arcs.map((s) => ({ next: s.every[0] + rand() * (s.every[1] - s.every[0]), until: -1, redraw: 0 }));
    const reduced = ctx.quality.reducedMotion;
    const spray = (x: number, y: number, zz: number, n: number, now: number, speed: number) => {
      const c = ctx.bursts.budget(n);
      for (let k = 0; k < c; k++) {
        const ang = rand() * Math.PI * 2;
        const sp = speed * (0.3 + rand());
        const hot = 0.8 + rand() * 1.4;
        ctx.bursts.emit({ x, y, z: zz, vx: Math.cos(ang) * sp * 0.6, vy: sp * (0.2 + rand() * 0.8), vz: Math.sin(ang) * sp * 0.6, r: sc.x * hot, g: sc.y * hot, b: sc.z * hot, size: 0.06 + rand() * 0.1, life: 0.6 + rand() * 1.0, gravity: -9.8, drag: 0.6, shape: 'spark', swirl: 0 }, now);
      }
    };
    return {
      object: mesh,
      update(frame) {
        const now = frame.time;
        const dt = Math.min(0.1, frame.dt);
        p.showers.forEach((s, i) => {
          showerNext[i]! -= dt;
          if (showerNext[i]! <= 0) {
            showerNext[i] = s.every[0] + rand() * (s.every[1] - s.every[0]);
            if (!reduced || rand() < 0.4) spray(s.at[0], GROUND_Y + s.at[1], s.at[2], s.count, now, 2.5);
          }
        });
        let used = 0;
        const soft = ctx.uniforms.flashLimit.value < 0.99;
        p.arcs.forEach((s, i) => {
          const st = arcState[i]!;
          st.next -= dt;
          if (st.next <= 0 && st.until < now) {
            st.until = now + 0.18 + rand() * 0.35;
            st.next = s.every[0] + rand() * (s.every[1] - s.every[0]);
            st.redraw = 0;
            spray(s.from[0], GROUND_Y + s.from[1], s.from[2], 18, now, 3);
            notice(w, s.from[0], GROUND_Y + s.from[1], s.from[2], 0.3);
          }
          if (st.until > now) {
            st.redraw -= dt;
            // A fresh jagged path a few times per discharge (slower with flash reduction).
            const pts: [number, number, number][] = [];
            const ax = s.from[0], ay = GROUND_Y + s.from[1], az = s.from[2];
            const bx = s.to[0], by = GROUND_Y + s.to[1], bz = s.to[2];
            const len = Math.hypot(bx - ax, by - ay, bz - az);
            const jag = len * 0.12;
            const seedK = Math.floor(now * (soft ? 8 : 24)) + i * 13;
            const r2 = seeded(seedK);
            for (let k = 0; k <= segs; k++) {
              const f = k / segs;
              const sag = Math.sin(f * Math.PI);
              pts.push([ax + (bx - ax) * f + (r2() - 0.5) * jag * sag, ay + (by - ay) * f + (r2() - 0.5) * jag * sag - sag * len * 0.05, az + (bz - az) * f + (r2() - 0.5) * jag * sag]);
            }
            const fade = Math.max(0, Math.min(1, (st.until - now) / 0.08));
            const flickerI = (0.5 + 0.5 * r2()) * fade * (soft ? 0.35 : 1);
            for (let k = 0; k < segs; k++) {
              const p0 = pts[k]!;
              const p1 = pts[k + 1]!;
              ia.setXYZW(used, p0[0], p0[1], p0[2], 0.06 + 0.04 * r2());
              ib.setXYZW(used, p1[0], p1[1], p1[2], flickerI * 2.2);
              used++;
            }
          }
        });
        mesh.count = used;
        mesh.visible = used > 0;
        if (used > 0) {
          ia.needsUpdate = true;
          ib.needsUpdate = true;
        }
      },
      dispose() {
        mesh.geometry.dispose();
        m.dispose();
        release(w);
      },
    };
  },
};

