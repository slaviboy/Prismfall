import type { Object3D } from 'three/webgpu';
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  LineBasicNodeMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  Quaternion,
  Sprite,
  SpriteNodeMaterial,
  Vector3,
  type Material,
} from 'three/webgpu';
import { mx_noise_float, output, positionWorld, smoothstep, uv, vec3, vec4 } from 'three/tsl';
import { additiveFog, floatUniform, noBloom, seeded, z, type ComponentFactory, type EnvironmentContext, type StageGameEvent } from '@prismfall/sdk';
import { PuffSystem } from './puffs';
import { castWorldShadows, frontier, FrontierMaterial, haze, LAMP_COLOR, litMaterial, releaseFrontier, tickFrontier, type V3 } from './shared';

const zXZ = z.tuple([z.number(), z.number()]);

const schema = z.object({
  src: z.string().default('models/train.glb'),
  /** The railway's centre line (world x, z), smoothed with a Catmull-Rom spline. */
  track: z.array(zXZ).min(3),
  /** Rail-top height above the ground. */
  railTop: z.number().default(0.5),
  /** Running speed, m/s. */
  speed: z.number().positive().default(8.5),
  /** Seconds between trains (randomised ±40 %). */
  every: z.number().positive().default(75),
  /** Seconds before the first train. */
  first: z.number().min(0).default(7),
  /** Arc-length span of the track the train runs over in one pass (start, end), metres. */
  run: zXZ.default([60, 560]),
  /** Cars behind the tender, in order. */
  cars: z.array(z.enum(['car_box', 'car_stock', 'car_coach', 'car_caboose'])).default(['car_box', 'car_stock', 'car_coach', 'car_caboose']),
  /** Telegraph poles beside the line: side offset (+ = towards the viewer side) and spacing. */
  poles: z
    .object({
      offset: z.number().default(-7),
      spacing: z.number().default(48),
      from: z.number().default(0),
      to: z.number().default(700),
    })
    .prefault({}),
  /** Railroad water tower: arc length along the track and side offset. */
  tower: z.object({ at: z.number().default(330), offset: z.number().default(6.2) }).prefault({}),
  /** Shadow box for the visible stretch of line. */
  shadowBox: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]).default([25, -10, -130, 140, 12, 20]),
  seed: z.number().default(3),
});

type Params = z.infer<typeof schema>;

interface Spline {
  length: number;
  /** Position and unit tangent at arc length s. */
  at(s: number, pos: Vector3, tan: Vector3): void;
}

function buildSpline(points: [number, number][], height: (x: number, z: number) => number, lift: number): Spline {
  const pts = points.map(([x, zz]) => new Vector3(x, 0, zz));
  const samples: Vector3[] = [];
  const cr = (p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, t: number): Vector3 => {
    const t2 = t * t;
    const t3 = t2 * t;
    return new Vector3(
      0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      0,
      0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
    );
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    const n = Math.max(4, Math.ceil(p1.distanceTo(p2) / 0.5));
    for (let k = 0; k < n; k++) samples.push(cr(p0, p1, p2, p3, k / n));
  }
  samples.push(pts[pts.length - 1]!.clone());
  // Smooth the heights along the line (a railway grade has no bumps).
  const ys = samples.map((p) => height(p.x, p.z) + lift);
  const smoothY = ys.map((_, i) => {
    let a = 0;
    let n = 0;
    for (let k = -40; k <= 40; k++) {
      const v = ys[i + k];
      if (v !== undefined) {
        a += v;
        n++;
      }
    }
    return a / n;
  });
  samples.forEach((p, i) => (p.y = smoothY[i]!));
  const cum = [0];
  for (let i = 1; i < samples.length; i++) cum.push(cum[i - 1]! + samples[i]!.distanceTo(samples[i - 1]!));
  const length = cum[cum.length - 1]!;
  return {
    length,
    at(s, pos, tan) {
      const c = Math.min(length, Math.max(0, s));
      let lo = 0;
      let hi = cum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid]! < c) lo = mid;
        else hi = mid;
      }
      const span = cum[hi]! - cum[lo]! || 1;
      const t = (c - cum[lo]!) / span;
      pos.copy(samples[lo]!).lerp(samples[hi]!, t);
      tan.copy(samples[hi]!).sub(samples[lo]!).normalize();
    },
  };
}

