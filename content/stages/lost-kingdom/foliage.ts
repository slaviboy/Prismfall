import { DoubleSide, Group, InstancedMesh, Matrix4, Mesh, MeshBasicNodeMaterial, type Material, type MeshStandardMaterial, type Texture } from 'three/webgpu';
import {
  cos,
  dot,
  float,
  hash,
  instanceIndex,
  max,
  mix,
  normalWorld,
  normalize,
  positionLocal,
  positionWorld,
  select,
  sin,
  smoothstep,
  step,
  texture,
  uv,
  vec3,
  vec4,
  frontFacing,
} from 'three/tsl';
import { clearFront, colorUniform, floatUniform, noBloom, seeded, z, zColor, type ComponentFactory } from '@prismfall/sdk';
import { canopyLight, canopyTime, loadTexture, zCanopy, zSun } from './env';

/**
 * The undergrowth: Poly Haven's scanned ferns, aroids, calatheas and shrubs (CC0), placed in Blender
 * on the terraces, the plaza edges, the outcrop's ledges and the North Platform, and shipped as GPU
 * instances (one draw call per plant kind). Lit like the baked stone: sky light from above and below
 * plus the canopy-dappled sun, with sunlight through backlit leaves; they sway in a slow breeze with
 * gusts that travel across the plaza.
 */

const schema = z.object({
  src: z.string().default('models/vegetation.glb'),
  canopy: zCanopy.prefault({}),
  sun: zSun.prefault({}),
  /** Sky light from above and bounce from the ground (linear-ish colours of the photograph). */
  sky: zColor.default('#9aa880'),
  ground: zColor.default('#3a3a24'),
  ambient: z.number().min(0).default(0.55),
  sunGain: z.number().min(0).default(1),
  translucency: z.number().min(0).default(0.6),
  /** Leaf colour correction towards the rainforest's greens. */
  tint: zColor.default('#ffffff'),
  /** Breeze: sway in metres at a plant's top, and gust speed. Bindable as `wind`. */
  wind: z.number().min(0).default(0.08),
  /** Share of the plants drawn at each detail level (low, medium, high, ultra). */
  share: z.tuple([z.number(), z.number(), z.number(), z.number()]).default([0.3, 0.6, 1, 1]),
  /** The world clear wave (SDK 1.5): leaves catch a passing sheen of light (`sheen`, in `color`). */
  clearWave: z.object({ sheen: z.number().min(0).default(0), color: zColor.default('#fff4c8') }).prefault({}),
  seed: z.number().default(5),
});
type Params = z.infer<typeof schema>;

