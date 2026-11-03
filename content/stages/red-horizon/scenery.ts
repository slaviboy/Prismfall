import { BufferAttribute, BufferGeometry, Euler, Group, InstancedMesh, Matrix4, Quaternion, Vector3, type DataTexture, type Mesh, type MeshStandardNodeMaterial, type Object3D, type Texture } from 'three/webgpu';
import { dot, float, mix, mx_fractal_noise_float, mx_noise_float, normalWorldGeometry, positionWorld, sin, smoothstep, vec3 } from 'three/tsl';
import { floatUniform, z, type ComponentFactory } from '@prismfall/sdk';
import { GROUND_Y, backdropTexture, envTexture, lin, release, shadeMaterial, stageTexture, triplanar, world, zHaze, type F, type Haze, type V3, type World } from './shared';

/** Geometry of every named top-level object in a kit GLB, split by material, in object space. */
export type Kit = Map<string, { material: string; geometry: BufferGeometry }[]>;

export function bakeKit(root: Object3D): Kit {
  root.updateMatrixWorld(true);
  const kit: Kit = new Map();
  const v = new Vector3();
  const nm = new Matrix4();
  for (const top of root.children) {
    const parts: { material: string; geometry: BufferGeometry }[] = [];
    top.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      // The kit's objects sit at the origin in Blender, so a node's world matrix is only
      // gltf-transform's dequantisation (scale and offset); bake it into float attributes.
      const src = mesh.geometry;
      const p = src.getAttribute('position');
      const n = src.getAttribute('normal');
      const pos = new Float32Array(p.count * 3);
      const nrm = new Float32Array(p.count * 3);
      nm.copy(mesh.matrixWorld).invert().transpose();
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
        pos[i * 3] = v.x;
        pos[i * 3 + 1] = v.y;
        pos[i * 3 + 2] = v.z;
        v.fromBufferAttribute(n, i).applyMatrix4(nm).normalize();
        nrm[i * 3] = v.x;
        nrm[i * 3 + 1] = v.y;
        nrm[i * 3 + 2] = v.z;
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      g.setAttribute('normal', new BufferAttribute(nrm, 3));
      const index = src.getIndex();
      if (index) g.setIndex(Array.from({ length: index.count }, (_, i) => index.getX(i)));
      g.computeBoundingSphere();
      const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      parts.push({ material: m?.name ?? 'rhConcrete', geometry: g });
    });
    kit.set(top.name, parts);
  }
  return kit;
}

export interface SceneryTextures {
  concrete: [Texture | null, Texture | null];
  rust: [Texture | null, Texture | null];
  steel: [Texture | null, Texture | null];
}

export async function loadSceneryTextures(w: World): Promise<SceneryTextures> {
  const [ca, cn, ra, rn, sa, sn] = await Promise.all([
    stageTexture(w, 'textures/concrete_albedo.webp'),
    stageTexture(w, 'textures/concrete_nr.webp', false),
    stageTexture(w, 'textures/rust_albedo.webp'),
    stageTexture(w, 'textures/rust_nr.webp', false),
    stageTexture(w, 'textures/steel_albedo.webp'),
    stageTexture(w, 'textures/steel_nr.webp', false),
  ]);
  return { concrete: [ca, cn], rust: [ra, rn], steel: [sa, sn] };
}

/**
 * The photographed PBR surfaces of the ruined world, by Blender material name: weathered concrete
 * (Poly Haven concrete layers), heavy rust, corroded steel plate, charred surfaces, dark broken
 * glass mirroring the burning sky, asphalt, oxide-painted steel, and the lit parts (factory
 * interior strips, red aviation lamps blinking slowly, hot metal). Soot climbs from the ground and
 * blooms in patches; everything fogs into the photo behind it.
 */
