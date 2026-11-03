import { Box3, Color, DoubleSide, Euler, Group, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3, type Material, type Object3D } from 'three/webgpu';
import { float, instanceIndex, positionLocal, sin, vec3 } from 'three/tsl';
import { floatUniform, seeded, z, zColor, zVec3, type ComponentFactory, type EnvironmentContext } from '@prismfall/sdk';
import { castWorldShadows, frontier, litMaterial, releaseFrontier, tickFrontier, type F, type Frontier } from './shared';

const zXZ = z.tuple([z.number(), z.number()]);

/** Keep-out shapes for scattering: circles, polylines with a width, and an oriented rectangle. */
export const zExclude = z
  .object({
    circles: z.array(z.object({ center: zXZ, radius: z.number() })).default([]),
    lines: z.array(z.object({ points: z.array(zXZ).min(2), width: z.number() })).default([]),
    rects: z.array(z.object({ origin: zXZ, axis: zXZ, s: zXZ, q: zXZ })).default([]),
    /** Half-width in degrees of the clear zone around the board (from the viewer), within `clearRange` metres. */
    clear: z.number().default(21),
    clearRange: z.number().default(70),
  })
  .prefault({});

type Exclude = z.infer<typeof zExclude>;

function segDist(x: number, zz: number, pts: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i]!;
    const [bx, bz] = pts[i + 1]!;
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (zz - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - zz));
  }
  return best;
}

export function excluded(ex: Exclude, x: number, zz: number, margin = 0): boolean {
  for (const c of ex.circles) if (Math.hypot(x - c.center[0], zz - c.center[1]) < c.radius + margin) return true;
  for (const l of ex.lines) if (segDist(x, zz, l.points as [number, number][]) < l.width / 2 + margin) return true;
  for (const r of ex.rects) {
    const len = Math.hypot(r.axis[0], r.axis[1]);
    const ax = r.axis[0] / len;
    const az = r.axis[1] / len;
    const dx = x - r.origin[0];
    const dz = zz - r.origin[1];
    const s = dx * ax + dz * az;
    const q = dx * az - dz * ax;
    if (s > r.s[0] - margin && s < r.s[1] + margin && q > r.q[0] - margin && q < r.q[1] + margin) return true;
  }
  const dist = Math.hypot(x, zz - 30);
  const az = (Math.atan2(x, 30 - zz) * 180) / Math.PI;
  if (dist < ex.clearRange && Math.abs(az) < ex.clear) return true;
  return false;
}

/** The meshes of a glTF node, with their transforms relative to the node, and the node's base. */
function variantParts(node: Object3D): { mesh: Mesh; matrix: Matrix4 }[] {
  node.updateMatrixWorld(true);
  const box = new Box3().setFromObject(node);
  const base = new Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  const toLocal = new Matrix4().makeTranslation(-base.x, -base.y, -base.z);
  const out: { mesh: Mesh; matrix: Matrix4 }[] = [];
  node.traverse((o) => {
    if (o instanceof Mesh) out.push({ mesh: o, matrix: toLocal.clone().multiply(o.matrixWorld) });
  });
  return out;
}

const scatterSchema = z.object({
  src: z.string(),
  /** Regex on top-level node names to use as variants (default: every top-level node). */
  include: z.string().optional(),
  count: z.number().int().min(1).max(20000).default(1500),
  /** Placement area: a ring around the viewer, in metres. */
  inner: z.number().default(30),
  outer: z.number().default(420),
  /** Azimuth window in degrees (0 = straight ahead), so nothing is wasted behind the viewer. */
  azimuth: zXZ.default([-80, 80]),
  scale: zXZ.default([1, 1.8]),
  /** Clustering: share of instances placed near other instances (groves, rock fields). */
  cluster: z.number().min(0).max(1).default(0.5),
  exclude: zExclude,
  tint: zColor.default('#ffffff'),
  /** Wind sway amplitude (metres at the top of a 1 m plant); 0 for rocks. */
  sway: z.number().min(0).default(0),
  sink: z.number().default(0.04),
  shadows: z.boolean().default(false),
  seed: z.number().default(11),
});

