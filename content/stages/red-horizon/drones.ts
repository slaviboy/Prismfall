import { DynamicDrawUsage, Group, InstancedBufferAttribute, Matrix4, Mesh, Quaternion, Vector3, Euler } from 'three/webgpu';
import { instancedBufferAttribute } from 'three/tsl';
import { floatUniform, linear, seeded, z, zColor, zVec3, type ComponentFactory } from '@prismfall/sdk';
import { SENTINEL_LOOK, machineMaterial } from './metal';
import { BeamSet, GlintSet } from './optics';
import { BoneTexture, RigSolver, mergeRigged, parseRig, skinNode, slotCount, wrapAngle } from './rig';
import { SensorController } from './sensor';
import { GROUND_Y, VIEWER, backdropTexture, envTexture, hum, release, stageTexture, world, zHaze, type F } from './shared';

const schema = z.object({
  /** Drones flying a closed loop through waypoints (world x, height above the yard, z). */
  patrols: z.array(z.object({ points: z.array(zVec3).min(3), count: z.number().int().min(1).max(8).default(2), speed: z.number().positive().default(8), spacing: z.number().positive().default(0.18) })).default([]),
  /** Drones hovering over an area, sweeping the ground with their searchlights. */
  scanners: z.array(z.object({ center: z.tuple([z.number(), z.number()]), radius: z.number().positive().default(18), altitude: z.tuple([z.number(), z.number()]).default([12, 22]), count: z.number().int().min(1).max(6).default(1) })).default([]),
  lens: zColor.default('#ff200e'),
  light: zColor.default('#ffe4c4'),
  /** Searchlight strength (beam and ground spot). */
  searchlight: z.number().min(0).default(1),
  haze: zHaze,
  seed: z.number().default(11),
});

type Params = z.infer<typeof schema>;

interface Drone {
  slot: number;
  pos: Vector3;
  vel: Vector3;
  target: Vector3;
  heading: number;
  bank: number;
  pitch: number;
  spin: number[];
  sensor: SensorController;
  solver: RigSolver;
  seed: number;
  /** Called each frame to move the target point. */
  steer(d: Drone, t: number, dt: number): void;
  search: number;
}

/** Closed Catmull-Rom loop through points; returns a sampler by arc fraction. */
function loop(points: [number, number, number][]): { at(u: number, out: Vector3): Vector3; length: number } {
  const n = points.length;
  const P = points.map((p) => new Vector3(p[0], GROUND_Y + p[1], p[2]));
  const cr = (u: number, out: Vector3): Vector3 => {
    const f = ((u % 1) + 1) % 1 * n;
    const i = Math.floor(f);
    const t = f - i;
    const p0 = P[(i - 1 + n) % n]!, p1 = P[i % n]!, p2 = P[(i + 1) % n]!, p3 = P[(i + 2) % n]!;
    const t2 = t * t, t3 = t2 * t;
    return out.set(
      0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
    );
  };
  let length = 0;
  const a = new Vector3();
  const b = new Vector3();
  cr(0, a);
  for (let i = 1; i <= 200; i++) {
    cr(i / 200, b);
    length += a.distanceTo(b);
    a.copy(b);
  }
  return { at: cr, length };
}

const TURRET_LENS = new Vector3(0, -0.27, -0.63);
const SEARCH_LENS = new Vector3(0.15, -0.27, -0.61);

/**
 * Recon drones (Blender kit): patrol loops between the ruins and searchlight scanners hovering over
 * the yard. Flight is a damped follow of a moving target, so speed, banking into turns, nose-down
 * pitch under acceleration and the forward tilt of the ducted fans all come from the actual motion;
 * a slow hover bob and drift keep them alive when still. The gimballed turret is driven by the
 * optical-sensor controller: scanners sweep the ground with a warm searchlight whose beam scatters
 * in the haze and lands as a soft spot on the yard; patrols look ahead and around.
 */