export function sceneryMaterials(w: World, tex: SceneryTextures, env: Texture | null, backdrop: DataTexture | null, haze: Haze, presence: F, time: F, opts: { soot?: number; interior?: number } = {}): Record<string, MeshStandardNodeMaterial> {
  const p = positionWorld as unknown as V3;
  const n = normalWorldGeometry as unknown as V3;
  const soot = opts.soot ?? 1;
  const sootK = smoothstep(0.42, 0.78, mx_fractal_noise_float(p.mul(0.035), 3, 2, 0.5).mul(0.5).add(0.5))
    .mul(0.55)
    .add(smoothstep(8, 0, p.y.sub(GROUND_Y)).mul(0.35))
    .mul(soot)
    .clamp(0, 0.9);
  const grime = mx_noise_float(p.mul(0.4)).mul(0.12).add(0.94);
  const tC = triplanar(tex.concrete[0], tex.concrete[1], p, n, 0.37);
  const tR = triplanar(tex.rust[0], tex.rust[1], p, n, 0.45);
  const tS = triplanar(tex.steel[0], tex.steel[1], p, n, 0.42);
  const gray = (c: V3, k: number) => mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, k) as V3;
  const base = { presence, haze, backdrop, env, envIntensity: 2.5, rim: 0.4 };
  const make = (albedo: V3, rough: F, metal: number, normal: V3, glow?: V3, bloom = 0) =>
    shadeMaterial(w, { ...base, albedo: albedo.mul(float(1).sub(sootK)).mul(grime) as V3, roughness: rough, metalness: float(metal) as F, normal, glow, bloom });
  const concrete = gray(tC.albedo, 0.35).mul(0.5) as V3;
  // Burnt-out vehicles: faded paint survives only along the sills; above it the paint blistered
  // and burnt off to soot, rust and grey ash, darkest along the scorch line.
  const hY = p.y.sub(GROUND_Y);
  const wn = mx_noise_float(p.mul(2.7));
  const wf = mx_fractal_noise_float(p.mul(6.3), 3, 2, 0.5);
  const up = n.y.max(0);
  const scorchK = smoothstep(0.3, 0.68, hY.add(wn.mul(0.14)));
  const paint = lin('#2c3846').mul(dot(tS.albedo, vec3(0.33)).mul(1.2).add(0.55));
  const charred = mix(vec3(0.02, 0.018, 0.017), tR.albedo.mul(0.5), smoothstep(-0.25, 0.3, wn.add(up.mul(0.45)).add(wf.mul(0.3))));
  const ashed = mix(charred, vec3(0.1, 0.095, 0.09), smoothstep(0.3, 0.75, wf.add(up.mul(0.3))).mul(0.4));
  const scorchLine = scorchK.mul(float(1).sub(scorchK)).mul(4);
  const wreck = mix(paint, ashed, scorchK).mul(float(1).sub(scorchLine.mul(0.55))) as V3;
  const blink = smoothstep(0.6, 0.66, sin(time.mul(2.3).add(p.x.mul(0.37)).add(p.z.mul(0.21))).mul(0.5).add(0.5));
  const flicker = mx_noise_float(vec3(time.mul(1.7), p.x.mul(0.05), p.z.mul(0.05))).mul(0.18).add(0.9);
  return {
    rhConcrete: make(concrete, tC.rough as F, 0, tC.normal),
    rhConcreteDark: make(concrete.mul(0.5) as V3, tC.rough as F, 0, tC.normal),
    rhAsphalt: make(gray(tC.albedo, 0.1).mul(0.22) as V3, float(0.85) as F, 0, tC.normal),
    rhBurnt: make(tC.albedo.mul(0.07).add(tR.albedo.mul(0.05)) as V3, float(0.9) as F, 0.1, tR.normal),
    rhRebar: make(tR.albedo.mul(0.7) as V3, tR.rough as F, 0.5, tR.normal),
    rhRust: make(tR.albedo.mul(0.75) as V3, tR.rough as F, 0.45, tR.normal),
    rhSteel: make(gray(tS.albedo, 0.6).mul(0.55) as V3, tS.rough.mul(0.6).add(0.25) as F, 0.8, tS.normal),
    rhPaint: make(lin('#3a120a').mul(dot(tS.albedo, vec3(0.33)).mul(2.2).add(0.4)) as V3, float(0.55) as F, 0.4, tS.normal),
    rhWindow: make(lin('#0a0b0d') as V3, float(0.06) as F, 0.6, n),
    rhInterior: make(lin('#2a1a10') as V3, float(0.6) as F, 0, n, lin('#ffa050', 2.2 * (opts.interior ?? 1)).mul(flicker) as V3, 0.18),
    rhWarning: make(lin('#300404') as V3, float(0.4) as F, 0, n, lin('#ff1e0a', 1.4).mul(blink.mul(0.92).add(0.08)) as V3, 0.08),
    rhHot: make(lin('#2a0a02') as V3, float(0.5) as F, 0, n, lin('#ff6a1e', 1.6).mul(flicker) as V3, 0.2),
    rhWreck: make(wreck, mix(float(0.55), float(0.92), scorchK) as F, 0.3, tR.normal),
  };
}

