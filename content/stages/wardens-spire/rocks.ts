import { Box3, CylinderGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicNodeMaterial, Quaternion, Vector3, type BufferGeometry, type Texture } from 'three/webgpu';
import { abs, cameraPosition, clamp, dot, exp, float, mix, mrt, mx_noise_float, normalWorldGeometry, normalize, positionWorld, smoothstep, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { seeded, z, type ComponentFactory, type EnvironmentContext } from '@prismfall/sdk';
import { COLORS, DEG, EYE, clearMask, duskLight, macro, release, revealMask, shared, spireLight, stageTexture, triplanar, type V3 } from './shared';

/**
 * Rock on the land: photoscanned rocks (Poly Haven scans already shipped in content/shared/scans)
 * strewn as black basalt, from fist-sized scree near the board to house-sized blocks far out,
 * and outcrops of columnar basalt (clusters of hexagonal columns whose tops step like broken
 * stairs). Lit like the land around them: the storm and the horizon's glow on their edges, the
 * Warden, and the lava's light where they stand near a channel. Kept off the lava and away from
 * the board's clear zone; one instanced draw call per scan and one for the columns.
 */

const zCluster = z.object({
  /** View azimuth (degrees) and distance from the eye (m). */
  at: z.tuple([z.number(), z.number()]),
  radius: z.number().default(22),
  count: z.number().int().default(70),
  /** Column height range (m) and column radius range (m). */
  height: z.tuple([z.number(), z.number()]).default([3, 14]),
  width: z.tuple([z.number(), z.number()]).default([1.1, 1.8]),
  /** How much the tops lean as one surface (m per m), and its direction (degrees). */
  tilt: z.number().default(0.18),
  dir: z.number().default(0),
});

const schema = z.object({
  models: z
    .array(z.object({ src: z.string(), weight: z.number().default(1) }))
    .default([
      { src: '/content/shared/scans/moon_rock_01.glb', weight: 1 },
      { src: '/content/shared/scans/moon_rock_03.glb', weight: 1 },
      { src: '/content/shared/scans/namaqualand_boulder_02.glb', weight: 0.6 },
      { src: '/content/shared/scans/namaqualand_rocks_01.glb', weight: 0.5 },
    ]),
  count: z.number().int().min(0).max(6000).default(1050),
  /** Distances from the eye (m), the view azimuths kept clear (degrees), sizes (m). */
  distance: z.tuple([z.number(), z.number()]).default([28, 1000]),
  clear: z.number().default(11),
  size: z.tuple([z.number(), z.number()]).default([0.5, 16]),
  /** Albedo of the darkened rock. */
  albedo: z.number().default(0.36),
  columns: z.array(zCluster).default([]),
  rock: z.string().default('textures/dark_rock_02_diff.webp'),
  seed: z.number().default(77),
});

type Params = z.infer<typeof schema>;

export const rocksComponent: ComponentFactory<Params> = {
  type: 'wardenSpireRocks',
  version: 1,
  description: 'Photoscanned rocks strewn over the land as dark basalt, and columnar basalt outcrops; kept off the lava and out of the clear zone.',
  schema,
  async create(ctx: EnvironmentContext, p: Params) {
    const s = shared(ctx);
    const group = new Group();
    group.name = 'wardens-spire-rocks';
    const presence = uniform(1);
    const disposables: { dispose(): void }[] = [];
    const loaded: { geometry: BufferGeometry; map: Texture | null; size: number; weight: number; src: string }[] = [];
    for (const m of p.models) {
      try {
        const gltf = await ctx.assets.loadGLTF(m.src);
        let mesh: Mesh | null = null;
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((o) => {
          if (!mesh && o instanceof Mesh) mesh = o;
        });
        if (!mesh) continue;
        const src = mesh as Mesh;
        // Bake the node transform (gltf-transform's dequantisation) and recentre on the base.
        const geometry = src.geometry.clone().applyMatrix4(src.matrixWorld);
        const box = new Box3().setFromBufferAttribute(geometry.getAttribute('position') as never);
        const c = box.getCenter(new Vector3());
        geometry.translate(-c.x, -box.min.y, -c.z);
        const dims = box.getSize(new Vector3());
        const material = src.material as { map?: Texture | null };
        loaded.push({ geometry, map: material.map ?? null, size: Math.max(dims.x, dims.z), weight: m.weight, src: m.src });
        disposables.push(geometry);
      } catch (err) {
        console.warn(`[wardens-spire] rock scan ${m.src} unavailable`, err);
      }
    }
    const rockTex = await stageTexture(ctx, s, p.rock, 'color');

    // Light shared by the scans and the columns.
    const wp = positionWorld;
    const ng = normalWorldGeometry;
    const river = s.river;
    let spill: V3 = vec3(0, 0, 0) as V3;
    if (river) {
      const rv = texture(river.tex, vec2(wp.x.sub(river.x0).div(river.w), wp.z.sub(river.z0).div(river.h)));
      const near = exp(rv.x.sub(rv.w).max(0).div(-40)).mul(smoothstep(88, 60, rv.x));
      spill = COLORS.lava.mul(near.mul(clamp(ng.y.negate().mul(0.4).add(0.75), 0, 1)).mul(0.9)).mul(s.u.lavaHeat) as V3;
    }
    const calm = clearMask(wp, 13, 25).mul(0.5).add(0.5);
    const lightAll = duskLight(wp, ng, { back: 1.6, glint: 0.25 }).add(spireLight(s, wp, ng, { core: 0.2, beam: 1, bolt: 0.7, rim: 0.7 })).add(spill).mul(calm);

    const rand = seeded(p.seed * 313);
    const total = loaded.reduce((a, l) => a + l.weight, 0);
    const detail = ctx.quality.detail === 'low' ? 0.4 : ctx.quality.detail === 'medium' ? 0.7 : ctx.quality.detail === 'high' ? 1 : 1.3;
    const count = Math.round(p.count * detail);
    const m4 = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    for (const l of loaded) {
      const n = Math.round((count * l.weight) / Math.max(1e-3, total));
      if (n <= 0) continue;
      const tex = l.map ? texture(l.map, uv()).rgb : vec3(0.3, 0.3, 0.3);
      const grey = dot(tex, vec3(0.3, 0.55, 0.15));
      const alb = mix(vec3(grey, grey, grey), tex, 0.15).mul(grey.mul(1.4).add(0.2)).mul(p.albedo);
      const mat = new MeshBasicNodeMaterial();
      mat.colorNode = vec4(alb.mul(lightAll).mul(presence), 1);
      mat.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
      mat.fog = true;
      mat.opacityNode = revealMask(presence);
      mat.alphaTest = 0.5;
      disposables.push(mat);
      const inst = new InstancedMesh(l.geometry, mat, n);
      let placed = 0;
      for (let tries = 0; placed < n && tries < n * 30; tries++) {
        const side = rand() < 0.5 ? -1 : 1;
        const az = (p.clear + rand() * (78 - p.clear)) * side;
        const dist = p.distance[0] * Math.pow(p.distance[1] / p.distance[0], Math.pow(rand(), 0.9));
        const x = EYE[0] + Math.sin(az * DEG) * dist;
        const zz = EYE[2] - Math.cos(az * DEG) * dist;
        // Not in or right beside the lava.
        if (s.riverDistance && s.riverDistance(x, zz) < 10) continue;
        // Many small stones, fewer boulders, a few great blocks; bigger far away so they read.
        const big = Math.pow(rand(), 3.2);
        const size = (p.size[0] + (p.size[1] - p.size[0]) * big) * (0.6 + Math.min(1, dist / 350) * 0.8);
        const k = size / Math.max(0.1, l.size);
        const h = Math.min(ctx.ground.height(x, zz), ctx.ground.height(x + size * 0.4, zz), ctx.ground.height(x, zz + size * 0.4));
        q.setFromAxisAngle(up, rand() * Math.PI * 2);
        const tilt = new Quaternion().setFromAxisAngle(new Vector3(rand() - 0.5, 0, rand() - 0.5).normalize(), (rand() - 0.5) * 0.5);
        q.multiply(tilt);
        m4.compose(new Vector3(x, h - size * 0.2, zz), q, new Vector3(k * (0.8 + rand() * 0.4), k * (0.55 + rand() * 0.6), k * (0.8 + rand() * 0.4)));
        inst.setMatrixAt(placed++, m4);
      }
      inst.count = placed;
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      group.add(inst);
    }

    // Columnar basalt: hexagonal columns in clusters, tops stepping like broken stairs.
    const total2 = p.columns.reduce((a, c) => a + c.count, 0);
    if (total2 > 0) {
      const geo = new CylinderGeometry(1, 1, 1, 6, 1, false);
      geo.translate(0, 0.5, 0);
      disposables.push(geo);
      const n = ng;
      const col = rockTex ? triplanar(rockTex, wp, n, 1 / 4.5).mul(0.7).add(triplanar(rockTex, wp, n, 1 / 17).mul(0.3)) : vec3(0.25, 0.24, 0.23);
      const g2 = dot(col, vec3(0.3, 0.55, 0.15));
      // Tops weathered paler; the sides streaked; a fine joint line darkens each column's foot.
      const top = smoothstep(0.7, 0.95, n.y);
      const streak = mx_noise_float(vec3(wp.x.mul(0.8), wp.y.mul(0.08), wp.z.mul(0.8))).mul(0.25).add(0.85);
      const alb = mix(vec3(g2, g2, g2), col, 0.25).mul(0.8).mul(streak).mul(top.mul(0.35).add(1)).mul(macro(wp, 0.05));
      // The columns' edges catch the red sky as they turn away from the viewer (they separate).
      const view = normalize(wp.sub(cameraPosition));
      const edgeLit = float(1).sub(abs(dot(n, view))).pow(3).mul(smoothstep(0.6, 0.2, abs(n.y)));
      const mat = new MeshBasicNodeMaterial();
      mat.colorNode = vec4(alb.mul(lightAll.add(vec3(0.55, 0.22, 0.12).mul(edgeLit))).mul(presence), 1);
      mat.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
      mat.fog = true;
      mat.opacityNode = revealMask(presence);
      mat.alphaTest = 0.5;
      disposables.push(mat);
      const inst = new InstancedMesh(geo, mat, Math.round(total2 * Math.max(0.5, detail)));
      let placed = 0;
      for (const c of p.columns) {
        const [cx, cz] = [EYE[0] + Math.sin(c.at[0] * DEG) * c.at[1], EYE[2] - Math.cos(c.at[0] * DEG) * c.at[1]];
        const dirX = Math.sin(c.dir * DEG);
        const dirZ = -Math.cos(c.dir * DEG);
        const nCl = Math.round(c.count * Math.max(0.5, detail));
        // Columns packed on a jittered hexagonal grid inside the cluster's footprint.
        const w0 = (c.width[0] + c.width[1]) / 2;
        const pitch = w0 * 1.75;
        const cand: [number, number][] = [];
        const span = Math.ceil(c.radius / pitch);
        for (let j = -span; j <= span; j++) {
          for (let i = -span; i <= span; i++) {
            const x = (i + (j % 2 === 0 ? 0 : 0.5)) * pitch;
            const zz = j * pitch * 0.866;
            const r = Math.hypot(x, zz) / c.radius;
            const edge = 0.75 + Math.sin(Math.atan2(zz, x) * 3 + c.at[0]) * 0.18;
            if (r < edge) cand.push([x, zz]);
          }
        }
        cand.sort(() => rand() - 0.5);
        for (const [ox, oz] of cand.slice(0, nCl)) {
          if (placed >= inst.count) break;
          const x = cx + ox + (rand() - 0.5) * w0 * 0.2;
          const zz = cz + oz + (rand() - 0.5) * w0 * 0.2;
          if (s.riverDistance && s.riverDistance(x, zz) < 6) continue;
          const r = Math.hypot(ox, oz) / c.radius;
          // One leaning surface across the cluster, lower towards its rim, broken column by column.
          const lean = (ox * dirX + oz * dirZ) * c.tilt;
          const hgt = Math.max(c.height[0], c.height[0] + (c.height[1] - c.height[0]) * (1 - r * r) + lean + (rand() - 0.5) * 3.2 - (rand() < 0.12 ? 4 : 0));
          const wd = c.width[0] + (c.width[1] - c.width[0]) * rand();
          const ground = Math.min(ctx.ground.height(x - wd, zz), ctx.ground.height(x + wd, zz), ctx.ground.height(x, zz - wd), ctx.ground.height(x, zz + wd));
          q.setFromAxisAngle(up, rand() * Math.PI);
          const lean2 = new Quaternion().setFromAxisAngle(new Vector3(rand() - 0.5, 0, rand() - 0.5).normalize(), (rand() - 0.5) * 0.05);
          q.multiply(lean2);
          m4.compose(new Vector3(x, ground - 2, zz), q, new Vector3(wd, hgt + 2, wd));
          inst.setMatrixAt(placed++, m4);
        }
      }
      inst.count = placed;
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      group.add(inst);
    }

    return {
      object: group,
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        for (const d of disposables) d.dispose();
        for (const l of loaded) ctx.assets.release(l.src);
        release(ctx, s);
      },
    };
  },
};
