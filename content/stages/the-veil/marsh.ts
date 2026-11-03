import { BufferAttribute, BufferGeometry, DoubleSide, Group, InstancedMesh, Matrix4, MeshBasicNodeMaterial, Quaternion, Vector3 } from 'three/webgpu';
import { attribute, cameraPosition, float, frontFacing, instanceIndex, mrt, normalize, normalWorld, positionLocal, positionWorld, select, sin, step, vec3, vec4 } from 'three/tsl';
import { floatUniform, z, type ComponentFactory } from '@prismfall/sdk';
import { fogModelFor } from './atmosphere';
import { cast, release, rng, shared, type F, type V3 } from './shared';
import { createLighting, zLighting } from './surface';
import { EYE, WATER, boardLimit, terrainHeight } from './terrain';

const zKind = z.object({
  count: z.number().int().min(0).max(2000),
  /** Height above (+) or below (−) the water where it grows: [min, max] metres. */
  band: z.tuple([z.number(), z.number()]),
  dist: z.tuple([z.number(), z.number()]),
  scale: z.tuple([z.number(), z.number()]).default([0.8, 1.25]),
});

const schema = z.object({
  exposure: z.number().min(0).default(0.3),
  lighting: zLighting,
  reeds: zKind.prefault({ count: 420, band: [-0.45, 0.35], dist: [24, 420] }),
  sedge: zKind.prefault({ count: 460, band: [-0.1, 0.9], dist: [12, 360] }),
  grass: zKind.prefault({ count: 700, band: [0.5, 30], dist: [4, 220] }),
  /** Keeps this many degrees either side of the board free of tall clumps (up to 70 m out). */
  clear: z.number().default(21),
  seed: z.number().default(17),
});

type Params = z.infer<typeof schema>;

interface BladeSpec {
  blades: [number, number];
  radius: number;
  height: [number, number];
  width: [number, number];
  arch: [number, number];
  segments: number;
  /** Share of blades that are stems with a drooping seed plume (reeds). */
  plumes: number;
  colour: [number, number, number];
}

/**
 * One clump of tapered, arching blades (dead reed, sedge or grass), with a height coordinate in
 * uv.y for the wind and a per-blade colour in the vertex colour.
 */