const zPlace = z.object({
  mesh: z.string(),
  at: z.tuple([z.number(), z.number()]),
  /** Height offset from the yard (metres). */
  y: z.number().default(0),
  yaw: z.number().default(0),
  /** Lean (degrees about x and z), for slumped wrecks and settled ruins. */
  tilt: z.tuple([z.number(), z.number()]).default([0, 0]),
  scale: z.number().positive().default(1),
  /** Lowest detail setting that shows it. */
  minDetail: z.enum(['low', 'medium', 'high']).default('low'),
});

const schema = z.object({
  src: z.string().default('models/ruins.glb'),
  place: z.array(zPlace).min(1),
  soot: z.number().min(0).max(2).default(1),
  interior: z.number().min(0).default(1),
  haze: zHaze,
});

type Params = z.infer<typeof schema>;

const RANK = { low: 0, medium: 1, high: 2, ultra: 3 } as const;

/**
 * Static ruined city from the Blender kit: gutted towers, a broken elevated highway, a buckled
 * lattice mast, burnt-out vehicles and debris fields, placed by name. Every (object, material)
 * pair is one instanced draw call shared by all its placements.
 */
export const sceneryComponent: ComponentFactory<Params> = {
  type: 'redHorizonScenery',
  version: 1,
  description: 'Ruined towers, broken highway, lattice mast, wrecks and debris with photographed PBR materials.',
  schema,
  async create(ctx, p) {
    const w = world(ctx);
    const [gltf, tex, env, backdrop] = await Promise.all([ctx.assets.loadGLTF(p.src), loadSceneryTextures(w), envTexture(w), backdropTexture(w)]);
    const kit = bakeKit(gltf.scene);
    const presence = floatUniform(1);
    const mats = sceneryMaterials(w, tex, env, backdrop, p.haze, presence as unknown as F, ctx.uniforms.time as unknown as F, { soot: p.soot, interior: p.interior });
    const group = new Group();
    const byMesh = new Map<string, z.infer<typeof zPlace>[]>();
    for (const pl of p.place) {
      if (RANK[pl.minDetail] > RANK[ctx.quality.detail]) continue;
      if (!kit.has(pl.mesh)) {
        console.warn(`[red-horizon] scenery: no object ${pl.mesh} in ${p.src}`);
        continue;
      }
      const list = byMesh.get(pl.mesh) ?? [];
      list.push(pl);
      byMesh.set(pl.mesh, list);
    }
    const m4 = new Matrix4();
    const q = new Quaternion();
    const e = new Euler();
    const v = new Vector3();
    const s = new Vector3();
    const owned: BufferGeometry[] = [];
    for (const [name, places] of byMesh) {
      for (const part of kit.get(name)!) {
        const mat = mats[part.material] ?? mats.rhConcrete!;
        const im = new InstancedMesh(part.geometry, mat, places.length);
        places.forEach((pl, i) => {
          e.set((pl.tilt[0] * Math.PI) / 180, (pl.yaw * Math.PI) / 180, (pl.tilt[1] * Math.PI) / 180);
          m4.compose(v.set(pl.at[0], GROUND_Y + pl.y, pl.at[1]), q.setFromEuler(e), s.setScalar(pl.scale));
          im.setMatrixAt(i, m4);
        });
        im.instanceMatrix.needsUpdate = true;
        im.frustumCulled = false;
        group.add(im);
      }
    }
    for (const parts of kit.values()) for (const part of parts) owned.push(part.geometry);
    return {
      object: group,
      setPresence(val) {
        presence.value = val;
      },
      dispose() {
        for (const g of owned) g.dispose();
        for (const m of Object.values(mats)) m.dispose();
        ctx.assets.release(p.src);
        release(w);
      },
    };
  },
};
