import { BufferAttribute, BufferGeometry, Color, Group, InstancedMesh, Matrix3, Matrix4, Mesh, Quaternion, Vector3, type Material } from 'three/webgpu';
import { cos, float, positionGeometry, positionLocal, sin, vec3 } from 'three/tsl';
import { clearFrontMotion } from '../../shaders/clearFront';
import { frameUniforms } from '../../shaders/uniforms';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { Noise2 } from '../terrain/heightfield';
import { floatUniform, seeded, zColor, zVec3 } from './common';
import { createRemapper, materialRuleSchema } from './materialRemap';

const item = z.object({
  /** Object name inside the GLB (Blender object name). */
  mesh: z.string(),
  weight: z.number().positive().default(1),
  scale: z.tuple([z.number().positive(), z.number().positive()]).default([0.8, 1.2]),
  /** Random tint spread around white (0 = none), so a forest isn't made of clones. */
  tintJitter: z.number().min(0).max(0.6).default(0.12),
  tint: zColor.optional(),
});

const area = z.discriminatedUnion('kind', [
  /** A wedge band in front of the viewer, `near`..`far` units behind the board. */
  z.object({ kind: z.literal('band'), near: z.number().default(40), far: z.number().default(300), spread: z.number().default(1.3), offsetX: z.number().default(0) }),
  z.object({ kind: z.literal('rect'), center: z.tuple([z.number(), z.number()]), size: z.tuple([z.number(), z.number()]) }),
  z.object({ kind: z.literal('ring'), center: z.tuple([z.number(), z.number()]), radius: z.tuple([z.number(), z.number()]) }),
  /** Floating in 3D (asteroids, debris): no ground. */
  z.object({ kind: z.literal('volume'), center: zVec3, size: zVec3 }),
]);

const schema = z.object({
  src: z.string().default('/content/shared/flora/flora.glb'),
  items: z.array(item).min(1),
  count: z.number().int().min(1).max(20000).default(400),
  area: area.default({ kind: 'band', near: 40, far: 300, spread: 1.3, offsetX: 0 }),
  /** Keep-out circles on the ground plane (the playfield and paths). */
  exclude: z.array(z.object({ center: z.tuple([z.number(), z.number()]), radius: z.number() })).default([{ center: [0, 5], radius: 24 }]),
  /** 0 = uniform; higher values group instances into groves and clearings. */
  clustering: z.number().min(0).max(1).default(0.4),
  clusterScale: z.number().positive().default(70),
  materials: z.array(materialRuleSchema).default([]),
  vertexAO: z.boolean().default(true),
  /** Wind (or current) sway: displacement grows with height. */
  sway: z.object({ amount: z.number().min(0).default(0.25), speed: z.number().default(0.9) }).prefault({}),
  /**
   * The world clear wave (since SDK 1.5; 0 = off): a gust front. As a clear's front passes, the
   * props bend away from the board by `sway` (as a share of their height, tips most) and swing back
   * in its tail.
   */
  clearWave: z.object({ sway: z.number().min(0).max(1).default(0) }).prefault({}),
  sink: z.number().default(0.3),
  /** Tilt instances to the ground slope (rocks) instead of standing upright (trees). */
  alignToSlope: z.boolean().default(false),
  /** Volume items tumble slowly (radians per second). */
  spin: z.number().default(0),
  seed: z.number().default(1),
});

type Params = z.infer<typeof schema>;

interface Part {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  readonly hasAO: boolean;
}

