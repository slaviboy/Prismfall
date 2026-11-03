import { DoubleSide, Group, InstancedMesh, Matrix4, MeshBasicNodeMaterial, Quaternion, Vector3, type Texture } from 'three/webgpu';
import { cameraPosition, cross, dFdx, dFdy, dot, float, inverseSqrt, max, mix, mrt, normalWorld, normalize, positionWorld, smoothstep, step, texture, uv, vec3, vec4 } from 'three/tsl';
import { floatUniform, z, type ComponentFactory } from '@prismfall/sdk';
import { fogModelFor } from './atmosphere';
import { partsNamed, baseOf, type BakedPart } from './models';
import { castShadow } from './shadow';
import { cast, release, rng, shared, type F, type V3 } from './shared';
import { createLighting, zLighting, type Lighting } from './surface';
import { EYE, WATER, boardLimit, terrainHeight } from './terrain';

const zPlace = z.object({
  model: z.string(),
  object: z.string(),
  /** Azimuth (degrees, 0 = behind the board, + right) and distance from the eye. */
  az: z.number(),
  dist: z.number().positive(),
  yaw: z.number().default(0),
  scale: z.number().positive().default(1),
  /** Sink into the ground (metres). */
  sink: z.number().default(0.1),
  tint: z.number().default(1),
  shadow: z.boolean().default(true),
});

const zScatter = z.object({
  model: z.string(),
  objects: z.array(z.string()).min(1),
  count: z.number().int().min(0).max(800),
  /** Azimuth bands (degrees, both signs allowed) and distance range. */
  az: z.array(z.tuple([z.number(), z.number()])).min(1),
  dist: z.tuple([z.number(), z.number()]),
  scale: z.tuple([z.number(), z.number()]).default([0.85, 1.2]),
  /** Keeps this many degrees either side of the board clear (up to `clearUntil` metres). */
  clear: z.number().default(23),
  clearUntil: z.number().default(650),
  tilt: z.number().default(3),
  spacing: z.number().default(4),
  sink: z.number().default(0.2),
  tint: z.number().default(1),
  shadow: z.boolean().default(true),
  /** Allow standing in the marsh water (drowned trees). */
  wet: z.boolean().default(true),
  minDetail: z.enum(['low', 'medium', 'high', 'ultra']).default('low'),
  seed: z.number().default(1),
});

const schema = z.object({
  exposure: z.number().min(0).default(0.4),
  lighting: zLighting,
  landmarks: z.array(zPlace).default([]),
  scatter: z.array(zScatter).default([]),
  seed: z.number().default(5),
});

type Params = z.infer<typeof schema>;

const DETAIL = ['low', 'medium', 'high', 'ultra'] as const;
const DEG = Math.PI / 180;

/** Normal from a tangent-space map using a cotangent frame from screen derivatives (no tangents needed). */
function perturbed(n: V3, map: Texture | null, uvN: ReturnType<typeof uv>, strength: number): V3 {
  if (!map) return n;
  const m = cast<V3>(texture(map, uvN).xyz.mul(2).sub(1));
  const p = cast<V3>(positionWorld);
  const dp1 = cast<V3>(dFdx(p));
  const dp2 = cast<V3>(dFdy(p));
  const duv1 = dFdx(uvN);
  const duv2 = dFdy(uvN);
  const dp2perp = cast<V3>(cross(dp2, n));
  const dp1perp = cast<V3>(cross(n, dp1));
  const t = cast<V3>(dp2perp.mul(duv1.x).add(dp1perp.mul(duv2.x)));
  const b = cast<V3>(dp2perp.mul(duv1.y).add(dp1perp.mul(duv2.y)));
  const inv = cast<F>(inverseSqrt(max(dot(t, t), dot(b, b)).max(1e-12)));
  return cast<V3>(normalize(t.mul(inv).mul(m.x.mul(strength)).add(b.mul(inv).mul(m.y.mul(-strength))).add(n.mul(m.z))));
}

