import { Euler, Group, InstancedMesh, Matrix4, Quaternion, Vector3, type BufferGeometry, type MeshStandardNodeMaterial } from 'three/webgpu';
import { floatUniform, linear, seeded, z, type ComponentFactory } from '@prismfall/sdk';
import { smokePool } from './atmosphere';
import { bakeKit, loadSceneryTextures, sceneryMaterials, type Kit } from './scenery';
import { GROUND_Y, backdropTexture, claimLight, envTexture, hum, release, setLight, world, zHaze, type F } from './shared';

const schema = z.object({
  src: z.string().default('models/factory.glb'),
  /** Where the hall stands (x, z on the yard) and its heading in degrees (0: open front faces +Z). */
  at: z.tuple([z.number(), z.number()]),
  yaw: z.number().default(0),
  /** Robot arms along the line: x along the hall and side of the conveyor (+1 / -1). */
  arms: z.array(z.tuple([z.number(), z.number()])).default([[-30, 1], [-18, -1], [-6, 1], [6, -1], [18, 1], [30, -1]]),
  /** Interior light (local light) strength. */
  interior: z.number().min(0).default(2600),
  /** Puffs per second from each chimney. */
  smoke: z.number().min(0).default(2.0),
  haze: zHaze,
  seed: z.number().default(41),
});

type Params = z.infer<typeof schema>;

/** Instanced parts of one kit object (one InstancedMesh per material). */
function instanced(kit: Kit, name: string, mats: Record<string, MeshStandardNodeMaterial>, count: number, group: Group): InstancedMesh[] {
  const parts = kit.get(name);
  if (!parts) {
    console.warn(`[red-horizon] factory: no object ${name}`);
    return [];
  }
  return parts.map((part) => {
    const im = new InstancedMesh(part.geometry as BufferGeometry, mats[part.material] ?? mats.rhSteel!, count);
    im.frustumCulled = false;
    group.add(im);
    return im;
  });
}

function setAll(meshes: InstancedMesh[], i: number, m: Matrix4): void {
  for (const im of meshes) im.setMatrixAt(i, m);
}

function flagAll(meshes: InstancedMesh[]): void {
  for (const im of meshes) im.instanceMatrix.needsUpdate = true;
}

interface Arm {
  x: number;
  side: number;
  phase: number;
  period: number;
  yaw: number;
  shoulder: number;
  elbow: number;
  wrist: number;
  welding: number;
}

/**
 * The machine factory: an assembly hall seen through its open front (Blender kit, photographed PBR
 * materials), lit warm inside, with chimneys trailing smoke and red aviation lamps. Six welding arms
 * along the conveyor work on the frames riding the line (the sentinel layer's assembly units):
 * each turns to the line, reaches in, welds with spark showers and a flickering light, and pulls
 * back, on its own cycle. An overhead gantry crane shuttles a frame along the hall; wall fans turn.
 */
