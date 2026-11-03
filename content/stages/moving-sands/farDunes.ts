import { BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, NormalBlending, Vector3, type Material, type Node, type Object3D, type Texture } from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  float,
  fwidth,
  length,
  max,
  mix,
  mx_cell_noise_float,
  mx_noise_float,
  normalWorld,
  normalize,
  positionWorld,
  pow,
  screenCoordinate,
  smoothstep,
  step,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { colorUniform, floatUniform, noBloom, seeded, z, zColor, type ComponentFactory, type EnvironmentContext } from '@prismfall/sdk';
import { buildDuneMesh, createDuneField, type DuneField } from './duneField';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

const DEG = Math.PI / 180;

const ridgeSchema = z.object({
  distance: z.number().positive(),
  height: z.number().positive(),
  meander: z.number().min(0).max(0.12).default(0.05),
  variation: z.number().min(0).max(1).default(0.5),
  peaks: z.number().min(0).max(2).default(0.4),
});

const schema = z.object({
  field: z
    .object({
      center: z.tuple([z.number(), z.number()]).default([0, 34]),
      span: z.tuple([z.number(), z.number()]).default([-100, 100]),
      start: z.number().positive().default(470),
      floor: z.number().default(-17),
      floorRise: z.number().default(6),
      ridges: z.array(ridgeSchema).min(1).max(10),
      lee: z.enum(['far', 'near']).default('far'),
      slip: z.number().min(10).max(45).default(33),
      stoss: z.number().min(3).max(30).default(20),
      undulation: z.number().min(0).max(0.4).default(0.08),
      perspective: z.number().min(0).max(1).default(0.6),
      seed: z.number().default(5),
    }),
  /** The near terrain layer's mesh wedge (`apex`, `far`, `spread`): the field stays under it. */
  near: z.object({ apex: z.tuple([z.number(), z.number()]).default([0, 34]), far: z.number().positive(), spread: z.number().positive() }).optional(),
  mesh: z.object({ columnsPerDegree: z.number().min(1).max(20).default(7), rowsPerGap: z.number().int().min(6).max(64).default(22) }).prefault({}),
  /**
   * Light on the sand (albedo folded in, engine colour convention): `ambient` from the sky, `moon`
   * at full facing. The grade crushes scene values under about 0.02, so these sit just above it.
   */
  light: z
    .object({
      ambient: zColor.default('#76767f'),
      moon: zColor.default('#838488'),
      /** The moon, low and just off frame to the front right: slip faces facing the viewer fall into shadow. */
      direction: z.tuple([z.number(), z.number()]).default([62, 10]),
      wrap: z.number().min(0).max(1).default(0.05),
      /** Darkening of the troughs and slope feet (0 = none). */
      occlusion: z.number().min(0).max(1).default(0.35),
      /** Moonlight caught by the rounded brinks above the shadowed slip faces. */
      brink: z.number().min(0).default(2.1),
    })
    .prefault({}),
  /** Interdune gravel, relative to the sand. */
  interdune: zColor.default('#fbfbfa'),
  /** Superimposed small dunes on the windward slopes (normal relief), faded before they alias. */
  dunelets: z.object({ strength: z.number().min(0).default(0.2), wavelength: z.number().positive().default(46), direction: z.number().default(20) }).prefault({}),
  /** Aerial perspective: transmittance exp(−density × distance), denser low in the valleys; slow drifting veils. */
  haze: z
    .object({
      color: zColor.default('#898a89'),
      density: z.number().min(0).default(0.00045),
      base: z.number().default(-16),
      height: z.number().positive().default(45),
      drift: z.number().min(0).max(1).default(0.35),
      wind: z.number().default(0.006),
      /** Brighter haze towards the moon. */
      moonSide: z.number().min(0).default(0.12),
    })
    .prefault({}),
  /** Scanned rocks scaled up into distant kopjes, standing in the sand. */
  rocks: z
    .array(
      z.object({
        src: z.string(),
        azimuth: z.number(),
        distance: z.number().positive(),
        scale: z.number().positive(),
        yaw: z.number().default(0),
        /** Height of the scan in its own units, buried in the sand (fraction). */
        sink: z.number().min(0).max(0.9).default(0.2),
        height: z.number().positive().default(1),
        /** Brightness relative to moonlit sand. */
        shade: z.number().min(0).default(0.85),
      }),
    )
    .default([]),
  /** Sand streaming off the nearer crests on the wind. */
  spindrift: z
    .object({
      count: z.number().int().min(0).max(400).default(60),
      ridges: z.array(z.number().int().min(0)).default([0, 1, 2, 3]),
      /** No plumes within this many degrees of straight ahead (the board's clear zone). */
      clear: z.number().min(0).default(20),
      length: z.number().positive().default(100),
      height: z.number().positive().default(18),
      /** Wind direction (degrees, as azimuth: 90 = blowing to the right). */
      wind: z.number().default(105),
      rise: z.number().default(0.12),
      color: zColor.default('#9c9d9e'),
      opacity: z.number().min(0).max(1).default(1),
      speed: z.number().default(0.5),
      seed: z.number().default(9),
    })
    .prefault({}),
  dither: z.number().min(0).default(0.0007),
});

