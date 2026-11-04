import { DynamicDrawUsage, Group, InstancedBufferAttribute, Matrix4, Mesh, Quaternion, Vector3, Euler } from 'three/webgpu';
import { instancedBufferAttribute } from 'three/tsl';
import { floatUniform, linear, seeded, z, zColor, type ComponentFactory } from '@prismfall/sdk';
import { smokePool } from './atmosphere';
import { SENTINEL_LOOK, machineMaterial } from './metal';
import { BeamSet, GlintSet } from './optics';
import { BoneTexture, RigSolver, mergeRigged, parseRig, skinNode, slotCount, twoBone } from './rig';
import { SensorController } from './sensor';
import { GROUND_Y, VIEWER, backdropTexture, envTexture, hum, release, stageTexture, world, zHaze, type F } from './shared';

const schema = z.object({
  walkers: z
    .array(
      z.object({
        /** Closed elliptical circuit: centre (x, z), radii, start fraction, direction. */
        center: z.tuple([z.number(), z.number()]),
        radius: z.tuple([z.number().positive(), z.number().positive()]),
        start: z.number().min(0).max(1).default(0),
        clockwise: z.boolean().default(false),
        speed: z.number().positive().default(1.5),
        scale: z.number().positive().default(1),
        /** Gait cycle (seconds per step of each leg). */
        cycle: z.number().positive().default(9),
      }),
    )
    .min(1),
  lens: zColor.default('#ff1c0c'),
  beam: zColor.default('#ff3018'),
  /** Strength of the gondola's red search beam in the haze (0 = none). */
  beamStrength: z.number().min(0).default(1),
  footsteps: z.boolean().default(true),
  haze: zHaze,
  seed: z.number().default(29),
});

type Params = z.infer<typeof schema>;

/** Wave gait: rear to front on the left, then on the right (legs 4, 2, 0, 5, 3, 1). */
const PHASE = [2 / 6, 5 / 6, 1 / 6, 4 / 6, 0, 3 / 6];
const DUTY = 0.76;
const STACKS = [new Vector3(2.4, 41.4, 9.5), new Vector3(-2.4, 42.9, 9.5), new Vector3(0, 39.4, 4.0)];
const LENS = new Vector3(0, 22.6, -20.04);

interface Walker {
  cfg: Params['walkers'][number];
  slot: number;
  theta: number;
  pos: Vector3;
  heading: number;
  phase: number;
  bob: number;
  bobV: number;
  roll: number;
  sensor: SensorController;
  solver: RigSolver;
  lastPhase: number[];
  puff: number;
}

/**
 * Colossi: hexapod walking refineries (Blender kit) striding slowly around the far ruins on
 * elliptical circuits. A wave gait (one leg in the air at a time, rear to front, left then right)
 * with stride from the measured speed keeps five feet planted; each leg is solved per frame by
 * turning its hip turret towards the foot target and two-bone IK in the leg's vertical plane with
 * the knee up; the pad stays level; hydraulic rams track the knees. The hull dips and settles after
 * each footfall and rolls slightly away from the lifted leg. Footfalls raise dust and a deep metal
 * impact; the stacks trail smoke; the gondola's optical sensor scans the ground ahead with a faint
 * red beam in the haze.
 */