type ScatterParams = z.infer<typeof scatterSchema>;

/**
 * Instanced scanned props (desert shrubs, boulders) over the desert floor: clustered, kept off the
 * town, the roads, the railway and the clear zone around the board, lit by the world's sun and sky,
 * plants swaying in the wind. One instanced draw per variant and material.
 */
export const frontierScatter: ComponentFactory<ScatterParams> = {
  type: 'frontierScatter',
  version: 1,
  description: 'Instanced scanned shrubs and rocks over the desert floor, kept off the town, roads, rail and clear zone, lit by the world sun.',
  schema: scatterSchema,
  async create(ctx: EnvironmentContext, p) {
    const s = frontier(ctx);
    const gltf = await ctx.assets.loadGLTF(p.src);
    const presence = floatUniform(1);
    const re = p.include ? new RegExp(p.include) : null;
    const variants = gltf.scene.children
      .filter((c) => !re || re.test(c.name))
      .map(variantParts)
      .filter((v) => v.length > 0);
    const rand = seeded(p.seed * 7919);
    const density = ctx.quality.detail === 'low' ? 0.4 : ctx.quality.detail === 'medium' ? 0.7 : ctx.quality.detail === 'high' ? 1 : 1.25;
    const count = Math.round(p.count * density * Math.min(1.5, Math.max(0.4, ctx.quality.particles)));
    // Positions: uniform in area over the ring sector, some pulled near earlier ones (clusters).
    const placed: {
      x: number;
      z: number;
      v: number;
      s: number;
      yaw: number;
    }[] = [];
    const a0 = (p.azimuth[0] * Math.PI) / 180;
    const a1 = (p.azimuth[1] * Math.PI) / 180;
    let guard = 0;
    while (placed.length < count && guard++ < count * 30) {
      let x: number;
      let zz: number;
      if (placed.length > 8 && rand() < p.cluster) {
        const o = placed[Math.floor(rand() * placed.length)]!;
        const r = 2 + rand() * 9;
        const a = rand() * Math.PI * 2;
        x = o.x + Math.cos(a) * r;
        zz = o.z + Math.sin(a) * r;
      } else {
        const r = Math.sqrt(p.inner * p.inner + rand() * (p.outer * p.outer - p.inner * p.inner));
        const a = a0 + rand() * (a1 - a0);
        x = Math.sin(a) * r;
        zz = 30 - Math.cos(a) * r;
      }
      if (excluded(p.exclude, x, zz)) continue;
      placed.push({
        x,
        z: zz,
        v: Math.floor(rand() * variants.length),
        s: p.scale[0] + rand() * (p.scale[1] - p.scale[0]),
        yaw: rand() * Math.PI * 2,
      });
    }
    const group = new Group();
    const materials = new Map<Material, Material>();
    const tint = new Color(p.tint);
    const time = ctx.uniforms.time as unknown as F;
    const reduced = ctx.quality.reducedMotion;
    const m4 = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    variants.forEach((parts, vi) => {
      const mine = placed.filter((pl) => pl.v === vi);
      if (mine.length === 0) return;
      for (const part of parts) {
        const src = part.mesh.material as Material;
        let mat = materials.get(src);
        if (!mat) {
          const m = litMaterial(s, src, { vertexAO: false, presence, tint });
          if (p.sway > 0 && !reduced) {
            // Sway grows with height; each plant has its own phase, gusts make it stronger.
            const ph = float(instanceIndex).mul(1.618);
            const h = positionLocal.y.max(0);
            const w = sin(time.mul(1.7).add(ph))
              .mul(0.6)
              .add(sin(time.mul(0.63).add(ph.mul(2.3))).mul(0.4));
            const amp = s.u.bass.mul(0.6).add(1);
            m.positionNode = positionLocal.add(
              vec3(
                w.mul(h).mul(amp).mul(p.sway),
                0,
                w
                  .mul(h)
                  .mul(amp)
                  .mul(p.sway * 0.6),
              ),
            );
          }
          if (src.alphaTest > 0 || src.transparent) {
            m.side = DoubleSide;
            m.transparent = false;
            m.alphaTest = Math.max(0.4, src.alphaTest);
          }
          mat = m;
          materials.set(src, m);
        }
        const inst = new InstancedMesh(part.mesh.geometry, mat, mine.length);
        mine.forEach((pl, i) => {
          q.setFromAxisAngle(up, pl.yaw);
          const y = ctx.ground.height(pl.x, pl.z) - p.sink * pl.s;
          m4.compose(new Vector3(pl.x, y, pl.z), q, new Vector3(pl.s, pl.s, pl.s)).multiply(part.matrix);
          inst.setMatrixAt(i, m4);
        });
        inst.instanceMatrix.needsUpdate = true;
        inst.frustumCulled = false;
        if (p.shadows) castWorldShadows(inst, true);
        else inst.receiveShadow = true;
        group.add(inst);
      }
    });
    return {
      object: group,
      update(frame) {
        tickFrontier(s, frame);
      },
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        for (const m of materials.values()) m.dispose();
        for (const c of group.children) (c as InstancedMesh).dispose();
        ctx.assets.release(p.src);
        releaseFrontier(ctx, s);
      },
    };
  },
};

