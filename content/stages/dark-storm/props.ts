import { AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, DoubleSide, Group, IcosahedronGeometry, InstancedBufferAttribute, InstancedBufferGeometry, Matrix4, Mesh, MeshBasicNodeMaterial, PlaneGeometry, Quaternion, Vector3 } from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  cross,
  dot,
  exp,
  float,
  floor,
  fract,
  instancedBufferAttribute,
  int,
  length,
  max,
  mix,
  mx_noise_float,
  normalWorld,
  normalize,
  output,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  smoothstep,
  step,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { noBloom, z, type ComponentFactory } from '@prismfall/sdk';
import { EYE, boardLimit, ledgeMask, pointAt, puddle, streamDistance, terrainHeight, vnoise } from './terrain';
import { StormMaterial, boltReflection, castFlashShadows, cast, haze, hash2, releaseStorm, rng, sat, skyRadiance, storm, tickStorm, FLASH_COLOR, MAX_FLASH, HAZE_DENSITY, type F, type V2, type V3, type V4 } from './shared';
import { reveal } from './land';

const schema = z.object({
  boulders: z.number().int().min(0).max(400).default(70),
  drips: z.number().int().min(0).max(4000).default(420),
  seed: z.number().int().default(7),
});

type Params = z.infer<typeof schema>;

/** Kinds of surface on the props (a vertex attribute). */
const STONE = 0;
const WOOD = 1;
const BARK = 2;

interface Builder {
  pos: number[];
  nrm: number[];
  kind: number[];
  idx: number[];
}

/** Appends a geometry, transformed, with a surface kind. */
function append(b: Builder, g: BufferGeometry, m: Matrix4, kind: number): void {
  // Smooth normals on the shared vertices first, then flattened into the merged mesh.
  const t = g.clone();
  t.applyMatrix4(m);
  t.computeVertexNormals();
  const geo = t.index ? t.toNonIndexed() : t;
  if (geo !== t) t.dispose();
  const p = geo.getAttribute('position');
  const n = geo.getAttribute('normal');
  const base = b.pos.length / 3;
  for (let i = 0; i < p.count; i++) {
    b.pos.push(p.getX(i), p.getY(i), p.getZ(i));
    b.nrm.push(n.getX(i), n.getY(i), n.getZ(i));
    b.kind.push(kind);
    b.idx.push(base + i);
  }
  geo.dispose();
}

/** Roughens every vertex of a geometry with value noise (rock), along its position from the centre. */
function roughen(g: BufferGeometry, amount: number, scale: number, seed: number): BufferGeometry {
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const zz = p.getZ(i);
    const n = vnoise(x * scale + seed, zz * scale - y * scale * 0.7, seed) * 0.6 + vnoise(x * scale * 2.7, y * scale * 2.7 + zz, seed + 3) * 0.4;
    const len = Math.hypot(x, y * 0.4, zz) || 1;
    p.setXYZ(i, x + (x / len) * n * amount, y + n * amount * 0.25, zz + (zz / len) * n * amount);
  }
  p.needsUpdate = true;
  return g;
}

/** A rough-hewn standing stone: a tapered, leaning slab with weathered faces. */
function standingStone(rand: () => number, height: number): BufferGeometry {
  const w = 0.7 + rand() * 0.7;
  const d = 0.35 + rand() * 0.4;
  const g = new BoxGeometry(w, height, d, 5, 12, 3);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / height + 0.5;
    const taper = 1 - y * (0.25 + rand() * 0.05);
    p.setX(i, p.getX(i) * taper);
    p.setZ(i, p.getZ(i) * (1 - y * 0.15));
    // A rounded, broken top.
    if (y > 0.9) p.setY(i, p.getY(i) - (Math.abs(p.getX(i)) / w) * height * 0.08 * rand());
  }
  g.translate(0, height / 2 - 0.3, 0);
  return roughen(g, 0.09, 1.3, Math.floor(rand() * 100));
}

