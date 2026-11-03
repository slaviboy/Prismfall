import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, DoubleSide, Group, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, Quaternion, TorusGeometry, Vector3 } from 'three/webgpu';
import { attribute, float, fract, instanceIndex, mix, mx_noise_float, output, positionLocal, positionWorld, sin, smoothstep, vec3, vec4 } from 'three/tsl';
import { floatUniform, seeded, z, type ComponentFactory, type EnvironmentContext } from '@prismfall/sdk';
import { excluded, zExclude } from './scatter';
import { castWorldShadows, frontier, FrontierMaterial, haze, lampLight, releaseFrontier, tickFrontier, type F, type Frontier, type U1, type V3 } from './shared';

const zXZ = z.tuple([z.number(), z.number()]);

const schema = z.object({
  /** Dry bunch-grass tufts. */
  grass: z
    .object({
      count: z.number().int().min(0).max(60000).default(16000),
      inner: z.number().default(26),
      outer: z.number().default(200),
      azimuth: zXZ.default([-80, 80]),
      height: zXZ.default([0.22, 0.6]),
      cluster: z.number().min(0).max(1).default(0.7),
    })
    .prefault({}),
  /** Loose stones and cobbles. */
  stones: z
    .object({
      count: z.number().int().min(0).max(40000).default(6000),
      inner: z.number().default(26),
      outer: z.number().default(160),
      azimuth: zXZ.default([-80, 80]),
      size: zXZ.default([0.08, 0.5]),
      cluster: z.number().min(0).max(1).default(0.6),
    })
    .prefault({}),
  /** Old post-and-rail fence lines (some rails fallen or missing). */
  fences: z.array(z.object({ points: z.array(zXZ).min(2), height: z.number().default(1.3), spacing: z.number().default(2.6), broken: z.number().min(0).max(1).default(0.3) })).max(6).default([]),
  /** Broken wagon wheels lying in the dirt. */
  wheels: z.array(z.object({ at: zXZ, yaw: z.number().default(0), tilt: z.number().default(78), radius: z.number().default(0.68), missing: z.number().int().min(0).max(8).default(3) })).max(6).default([]),
  exclude: zExclude,
  seed: z.number().default(17),
});

type Params = z.infer<typeof schema>;