/** A photographed-material surface (scans, bark, planks, stone) lit and fogged like the rest of the world. */
export function sceneryMaterial(light: Lighting, part: BakedPart, opts: { tint: number; presence: { value: number }; desaturate?: number; wetBelow?: number; sheen?: number; rim?: number; fill?: number; contrast?: number }): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  const uvN = uv();
  const dist = cast<F>(positionWorld.sub(cameraPosition).length());
  let albedo: V3 = part.maps.map ? cast<V3>(texture(part.maps.map, uvN).rgb) : cast<V3>(vec3(0.3, 0.28, 0.26));
  const grey = dot(albedo, vec3(0.3, 0.59, 0.11));
  albedo = cast<V3>(mix(albedo, vec3(grey), opts.desaturate ?? 0.35).mul(opts.tint));
  // Bark and timber: deepen the grooves so the grain reads in low light.
  if (opts.contrast) albedo = cast<V3>(albedo.pow(vec3(opts.contrast)).mul(1 + (opts.contrast - 1) * 2.2));
  const n0 = cast<V3>(normalize(normalWorld));
  const n = cast<V3>(mix(n0, perturbed(n0, part.maps.normalMap, uvN, 1), smoothstep(120, 25, dist)));
  const rough = part.maps.roughnessMap ? cast<F>(texture(part.maps.roughnessMap, uvN).g) : cast<F>(float(0.85));
  const ao = part.maps.aoMap ? cast<F>(texture(part.maps.aoMap, uvN).r.mul(0.7).add(0.3)) : cast<F>(float(1));
  // Wet near the water; rocks also carry a damp sheen on their upward faces (dew and mist).
  const low = opts.wetBelow !== undefined ? cast<F>(smoothstep(opts.wetBelow + 0.8, opts.wetBelow, positionWorld.y)) : cast<F>(float(0));
  const damp = cast<F>(n0.y.max(0).pow(2).mul(opts.sheen ?? 0));
  const wet = cast<F>(low.add(damp).min(1));
  albedo = cast<V3>(albedo.mul(mix(float(1), float(0.6), low)));
  const color = light.shade({ albedo, normal: n, world: cast<V3>(positionWorld), roughness: cast<F>(rough.mul(float(1).sub(damp.mul(0.5)))), ao, wet, rim: opts.rim ?? 0.7, fill: opts.fill ?? 1.6 });
  m.colorNode = vec4(color, 1);
  // Crossfades: the world appears outward from the viewer.
  m.opacityNode = cast<F>(step(dist, float(1900).mul(cast<F>(opts.presence)).add(1)));
  m.alphaTest = 0.5;
  m.fog = false;
  m.side = DoubleSide;
  m.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
  return m;
}

/**
 * The scenery: photoscanned stumps, roots, fallen trunks and mossy rocks (Poly Haven) around the
 * viewer and through the lowland, Blender-built dead trees in groves that thin into the fog and a
 * far forest of low-detail trees, the ruined cabin, lookout tower, boardwalk and fence, and the far
 * stone architecture. Trees and ruins cast moon shadows (into the fog: light shafts).
 */