export const colossusComponent: ComponentFactory<Params> = {
  type: 'redHorizonColossus',
  version: 1,
  description: 'Hexapod walking refineries on slow circuits behind the ruins, with planted-foot wave gait and a scanning gondola.',
  schema,
  async create(ctx, p) {
    const w = world(ctx);
    const rig = parseRig(ctx.assets.json('models/colossus.rig.json'));
    if (!rig) throw new Error('colossus rig missing');
    const [gltf, env, backdrop, aAlb, aNr, sAlb, sNr] = await Promise.all([
      ctx.assets.loadGLTF('models/colossus.glb'),
      envTexture(w),
      backdropTexture(w),
      stageTexture(w, 'textures/armour_albedo.webp'),
      stageTexture(w, 'textures/armour_nr.webp', false),
      stageTexture(w, 'textures/steel_albedo.webp'),
      stageTexture(w, 'textures/steel_nr.webp', false),
    ]);
    const rand = seeded(p.seed * 1291 + 3);
    const bone = (n: string) => rig.bones.find((b) => b.name === n)!;
    const legs = [0, 1, 2, 3, 4, 5].map((i) => {
      const coxa = bone(`coxa${i}`);
      const femur = bone(`femur${i}`);
      const tibia = bone(`tibia${i}`);
      const foot = bone(`foot${i}`);
      const s = Math.sign(coxa.pivot[0]);
      const c = new Vector3(...coxa.pivot);
      const f = new Vector3(...femur.pivot);
      const k = new Vector3(...tibia.pivot);
      const a = new Vector3(...foot.pivot);
      const L1 = Math.hypot(k.x - f.x, k.y - f.y);
      const L2 = Math.hypot(a.x - k.x, a.y - k.y);
      const femur0 = Math.atan2(k.y - f.y, Math.abs(k.x - f.x));
      const tibia0 = Math.atan2(a.y - k.y, Math.abs(a.x - k.x));
      return { i, s, coxa: coxa.id, femur: femur.id, tibia: tibia.id, foot: foot.id, c, f, a, L1, L2, femur0, tibia0 };
    });
    const hull = bone('hull').id;
    const gondola = bone('gondola').id;
    const sensorBone = bone('sensor').id;
    const walkers: Walker[] = p.walkers.map((cfg, slot) => ({
      cfg,
      slot,
      theta: cfg.start * Math.PI * 2,
      pos: new Vector3(),
      heading: 0,
      phase: rand(),
      bob: 0,
      bobV: 0,
      roll: 0,
      sensor: new SensorController({ seed: Math.floor(rand() * 1e6), yaw: [-0.9, 0.9], pitch: [-0.5, -0.12], restPitch: -0.3, scanSpeed: 0.09, pause: [1.5, 4], focusChance: 0.4, turnChance: 0.1, hearing: 1500 }),
      solver: new RigSolver(rig),
      lastPhase: [0, 0, 0, 0, 0, 0],
      puff: rand(),
    }));
    const tex = new BoneTexture(walkers.length, slotCount(rig));
    const optic = new InstancedBufferAttribute(new Float32Array(walkers.length * 4), 4);
    optic.setUsage(DynamicDrawUsage);
    const seedAttr = new InstancedBufferAttribute(new Float32Array(walkers.length), 1);
    walkers.forEach((wk) => seedAttr.setX(wk.slot, rand() * 100));
    const geometry = mergeRigged(gltf.scene, rig);
    const skin = skinNode(tex, 'Colossus');
    const presence = floatUniform(1);
    const material = machineMaterial(
      w,
      { position: skin.position, normal: skin.normal, rest: skin.rest, tag: skin.tag as unknown as { x: F; y: F } },
      optic,
      instancedBufferAttribute<'float'>(seedAttr, 'float') as unknown as F,
      { ...SENTINEL_LOOK, lens: p.lens, scale: 0.12, dustHeight: 6, steel: '#2c2a28', armour: '#3a3936', armourB: '#45403a', slitHalf: 1.9, slitWidth: 0.55, lensGlow: 1.6 },
      { armour: [aAlb, aNr], steel: [sAlb, sNr] },
      env,
      backdrop,
      p.haze,
      presence as unknown as F,
      ctx.uniforms.time as unknown as F,
    );
    const mesh = new Mesh(geometry, material);
    mesh.count = walkers.length;
    mesh.frustumCulled = false;
    mesh.userData.redHorizon = { world: w, bones: tex, agents: () => walkers.map((a) => ({ slot: a.slot })) };
    const beams = new BeamSet(ctx, walkers.length, p.haze, 1);
    const glints = new GlintSet(walkers.length * 2, p.haze, 2.2, 0.3);
    const group = new Group();
    group.add(mesh, beams.cones, beams.spots, glints.mesh);
    const lensCol = linear(p.lens);
    const beamCol = linear(p.beam);
    const root = new Matrix4();
    const q = new Quaternion();
    const e = new Euler(0, 0, 0, 'YXZ');
    const scaleV = new Vector3();
    const tmp = new Vector3();
    const fwd = new Vector3();
    const toCam = new Vector3();
    const reduced = ctx.quality.reducedMotion;
    let stepBudget = 0;

    const ellipse = (cfg: Params['walkers'][number], th: number, out: Vector3) => out.set(cfg.center[0] + Math.cos(th) * cfg.radius[0], GROUND_Y, cfg.center[1] + Math.sin(th) * cfg.radius[1]);

    // Bindable pace: the walkers stride quicker in drops (legs and ground speed together).
    const pace = floatUniform(1);
    return {
      object: group,
      reactive: { pace },
      update(frame) {
        const dt = Math.min(0.1, frame.dt) * (reduced ? 0.7 : 1) * Math.max(0, pace.value);
        const t = frame.time;
        stepBudget = Math.min(3, stepBudget + dt);
        beams.begin();
        glints.begin();
        for (const wk of walkers) {
          const cfg = wk.cfg;
          const dir = cfg.clockwise ? -1 : 1;
          // Constant ground speed around the ellipse.
          const dx = -Math.sin(wk.theta) * cfg.radius[0];
          const dz = Math.cos(wk.theta) * cfg.radius[1];
          const speedTheta = cfg.speed / Math.max(1e-3, Math.hypot(dx, dz));
          wk.theta += dir * speedTheta * dt;
          ellipse(cfg, wk.theta, wk.pos);
          wk.heading = Math.atan2(-dx * dir, -dz * dir);
          const sc = cfg.scale;
          const T = cfg.cycle * Math.sqrt(sc);
          wk.phase = (wk.phase + dt / T) % 1;
          const S = (cfg.speed / sc) * DUTY * T;
          const P = wk.solver;
          P.reset();
          // ---- Legs.
          let lifted = 0;
          for (const L of legs) {
            const ph = (wk.phase + PHASE[L.i]!) % 1;
            let off: number;
            let lift = 0;
            if (ph < DUTY) {
              off = -S / 2 + (S * ph) / DUTY;
            } else {
              const u = (ph - DUTY) / (1 - DUTY);
              const sm = u * u * (3 - 2 * u);
              off = S / 2 - S * sm;
              lift = Math.sin(Math.PI * u) * 4.2;
              lifted += L.s * Math.sin(Math.PI * u);
            }
            // Footfall: dust, a deep metallic impact for the near ones, a dip of the hull.
            const prev = wk.lastPhase[L.i]!;
            if (ph < prev) {
              wk.bobV -= 0.9;
              tmp.set(L.a.x * sc, 0, (L.a.z + off) * sc).applyAxisAngle(new Vector3(0, 1, 0), wk.heading).add(wk.pos);
              const pool = smokePool(w);
              if (pool) for (let k = 0; k < 4; k++) pool.emit({ x: tmp.x + (rand() - 0.5) * 4, y: GROUND_Y + 0.5, z: tmp.z + (rand() - 0.5) * 4, vx: (rand() - 0.5) * 3, vy: 0.6 + rand(), vz: (rand() - 0.5) * 3, size0: 3, size1: 10, life: 9 + rand() * 5, heat: 0, dark: 0.25 }, t);
              if (p.footsteps && stepBudget >= 1 && tmp.distanceTo(VIEWER) < 900) {
                stepBudget -= 1;
                ctx.sounds.emit('footstep', tmp.x, tmp.y, tmp.z, 1);
              }
            }
            wk.lastPhase[L.i] = ph;
            // Foot target in model space.
            const tx = L.a.x;
            const ty = L.a.y + lift;
            const tz = L.a.z + off;
            // Hip turret yaw towards the target.
            const ddx = tx - L.c.x;
            const ddz = tz - L.c.z;
            const yaw = L.s > 0 ? Math.atan2(-ddz, ddx) : Math.atan2(ddz, -ddx);
            P.pose(L.coxa).ry = yaw;
            // Femur pivot after the yaw (it sits outboard of the turret axis).
            const fr = Math.abs(L.f.x - L.c.x);
            const fx = L.c.x + L.s * Math.cos(yaw) * fr;
            const fz = L.c.z - Math.sin(yaw) * fr * L.s;
            const r = Math.hypot(tx - fx, tz - fz);
            const h = ty - (L.f.y + wk.bob);
            const D = Math.hypot(r, h);
            const { a1, a2 } = twoBone(L.L1, L.L2, D);
            const alpha = Math.atan2(h, r);
            const femurAbs = alpha + a1;
            const tibiaAbs = alpha - a2;
            P.pose(L.femur).rz = L.s * (femurAbs - L.femur0);
            P.pose(L.tibia).rz = L.s * (tibiaAbs - L.tibia0 - (femurAbs - L.femur0));
            P.pose(L.foot).rz = -L.s * (tibiaAbs - L.tibia0);
            P.pose(L.foot).ry = -yaw * 0.5;
          }
          // ---- Hull: settle after footfalls, roll away from the lifted leg, a slow sway.
          const k = 1.6;
          wk.bobV += (-k * k * wk.bob - 2 * 0.45 * k * wk.bobV) * dt;
          wk.bob += wk.bobV * dt;
          wk.roll += (lifted * 0.012 - wk.roll) * Math.min(1, dt * 2);
          const hp = P.pose(hull);
          hp.ty = wk.bob;
          hp.rz = wk.roll;
          hp.rx = Math.sin(wk.phase * Math.PI * 4) * 0.006;
          // ---- Gondola sensor.
          wk.sensor.update(dt, w.events, t, { x: wk.pos.x, y: wk.pos.y + 22 * sc, z: wk.pos.z, heading: wk.heading });
          P.pose(gondola).ry = wk.sensor.yaw * 0.7;
          P.pose(sensorBone).rx = wk.sensor.pitch;
          e.set(0, wk.heading, 0, 'YXZ');
          q.setFromEuler(e);
          root.compose(wk.pos, q, scaleV.setScalar(sc));
          P.solve(root, tex, wk.slot);
          // ---- Optics, beam, smoke.
          P.pointOn(sensorBone, LENS, tmp);
          const wm = P.worldOf(sensorBone);
          fwd.set(-wm.elements[8]!, -wm.elements[9]!, -wm.elements[10]!).normalize();
          toCam.copy(VIEWER).sub(tmp).normalize();
          const facing = Math.max(0, fwd.dot(toCam));
          const gain = wk.sensor.intensity * (0.25 + 0.75 * facing * facing) * 1.5;
          glints.add(tmp.x + toCam.x * 0.8, tmp.y + toCam.y * 0.8, tmp.z + toCam.z * 0.8, 0.56 * sc, lensCol.x * gain, lensCol.y * gain, lensCol.z * gain);
          const scan = Math.max(-1, Math.min(1, wk.sensor.yaw / 0.9));
          optic.setXYZW(wk.slot, wk.sensor.intensity, wk.sensor.focus, scan, 0);
          if (p.beamStrength > 0 && !reduced) {
            const bi = p.beamStrength * wk.sensor.intensity * (0.4 + 0.6 * wk.sensor.focus) * 0.5;
            beams.add(tmp.x, tmp.y, tmp.z, fwd.x, fwd.y, fwd.z, 160 * sc, 0.05, beamCol.x * bi, beamCol.y * bi, beamCol.z * bi);
          }
          wk.puff += dt * 3;
          const pool = smokePool(w);
          if (pool && wk.puff >= 1) {
            wk.puff -= 1;
            const st = STACKS[Math.floor(rand() * STACKS.length)]!;
            P.pointOn(hull, st, tmp);
            pool.emit({ x: tmp.x, y: tmp.y, z: tmp.z, vx: (rand() - 0.5) * 0.6, vy: 2.5 + rand() * 1.5, vz: (rand() - 0.5) * 0.6, size0: 2 * sc, size1: 8.5 * sc, life: 14 + rand() * 6, heat: 0.15, dark: 0.75 }, t);
          }
        }
        // Servo drone of the nearest walker, its pitch working with the gait.
        const nearW = walkers.reduce((a, b) => (a.pos.distanceTo(VIEWER) < b.pos.distanceTo(VIEWER) ? a : b));
        hum(ctx, 'red-horizon-colossus', nearW.pos.x, nearW.pos.z, 180 / Math.max(180, nearW.pos.distanceTo(VIEWER)) * 0.35, 33 + Math.sin(nearW.phase * Math.PI * 12) * 2.5, 0.2);
        tex.upload();
        optic.needsUpdate = true;
        beams.end();
        glints.end();
      },
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        geometry.dispose();
        material.dispose();
        tex.dispose();
        beams.dispose();
        glints.dispose();
        ctx.assets.release('models/colossus.glb');
        release(w);
      },
    };
  },
};