interface Vehicle {
  name: string;
  root: Object3D;
  length: number;
  wheels: { o: Object3D; r: number }[];
  /** Distance from the train's front coupler to this vehicle's centre. */
  offset: number;
}

/**
 * The railway: a smoothed line of ties, rails and ballast with telegraph poles and a water tower,
 * and now and then the Blender 4-4-0 with its tender and four cars running through: wheels turning
 * by the distance covered, side rods, main rods and crossheads driven kinematically, wood smoke
 * chuffing from the stack in time with the drivers, steam from the cocks and the whistle, dust
 * thrown up along the ballast, a slight ride vibration, and the headlight and coach windows lit at
 * dusk.
 */
export const frontierRail: ComponentFactory<Params> = {
  type: 'frontierRail',
  version: 1,
  description: 'Railway line with poles and a water tower; a steam train runs through with turning wheels, rods, smoke, steam, dust and a headlight.',
  schema,
  async create(ctx: EnvironmentContext, p) {
    const s = frontier(ctx);
    s.shadowBoxes.push([...p.shadowBox]);
    const gltf = await ctx.assets.loadGLTF(p.src);
    const presence = floatUniform(1);
    const rand = seeded(p.seed * 4253);
    const reduced = ctx.quality.reducedMotion;
    const line = buildSpline(p.track as [number, number][], (x, zz) => ctx.ground.height(x, zz), p.railTop);
    const group = new Group();
    const pos = new Vector3();
    const tan = new Vector3();
    const up = new Vector3(0, 1, 0);

    // ---- Track: ballast, ties and rails along the visible part ----
    const step = 0.62;
    const tieCount = Math.floor(line.length / step);
    const tieGeo = new BoxGeometry(2.5, 0.16, 0.22);
    const tieMat = new FrontierMaterial();
    const grain = mx_noise_float(positionWorld.mul(vec3(0.6, 3, 0.6)))
      .mul(0.5)
      .add(0.5);
    tieMat.colorNode = vec3(0.23, 0.17, 0.12).mul(grain.mul(0.5).add(0.7));
    tieMat.roughness = 0.95;
    tieMat.lightsNode = s.lightsNode;
    tieMat.fog = false;
    tieMat.outputNode = vec4(haze(s, output.rgb as unknown as V3).mul(presence), 1);
    const ties = new InstancedMesh(tieGeo, tieMat, tieCount);
    const m4 = new Matrix4();
    const q = new Quaternion();
    for (let i = 0; i < tieCount; i++) {
      line.at(i * step, pos, tan);
      q.setFromUnitVectors(new Vector3(0, 0, 1), tan);
      q.multiply(new Quaternion().setFromAxisAngle(up, (rand() - 0.5) * 0.05));
      m4.compose(new Vector3(pos.x, pos.y - 0.24, pos.z), q, new Vector3(1, 1, 1));
      ties.setMatrixAt(i, m4);
    }
    ties.instanceMatrix.needsUpdate = true;
    ties.frustumCulled = false;
    ties.receiveShadow = true;
    group.add(ties);
    // Rails and ballast as ribbons along the line.
    const ribbon = (offsets: [number, number][], segLen: number): BufferGeometry => {
      const n = Math.floor(line.length / segLen) + 1;
      const verts: number[] = [];
      const idx: number[] = [];
      const side = new Vector3();
      for (let i = 0; i < n; i++) {
        line.at(i * segLen, pos, tan);
        side.crossVectors(tan, up).normalize();
        for (const [dx, dy] of offsets) verts.push(pos.x + side.x * dx, pos.y + dy, pos.z + side.z * dx);
        if (i > 0) {
          const k = offsets.length;
          for (let j = 0; j < k - 1; j++) {
            const a = (i - 1) * k + j;
            const b = a + 1;
            const c = i * k + j + 1;
            const d = i * k + j;
            idx.push(a, d, b, b, d, c);
          }
        }
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    };
    const railMat = new FrontierMaterial();
    railMat.color = new Color(0.16, 0.12, 0.1);
    railMat.metalness = 0.3;
    railMat.roughness = 0.7;
    railMat.lightsNode = s.lightsNode;
    railMat.fog = false;
    railMat.outputNode = vec4(haze(s, output.rgb as unknown as V3).mul(presence), 1);
    const gauge = 1.435 / 2 + 0.035;
    const railProfile = (c: number): [number, number][] => [
      [c - 0.04, -0.16],
      [c - 0.035, 0],
      [c + 0.035, 0],
      [c + 0.04, -0.16],
    ];
    const rails = [new Mesh(ribbon(railProfile(-gauge), 1.0), railMat), new Mesh(ribbon(railProfile(gauge), 1.0), railMat)];
    const ballastMat = new FrontierMaterial();
    const pebbly = mx_noise_float(positionWorld.mul(5)).mul(0.5).add(0.5);
    ballastMat.colorNode = vec3(0.36, 0.3, 0.26).mul(pebbly.mul(0.4).add(0.75));
    ballastMat.roughness = 1;
    ballastMat.lightsNode = s.lightsNode;
    ballastMat.fog = false;
    ballastMat.outputNode = vec4(haze(s, output.rgb as unknown as V3).mul(presence), 1);
    const ballast = new Mesh(
      ribbon(
        [
          [-2.6, -0.75],
          [-1.55, -0.28],
          [1.55, -0.28],
          [2.6, -0.75],
        ],
        2,
      ),
      ballastMat,
    );
    for (const m of [...rails, ballast]) {
      m.frustumCulled = false;
      m.receiveShadow = true;
      group.add(m);
    }

    // ---- Converted train materials ----
    const converted = new Map<Material, Material>();
    const lampsU = s.u.lamps;
    const headlight = vec3(1.0, 0.8, 0.5).mul(lampsU.mul(14).add(0.0)) as V3;
    const windowGlow = vec3(...LAMP_COLOR)
      .mul(lampsU.mul(1.6))
      .mul(
        smoothstep(0.02, 0.25, uv().x)
          .mul(smoothstep(0.98, 0.75, uv().x))
          .mul(0.6)
          .add(0.4),
      ) as V3;
    const convert = (m: Material): Material => {
      const c = converted.get(m);
      if (c) return c;
      const n = m.name || '';
      const out = /^lampGlow/i.test(n)
        ? litMaterial(s, m, { vertexAO: false, presence, emissive: headlight })
        : /^glass/i.test(n)
          ? litMaterial(s, m, {
              vertexAO: true,
              presence,
              emissive: windowGlow,
            })
          : litMaterial(s, m, { vertexAO: true, presence });
      converted.set(m, out);
      return out;
    };
    const prepare = (node: Object3D): Object3D => {
      const o = node.clone(true);
      o.traverse((x) => {
        if (x instanceof Mesh) {
          x.material = Array.isArray(x.material) ? x.material.map(convert) : convert(x.material);
          x.frustumCulled = false;
        }
      });
      castWorldShadows(o, true);
      return o;
    };
    const byName = (name: string): Object3D | undefined => gltf.scene.children.find((c) => c.name === name);
    const find = (root: Object3D, name: string): Object3D | undefined => {
      let out: Object3D | undefined;
      root.traverse((o) => {
        if (!out && o.name === name) out = o;
      });
      return out;
    };

    // ---- Telegraph poles and the water tower ----
    const poleSrc = byName('telegraph_pole');
    const wirePts: number[] = [];
    if (poleSrc) {
      const side = new Vector3();
      let prev: Vector3[] | null = null;
      for (let d = p.poles.from; d < Math.min(line.length, p.poles.to); d += p.poles.spacing) {
        line.at(d, pos, tan);
        side.crossVectors(tan, up).normalize();
        const base = pos.clone().addScaledVector(side, p.poles.offset);
        base.y = ctx.ground.height(base.x, base.z);
        const pole = prepare(poleSrc);
        pole.position.copy(base);
        pole.quaternion.setFromUnitVectors(new Vector3(0, 0, -1), tan);
        pole.rotateY((rand() - 0.5) * 0.06);
        pole.rotateX((rand() - 0.5) * 0.03);
        group.add(pole);
        // Four wires at the insulators (7.345 m up, ±0.35 and ±0.85 m along the crossarm).
        const tips = [-0.85, -0.35, 0.35, 0.85].map((x) =>
          base
            .clone()
            .addScaledVector(side, x)
            .add(new Vector3(0, 7.32, 0)),
        );
        if (prev) {
          for (let w = 0; w < 4; w++) {
            const a = prev[w]!;
            const b = tips[w]!;
            const segs = 8;
            for (let k = 0; k < segs; k++) {
              const t0 = k / segs;
              const t1 = (k + 1) / segs;
              const sag = (t: number) => 4 * t * (1 - t) * 0.55;
              const pa = a.clone().lerp(b, t0);
              pa.y -= sag(t0);
              const pb = a.clone().lerp(b, t1);
              pb.y -= sag(t1);
              wirePts.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
            }
          }
        }
        prev = tips;
      }
    }
    const wireGeo = new BufferGeometry();
    wireGeo.setAttribute('position', new BufferAttribute(new Float32Array(wirePts), 3));
    const wireMat = new LineBasicNodeMaterial();
    wireMat.colorNode = vec4(haze(s, vec3(0.05, 0.045, 0.04).add(s.u.skyColor.mul(0.04)) as V3).mul(presence), 1);
    wireMat.transparent = true;
    wireMat.opacity = 0.22;
    wireMat.fog = false;
    const wires = new LineSegments(wireGeo, wireMat);
    wires.frustumCulled = false;
    group.add(wires);
    const towerSrc = byName('water_tower');
    if (towerSrc) {
      line.at(p.tower.at, pos, tan);
      const side = new Vector3().crossVectors(tan, up).normalize();
      const tower = prepare(towerSrc);
      // Its spout faces +X locally; the track runs at local x ≈ +4.6.
      const base = pos.clone().addScaledVector(side, p.tower.offset);
      base.y = ctx.ground.height(base.x, base.z);
      tower.position.copy(base);
      const toTrack = pos.clone().sub(base).setY(0).normalize();
      tower.quaternion.setFromUnitVectors(new Vector3(1, 0, 0), toTrack);
      group.add(tower);
    }

    // ---- The train ----
    const lengths: Record<string, number> = {
      loco: 8.97,
      tender: 7.5,
      car_box: 9.4,
      car_stock: 9.4,
      car_coach: 15.6,
      car_caboose: 8.4,
    };
    const order = ['loco', 'tender', ...p.cars];
    const vehicles: Vehicle[] = [];
    let off = 0;
    const train = new Group();
    for (const name of order) {
      const src = byName(name);
      if (!src) continue;
      const root = prepare(src);
      const L = lengths[name] ?? 9;
      const wheels: { o: Object3D; r: number }[] = [];
      root.traverse((o) => {
        if (/_(drive|truck)_\d$|_wheel_\d$/.test(o.name))
          wheels.push({
            o,
            r: /drive/.test(o.name) ? 0.8 : /truck/.test(o.name) ? 0.38 : 0.42,
          });
      });
      vehicles.push({ name, root, length: L, wheels, offset: off + L / 2 });
      off += L;
      train.add(root);
    }
    const trainLength = off;
    const loco = vehicles.find((v) => v.name === 'loco');
    const rest = (o: Object3D | undefined) => (o ? { o, p: o.position.clone(), q: o.quaternion.clone() } : null);
    const rods = loco
      ? {
          sideL: rest(find(loco.root, 'loco_siderod_L')),
          sideR: rest(find(loco.root, 'loco_siderod_R')),
          mainL: rest(find(loco.root, 'loco_mainrod_L')),
          mainR: rest(find(loco.root, 'loco_mainrod_R')),
          crossL: rest(find(loco.root, 'loco_crosshead_L')),
          crossR: rest(find(loco.root, 'loco_crosshead_R')),
        }
      : null;
    train.visible = false;
    group.add(train);

    // Headlight glow (additive, steady: never flashes).
    const glowMat = new SpriteNodeMaterial();
    const gShape = smoothstep(1, 0, uv().sub(0.5).mul(2).length()).pow(2.5);
    glowMat.colorNode = vec4(additiveFog(vec3(1.0, 0.78, 0.5).mul(gShape.mul(lampsU.mul(0.9).add(0.04)).mul(presence))), 1);
    glowMat.transparent = true;
    glowMat.depthWrite = false;
    glowMat.blending = AdditiveBlending;
    glowMat.fog = false;
    noBloom(glowMat);
    const glow = new Sprite(glowMat);
    glow.scale.setScalar(2.4);
    glow.renderOrder = 4;
    if (loco) {
      loco.root.add(glow);
      glow.position.set(0, 3.45, -4.15);
    }

    // Smoke, steam and dust.
    const puffs = new PuffSystem(ctx, s, ctx.quality.detail === 'low' ? 1500 : 4000, presence, { renderOrder: 3 });
    group.add(puffs.object);
    const density = Math.min(1.5, Math.max(0.3, ctx.quality.particles)) * (reduced ? 0.6 : 1);

    // Schedule.
    let clock = 0;
    let next = p.first;
    let running = false;
    let dir = 1;
    let head = 0;
    let travelled = 0;
    let chuffAcc = 0;
    let whistleAt = -1e9;
    const start = () => {
      running = true;
      train.visible = true;
      head = dir > 0 ? p.run[0] : p.run[1];
      travelled = 0;
      whistleAt = clock + 2.5 + rand() * 3;
    };
    const tmpP = new Vector3();
    const tmpT = new Vector3();
    const worldPos = new Vector3();
    const place = (v: Vehicle, t: number) => {
      // Centre of the vehicle `offset` metres behind the head, in the direction of travel.
      const sc = head - dir * v.offset;
      line.at(sc - 2.2, tmpP, tmpT);
      const back = tmpP.clone();
      line.at(sc + 2.2, tmpP, tmpT);
      const front = tmpP.clone();
      const fwd = dir > 0 ? front.clone().sub(back).normalize() : back.clone().sub(front).normalize();
      v.root.position.copy(front).add(back).multiplyScalar(0.5);
      v.root.quaternion.setFromUnitVectors(new Vector3(0, 0, -1), fwd);
      // Ride vibration: a fine, irregular shake and a slow sway, tiny but alive.
      if (!reduced) {
        const k = v.offset * 1.7;
        v.root.position.y += Math.sin(t * 23 + k) * 0.004 + Math.sin(t * 37.3 + k * 2) * 0.003;
        v.root.rotateZ(Math.sin(t * 1.3 + k) * 0.0022);
      }
    };

    return {
      object: group,
      update(frame) {
        tickFrontier(s, frame);
        const dt = Math.min(0.1, frame.dt);
        clock += dt;
        if (!running) {
          if (clock >= next) start();
          puffs.flush();
          return;
        }
        const v = p.speed;
        head += dir * v * dt;
        travelled += v * dt;
        const done = dir > 0 ? head - trainLength > p.run[1] : head + trainLength < p.run[0];
        if (done) {
          running = false;
          train.visible = false;
          dir = -dir;
          next = clock + p.every * (0.6 + rand() * 0.8);
          puffs.flush();
          return;
        }
        for (const veh of vehicles) {
          place(veh, clock);
          for (const w of veh.wheels) w.o.rotation.x = -travelled / w.r;
        }
        // Rods (both sides in phase; the drivers' crank pins at front dead centre at rest).
        if (rods) {
          const r = 0.305;
          const theta = -travelled / 0.8;
          const pinY = Math.cos(theta) * r;
          const pinZ = Math.sin(theta) * r;
          const L = 3.955;
          const h = 0.8;
          const bigY = -2.365 + pinY;
          const bigZ = 0.8 + pinZ;
          const yx = bigY + Math.sqrt(L * L - (bigZ - h) * (bigZ - h));
          const ang = Math.atan2(h - bigZ, yx - bigY);
          for (const sd of [rods.sideL, rods.sideR]) if (sd) sd.o.position.set(sd.p.x, sd.p.y + pinZ, sd.p.z - (pinY - r));
          for (const mn of [rods.mainL, rods.mainR]) {
            if (!mn) continue;
            mn.o.position.set(mn.p.x, mn.p.y + pinZ, mn.p.z - (pinY - r));
            mn.o.quaternion.copy(mn.q);
            mn.o.rotateX(ang);
          }
          for (const ch of [rods.crossL, rods.crossR]) if (ch) ch.o.position.set(ch.p.x, ch.p.y, ch.p.z - (yx - 1.895));
        }
        // Smoke: four exhaust beats per driver revolution.
        if (loco) {
          loco.root.updateMatrixWorld(true);
          chuffAcc += ((v * dt) / (2 * Math.PI * 0.8)) * 4;
          const fwd = new Vector3(0, 0, -1).applyQuaternion(loco.root.quaternion);
          while (chuffAcc >= 1) {
            chuffAcc -= 1;
            const n = Math.max(1, Math.round(2 * density));
            for (let i = 0; i < n; i++) {
              worldPos.set(0, 4.7, -2.635).applyMatrix4(loco.root.matrixWorld);
              const grey = 0.26 + rand() * 0.12;
              puffs.emit(
                {
                  x: worldPos.x + (rand() - 0.5) * 0.2,
                  y: worldPos.y,
                  z: worldPos.z + (rand() - 0.5) * 0.2,
                  vx: fwd.x * v * 0.55 + (rand() - 0.5) * 0.8,
                  vy: 4.5 + rand() * 2.5,
                  vz: fwd.z * v * 0.55 + (rand() - 0.5) * 0.8,
                  life: 7 + rand() * 4,
                  size0: 0.9,
                  size1: 7 + rand() * 4,
                  opacity: 0.42,
                  r: grey * 1.05,
                  g: grey,
                  b: grey * 0.94,
                  rise: 0.25,
                  drag: 1.2,
                  windy: 1,
                },
                frame.time,
              );
            }
          }
          // The whistle: a white plume for a couple of seconds after the train comes into view.
          const tw = clock - whistleAt;
          if (tw > 0 && tw < 2.2 && rand() < 0.6 * density) {
            worldPos.set(0, 4.25, 0.325).applyMatrix4(loco.root.matrixWorld);
            puffs.emit(
              {
                x: worldPos.x,
                y: worldPos.y,
                z: worldPos.z,
                vx: fwd.x * v * 0.4,
                vy: 2.8 + rand(),
                vz: fwd.z * v * 0.4,
                life: 2.4,
                size0: 0.3,
                size1: 3.2,
                opacity: 0.55,
                r: 0.86,
                g: 0.86,
                b: 0.86,
                rise: 0.6,
                drag: 1.5,
                windy: 1,
              },
              frame.time,
            );
          }
          // Steam leaking from the cylinder cocks, low and sideways.
          if (rand() < 0.35 * density) {
            const sx = rand() < 0.5 ? -1.03 : 1.03;
            worldPos.set(sx, 0.41, -2.6).applyMatrix4(loco.root.matrixWorld);
            const side = new Vector3(sx, 0, 0).applyQuaternion(loco.root.quaternion).normalize();
            puffs.emit(
              {
                x: worldPos.x,
                y: worldPos.y,
                z: worldPos.z,
                vx: side.x * 2.5 + fwd.x * v * 0.3,
                vy: 0.4,
                vz: side.z * 2.5 + fwd.z * v * 0.3,
                life: 1.6,
                size0: 0.3,
                size1: 2.0,
                opacity: 0.4,
                r: 0.85,
                g: 0.85,
                b: 0.84,
                rise: 0.4,
                drag: 2,
                windy: 0.6,
              },
              frame.time,
            );
          }
        }
        // Dust kicked up along the ballast by the train.
        if (rand() < 0.9 * density) {
          const veh = vehicles[Math.floor(rand() * vehicles.length)]!;
          worldPos.set((rand() - 0.5) * 3.2, -0.1, (rand() - 0.5) * veh.length).applyMatrix4(veh.root.matrixWorld);
          puffs.emit(
            {
              x: worldPos.x,
              y: worldPos.y,
              z: worldPos.z,
              vx: (rand() - 0.5) * 1.5,
              vy: 0.3 + rand() * 0.5,
              vz: (rand() - 0.5) * 1.5,
              life: 3 + rand() * 2,
              size0: 0.8,
              size1: 3.5,
              opacity: 0.16,
              r: 0.62,
              g: 0.48,
              b: 0.34,
              rise: 0.05,
              drag: 1.2,
              windy: 0.8,
            },
            frame.time,
          );
        }
        puffs.flush();
      },
      onGameEvent(e: StageGameEvent) {
        // A big clear brings the next train sooner.
        if (e.kind === 'clear' && e.lines >= 4 && !running) next = Math.min(next, clock + 3);
      },
      setPresence(val) {
        presence.value = val;
      },
      dispose() {
        for (const m of converted.values()) m.dispose();
        for (const m of [tieMat, railMat, ballastMat, wireMat, glowMat]) m.dispose();
        tieGeo.dispose();
        wireGeo.dispose();
        for (const m of [...rails, ballast]) m.geometry.dispose();
        ties.dispose();
        puffs.dispose();
        ctx.assets.release(p.src);
        releaseFrontier(ctx, s);
      },
    };
  },
};