export const jungleFoliage: ComponentFactory<Params> = {
  type: 'jungleFoliage',
  version: 1,
  description: 'Instanced scanned rainforest undergrowth with canopy-dappled sun, leaf translucency and a travelling breeze.',
  schema,
  async create(ctx, p) {
    const gltf = await ctx.assets.loadGLTF(p.src);
    const mask = await loadTexture(ctx, p.canopy.src, 'data');
    const root = new Group();
    const u = {
      presence: floatUniform(1),
      wind: floatUniform(ctx.quality.reducedMotion ? p.wind * 0.35 : p.wind),
      sun: floatUniform(p.sunGain),
      ambient: floatUniform(p.ambient),
    };
    const sunColor = colorUniform(p.sun.color);
    const sky = colorUniform(p.sky);
    const ground = colorUniform(p.ground);
    const tint = colorUniform(p.tint);
    const waveColor = colorUniform(p.clearWave.color);
    const L = vec3(...p.sun.direction).normalize();
    const share = p.share[['low', 'medium', 'high', 'ultra'].indexOf(ctx.quality.detail)] ?? 1;
    const rand = seeded(p.seed);
    const materials: Material[] = [];
    const scene = gltf.scene.clone(true);
    scene.updateMatrixWorld(true);
    const meshes: Mesh[] = [];
    scene.traverse((o) => {
      if (o instanceof Mesh) meshes.push(o);
    });
    for (const o of meshes) {
      const src = o.material as MeshStandardMaterial;
      const map = src.map as Texture | null;
      // A breeze bending each plant from its base (as a share of its height, in the mesh's own,
      // possibly quantised, units); gust fronts travel across the plaza.
      o.geometry.computeBoundingBox();
      const box = o.geometry.boundingBox;
      const y0 = box ? box.min.y : 0;
      const hl = box ? Math.max(1e-4, box.max.y - box.min.y) : 1;
      const id = hash(instanceIndex.add(o.id * 131));
      const h = positionLocal.y.sub(y0).div(hl).clamp(0, 1);
      const bend = h.mul(h).mul(u.wind).mul(hl);
      const t = canopyTime;
      const wp = positionWorld;
      const gust = sin(wp.x.mul(0.045).add(wp.z.mul(0.03)).sub(t.mul(0.9))).mul(0.5).add(0.5);
      const sway = vec3(sin(t.mul(1.3).add(id.mul(40))).mul(0.6).add(gust.mul(0.9)), 0, cos(t.mul(1.1).add(id.mul(23))).mul(0.5));
      const flutter = sin(t.mul(6.5).add(id.mul(60)).add(positionLocal.x.mul(9))).mul(0.15);
      const m = new MeshBasicNodeMaterial();
      m.positionNode = positionLocal.add(sway.mul(bend)).add(vec3(0, flutter.mul(bend), 0));
      const base = map ? texture(map, uv()) : vec4(0.2, 0.35, 0.12, 1);
      const n = normalize(select(frontFacing, normalWorld, normalWorld.negate()));
      const up = n.y.mul(0.5).add(0.5);
      const amb = mix(ground, sky, up).mul(u.ambient);
      const ndl = max(dot(n, L), 0);
      const back = max(dot(n, L).negate(), 0).mul(p.translucency);
      const dapple = mask ? canopyLight(mask, p.canopy, p.sun, wp, 1) : float(0.4);
      // Self-shading: the heart of a clump is darker than its outer leaves.
      const occl = smoothstep(0.0, 0.55, h).mul(0.55).add(0.45);
      const sunLight = sunColor.mul(ndl.add(back)).mul(dapple).mul(p.sun.intensity).mul(u.sun);
      const leaf = base.rgb.mul(tint);
      const lit = leaf.mul(amb.mul(occl).add(sunLight.mul(occl.mul(0.6).add(0.4))));
      // The clear front: a sheen of light running through the leaves (outer leaves more than the heart).
      m.colorNode = p.clearWave.sheen > 0 ? lit.add(leaf.mul(waveColor).mul(clearFront(wp).mul(occl).mul(p.clearWave.sheen))) : lit;
      // Crisp cut-out leaves; the dither only shows while the world fades in or out.
      m.opacityNode = step(0.5, base.a).mul(u.presence);
      m.alphaHash = true;
      m.side = DoubleSide;
      m.transparent = false;
      noBloom(m);
      // Thin the plants on lower settings (shuffled so every area thins evenly).
      if (o instanceof InstancedMesh) {
        const n0 = o.count;
        const mats: Matrix4[] = [];
        for (let i = 0; i < n0; i++) {
          const mm = new Matrix4();
          o.getMatrixAt(i, mm);
          mats.push(mm);
        }
        for (let i = mats.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [mats[i], mats[j]] = [mats[j] as Matrix4, mats[i] as Matrix4];
        }
        mats.forEach((mm, i) => o.setMatrixAt(i, mm));
        o.count = Math.max(1, Math.round(n0 * share));
        o.instanceMatrix.needsUpdate = true;
      }
      o.material = m;
      o.frustumCulled = false;
      materials.push(m);
    }
    root.add(scene);
    return {
      object: root,
      reactive: { wind: u.wind, sun: u.sun },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        for (const m of materials) m.dispose();
        mask?.dispose();
        ctx.assets.release(p.src);
      },
    };
  },
};