const rocksSchema = z.object({
  src: z.string(),
  include: z.string().optional(),
  instances: z
    .array(
      z.object({
        position: zVec3,
        yaw: z.number().default(0),
        scale: z.number().positive().default(1),
        tilt: zVec3.default([0, 0, 0]),
      }),
    )
    .min(1),
  tint: zColor.default('#ffffff'),
  shadows: z.boolean().default(true),
});

/** Individually placed scanned rocks and cliffs (outcrops), on the ground, lit by the world's sun. */
export const frontierRocks: ComponentFactory<z.infer<typeof rocksSchema>> = {
  type: 'frontierRocks',
  version: 1,
  description: 'Individually placed scanned cliffs and boulders (outcrops) lit by the world sun.',
  schema: rocksSchema,
  async create(ctx, p) {
    const s: Frontier = frontier(ctx);
    const gltf = await ctx.assets.loadGLTF(p.src);
    const presence = floatUniform(1);
    const re = p.include ? new RegExp(p.include) : null;
    const nodes = gltf.scene.children.filter((c) => !re || re.test(c.name));
    const parts = nodes.flatMap(variantParts);
    const tint = new Color(p.tint);
    const materials = new Map<Material, Material>();
    const group = new Group();
    for (const part of parts) {
      const src = part.mesh.material as Material;
      let mat = materials.get(src);
      if (!mat) {
        mat = litMaterial(s, src, { vertexAO: false, presence, tint });
        materials.set(src, mat);
      }
      const inst = new InstancedMesh(part.mesh.geometry, mat, p.instances.length);
      p.instances.forEach((it, i) => {
        const [x, y, zz] = it.position;
        const e = new Quaternion().setFromEuler(new Euler((it.tilt[0] * Math.PI) / 180, (it.yaw * Math.PI) / 180, (it.tilt[2] * Math.PI) / 180));
        const m = new Matrix4().compose(new Vector3(x, ctx.ground.height(x, zz) + y, zz), e, new Vector3(it.scale, it.scale, it.scale)).multiply(part.matrix);
        inst.setMatrixAt(i, m);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      if (p.shadows) castWorldShadows(inst, true);
      group.add(inst);
    }
    return {
      object: group,
      update(frame) {
        tickFrontier(s, frame);
      },
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        for (const m of materials.values()) m.dispose();
        for (const c of group.children) (c as InstancedMesh).dispose();
        ctx.assets.release(p.src);
        releaseFrontier(ctx, s);
      },
    };
  },
};