type Params = z.infer<typeof schema>;

function dirOf([az, el]: readonly [number, number]): Vector3 {
  return new Vector3(Math.sin(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG), -Math.cos(az * DEG) * Math.cos(el * DEG));
}

/**
 * Crossfade mask for the opaque far field (as the built-in terrain does): the world is revealed
 * outward from the viewer with a ragged edge as presence rises, reaching past the farthest ridge
 * at full presence. Use with alphaTest 0.5.
 */
function reveal(presence: F, reach = 2600): F {
  const dist = length(positionWorld.sub(cameraPosition));
  const edge = mx_noise_float(positionWorld.mul(0.012)).mul(0.06);
  const front = smoothstep(0, 1, presence).mul(1.12);
  return step(dist.div(reach).add(edge).add(0.02), front);
}

interface Shading {
  /** Moonlit colour for a surface normal (before haze). */
  lit(n: V3, occlusion: F): V3;
  /** Direction to the moon and its light (albedo folded in). */
  L: V3;
  moon: V3;
  /** Aerial perspective over the surface colour at the current fragment. */
  haze(color: V3): V3;
  dither: F;
}

function shading(ctx: EnvironmentContext, p: Params): Shading {
  const moonDir = dirOf(p.light.direction);
  const L = vec3(moonDir.x, moonDir.y, moonDir.z);
  const ambient = colorUniform(p.light.ambient);
  const moon = colorUniform(p.light.moon);
  const wp = positionWorld;
  const toCam = cameraPosition.sub(wp);
  const dist = length(toCam);
  const time = ctx.uniforms.time;
  const hz = p.haze;
  const veil = mx_noise_float(vec3(wp.x.mul(0.0022).sub(time.mul(hz.wind)), wp.z.mul(0.0022), 3.3)).mul(hz.drift).add(1);
  const low = exp(max(wp.y.sub(hz.base), 0).div(-hz.height)).mul(0.6).add(0.4);
  const T = exp(dist.mul(hz.density).mul(veil).mul(low).negate());
  const view = normalize(vec2(toCam.x, toCam.z).negate());
  const side = max(dot(view, normalize(vec2(moonDir.x, moonDir.z))), 0);
  const hazeCol = colorUniform(hz.color).mul(side.mul(side).mul(hz.moonSide).add(1));
  const n1 = mx_cell_noise_float(vec3(screenCoordinate.xy, 5));
  const n2 = mx_cell_noise_float(vec3(screenCoordinate.xy.add(vec2(29.1, 7.7)), 13));
  return {
    L,
    moon,
    lit(n, occlusion) {
      const diffuse = clamp(dot(n, L).add(p.light.wrap).div(1 + p.light.wrap), 0, 1);
      return ambient.mul(n.y.mul(0.3).add(0.7)).mul(occlusion).add(moon.mul(diffuse));
    },
    haze(color) {
      return mix(hazeCol, color, T);
    },
    dither: n1.add(n2).sub(1).mul(p.dither),
  };
}