export const factoryComponent: ComponentFactory<Params> = {
  type: 'redHorizonFactory',
  version: 1,
  description: 'Assembly hall with welding arms, gantry crane, fans, chimneys and interior light.',
  schema,
  async create(ctx, p) {
    const w = world(ctx);
    const [gltf, tex, env, backdrop] = await Promise.all([ctx.assets.loadGLTF(p.src), loadSceneryTextures(w), envTexture(w), backdropTexture(w)]);
    const kit = bakeKit(gltf.scene);
    const presence = floatUniform(1);
    const mats = sceneryMaterials(w, tex, env, backdrop, p.haze, presence as unknown as F, ctx.uniforms.time as unknown as F, { soot: 0.8 });
    const group = new Group();
    const yaw = (p.yaw * Math.PI) / 180;
    const base = new Matrix4().compose(new Vector3(p.at[0], GROUND_Y, p.at[1]), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw), new Vector3(1, 1, 1));
    // Static parts.
    for (const name of ['factory_hall', 'factory_chimneys']) {
      const meshes = instanced(kit, name, mats, 1, group);
      setAll(meshes, 0, base);
      flagAll(meshes);
    }
    const fanAt = [-33, -11, 11, 33].map((x) => new Vector3(x, 15.5, -20.4));
    const housings = instanced(kit, 'factory_fan_housing', mats, fanAt.length, group);
    const rotors = instanced(kit, 'factory_fan_rotor', mats, fanAt.length, group);
    const m = new Matrix4();
    const m2 = new Matrix4();
    const q = new Quaternion();
    const e = new Euler();
    const v = new Vector3();
    const one = new Vector3(1, 1, 1);
    fanAt.forEach((f, i) => {
      m.compose(f, q.identity(), one).premultiply(base);
      setAll(housings, i, m);
    });
    flagAll(housings);
    // Arms.
    const links = ['arm_base', 'arm_turret', 'arm_upper', 'arm_fore', 'arm_wrist'].map((n) => instanced(kit, n, mats, p.arms.length, group));
    const rand = seeded(p.seed * 97 + 1);
    const arms: Arm[] = p.arms.map(([x, side]) => ({ x, side, phase: rand(), period: 9 + rand() * 6, yaw: 0, shoulder: 0, elbow: 0, wrist: 0, welding: 0 }));
    const crane = ['crane_bridge', 'crane_trolley', 'crane_hook'].map((n) => instanced(kit, n, mats, 1, group));
    const interior = claimLight(w);
    const weldLight = claimLight(w);
    const chimneys = [new Vector3(-30, 64, -35), new Vector3(-12, 56, -37), new Vector3(22, 70, -33)];
    let smokeCarry = 0;
    const reduced = ctx.quality.reducedMotion;
    const spark = linear('#ffc890');
    const tip = new Vector3();
    const tmp = new Vector3();
    let craneX = -30;
    let craneDir = 1;
    let craneWait = 0;
    let trolley = 0;
    let hook = 8;

    // Interior: a warm light at the middle of the hall (fixed), the weld light flickers.
    v.set(0, 12, -4).applyMatrix4(base);
    setLight(w, interior, v.x, v.y, v.z, p.interior, 1, 0.62, 0.32, 90);

    return {
      object: group,
      update(frame) {
        const dt = Math.min(0.1, frame.dt) * (reduced ? 0.6 : 1);
        const t = frame.time;
        // ---- Fans.
        fanAt.forEach((f, i) => {
          e.set(0, 0, t * (1.1 + i * 0.17) * (i % 2 ? 1 : -1));
          m.compose(f, q.setFromEuler(e), one).premultiply(base);
          setAll(rotors, i, m);
        });
        flagAll(rotors);
        // ---- Arms: approach, weld, retract, rest.
        let weldBest = 0;
        arms.forEach((a, i) => {
          const c = (((t / a.period + a.phase) % 1) + 1) % 1;
          // 0-0.25 reach in, 0.25-0.6 weld, 0.6-0.8 retract, 0.8-1 rest.
          const reach = c < 0.25 ? smooth(c / 0.25) : c < 0.6 ? 1 : c < 0.8 ? 1 - smooth((c - 0.6) / 0.2) : 0;
          const weld = c > 0.27 && c < 0.58 ? 1 : 0;
          a.welding = weld;
          const sway = weld ? Math.sin(t * 2.3 + i) * 0.06 : 0;
          a.yaw = a.side > 0 ? Math.PI + (0.35 - reach * 0.35) * (i % 2 ? 1 : -1) + sway : (0.35 - reach * 0.35) * (i % 2 ? -1 : 1) + sway;
          a.shoulder = 0.15 + reach * 0.35;
          a.elbow = 1.0 + reach * 0.6 + Math.sin(t * 1.7 + i) * 0.04 * weld;
          a.wrist = 0.4 + 0.5 * reach + Math.sin(t * 5 + i * 2) * 0.08 * weld;
          // Chain the link matrices (game axes: y up; the shoulder and elbow pitch about local x).
          const bx = a.x;
          const bz = a.side * 5.2;
          m.compose(v.set(bx, 0.6, bz), q.identity(), one).premultiply(base);
          setAll(links[0]!, i, m);
          e.set(0, a.yaw, 0);
          m2.compose(v.set(0, 1.8, 0), q.setFromEuler(e), one);
          m.multiply(m2);
          setAll(links[1]!, i, m);
          e.set(a.shoulder, 0, 0);
          m2.compose(v.set(0, 1.5, 0), q.setFromEuler(e), one);
          m.multiply(m2);
          setAll(links[2]!, i, m);
          e.set(a.elbow, 0, 0);
          m2.compose(v.set(0, 4.2, 0), q.setFromEuler(e), one);
          m.multiply(m2);
          setAll(links[3]!, i, m);
          e.set(a.wrist, 0, 0);
          m2.compose(v.set(0, 3.4, 0), q.setFromEuler(e), one);
          m.multiply(m2);
          setAll(links[4]!, i, m);
          if (weld) {
            tip.set(0, 1.55, 0).applyMatrix4(m);
            const flick = 0.5 + 0.5 * Math.sin(t * 37 + i * 5) * Math.sin(t * 23 + i);
            if (flick > weldBest) {
              weldBest = flick;
              tmp.copy(tip);
            }
            if (!reduced && rand() < dt * 9) {
              const n = ctx.bursts.budget(6);
              for (let k = 0; k < n; k++) {
                const ang = rand() * Math.PI * 2;
                const sp = 2 + rand() * 4;
                const hot = 1 + rand() * 2;
                ctx.bursts.emit({ x: tip.x, y: tip.y, z: tip.z, vx: Math.cos(ang) * sp, vy: rand() * 3, vz: Math.sin(ang) * sp, r: spark.x * hot, g: spark.y * hot, b: spark.z * hot, size: 0.08 + rand() * 0.1, life: 0.4 + rand() * 0.6, gravity: -9.8, drag: 0.5, shape: 'spark', swirl: 0 }, t);
              }
            }
          }
        });
        for (const l of links) flagAll(l);
        // Weld light: a hard white-blue flicker at the busiest torch (soft with flash reduction).
        const soft = ctx.uniforms.flashLimit.value < 0.99 ? 0.35 : 1;
        if (weldBest > 0) setLight(w, weldLight, tmp.x, tmp.y + 0.5, tmp.z, 900 * weldBest * soft, 0.75, 0.85, 1, 40);
        else setLight(w, weldLight, 0, -1000, 0, 0, 0, 0, 0, 1);
        // ---- Crane: shuttles along the hall, pauses, the trolley and hook work.
        if (craneWait > 0) {
          craneWait -= dt;
          hook = 8 + Math.sin(Math.min(1, craneWait / 3) * Math.PI) * 4;
        } else {
          craneX += craneDir * dt * 1.6;
          if (craneX > 34 || craneX < -34) {
            craneDir = -craneDir;
            craneWait = 5 + rand() * 4;
          }
        }
        trolley = Math.sin(t * 0.07) * 9;
        m.compose(v.set(craneX, 19.2, 0), q.identity(), one).premultiply(base);
        setAll(crane[0]!, 0, m);
        m2.compose(v.set(0, 0, trolley), q.identity(), one);
        m.multiply(m2);
        setAll(crane[1]!, 0, m);
        m2.compose(v.set(0, -hook, 0), q.identity(), one);
        m.multiply(m2);
        setAll(crane[2]!, 0, m);
        for (const c of crane) flagAll(c);
        // ---- The plant's low hum, a little brighter while the torches work.
        hum(ctx, 'red-horizon-factory', p.at[0], p.at[1], 0.22, 46, 0.25 + weldBest * 0.15);
        // ---- Chimney smoke.
        const pool = smokePool(w);
        smokeCarry += dt * p.smoke * chimneys.length;
        while (pool && smokeCarry >= 1) {
          smokeCarry -= 1;
          const ch = chimneys[Math.floor(rand() * chimneys.length)]!;
          tmp.copy(ch).applyMatrix4(base);
          pool.emit({ x: tmp.x + (rand() - 0.5) * 2, y: tmp.y, z: tmp.z + (rand() - 0.5) * 2, vx: (rand() - 0.5) * 0.5, vy: 3 + rand() * 2, vz: (rand() - 0.5) * 0.5, size0: 3, size1: 15, life: 24 + rand() * 10, heat: 0.2, dark: 0.55 + rand() * 0.3 }, t);
        }
      },
      setPresence(val) {
        presence.value = val;
      },
      dispose() {
        for (const parts of kit.values()) for (const part of parts) part.geometry.dispose();
        for (const mm of Object.values(mats)) mm.dispose();
        setLight(w, interior, 0, -1000, 0, 0, 0, 0, 0, 1);
        setLight(w, weldLight, 0, -1000, 0, 0, 0, 0, 0, 1);
        ctx.assets.release(p.src);
        release(w);
      },
    };
  },
};

function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}