export const dronesComponent: ComponentFactory<Params> = {
  type: 'redHorizonDrones',
  version: 1,
  description: 'Recon drones on patrol loops and hovering searchlight scanners, with ducted fans and a sensor turret.',
  schema,
  async create(ctx, p) {
    const w = world(ctx);
    const rig = parseRig(ctx.assets.json('models/drone.rig.json'));
    if (!rig) throw new Error('drone rig missing');
    const [gltf, env, backdrop, aAlb, aNr, sAlb, sNr] = await Promise.all([
      ctx.assets.loadGLTF('models/drone.glb'),
      envTexture(w),
      backdropTexture(w),
      stageTexture(w, 'textures/armour_albedo.webp'),
      stageTexture(w, 'textures/armour_nr.webp', false),
      stageTexture(w, 'textures/steel_albedo.webp'),
      stageTexture(w, 'textures/steel_nr.webp', false),
    ]);
    const rand = seeded(p.seed * 3001 + 17);
    const B = (name: string) => rig.bones.find((b) => b.name === name)!.id;
    const id = { body: B('body'), arms: [0, 1, 2, 3].map((i) => B(`arm${i}`)), rotors: [0, 1, 2, 3].map((i) => B(`rotor${i}`)), yaw: B('turretYaw'), pitch: B('turretPitch') };
    const drones: Drone[] = [];
    const reduced = ctx.quality.reducedMotion;
    const mk = (start: Vector3, steer: Drone['steer'], sensorCfg: ConstructorParameters<typeof SensorController>[0], search: number): void => {
      const seed = rand();
      drones.push({
        slot: drones.length,
        pos: start.clone(),
        vel: new Vector3(),
        target: start.clone(),
        heading: rand() * Math.PI * 2,
        bank: 0,
        pitch: 0,
        spin: [rand() * 6, rand() * 6, rand() * 6, rand() * 6],
        sensor: new SensorController({ ...sensorCfg, seed: Math.floor(seed * 1e6) }),
        solver: new RigSolver(rig),
        seed,
        steer,
        search,
      });
    };
    for (const pt of p.patrols) {
      const path = loop(pt.points);
      for (let i = 0; i < pt.count; i++) {
        const phase = i * pt.spacing + rand() * 0.03;
        const sp = pt.speed * (0.92 + rand() * 0.16);
        const bob = rand() * 10;
        const start = path.at(phase, new Vector3());
        mk(
          start,
          (d, t) => {
            path.at(phase + (t * sp) / path.length, d.target);
            d.target.y += Math.sin(t * 0.37 + bob) * 2.2 + Math.sin(t * 0.13 + bob * 2) * 3;
          },
          { yaw: [-1.2, 1.2], pitch: [-0.9, 0.1], restPitch: -0.35, scanSpeed: 0.45, focusChance: 0.3, turnChance: 0.35 },
          0.25,
        );
      }
    }
    for (const sc of p.scanners) {
      for (let i = 0; i < sc.count; i++) {
        const home = new Vector3(sc.center[0] + (rand() - 0.5) * sc.radius, 0, sc.center[1] + (rand() - 0.5) * sc.radius);
        const alt = sc.altitude[0] + rand() * (sc.altitude[1] - sc.altitude[0]);
        const goal = home.clone();
        let timer = rand() * 6;
        const r = seeded(Math.floor(rand() * 1e6));
        const bob = r() * 10;
        mk(
          new Vector3(home.x, GROUND_Y + alt, home.z),
          (d, t, dt) => {
            timer -= dt;
            if (timer <= 0) {
              // Move on to a new patch of ground, then hover there.
              const a = r() * Math.PI * 2;
              const rr = Math.sqrt(r()) * sc.radius;
              goal.set(sc.center[0] + Math.cos(a) * rr, 0, sc.center[1] + Math.sin(a) * rr);
              timer = 7 + r() * 9;
            }
            const k = Math.min(1, dt * 0.25);
            d.target.x += (goal.x - d.target.x) * k;
            d.target.z += (goal.z - d.target.z) * k;
            d.target.y = GROUND_Y + alt + Math.sin(t * 0.5 + bob) * 0.8 + Math.sin(t * 0.21 + bob) * 1.4;
          },
          { yaw: [-1.4, 1.4], pitch: [-1.35, -0.5], restPitch: -1.0, scanSpeed: 0.3, focusChance: 0.45, turnChance: 0.25, pause: [1, 3] },
          1,
        );
      }
    }

    const count = Math.max(1, drones.length);
    const slots = slotCount(rig);
    const tex = new BoneTexture(count, slots);
    const optic = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
    optic.setUsage(DynamicDrawUsage);
    const seedAttr = new InstancedBufferAttribute(new Float32Array(count), 1);
    drones.forEach((d) => seedAttr.setX(d.slot, d.seed * 100));
    const geometry = mergeRigged(gltf.scene, rig);
    const skin = skinNode(tex, 'Drone');
    const presence = floatUniform(1);
    const material = machineMaterial(
      w,
      { position: skin.position, normal: skin.normal, rest: skin.rest, tag: skin.tag as unknown as { x: F; y: F } },
      optic,
      instancedBufferAttribute<'float'>(seedAttr, 'float') as unknown as F,
      { ...SENTINEL_LOOK, lens: p.lens, scale: 2.2, dustHeight: -1 },
      { armour: [aAlb, aNr], steel: [sAlb, sNr] },
      env,
      backdrop,
      p.haze,
      presence as unknown as F,
      ctx.uniforms.time as unknown as F,
    );
    const mesh = new Mesh(geometry, material);
    mesh.count = drones.length;
    mesh.frustumCulled = false;
    mesh.userData.redHorizon = { world: w, bones: tex, agents: () => drones.map((a) => ({ slot: a.slot })) };
    const beams = new BeamSet(ctx, Math.max(1, drones.length), p.haze, 1);
    const glints = new GlintSet(Math.max(1, drones.length * 2), p.haze, 2.0, 0.3);
    const group = new Group();
    group.add(mesh, beams.cones, beams.spots, glints.mesh);
    const lensCol = linear(p.lens);
    const lightCol = linear(p.light);
    const root = new Matrix4();
    const q = new Quaternion();
    const e = new Euler(0, 0, 0, 'YXZ');
    const one = new Vector3(1, 1, 1);
    const acc = new Vector3();
    const prevVel = new Vector3();
    const lensW = new Vector3();
    const fwd = new Vector3();
    const toCam = new Vector3();
    const hover = floatUniform(1);
    return {
      object: group,
      reactive: { search: hover },
      update(frame) {
        const dt = Math.min(0.1, frame.dt) * (reduced ? 0.7 : 1);
        const t = frame.time;
        beams.begin();
        glints.begin();
        for (const d of drones) {
          d.steer(d, t, dt);
          // Damped follow of the target (a heavy airframe), with a limit on acceleration.
          prevVel.copy(d.vel);
          const kk = 1.1;
          acc.copy(d.target).sub(d.pos).multiplyScalar(kk * kk).addScaledVector(d.vel, -2 * kk);
          const amax = 6;
          if (acc.length() > amax) acc.setLength(amax);
          d.vel.addScaledVector(acc, dt);
          d.pos.addScaledVector(d.vel, dt);
          const speed = Math.hypot(d.vel.x, d.vel.z);
          // Heading turns towards the direction of travel when moving, otherwise follows the turret.
          if (speed > 1.2) {
            const want = Math.atan2(-d.vel.x, -d.vel.z);
            d.heading += wrapAngle(want - d.heading) * Math.min(1, dt * 1.2);
          } else {
            d.heading += wrapAngle(d.heading + d.sensor.yaw * 0.5 - d.heading) * Math.min(1, dt * 0.3);
          }
          // Bank from lateral acceleration, pitch from forward acceleration and speed.
          const fx = -Math.sin(d.heading), fz = -Math.cos(d.heading);
          const along = acc.x * fx + acc.z * fz;
          const lateral = acc.x * -fz + acc.z * fx;
          d.bank += (Math.max(-0.5, Math.min(0.5, -lateral * 0.09)) - d.bank) * Math.min(1, dt * 2.5);
          d.pitch += (Math.max(-0.35, Math.min(0.25, -along * 0.05 - speed * 0.018)) - d.pitch) * Math.min(1, dt * 2.5);
          const P = d.solver;
          P.reset();
          // Fans tilt with speed (thrust vectoring) and spin.
          for (let i = 0; i < 4; i++) {
            P.pose(id.arms[i]!).rx = -speed * 0.035 - d.pitch * 0.4;
            d.spin[i]! += dt * (13 + (i % 2) * 2.3) * (i % 2 === 0 ? 1 : -1);
            P.pose(id.rotors[i]!).ry = d.spin[i]!;
          }
          d.sensor.update(dt, w.events, t, { x: d.pos.x, y: d.pos.y, z: d.pos.z, heading: d.heading });
          P.pose(id.yaw).ry = d.sensor.yaw;
          P.pose(id.pitch).rx = d.sensor.pitch;
          e.set(d.pitch, d.heading, d.bank, 'YXZ');
          q.setFromEuler(e);
          root.compose(d.pos, q, one);
          P.solve(root, tex, d.slot);
          // Optics: the turret's red strip and lenses; the searchlight.
          P.pointOn(id.pitch, TURRET_LENS, lensW);
          const wm = P.worldOf(id.pitch);
          fwd.set(-wm.elements[8]!, -wm.elements[9]!, -wm.elements[10]!).normalize();
          toCam.copy(VIEWER).sub(lensW).normalize();
          const facing = Math.max(0, fwd.dot(toCam));
          const gain = d.sensor.intensity * (0.2 + 0.8 * facing * facing) * 1.4;
          glints.add(lensW.x + toCam.x * 0.05, lensW.y + toCam.y * 0.05, lensW.z + toCam.z * 0.05, 0.03, lensCol.x * gain, lensCol.y * gain, lensCol.z * gain);
          optic.setXYZW(d.slot, d.sensor.intensity * (0.6 + 0.4 * d.search), d.sensor.focus, 0, 1);
          if (d.search > 0.5) {
            P.pointOn(id.pitch, SEARCH_LENS, lensW);
            const s = p.searchlight * hover.value * (0.5 + d.sensor.focus * 0.2);
            beams.add(lensW.x, lensW.y, lensW.z, fwd.x, fwd.y, fwd.z, 60, 0.11, lightCol.x * s, lightCol.y * s, lightCol.z * s);
            glints.add(lensW.x + toCam.x * 0.05, lensW.y + toCam.y * 0.05, lensW.z + toCam.z * 0.05, 0.04, lightCol.x * s * facing * 2, lightCol.y * s * facing * 2, lightCol.z * s * facing * 2);
          }
        }
        // The nearest drone's fans: a hum that rises with its speed (silent on hosts without drones).
        let near: Drone | null = null;
        let nd = Infinity;
        for (const d of drones) {
          const dist = d.pos.distanceTo(VIEWER);
          if (dist < nd) {
            nd = dist;
            near = d;
          }
        }
        if (near) hum(ctx, 'red-horizon-drone', near.pos.x, near.pos.z, 26 / Math.max(26, nd) * 0.5, 150 + Math.hypot(near.vel.x, near.vel.z) * 5, 0.55);
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
        ctx.assets.release('models/drone.glb');
        release(w);
      },
    };
  },
};