function clumpGeometry(spec: BladeSpec, seed: number): BufferGeometry {
  const r = rng(seed);
  const pos: number[] = [];
  const nrm: number[] = [];
  const hgt: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const n = Math.round(spec.blades[0] + (spec.blades[1] - spec.blades[0]) * r());
  const blade = (x0: number, z0: number, h: number, w: number, dirA: number, arch: number, tone: number, droop = false) => {
    const base = pos.length / 3;
    const dx = Math.cos(dirA);
    const dz = Math.sin(dirA);
    const segs = spec.segments;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      // Arching: the blade leans out along its direction more and more towards the tip.
      const lean = arch * t * t * h;
      const y = h * (t - (droop ? 0.55 * t * t * t : 0.12 * arch * t * t));
      const cx = x0 + dx * lean;
      const cz = z0 + dz * lean;
      const ww = w * (1 - t) ** 0.9 * 0.5 + 0.0015;
      // The blade's width runs across its lean direction.
      pos.push(cx - dz * ww, y, cz + dx * ww, cx + dz * ww, y, cz - dx * ww);
      const nx = dx * 0.6;
      const nz = dz * 0.6;
      nrm.push(nx, 0.8, nz, nx, 0.8, nz);
      hgt.push(t, t);
      const c = 0.82 + 0.3 * t;
      col.push(spec.colour[0] * tone * c, spec.colour[1] * tone * c, spec.colour[2] * tone * c, spec.colour[0] * tone * c, spec.colour[1] * tone * c, spec.colour[2] * tone * c);
      if (k < segs) idx.push(base + k * 2, base + k * 2 + 1, base + k * 2 + 2, base + k * 2 + 1, base + k * 2 + 3, base + k * 2 + 2);
    }
  };
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    const rr = Math.sqrt(r()) * spec.radius;
    const x0 = Math.cos(a) * rr;
    const z0 = Math.sin(a) * rr;
    const h = spec.height[0] + (spec.height[1] - spec.height[0]) * r();
    const w = spec.width[0] + (spec.width[1] - spec.width[0]) * r();
    const arch = spec.arch[0] + (spec.arch[1] - spec.arch[0]) * r();
    const dir = a + (r() - 0.5) * 1.2;
    const tone = 0.7 + 0.5 * r();
    // A few blades snapped off short.
    const broken = r() < 0.15;
    blade(x0, z0, broken ? h * (0.35 + 0.3 * r()) : h, w, dir, arch, tone);
    if (spec.plumes > 0 && r() < spec.plumes) {
      // Reed stem: thin and nearly straight, a drooping seed plume of short soft blades at the top.
      const sh = h * (1.15 + 0.25 * r());
      blade(x0, z0, sh, w * 0.35, dir, 0.05, tone * 0.9);
      const top = new Vector3(x0, sh * 0.94, z0);
      for (let k = 0; k < 6; k++) {
        const pa = dir + (k / 6) * Math.PI * 2 * 0.4 - 0.4;
        const before = pos.length / 3;
        blade(0, 0, 0.32 + 0.12 * r(), 0.05, pa, 1.1, tone * 1.15, true);
        for (let q = before; q < pos.length / 3; q++) {
          pos[q * 3] = pos[q * 3]! + top.x;
          pos[q * 3 + 1] = pos[q * 3 + 1]! + top.y;
          pos[q * 3 + 2] = pos[q * 3 + 2]! + top.z;
          hgt[q] = 0.92 + hgt[q]! * 0.08;
        }
      }
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  geo.setAttribute('blade', new BufferAttribute(new Float32Array(hgt), 1));
  geo.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

const KINDS: Record<'reeds' | 'sedge' | 'grass', BladeSpec> = {
  reeds: { blades: [30, 46], radius: 0.6, height: [1.5, 2.6], width: [0.02, 0.034], arch: [0.08, 0.35], segments: 5, plumes: 0.35, colour: [0.3, 0.27, 0.21] },
  sedge: { blades: [24, 36], radius: 0.35, height: [0.55, 1.1], width: [0.012, 0.02], arch: [0.5, 1.0], segments: 4, plumes: 0, colour: [0.27, 0.26, 0.2] },
  grass: { blades: [16, 26], radius: 0.22, height: [0.25, 0.55], width: [0.006, 0.012], arch: [0.4, 0.9], segments: 3, plumes: 0, colour: [0.4, 0.36, 0.27] },
};

/**
 * Marsh vegetation: clumps of dead reeds with drooping seed plumes in the shallows and along the
 * shores, arching sedge on the wet banks, and dead grass tufts on the drier ground near the viewer.
 * Each clump is a hand-built bundle of tapered blades (one draw call per kind, instanced), placed
 * by the real terrain and water level; the wind bends them from the base in slow, irregular gusts.
 * Lit by the moon like everything else, with the light coming through the thin blades from behind.
 */
export const marshComponent: ComponentFactory<Params> = {
  type: 'veilMarsh',
  version: 1,
  description: 'Dead reeds, sedge and grass tufts along the marsh shores, swaying in the wind.',
  schema,
  async create(ctx, p) {
    const s = shared(ctx);
    const fog = await fogModelFor(ctx, s, p.exposure);
    const light = createLighting(s, fog, p.lighting);
    const presence = floatUniform(1);
    const group = new Group();
    const detail = ctx.quality.detail;
    const density = detail === 'low' ? 0.35 : detail === 'medium' ? 0.65 : detail === 'high' ? 1 : 1.3;
    const r = rng(p.seed * 131);
    const disposables: { dispose(): void }[] = [];
    const t = ctx.uniforms.time;
    const calm = ctx.quality.reducedMotion ? 0.4 : 1;

    (['reeds', 'sedge', 'grass'] as const).forEach((kind, ki) => {
      const spec = KINDS[kind];
      const k = p[kind];
      const count = Math.round(k.count * density);
      if (count === 0) return;
      const mats: Matrix4[] = [];
      let tries = 0;
      while (mats.length < count && tries < count * 60) {
        tries++;
        const az = (r() * 2 - 1) * 150;
        const u = r();
        const dist = k.dist[0] + (k.dist[1] - k.dist[0]) * u * u;
        if (Math.abs(az) < p.clear && dist < 70 && kind !== 'grass') continue;
        const a = (az * Math.PI) / 180;
        const x = EYE.x + Math.sin(a) * dist;
        const zz = EYE.z - Math.cos(a) * dist;
        const h = terrainHeight(x, zz);
        const rel = h - WATER;
        if (rel < k.band[0] || rel > k.band[1]) continue;
        const sc = k.scale[0] + (k.scale[1] - k.scale[0]) * r();
        if (h + spec.height[1] * 1.4 * sc > boardLimit(x, zz) - 0.5) continue;
        // Clumps gather: grow next to an earlier clump more often than not.
        const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), r() * Math.PI * 2);
        const tilt = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (r() - 0.5) * 0.12);
        mats.push(new Matrix4().compose(new Vector3(x, h - 0.05, zz), q.multiply(tilt), new Vector3(sc, sc * (0.85 + 0.3 * r()), sc)));
        if (r() < 0.6 && mats.length < count) {
          const ox = x + (r() - 0.5) * 3.5;
          const oz = zz + (r() - 0.5) * 3.5;
          const oh = terrainHeight(ox, oz);
          if (oh - WATER >= k.band[0] && oh - WATER <= k.band[1] && oh + spec.height[1] * 1.4 * sc < boardLimit(ox, oz) - 0.5) {
            mats.push(new Matrix4().compose(new Vector3(ox, oh - 0.05, oz), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), r() * 6.28), new Vector3(sc * 0.8, sc * 0.8, sc * 0.8)));
          }
        }
      }
      const geo = clumpGeometry(spec, p.seed + ki * 7);
      // Wind: a slow bend from the base, with gusts travelling across the marsh.
      const hb = cast<F>(attribute('blade', 'float'));
      const id = cast<F>(instanceIndex.toFloat());
      const gust = cast<F>(sin(t.mul(0.45).add(id.mul(0.37))).mul(0.5).add(sin(t.mul(1.13).add(id.mul(1.91))).mul(0.25)).add(0.35));
      const bend = cast<F>(hb.mul(hb).mul(gust).mul(kind === 'reeds' ? 0.16 : kind === 'sedge' ? 0.1 : 0.05).mul(calm));
      const g = cast<V3>(positionLocal);
      const material = new MeshBasicNodeMaterial();
      material.positionNode = vec3(g.x.add(bend), g.y.sub(bend.mul(bend).mul(0.6)), g.z.add(bend.mul(0.35)));
      const n0 = cast<V3>(normalize(normalWorld));
      const n = cast<V3>(select(frontFacing, n0, n0.negate()));
      const albedo = cast<V3>(cast<V3>(attribute('color', 'vec3')).mul(hb.mul(0.25).add(0.75)));
      const lit = light.shade({ albedo, normal: n, world: cast<V3>(positionWorld), roughness: cast<F>(float(0.75)), translucent: cast<F>(float(0.22)), rim: 0.25, fill: 1.2 });
      material.colorNode = vec4(lit, 1);
      const dist = cast<F>(positionWorld.sub(cameraPosition).length());
      material.opacityNode = cast<F>(step(dist, float(1900).mul(presence).add(1)));
      material.alphaTest = 0.5;
      material.side = DoubleSide;
      material.fog = false;
      material.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
      const mesh = new InstancedMesh(geo, material, mats.length);
      mats.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.name = `veil-${kind}`;
      group.add(mesh);
      disposables.push(geo, material);
    });

    return {
      object: group,
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        disposables.forEach((d) => d.dispose());
        release(ctx, s);
      },
    };
  },
};