/** A dead, wind-bent tree: tapered limbs branching from a leaning trunk. */
function deadTree(rand: () => number, b: Builder, at: Vector3, drips: Vector3[]): void {
  const up = new Vector3(0, 1, 0);
  const limb = (from: Vector3, dir: Vector3, length: number, radius: number, depth: number): void => {
    const g = new CylinderGeometry(radius * 0.55, radius, length, 7, 3, true);
    g.translate(0, length / 2, 0);
    const q = new Quaternion().setFromUnitVectors(up, dir.clone().normalize());
    append(b, g, new Matrix4().compose(from, q, new Vector3(1, 1, 1)), BARK);
    g.dispose();
    const tip = from.clone().addScaledVector(dir.clone().normalize(), length);
    if (depth >= 4 || radius < 0.035) {
      drips.push(tip.clone());
      return;
    }
    const kids = depth === 0 ? 3 : 2 + (rand() < 0.4 ? 1 : 0);
    for (let k = 0; k < kids; k++) {
      // Leaning away from the wind (towards +x), spreading and drooping a little.
      const d = dir.clone().normalize().add(new Vector3((rand() - 0.35) * 1.1, (rand() - 0.6) * 0.5, (rand() - 0.5) * 1.1)).normalize();
      const start = from.clone().addScaledVector(dir.clone().normalize(), length * (0.55 + rand() * 0.45));
      limb(start, d, length * (0.55 + rand() * 0.25), radius * 0.62, depth + 1);
    }
  };
  limb(at.clone().setY(at.y - 0.4), new Vector3(0.18, 1, 0.05), 4.2, 0.32, 0);
}

/**
 * The ledge's props: a broken circle of standing stones on the left, a ruined stone bothy beyond
 * them, a dead, wind-bent tree and a sagging line of fence posts on the right, boulders and slabs
 * everywhere. Wet stone and timber: rivulets run down the stones with drops sliding along them,
 * the sheen reflects the sky, and each nearby flash throws their shadows across the ledge. Water
 * drips from the tree's limbs and the bothy's eaves.
 */