export const sceneryComponent: ComponentFactory<Params> = {
  type: 'veilScenery',
  version: 1,
  description: 'Scanned rocks and deadwood, Blender dead trees and ruins, placed outside the clear zone.',
  schema,
  async create(ctx, p) {
    const s = shared(ctx);
    const fog = await fogModelFor(ctx, s, p.exposure);
    const light = createLighting(s, fog, p.lighting);
    const presence = floatUniform(1);
    const group = new Group();
    const disposables: { dispose(): void }[] = [];
    const loaded = new Map<string, Awaited<ReturnType<typeof ctx.assets.loadGLTF>>>();
    const load = async (src: string) => {
      let g = loaded.get(src);
      if (!g) {
        g = await ctx.assets.loadGLTF(src);
        loaded.set(src, g);
      }
      return g;
    };
    const detailIdx = DETAIL.indexOf(ctx.quality.detail);
    const placed: { x: number; z: number; r: number }[] = [];
    const free = (x: number, zz: number, r: number) => placed.every((q) => (q.x - x) ** 2 + (q.z - zz) ** 2 > (q.r + r) ** 2);

    const addInstances = (parts: BakedPart[], matrices: Matrix4[], tint: number, shadow: boolean, name: string) => {
      if (matrices.length === 0) return;
      for (const part of parts) {
        const rocky = /rock|boulder/.test(part.name);
        const mat = sceneryMaterial(light, part, { tint: tint * (rocky ? 1.1 : 1.25), presence, wetBelow: WATER, sheen: rocky ? 0.55 : 0.1, rim: rocky ? 0.5 : 0.9, desaturate: rocky ? 0.25 : 0.2, fill: rocky ? 1.5 : 1.9, contrast: rocky ? 1 : 1.35 });
        const mesh = new InstancedMesh(part.geometry, mat, matrices.length);
        matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.name = `veil-${name}`;
        group.add(mesh);
        if (shadow) castShadow(mesh);
        disposables.push(part.geometry, mat);
      }
    };

    const matrix = (x: number, y: number, zz: number, yaw: number, scale: number, tiltX = 0, tiltZ = 0) => {
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
      const t = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), tiltX).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), tiltZ));
      return new Matrix4().compose(new Vector3(x, y, zz), t.multiply(q), new Vector3(scale, scale, scale));
    };

    // Landmarks: ruins, monuments and hand-placed scans.
    for (const l of p.landmarks) {
      const g = await load(l.model);
      const parts = partsNamed(g.scene, l.object);
      if (parts.length === 0) {
        console.warn(`[the-veil] no object "${l.object}" in ${l.model}`);
        continue;
      }
      const a = l.az * DEG;
      const x = EYE.x + Math.sin(a) * l.dist;
      const zz = EYE.z - Math.cos(a) * l.dist;
      const y = terrainHeight(x, zz) - l.sink - Math.min(...parts.map((q) => baseOf(q.geometry))) * l.scale;
      // Keep others off its real footprint (not a fixed radius): rocks and stumps are small.
      const footprint = Math.max(...parts.map((q) => (q.geometry.boundingBox ? Math.max(q.geometry.boundingBox.max.x - q.geometry.boundingBox.min.x, q.geometry.boundingBox.max.z - q.geometry.boundingBox.min.z) : 4))) * 0.5 * l.scale;
      placed.push({ x, z: zz, r: footprint });
      addInstances(parts, [matrix(x, y, zz, l.yaw * DEG, l.scale)], l.tint, l.shadow, l.object);
    }

    // Scattered trees and scans.
    for (const sc of p.scatter) {
      if (detailIdx < DETAIL.indexOf(sc.minDetail)) continue;
      const g = await load(sc.model);
      const kinds = sc.objects.map((o) => partsNamed(g.scene, o)).filter((q) => q.length > 0);
      if (kinds.length === 0) continue;
      const r = rng(sc.seed * 7919 + p.seed);
      const count = Math.round(sc.count * (detailIdx === 0 ? 0.5 : detailIdx === 1 ? 0.75 : 1));
      const per: Matrix4[][] = kinds.map(() => []);
      let tries = 0;
      let made = 0;
      while (made < count && tries < count * 40) {
        tries++;
        const band = sc.az[Math.floor(r() * sc.az.length)]!;
        const az = band[0] + (band[1] - band[0]) * r();
        // Denser near the inner edge of the distance range (groves thin into the fog).
        const u = r();
        const dist = sc.dist[0] + (sc.dist[1] - sc.dist[0]) * u * u;
        if (Math.abs(az) < sc.clear && dist < sc.clearUntil) continue;
        const a = az * DEG;
        const x = EYE.x + Math.sin(a) * dist;
        const zz = EYE.z - Math.cos(a) * dist;
        const h = terrainHeight(x, zz);
        if (h > boardLimit(x, zz) - 30) continue;
        if (!sc.wet && h < WATER + 0.1) continue;
        const spacing = sc.spacing * (0.7 + 0.6 * r());
        if (!free(x, zz, spacing)) continue;
        placed.push({ x, z: zz, r: spacing });
        const k = Math.floor(r() * kinds.length);
        const scale = sc.scale[0] + (sc.scale[1] - sc.scale[0]) * r();
        const base = Math.min(...kinds[k]!.map((q) => baseOf(q.geometry)));
        const tilt = sc.tilt * DEG;
        per[k]!.push(matrix(x, h - sc.sink - base * scale, zz, r() * Math.PI * 2, scale, (r() - 0.5) * 2 * tilt, (r() - 0.5) * 2 * tilt));
        made++;
      }
      kinds.forEach((parts, k) => addInstances(parts.map((q) => ({ ...q, geometry: q.geometry.clone() })), per[k]!, sc.tint, sc.shadow, sc.objects[k]!));
      kinds.forEach((parts) => parts.forEach((q) => q.geometry.dispose()));
    }

    return {
      object: group,
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        disposables.forEach((d) => d.dispose());
        for (const src of loaded.keys()) ctx.assets.release(src);
        release(ctx, s);
      },
    };
  },
};