/** Places `count` points over a ring sector around the viewer, clustered, outside the exclusions. */
function placePoints(count: number, inner: number, outer: number, azimuth: [number, number], cluster: number, rand: () => number, keep: (x: number, z: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  const a0 = (azimuth[0] * Math.PI) / 180;
  const a1 = (azimuth[1] * Math.PI) / 180;
  let guard = 0;
  while (out.length < count && guard++ < count * 25) {
    let x: number;
    let zz: number;
    if (out.length > 12 && rand() < cluster) {
      const o = out[Math.floor(rand() * out.length)]!;
      const r = 0.6 + rand() * rand() * 7;
      const a = rand() * Math.PI * 2;
      x = o[0] + Math.cos(a) * r;
      zz = o[1] + Math.sin(a) * r;
    } else {
      // Density falls off with distance a little less than area grows: more detail near the viewer.
      const t = rand();
      const r = inner + (outer - inner) * t * t;
      const a = a0 + rand() * (a1 - a0);
      x = Math.sin(a) * r;
      zz = 30 - Math.cos(a) * r;
    }
    if (keep(x, zz)) out.push([x, zz]);
  }
  return out;
}

/** One dry grass tuft: thin tapered blades fanning out from a small base (two triangles each). */
function tuftGeometry(rand: () => number, blades: number): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const h: number[] = [];
  for (let i = 0; i < blades; i++) {
    const a = rand() * Math.PI * 2;
    const lean = 0.25 + rand() * 0.55;
    const len = 0.6 + rand() * 0.4;
    const w = 0.02 + rand() * 0.016;
    const bx = Math.cos(a) * 0.03;
    const bz = Math.sin(a) * 0.03;
    const tx = bx + Math.cos(a) * lean * len;
    const tz = bz + Math.sin(a) * lean * len;
    const ty = len * (1 - lean * 0.35);
    const px = -Math.sin(a) * w;
    const pz = Math.cos(a) * w;
    pos.push(bx - px, 0, bz - pz, bx + px, 0, bz + pz, tx, ty, tz);
    for (let k = 0; k < 3; k++) nrm.push(Math.cos(a) * 0.3, 0.9, Math.sin(a) * 0.3);
    h.push(0, 0, 1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('bladeH', new BufferAttribute(new Float32Array(h), 1));
  return g;
}

/** A weathered, irregular stone: a subdivided icosahedron pushed about and flattened. */
function stoneGeometry(rand: () => number): BufferGeometry {
  const g = new IcosahedronGeometry(1, 1);
  const p = g.getAttribute('position');
  const v = new Vector3();
  const k1 = rand() * 10;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = 0.78 + 0.22 * Math.sin(v.x * 3.1 + k1) * Math.cos(v.z * 2.7 + k1 * 0.7) + (rand() - 0.5) * 0.12;
    v.multiplyScalar(n);
    v.y *= 0.55;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

function finishMaterial(s: Frontier, m: FrontierMaterial, presence: U1, albedo: V3): FrontierMaterial {
  m.colorNode = albedo;
  m.lightsNode = s.lightsNode;
  m.fog = false;
  m.outputNode = vec4(haze(s, (output.rgb as unknown as V3).add(lampLight(s).mul(albedo)) as V3).mul(presence), 1);
  return m;
}

/**
 * Ground clutter that makes the desert floor read as real ground under a low sun: thousands of dry
 * bunch-grass tufts swaying in the wind, loose stones and cobbles, old post-and-rail fence lines with
 * fallen rails, and broken wagon wheels lying in the dirt. All instanced (one draw per kind), kept
 * off the town, the roads, the railway and the clear zone near the board, lit by the world's sun.
 */
export const frontierClutter: ComponentFactory<Params> = {
  type: 'frontierClutter',
  version: 1,
  description: 'Instanced dry grass tufts, stones, old fence lines and broken wagon wheels on the desert floor, lit by the world sun.',
  schema,
  create(ctx: EnvironmentContext, p: Params) {
    const s = frontier(ctx);
    const presence = floatUniform(1);
    const rand = seeded(p.seed * 4111);
    const group = new Group();
    const disposables: { dispose(): void }[] = [];
    const detail = ctx.quality.detail === 'low' ? 0.35 : ctx.quality.detail === 'medium' ? 0.65 : ctx.quality.detail === 'high' ? 1 : 1.25;
    const density = detail * Math.min(1.5, Math.max(0.4, ctx.quality.particles));
    const keep = (x: number, zz: number) => !excluded(p.exclude, x, zz);
    const time = ctx.uniforms.time as unknown as F;
    const reduced = ctx.quality.reducedMotion;
    const m4 = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);

    // ---- Grass tufts ----
    const grassPts = placePoints(Math.round(p.grass.count * density), p.grass.inner, p.grass.outer, p.grass.azimuth as [number, number], p.grass.cluster, rand, keep);
    if (grassPts.length > 0) {
      const geo = tuftGeometry(rand, 12);
      const bh = attribute<'float'>('bladeH', 'float');
      const id = float(instanceIndex);
      const hash = fract(sin(id.mul(12.9898)).mul(43758.5453));
      const straw = mix(vec3(0.12, 0.085, 0.045), vec3(0.2, 0.15, 0.08), hash);
      const tip = mix(vec3(0.36, 0.28, 0.15), vec3(0.46, 0.36, 0.2), hash);
      const albedo = mix(straw.mul(0.7), tip, bh.pow(0.8)) as V3;
      const mat = finishMaterial(s, new FrontierMaterial(), presence, albedo);
      mat.side = DoubleSide;
      mat.roughness = 0.9;
      if (!reduced) {
        const ph = hash.mul(6.28);
        const gust = s.u.bass.mul(0.5).add(1);
        const w = sin(time.mul(2.1).add(ph).add(positionWorld.x.mul(0.15))).mul(0.6).add(sin(time.mul(0.8).add(ph.mul(1.7))).mul(0.4));
        const bend = bh.mul(bh).mul(w).mul(0.07).mul(gust);
        mat.positionNode = positionLocal.add(vec3(bend.mul(-0.9), 0, bend.mul(-0.4)));
      }
      const inst = new InstancedMesh(geo, mat, grassPts.length);
      grassPts.forEach(([x, zz], i) => {
        const hgt = p.grass.height[0] + rand() * (p.grass.height[1] - p.grass.height[0]);
        const wide = hgt * (0.8 + rand() * 0.6);
        q.setFromAxisAngle(up, rand() * Math.PI * 2);
        m4.compose(new Vector3(x, ctx.ground.height(x, zz) - 0.02, zz), q, new Vector3(wide, hgt, wide));
        inst.setMatrixAt(i, m4);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      inst.receiveShadow = true;
      group.add(inst);
      disposables.push(geo, mat, inst);
    }

    // ---- Stones ----
    const stonePts = placePoints(Math.round(p.stones.count * density), p.stones.inner, p.stones.outer, p.stones.azimuth as [number, number], p.stones.cluster, rand, keep);
    if (stonePts.length > 0) {
      const variants = [stoneGeometry(rand), stoneGeometry(rand), stoneGeometry(rand)];
      const n = mx_noise_float(positionWorld.mul(3.1)).mul(0.5).add(0.5);
      const id = float(instanceIndex);
      const hash = fract(sin(id.mul(78.233)).mul(43758.5453));
      const base = mix(vec3(0.07, 0.048, 0.034), vec3(0.17, 0.12, 0.085), hash);
      const varnish = mix(float(0.75), float(1.1), n);
      // Desert varnish darkens the tops; the undersides keep the paler dust colour.
      const albedo = base.mul(varnish).mul(mix(float(1.08), float(0.82), smoothstep(-0.2, 0.6, positionLocal.y))) as V3;
      const mat = finishMaterial(s, new FrontierMaterial(), presence, albedo);
      mat.roughness = 0.85;
      variants.forEach((geo, vi) => {
        const mine = stonePts.filter((_, i) => i % variants.length === vi);
        const inst = new InstancedMesh(geo, mat, mine.length);
        mine.forEach(([x, zz], i) => {
          const sz = p.stones.size[0] + Math.pow(rand(), 2.2) * (p.stones.size[1] - p.stones.size[0]);
          q.setFromAxisAngle(new Vector3(rand() - 0.5, 1, rand() - 0.5).normalize(), rand() * Math.PI * 2);
          m4.compose(new Vector3(x, ctx.ground.height(x, zz) - sz * 0.15, zz), q, new Vector3(sz * (0.8 + rand() * 0.5), sz, sz * (0.8 + rand() * 0.5)));
          inst.setMatrixAt(i, m4);
        });
        inst.instanceMatrix.needsUpdate = true;
        inst.frustumCulled = false;
        inst.receiveShadow = true;
        group.add(inst);
        disposables.push(geo, inst);
      });
      disposables.push(mat);
    }

    // ---- Weathered wood (fences, wheels) ----
    const grain = mx_noise_float(positionWorld.mul(vec3(1.5, 9, 1.5))).mul(0.5).add(0.5);
    const woodAlbedo = mix(vec3(0.045, 0.034, 0.026), vec3(0.11, 0.09, 0.07), grain) as V3;
    const woodMat = finishMaterial(s, new FrontierMaterial(), presence, woodAlbedo);
    woodMat.roughness = 0.92;
    disposables.push(woodMat);
    const ironMat = finishMaterial(s, new FrontierMaterial(), presence, vec3(0.03, 0.02, 0.015) as V3);
    ironMat.roughness = 0.7;
    ironMat.metalness = 0.4;
    disposables.push(ironMat);

    // ---- Fences ----
    const postGeo = new BoxGeometry(0.13, 1, 0.13);
    postGeo.translate(0, 0.5, 0);
    const railGeo = new BoxGeometry(1, 0.085, 0.05);
    disposables.push(postGeo, railGeo);
    const posts: Matrix4[] = [];
    const rails: Matrix4[] = [];
    for (const f of p.fences) {
      const pts = f.points.map(([x, zz]) => new Vector3(x, 0, zz));
      const along: Vector3[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        const n = Math.max(1, Math.round(a.distanceTo(b) / f.spacing));
        for (let k = 0; k < n; k++) along.push(a.clone().lerp(b, k / n));
      }
      along.push(pts[pts.length - 1]!.clone());
      const tops: (Vector3 | null)[] = [];
      along.forEach((pt, i) => {
        if (rand() < f.broken * 0.25 && i > 0) {
          tops.push(null);
          return;
        }
        const y = ctx.ground.height(pt.x, pt.z) - 0.25;
        const hgt = f.height * (0.9 + rand() * 0.2) + 0.25;
        const tilt = new Quaternion().setFromAxisAngle(new Vector3(rand() - 0.5, 0, rand() - 0.5).normalize(), (rand() - 0.5) * 0.16);
        posts.push(new Matrix4().compose(new Vector3(pt.x, y, pt.z), tilt, new Vector3(1, hgt, 1)));
        tops.push(new Vector3(pt.x, y + hgt, pt.z));
      });
      for (let i = 0; i < tops.length - 1; i++) {
        const a = tops[i];
        const b = tops[i + 1];
        for (const [k, drop] of [
          [0.25, 0],
          [0.62, 0],
        ] as const) {
          if (!a || !b || rand() < f.broken * 0.5) {
            // A fallen rail lies in the dirt beside the gap now and then.
            if (a && rand() < 0.5) {
              const end = b ?? a.clone().add(new Vector3(f.spacing, 0, 0));
              const mid = a.clone().lerp(end, 0.5);
              const gy = ctx.ground.height(mid.x, mid.z) + 0.04;
              const dir = end.clone().sub(a).setY(0).normalize();
              const rq = new Quaternion().setFromUnitVectors(new Vector3(1, 0, 0), dir).multiply(new Quaternion().setFromAxisAngle(up, (rand() - 0.5) * 0.6));
              rails.push(new Matrix4().compose(new Vector3(mid.x + (rand() - 0.5) * 0.8, gy, mid.z + (rand() - 0.5) * 0.8), rq, new Vector3(f.spacing * 0.95, 1, 1)));
            }
            continue;
          }
          const ya = a.y - (a.y - ctx.ground.height(a.x, a.z)) * k + drop;
          const yb = b.y - (b.y - ctx.ground.height(b.x, b.z)) * k;
          const pa = new Vector3(a.x, ya, a.z);
          const pb = new Vector3(b.x, yb, b.z);
          const mid = pa.clone().lerp(pb, 0.5);
          const dir = pb.clone().sub(pa);
          const len = dir.length();
          const rq = new Quaternion().setFromUnitVectors(new Vector3(1, 0, 0), dir.normalize());
          rails.push(new Matrix4().compose(mid, rq, new Vector3(len * 1.04, 1, 1)));
        }
      }
    }
    for (const [geo, list] of [
      [postGeo, posts],
      [railGeo, rails],
    ] as const) {
      if (list.length === 0) continue;
      const inst = new InstancedMesh(geo, woodMat, list.length);
      list.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      castWorldShadows(inst, true);
      group.add(inst);
      disposables.push(inst);
    }

    // ---- Broken wagon wheels ----
    for (const w of p.wheels) {
      const wheel = new Group();
      const rim = new Mesh(new TorusGeometry(w.radius, 0.05, 6, 30), ironMat);
      const felloe = new Mesh(new TorusGeometry(w.radius - 0.06, 0.055, 5, 30), woodMat);
      const hub = new Mesh(new CylinderGeometry(0.11, 0.13, 0.26, 10), woodMat);
      hub.rotation.x = Math.PI / 2;
      wheel.add(rim, felloe, hub);
      const spokes = 12;
      for (let i = 0; i < spokes; i++) {
        if (i % Math.max(1, Math.floor(spokes / Math.max(1, w.missing))) === 1 && w.missing > 0) continue;
        const a = (i / spokes) * Math.PI * 2;
        const len = (w.radius - 0.11) * (rand() < 0.15 ? 0.55 : 1);
        const sp = new Mesh(new CylinderGeometry(0.022, 0.03, len, 5), woodMat);
        sp.position.set(Math.cos(a) * (0.11 + len / 2), Math.sin(a) * (0.11 + len / 2), 0);
        sp.rotation.z = a - Math.PI / 2;
        wheel.add(sp);
      }
      // Lying tilted in the dirt, half sunk on one side.
      const [x, zz] = w.at;
      wheel.position.set(x, ctx.ground.height(x, zz) + Math.cos((w.tilt * Math.PI) / 180) * w.radius * 0.6, zz);
      wheel.rotation.set((w.tilt * Math.PI) / 180, (w.yaw * Math.PI) / 180, 0, 'YXZ');
      wheel.traverse((o) => {
        if (o instanceof Mesh) disposables.push(o.geometry);
      });
      castWorldShadows(wheel, true);
      group.add(wheel);
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
        for (const d of disposables) d.dispose();
        releaseFrontier(ctx, s);
      },
    };
  },
};