/** Copies a (possibly quantised) GLB mesh into float geometry in the item's own space. */
function bakePart(mesh: Mesh, toItem: Matrix4): BufferGeometry {
  const src = mesh.geometry;
  const g = new BufferGeometry();
  const pos = src.getAttribute('position');
  const nor = src.getAttribute('normal');
  const col = src.getAttribute('color');
  const n = pos.count;
  const p = new Float32Array(n * 3);
  const nn = new Float32Array(n * 3);
  const v = new Vector3();
  const nm = new Matrix3().getNormalMatrix(toItem);
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(toItem);
    p.set([v.x, v.y, v.z], i * 3);
    if (nor) {
      v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      nn.set([v.x, v.y, v.z], i * 3);
    }
  }
  g.setAttribute('position', new BufferAttribute(p, 3));
  g.setAttribute('normal', new BufferAttribute(nn, 3));
  if (col) {
    const c = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) c.set([col.getX(i), col.getY(i), col.getZ(i), col.itemSize > 3 ? col.getW(i) : 1], i * 4);
    g.setAttribute('color', new BufferAttribute(c, 4));
  }
  const idx = src.getIndex();
  if (idx) g.setIndex(new BufferAttribute(Uint32Array.from(idx.array as ArrayLike<number>), 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * Instanced Blender props over the terrain: forests, cherry groves, kelp beds, crystal fields,
 * lanterns, floating asteroids. Instances snap to the stage ground, cluster into groves, avoid the
 * playfield and sway in the wind (or current) in the vertex shader.
 */
export const scatterComponent: ComponentFactory<Params> = {
  type: 'scatter',
  version: 1,
  description: 'Instanced Blender props (trees, plants, rocks, crystals) scattered over the ground or in a volume, with wind sway.',
  schema,
  async create(ctx, p) {
    const gltf = await ctx.assets.loadGLTF(p.src);
    gltf.scene.updateMatrixWorld(true);
    const u = { presence: floatUniform(1), music: floatUniform(0), emissive: floatUniform(1), sway: floatUniform(p.sway.amount) };
    const time = ctx.uniforms.time;
    // Height-weighted sway; the phase travels through the field like gusts of wind.
    const swayFor = (height: number) => {
      const h = positionGeometry.y.div(Math.max(0.5, height)).clamp(0, 1.5);
      const k = h.mul(h).mul(u.sway).mul(height * 0.08);
      const ph = time.mul(p.sway.speed).add(positionLocal.x.mul(0.045)).add(positionLocal.z.mul(0.03));
      let bent = positionLocal.add(vec3(sin(ph).mul(k), float(0), cos(ph.mul(0.83).add(1.3)).mul(k).mul(0.6)));
      if (p.clearWave.sway > 0) {
        // The instanced position is in the layer's space, which sits at the world origin.
        const away = positionLocal.sub(frameUniforms.waveOrigin).mul(vec3(1, 0, 1)).normalize();
        const gust = clearFrontMotion(positionLocal).mul(h.mul(h)).mul(height * p.clearWave.sway * 0.22);
        bent = bent.add(away.mul(gust)).sub(vec3(0, gust.mul(0.15), 0));
      }
      return bent;
    };
    const swaying = p.sway.amount > 0 || p.clearWave.sway > 0;
    const remapper = createRemapper(p.materials, { time, presence: u.presence, music: u.music, emissive: u.emissive }, p.vertexAO, true);

    // Gather each item's parts (one per material primitive) in item space.
    const parts = new Map<string, { parts: Part[]; height: number }>();
    for (const it of p.items) {
      const root = gltf.scene.getObjectByName(it.mesh);
      if (!root) throw new Error(`scatter: "${it.mesh}" not found in ${p.src}`);
      // Kit objects sit at the origin, so world space is item space. Their node transforms are
      // gltf-transform's dequantisation (scale/offset) and must be kept, not inverted.
      const list: Part[] = [];
      let height = 0;
      root.traverse((o) => {
        if (!(o instanceof Mesh)) return;
        const toItem = new Matrix4().copy(o.matrixWorld);
        const geometry = bakePart(o, toItem);
        geometry.computeBoundingBox();
        height = Math.max(height, geometry.boundingBox?.max.y ?? 0);
        list.push({ geometry, material: o.material as Material, hasAO: geometry.getAttribute('color') !== undefined });
      });
      parts.set(it.mesh, { parts: list, height });
    }

    // Placement.
    const rand = seeded(p.seed * 1013 + 17);
    const cluster = new Noise2(p.seed * 31 + 5);
    const totalWeight = p.items.reduce((s, it) => s + it.weight, 0);
    const placements = new Map<string, { m: Matrix4; tint: Color }[]>();
    p.items.forEach((it) => placements.set(it.mesh, []));
    const pos = new Vector3();
    const quat = new Quaternion();
    const scl = new Vector3();
    const up = new Vector3(0, 1, 0);
    const normal = new Vector3();
    const yawQ = new Quaternion();
    const detail = ctx.quality.detail === 'low' ? 0.45 : ctx.quality.detail === 'medium' ? 0.7 : 1;
    const target = Math.max(1, Math.round(p.count * detail));
    let placed = 0;
    for (let attempt = 0; attempt < target * 12 && placed < target; attempt++) {
      let x = 0;
      let y = 0;
      let zz = 0;
      const a = p.area;
      if (a.kind === 'band') {
        const d = a.near + (a.far - a.near) * Math.sqrt(rand());
        zz = -d;
        x = a.offsetX + (rand() * 2 - 1) * (d * a.spread + 30);
      } else if (a.kind === 'rect') {
        x = a.center[0] + (rand() - 0.5) * a.size[0];
        zz = a.center[1] + (rand() - 0.5) * a.size[1];
      } else if (a.kind === 'ring') {
        const ang = rand() * Math.PI * 2;
        const r = a.radius[0] + (a.radius[1] - a.radius[0]) * Math.sqrt(rand());
        x = a.center[0] + Math.cos(ang) * r;
        zz = a.center[1] + Math.sin(ang) * r;
      } else {
        x = a.center[0] + (rand() - 0.5) * a.size[0];
        y = a.center[1] + (rand() - 0.5) * a.size[1];
        zz = a.center[2] + (rand() - 0.5) * a.size[2];
      }
      if (a.kind !== 'volume') {
        if (p.exclude.some((e) => Math.hypot(x - e.center[0], zz - e.center[1]) < e.radius)) continue;
        if (p.clustering > 0) {
          const density = cluster.fbm(x / p.clusterScale, zz / p.clusterScale, 3) * 0.5 + 0.5;
          if (rand() > Math.pow(density, 1 + p.clustering * 4) * (1 + p.clustering * 2)) continue;
        }
        y = ctx.ground.height(x, zz) - p.sink;
      }
      // Weighted item choice.
      let w = rand() * totalWeight;
      let chosen = p.items[0]!;
      for (const it of p.items) {
        w -= it.weight;
        if (w <= 0) {
          chosen = it;
          break;
        }
      }
      const s = chosen.scale[0] + (chosen.scale[1] - chosen.scale[0]) * rand();
      yawQ.setFromAxisAngle(up, rand() * Math.PI * 2);
      if (a.kind === 'volume') {
        quat.setFromAxisAngle(new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(), rand() * Math.PI * 2);
      } else if (p.alignToSlope) {
        const e = 1;
        const dx = ctx.ground.height(x + e, zz) - ctx.ground.height(x - e, zz);
        const dz = ctx.ground.height(x, zz + e) - ctx.ground.height(x, zz - e);
        normal.set(-dx, 2 * e, -dz).normalize();
        quat.setFromUnitVectors(up, normal).multiply(yawQ);
      } else quat.copy(yawQ);
      pos.set(x, y, zz);
      scl.setScalar(s);
      const base = chosen.tint ? new Color(chosen.tint) : new Color(1, 1, 1);
      const j = chosen.tintJitter;
      const tint = base.clone().multiplyScalar(1 - j * 0.5 + rand() * j);
      tint.offsetHSL((rand() - 0.5) * j * 0.15, 0, 0);
      placements.get(chosen.mesh)!.push({ m: new Matrix4().compose(pos, quat, scl), tint });
      placed++;
    }

    const group = new Group();
    const meshes: InstancedMesh[] = [];
    const spinning: { mesh: InstancedMesh; base: Matrix4[]; axes: Vector3[] }[] = [];
    for (const it of p.items) {
      const list = placements.get(it.mesh)!;
      const entry = parts.get(it.mesh)!;
      if (list.length === 0) continue;
      for (const part of entry.parts) {
        const material = remapper.remap(part.material, part.hasAO, { positionNode: swaying ? swayFor(entry.height) : undefined });
        const mesh = new InstancedMesh(part.geometry, material, list.length);
        list.forEach((pl, i) => {
          mesh.setMatrixAt(i, pl.m);
          mesh.setColorAt(i, pl.tint);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.receiveShadow = false;
        mesh.castShadow = false;
        group.add(mesh);
        meshes.push(mesh);
        if (p.spin !== 0 && p.area.kind === 'volume') spinning.push({ mesh, base: list.map((pl) => pl.m.clone()), axes: list.map(() => new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize()) });
      }
    }
    const tmp = new Matrix4();
    const rot = new Matrix4();
    return {
      object: group,
      reactive: { sway: u.sway, emissive: u.emissive },
      update(frame) {
        u.music.value = frame.audio.bass * 0.6 + frame.audio.beatPulse * 0.4;
        if (spinning.length === 0 || ctx.quality.reducedMotion) return;
        const ang = frame.time * p.spin;
        for (const s of spinning) {
          for (let i = 0; i < s.base.length; i++) {
            rot.makeRotationAxis(s.axes[i]!, ang * (0.5 + (i % 7) / 7));
            tmp.copy(s.base[i]!).multiply(rot);
            s.mesh.setMatrixAt(i, tmp);
          }
          s.mesh.instanceMatrix.needsUpdate = true;
        }
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        remapper.dispose();
        for (const m of meshes) m.dispose();
        for (const e of parts.values()) e.parts.forEach((pt) => pt.geometry.dispose());
        ctx.assets.release(p.src);
      },
    };
  },
};