function duneMaterial(p: Params, s: Shading, presence: F): MeshBasicNodeMaterial {
  const info = attribute<'vec4'>('dune', 'vec4');
  const h01 = info.x;
  const slipSide = info.z;
  const wp = positionWorld;
  let n: V3 = normalize(normalWorld);
  // Superimposed dunelets: a meandering ripple field on the windward slopes, faded by its
  // screen-space frequency so it never aliases.
  const a = p.dunelets.direction * DEG;
  const wdir = vec2(Math.cos(a), Math.sin(a));
  const phase = dot(wp.xz, wdir)
    .div(p.dunelets.wavelength)
    .add(mx_noise_float(vec3(wp.x.mul(0.006), 0.7, wp.z.mul(0.006))).mul(3.2))
    .add(mx_noise_float(vec3(wp.x.mul(0.021), 4.1, wp.z.mul(0.021))).mul(0.7));
  const amp = smoothstep(0.42, 0.1, fwidth(phase)).mul(float(1).sub(slipSide)).mul(p.dunelets.strength);
  n = normalize(n.sub(vec3(wdir.x, 0, wdir.y).mul(cos(phase.mul(Math.PI * 2)).mul(amp))));
  const occlusion = mix(float(1 - p.light.occlusion), float(1), smoothstep(0, 0.55, h01));
  const patches = mx_noise_float(vec3(wp.x.mul(0.004), 2.1, wp.z.mul(0.004))).mul(0.05).add(1);
  const gravel = smoothstep(0.1, 0.015, h01);
  const albedo = mix(vec3(1, 1, 1), colorUniform(p.interdune), gravel).mul(patches);
  // The brink is rounded over a few metres: its top faces up and away from the viewer, so it
  // catches the low moon above a slip face in shadow.
  const away = normalize(wp.xz.sub(cameraPosition.xz));
  const brinkNormal = normalize(vec3(away.x.mul(0.6), 0.8, away.y.mul(0.6)));
  // Sharper and rounder stretches of brink alternate along the crests.
  const brinkVary = mx_noise_float(vec3(wp.x.mul(0.012), 6.1, wp.z.mul(0.012))).mul(0.45).add(0.85);
  const brink = smoothstep(0.8, 0.99, h01).mul(slipSide).mul(clamp(dot(brinkNormal, s.L), 0, 1)).mul(brinkVary).mul(p.light.brink);
  const color = s.haze(s.lit(n, occlusion).add(s.moon.mul(brink)).mul(albedo)).add(s.dither);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = vec4(color, 1);
  material.opacityNode = reveal(presence);
  material.alphaTest = 0.5;
  material.fog = false;
  noBloom(material);
  return material;
}

/** Mean linear luminance of a texture's image (a 16 × 16 downsample), or a typical rock albedo. */
function meanLuminance(map: Texture | null): number {
  try {
    const img = map?.image as CanvasImageSource | undefined;
    if (!img || typeof OffscreenCanvas === 'undefined') return 0.25;
    const canvas = new OffscreenCanvas(16, 16);
    const g = canvas.getContext('2d');
    if (!g) return 0.25;
    g.drawImage(img, 0, 0, 16, 16);
    const px = g.getImageData(0, 0, 16, 16).data;
    const lin = (v: number): number => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += 0.2126 * lin(px[i]!) + 0.7152 * lin(px[i + 1]!) + 0.0722 * lin(px[i + 2]!);
    return Math.max(0.03, sum / (px.length / 4));
  } catch {
    return 0.25;
  }
}

/** Scanned rock material: its photographed albedo, lit and hazed like the dunes. */
function rockMaterial(map: Texture | null, shade: number, s: Shading, presence: F): MeshBasicNodeMaterial {
  const mean = meanLuminance(map);
  const n = normalize(normalWorld);
  // The scan's albedo, mostly desaturated and normalised around its mean, so only its tonal
  // variation (joints, lichen, weathering) shows under the moon.
  const tex = map ? texture(map, uv()).rgb : vec3(0.3, 0.3, 0.3);
  const lum = dot(tex, vec3(0.2126, 0.7152, 0.0722));
  const albedo = clamp(mix(vec3(lum, lum, lum), tex, 0.08).div(mean), 0.3, 1.8);
  const color = s.haze(s.lit(n, float(1)).mul(albedo).mul(shade)).add(s.dither);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = vec4(color, 1);
  material.opacityNode = reveal(presence);
  material.alphaTest = 0.5;
  material.fog = false;
  noBloom(material);
  return material;
}