export const propsComponent: ComponentFactory<Params> = {
  type: 'stormProps',
  version: 1,
  description: 'Dark Storm: standing stones, a ruined bothy, a dead tree, fence posts and boulders on the wet ledge, with rivulets and drips.',
  schema,
  create(ctx, p) {
    const s = storm(ctx);
    const u = s.u;
    const rand = rng(p.seed * 7919 + 1);
    const b: Builder = { pos: [], nrm: [], kind: [], idx: [] };
    const drips: Vector3[] = [];
    const place = (x: number, zz: number, sink = 0.15): Vector3 => new Vector3(x, terrainHeight(x, zz) - sink, zz);
    const ok = (x: number, zz: number): boolean => ledgeMask(x, zz) > 0.95 && puddle(x, zz) < 0.3 && streamDistance(x, zz) > 2.5 && boardLimit(x, zz) > 0 && Math.hypot(x - EYE.x, zz - EYE.z) > 14;

    // The stone circle: a ring of tall stones, two of them fallen.
    const ring = pointAt(-30, 52);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rand() * 0.25;
      const x = ring.x + Math.cos(a) * 9.5;
      const zz = ring.z + Math.sin(a) * 9.5;
      if (!ok(x, zz)) continue;
      const fallen = i === 3 || i === 7;
      const h = fallen ? 2.6 + rand() : 2.4 + rand() * 2.2;
      const g = standingStone(rand, h);
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), a + Math.PI / 2 + (rand() - 0.5) * 0.4);
      if (fallen) q.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2 - 0.08));
      else q.multiply(new Quaternion().setFromAxisAngle(new Vector3(rand() - 0.5, 0, rand() - 0.5).normalize(), (rand() - 0.3) * 0.12));
      append(b, g, new Matrix4().compose(place(x, zz, fallen ? 0.3 : 0.2), q, new Vector3(1, 1, 1)), STONE);
      g.dispose();
    }
    // A lone tall stone nearer the viewer on the left.
    {
      const at = pointAt(-24, 21);
      const g = standingStone(rand, 3.4);
      append(b, g, new Matrix4().compose(place(at.x, at.z, 0.2), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.6), new Vector3(1, 1, 1)), STONE);
      g.dispose();
    }
    // The bothy: a roofless stone cottage, gable ends standing.
    {
      const at = pointAt(-52, 96);
      const ground = terrainHeight(at.x, at.z);
      const yaw = 0.5;
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
      const wall = (lx: number, lz: number, w: number, h: number, d: number, gable: boolean): void => {
        const g = new BoxGeometry(w, h, d, Math.ceil(w * 2), Math.ceil(h * 2), 1);
        if (gable) {
          const pp = g.getAttribute('position');
          for (let i = 0; i < pp.count; i++) if (pp.getY(i) > 0) pp.setY(i, pp.getY(i) + (1 - Math.abs(pp.getX(i)) / (w / 2)) * 2.2);
        }
        roughen(g, 0.06, 2.2, Math.floor(rand() * 100));
        const off = new Vector3(lx, h / 2 - 0.2, lz).applyQuaternion(q);
        append(b, g, new Matrix4().compose(new Vector3(at.x, ground, at.z).add(off), q, new Vector3(1, 1, 1)), STONE);
        g.dispose();
      };
      wall(0, -2.6, 7.6, 2.4, 0.55, false);
      wall(-1.6, 2.6, 4.2, 1.6, 0.55, false);
      wall(-3.6, 0, 0.55, 2.4, 5.6, false);
      wall(3.6, 0, 0.55, 2.6, 5.6, false);
      // Gable ends (as thin walls turned across).
      const gq = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw + Math.PI / 2);
      for (const lx of [-3.6, 3.6]) {
        const g = new BoxGeometry(5.6, 2.5, 0.55, 8, 4, 1);
        const pp = g.getAttribute('position');
        for (let i = 0; i < pp.count; i++) if (pp.getY(i) > 0) pp.setY(i, pp.getY(i) + (1 - Math.abs(pp.getX(i)) / 2.8) * 2.3);
        roughen(g, 0.05, 2.2, 5);
        const off = new Vector3(lx, 1.2, 0).applyQuaternion(q);
        append(b, g, new Matrix4().compose(new Vector3(at.x, ground, at.z).add(off), gq, new Vector3(1, 1, 1)), STONE);
        g.dispose();
        for (let k = 0; k < 6; k++) drips.push(new Vector3(at.x, ground + 2.4, at.z).add(new Vector3(lx * 0.98, 0, -2.4 + k * 0.95).applyQuaternion(q)));
      }
    }
    // The dead tree on the right.
    {
      const at = pointAt(37, 63);
      deadTree(rand, b, new Vector3(at.x, terrainHeight(at.x, at.z), at.z), drips);
    }
    // Fence posts along the right of the ledge, leaning, some broken.
    {
      const from = pointAt(18, 16);
      const to = pointAt(46, 74);
      const n = 19;
      const tops: Vector3[] = [];
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const x = from.x + (to.x - from.x) * t + (rand() - 0.5) * 0.4;
        const zz = from.z + (to.z - from.z) * t + (rand() - 0.5) * 0.4;
        if (boardLimit(x, zz) < terrainHeight(x, zz) + 2) continue;
        const h = rand() < 0.15 ? 0.6 + rand() * 0.4 : 1.25 + rand() * 0.2;
        const g = new BoxGeometry(0.13, h, 0.13, 1, 3, 1);
        g.translate(0, h / 2 - 0.25, 0);
        const lean = new Quaternion().setFromAxisAngle(new Vector3(rand() - 0.5, 0, rand() - 0.5).normalize(), (rand() - 0.5) * 0.18);
        const base = place(x, zz, 0.05);
        append(b, g, new Matrix4().compose(base, lean, new Vector3(1, 1, 1)), WOOD);
        g.dispose();
        if (h > 1) tops.push(base.clone().add(new Vector3(0, h - 0.35, 0).applyQuaternion(lean)));
      }
      // Two sagging wires between the posts.
      for (let i = 0; i < tops.length - 1; i++) {
        for (const drop of [0, 0.45]) {
          const a = tops[i]!.clone().setY(tops[i]!.y - drop);
          const c = tops[i + 1]!.clone().setY(tops[i + 1]!.y - drop);
          const mid = a.clone().add(c).multiplyScalar(0.5).setY((a.y + c.y) / 2 - 0.12);
          for (const [p0, p1] of [
            [a, mid],
            [mid, c],
          ] as const) {
            const len = p0.distanceTo(p1);
            const g = new CylinderGeometry(0.008, 0.008, len, 3, 1, true);
            const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), p1.clone().sub(p0).normalize());
            append(b, g, new Matrix4().compose(p0.clone().add(p1).multiplyScalar(0.5), q, new Vector3(1, 1, 1)), WOOD);
            g.dispose();
          }
          if (drop === 0) drips.push(mid.clone());
        }
      }
    }
    // Boulders and slabs scattered over the ledge.
    for (let i = 0, tries = 0; i < p.boulders && tries < p.boulders * 12; tries++) {
      const az = (rand() < 0.5 ? -1 : 1) * (15 + rand() * 70);
      const dist = 6 + Math.pow(rand(), 1.4) * 120;
      const at = pointAt(az, dist);
      if (!ok(at.x, at.z)) continue;
      i++;
      const size = 0.2 + Math.pow(rand(), 2.6) * (dist < 25 ? 0.45 : 0.95);
      const g = roughen(mergeVertices(new IcosahedronGeometry(1, 1)), 0.34, 1.6, i);
      const sc = new Vector3(size * (0.9 + rand() * 0.8), size * (0.45 + rand() * 0.4), size * (0.8 + rand() * 0.7));
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), rand() * 6.28);
      append(b, g, new Matrix4().compose(place(at.x, at.z, sc.y * 0.3), q, sc), STONE);
      g.dispose();
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(b.pos), 3));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(b.nrm), 3));
    geo.setAttribute('kind', new BufferAttribute(new Float32Array(b.kind), 1));
    geo.computeBoundingSphere();

    const m = new StormMaterial();
    m.lightsNode = s.lightsNode;
    m.fog = false;
    const world = cast<V3>(positionWorld);
    const kind = cast<F>(attribute('kind', 'float'));
    const nW = cast<V3>(normalize(normalWorld));
    const isStone = cast<F>(step(kind, 0.5));
    const isBark = cast<F>(step(1.5, kind));
    const nA = cast<F>(mx_noise_float(world.mul(0.9)).mul(0.5).add(0.5));
    const nB = cast<F>(mx_noise_float(world.mul(4.3)).mul(0.5).add(0.5));
    // Lichen-flecked grey stone; dark, silvered timber; near-black wet bark.
    const stone = cast<V3>(mix(vec3(0.075, 0.077, 0.08), vec3(0.085, 0.092, 0.07), smoothstep(0.55, 0.75, nA)).mul(nB.mul(0.4).add(0.75)));
    const wood = cast<V3>(vec3(0.05, 0.043, 0.036).mul(nB.mul(0.5).add(0.7)));
    const bark = cast<V3>(vec3(0.028, 0.025, 0.022).mul(nB.mul(0.5).add(0.7)));
    const base = cast<V3>(mix(mix(wood, bark, isBark), stone, isStone));
    // Rivulets down the stones: narrow wet runs, darker and glossy, with drops sliding down them.
    const run = cast<F>(mx_noise_float(vec3(world.x.mul(5.5).add(world.z.mul(3.1)), world.y.mul(0.35), world.z.mul(5.5).sub(world.x.mul(2.3)))).mul(0.5).add(0.5));
    const rivulet = cast<F>(smoothstep(0.6, 0.72, run).mul(float(1).sub(nW.y.abs())).mul(isStone));
    const slide = cast<F>(fract(world.y.mul(0.7).add(u.time.mul(0.55)).add(run.mul(9))));
    const drop = cast<F>(smoothstep(0.96, 1, slide).mul(rivulet));
    m.colorNode = vec4(base.mul(float(1).sub(rivulet.mul(0.35))), 1);
    const rough = cast<F>(mix(mix(float(0.55), float(0.62), isBark), float(0.34).sub(nB.mul(0.1)), isStone).sub(rivulet.mul(0.25)).sub(drop.mul(0.1)));
    m.roughnessNode = rough;
    m.metalness = 0;
    const v = cast<V3>(normalize(cameraPosition.sub(world)));
    const r = cast<V3>(reflect(v.negate(), nW));
    const ndv = cast<F>(max(dot(nW, v), 0));
    const fres = cast<F>(float(0.03).add(float(0.97).mul(pow(float(1).sub(ndv), 5))));
    const wet = cast<F>(float(0.35).add(rivulet.mul(0.5)));
    const env = cast<V3>(skyRadiance(s, r, rough.mul(3)).add(boltReflection(s, world, r, rough)));
    m.emissiveNode = env.mul(fres).mul(wet).add(vec3(...FLASH_COLOR).mul(drop.mul(u.skyFlash).mul(0.6)));
    m.outputNode = Fn(() => vec4(haze(s, cast<V3>(output.rgb), world), 1))();
    m.opacityNode = reveal(u.presence);
    m.alphaTest = 0.5;
    noBloom(m);
    const mesh = new Mesh(geo, m);
    castFlashShadows(mesh);
    mesh.frustumCulled = false;
    const group = new Group();
    group.add(mesh);
    const disposables: { dispose(): void }[] = [geo, m];

    // Drips: water falling from the tree's limbs, the fence wire and the bothy's gables.
    const dripCount = Math.min(p.drips, Math.round(p.drips * ctx.quality.particles));
    if (dripCount > 0 && drips.length > 0) {
      const quad = new PlaneGeometry(1, 1);
      const igeo = new InstancedBufferGeometry();
      igeo.index = quad.index;
      igeo.setAttribute('position', quad.getAttribute('position'));
      const a0 = new Float32Array(dripCount * 4);
      const a1 = new Float32Array(dripCount * 4);
      for (let i = 0; i < dripCount; i++) {
        const src = drips[i % drips.length]!;
        const x = src.x + (rand() - 0.5) * 0.3;
        const zz = src.z + (rand() - 0.5) * 0.3;
        a0.set([x, src.y, zz, 0.7 + rand() * 1.4], i * 4);
        a1.set([terrainHeight(x, zz), rand(), rand(), 0], i * 4);
      }
      const at0 = new InstancedBufferAttribute(a0, 4);
      const at1 = new InstancedBufferAttribute(a1, 4);
      igeo.setAttribute('drip0', at0);
      igeo.setAttribute('drip1', at1);
      igeo.instanceCount = dripCount;
      const D0 = cast<V4>(instancedBufferAttribute(at0, 'vec4'));
      const D1 = cast<V4>(instancedBufferAttribute(at1, 'vec4'));
      const vQ = varyingProperty('vec2', 'vDripQ');
      const vC = varyingProperty('vec3', 'vDripColor');
      const dm = new MeshBasicNodeMaterial();
      dm.positionNode = Fn(() => {
        const period = D0.w;
        const t = u.time.add(D1.y.mul(period));
        const life = fract(t.div(period));
        const fallH = D0.y.sub(D1.x);
        // Hangs, swelling, for a moment; then falls under gravity to the ground.
        const hang = 0.35;
        const ft = max(life.mul(period).sub(hang), 0);
        const y = D0.y.sub(ft.mul(ft).mul(4.9));
        const alive = step(D1.x, y).mul(step(D1.z, u.rain.div(1.3).add(0.2)));
        const centre = cast<V3>(vec3(D0.x, max(y, D1.x), D0.z));
        const toCam = cast<V3>(cameraPosition.sub(centre));
        const dist = length(toCam);
        const speed = ft.mul(9.8);
        const len = speed.mul(0.03).add(0.02);
        const right = normalize(cross(vec3(0, 1, 0), toCam));
        const w = max(float(0.006), dist.mul(0.0009));
        vQ.assign(positionGeometry.xy.mul(2));
        let lit: V3 = cast<V3>(vec3(0.02, 0.024, 0.03).add(vec3(...FLASH_COLOR).mul(u.skyFlash.mul(0.3))));
        for (let i = 0; i < MAX_FLASH; i++) {
          const fp = cast<V4>(u.flashPos.element(int(i)));
          lit = cast<V3>(lit.add(vec3(...FLASH_COLOR).mul(fp.w.mul(90).div(length(fp.xyz.sub(centre)).add(150)))));
        }
        vC.assign(lit.mul(alive).mul(exp(dist.mul(-HAZE_DENSITY))).mul(smoothstep(0, 1, fallH)));
        return centre.add(right.mul(positionGeometry.x.mul(w))).add(vec3(0, 1, 0).mul(positionGeometry.y.mul(len)));
      })();
      const q = cast<V2>(vQ);
      const shape = exp(q.x.mul(q.x).mul(-4)).mul(smoothstep(1, 0.3, q.y.abs()));
      dm.colorNode = vec4(cast<V3>(vC).mul(shape).mul(1.4).mul(u.presence), 1);
      dm.transparent = true;
      dm.depthWrite = false;
      dm.blending = AdditiveBlending;
      dm.side = DoubleSide;
      dm.fog = false;
      noBloom(dm);
      const dmesh = new Mesh(igeo, dm);
      dmesh.frustumCulled = false;
      dmesh.renderOrder = 7;
      group.add(dmesh);
      disposables.push(quad, igeo, dm);
    }
    void floor;
    void hash2;
    void sat;
    void vec2;
    void cameraViewMatrix;

    return {
      object: group,
      update(frame) {
        tickStorm(s, ctx, frame);
      },
      setPresence(val) {
        u.presence.value = val;
      },
      dispose() {
        for (const d of disposables) d.dispose();
        releaseStorm(ctx, s);
      },
    };
  },
};