/** Spindrift: sheets of sand streaming downwind off crest points, flowing and gusting. */
function spindrift(ctx: EnvironmentContext, p: Params, field: DuneField, crests: Float32Array[], columns: number, s: Shading, presence: F): Mesh | null {
  const sp = p.spindrift;
  const detail = ctx.quality.detail === 'low' ? 0.4 : ctx.quality.detail === 'medium' ? 0.7 : 1;
  const count = Math.round(sp.count * detail * Math.min(1.5, Math.max(0.3, ctx.quality.particles)));
  if (count <= 0) return null;
  const rand = seeded(sp.seed * 7717 + 3);
  const span = field.spec.span;
  const candidates: { x: number; y: number; z: number; h: number; az: number; k: number }[] = [];
  for (const k of sp.ridges) {
    const row = crests[k];
    if (!row) continue;
    for (let c = 0; c < columns; c += 3) {
      const az = span[0] + ((span[1] - span[0]) * c) / (columns - 1);
      if (Math.abs(az) < sp.clear || Math.abs(az) > 60) continue;
      candidates.push({ x: row[c * 4]!, y: row[c * 4 + 1]!, z: row[c * 4 + 2]!, h: row[c * 4 + 3]!, az, k });
    }
  }
  if (candidates.length === 0) return null;
  const maxH = Math.max(...candidates.map((c) => c.h));
  const chosen: typeof candidates = [];
  let guard = 0;
  while (chosen.length < count && guard++ < count * 60) {
    const c = candidates[Math.floor(rand() * candidates.length)]!;
    // Sand leaves the highest, most exposed crests.
    if (rand() > Math.pow(c.h / maxH, 1.5)) continue;
    if (chosen.some((o) => Math.abs(o.az - c.az) < 0.6 && o.k === c.k)) continue;
    chosen.push(c);
  }
  const n = chosen.length;
  const positions = new Float32Array(n * 4 * 3);
  const corner = new Float32Array(n * 4 * 2);
  const params = new Float32Array(n * 4 * 4);
  const index = new Uint16Array(n * 6);
  const wa = sp.wind * DEG;
  const wind = new Vector3(Math.sin(wa), 0, -Math.cos(wa));
  chosen.forEach((c, i) => {
    const scale = Math.max(0.45, c.h / maxH) * (0.7 + rand() * 0.6);
    const len = sp.length * scale;
    const h = sp.height * scale;
    const corners: [number, number][] = [
      [0, -1],
      [1, -1],
      [1, 1],
      [0, 1],
    ];
    corners.forEach(([ax, cy], j) => {
      const v = i * 4 + j;
      // The sheet widens and lifts downwind; the shader shapes it inside the quad.
      const lift = sp.rise * len * ax * ax;
      const half = h * (0.35 + ax * 0.9);
      positions.set([c.x + wind.x * len * ax, c.y + 0.4 + lift + cy * half, c.z + wind.z * len * ax], v * 3);
      corner.set([ax, cy], v * 2);
      params.set([rand() * 100, 0.6 + rand() * 0.8, c.az, scale], v * 4);
    });
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('corner', new BufferAttribute(corner, 2));
  geometry.setAttribute('plume', new BufferAttribute(params, 4));
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.computeBoundingSphere();

  const time = ctx.uniforms.time;
  const cr = attribute<'vec2'>('corner', 'vec2');
  const pl = attribute<'vec4'>('plume', 'vec4');
  const along = cr.x;
  const across = cr.y;
  const seed = pl.x;
  const rate = pl.y;
  const az = pl.z;
  // Thin at the crest, fanning out and thinning downwind.
  const env = smoothstep(0, 0.06, along).mul(pow(float(1).sub(along), 1.5));
  const width = along.mul(0.75).add(0.25);
  const body = exp(across.div(width).pow2().mul(-1.7));
  // Streaks flowing downwind; gusts sweep across the field with the wind (left to right).
  const flow = mx_noise_float(vec3(along.mul(6).sub(time.mul(sp.speed).mul(rate)), across.mul(2.6), seed)).mul(0.5).add(0.5);
  const streaks = pow(flow, 1.5).mul(1.8);
  const gust = smoothstep(-0.35, 0.45, mx_noise_float(vec3(time.mul(0.045).sub(az.mul(0.035)), seed.mul(0.01), 4.4)));
  const alpha = clamp(env.mul(body).mul(streaks).mul(gust).mul(sp.opacity), 0, 1);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = vec4(s.haze(colorUniform(sp.color)), 1);
  material.opacityNode = alpha.mul(presence);
  material.transparent = true;
  material.blending = NormalBlending;
  material.depthWrite = false;
  material.side = DoubleSide;
  material.fog = false;
  noBloom(material);
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return mesh;
}

/**
 * The far background of Moving Sands: receding ridgelines of a generated dune sea (crest-aligned
 * 3D mesh, sharp brinks, slip faces, dunelets) under moonlight and night haze, scanned granite
 * kopjes standing in the sand, and sand streaming off the nearer crests.
 */
export const sandsFarDunes: ComponentFactory<Params> = {
  type: 'sandsFarDunes',
  version: 1,
  description: 'Generated far dune sea with sharp crests, night haze, scanned rock kopjes and spindrift.',
  schema,
  async create(ctx, p) {
    const field = createDuneField({ ...p.field, ridges: p.field.ridges });
    const detail = ctx.quality.detail === 'low' ? 0.5 : ctx.quality.detail === 'medium' ? 0.75 : 1;
    const near = p.near ? { ...p.near, height: (x: number, zz: number) => ctx.ground.height(x, zz) } : undefined;
    const built = buildDuneMesh(field, {
      columnsPerDegree: p.mesh.columnsPerDegree * detail,
      rowsPerGap: Math.max(8, Math.round(p.mesh.rowsPerGap * (detail < 1 ? 0.75 : 1))),
      near,
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(built.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(built.normals, 3));
    geometry.setAttribute('dune', new BufferAttribute(built.dune, 4));
    geometry.setIndex(new BufferAttribute(built.index, 1));
    geometry.computeBoundingSphere();

    const presence = floatUniform(1);
    const s = shading(ctx, p);
    const group = new Group();
    const materials: Material[] = [];
    const duneMat = duneMaterial(p, s, presence);
    materials.push(duneMat);
    const dunes = new Mesh(geometry, duneMat);
    dunes.frustumCulled = false;
    // After the near terrain (−8): its pixels in front reject these early.
    dunes.renderOrder = -7;
    group.add(dunes);

    const loaded: string[] = [];
    for (const rock of p.rocks) {
      try {
        const gltf = await ctx.assets.loadGLTF(rock.src);
        loaded.push(rock.src);
        const obj = gltf.scene.clone(true);
        obj.traverse((o: Object3D) => {
          const m = o as Mesh;
          if (!m.isMesh) return;
          const src = m.material as unknown as { map?: Texture | null };
          const mat = rockMaterial(src.map ?? null, rock.shade, s, presence);
          materials.push(mat);
          m.material = mat;
          m.castShadow = false;
          m.receiveShadow = false;
          m.frustumCulled = false;
          m.renderOrder = -7;
        });
        const [x, zz] = field.xz(rock.azimuth, rock.distance);
        const y = field.height(rock.azimuth, rock.distance) - rock.sink * rock.height * rock.scale;
        obj.position.set(x, y, zz);
        obj.rotation.y = rock.yaw * DEG;
        obj.scale.setScalar(rock.scale);
        group.add(obj);
      } catch (err) {
        console.warn(`[sandsFarDunes] rock ${rock.src} not loaded`, err);
      }
    }

    const drift = spindrift(ctx, p, field, built.crests, built.columns, s, presence);
    if (drift) {
      materials.push(drift.material as Material);
      group.add(drift);
    }
    return {
      object: group,
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        geometry.dispose();
        drift?.geometry.dispose();
        for (const m of materials) m.dispose();
        for (const src of loaded) ctx.assets.release(src);
      },
    };
  },
};
