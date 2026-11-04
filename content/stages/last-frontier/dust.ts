import type { Object3D } from 'three/webgpu';
import { Group, Vector3 } from 'three/webgpu';
import { floatUniform, seeded, z, type ComponentFactory, type EnvironmentContext, type StageGameEvent } from '@prismfall/sdk';
import { PuffSystem } from './puffs';
import { frontier, releaseFrontier, tickFrontier } from './shared';

const zXZ = z.tuple([z.number(), z.number()]);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const schema = z.object({
  /** Areas where low dust drifts along the ground (centre x, z; half sizes). */
  drifts: z
    .array(z.object({ center: zXZ, size: zXZ, rate: z.number().default(3) }))
    .max(6)
    .default([]),
  /** Where gusts sweep through (the town street) and where dust devils may rise. */
  gustArea: z.object({ center: zXZ, size: zXZ }).default({ center: [-40, -40], size: [45, 30] }),
  devilArea: z.object({ center: zXZ, size: zXZ }).default({ center: [95, -150], size: [60, 60] }),
  /** Average seconds between gusts (big music moments and QUADs also raise one). */
  gustEvery: z.number().positive().default(38),
  /** Dust thrown up by anything walking or galloping (the horses, wagons and riders of the model layers). */
  hooves: z
    .object({
      enabled: z.boolean().default(true),
      amount: z.number().default(1),
    })
    .prefault({}),
  /**
   * The world clear wave (SDK 1.5): as each front rolls out from the board, a low skirt of dust lifts
   * off the plain along it and drifts outward (`rate`: puffs per second along the front at full
   * strength; `reach`: the farthest distance where it still raises dust). 0 (off) by default. It
   * follows the front's motion channel, so reduced motion and calm world events thin it.
   */
  front: z
    .object({
      rate: z.number().min(0).default(0),
      reach: z.number().positive().default(160),
      size: z.number().positive().default(6),
      opacity: z.number().min(0).max(1).default(0.07),
    })
    .prefault({}),
  /** Bindable as `drift`: scales the low drifts (section states thicken them in drops). */
  drift: z.number().min(0).default(1),
  /** Dust colour (sRGB-ish, linear values). */
  color: z.tuple([z.number(), z.number(), z.number()]).default([0.66, 0.5, 0.36]),
  seed: z.number().default(9),
});

type Params = z.infer<typeof schema>;

/**
 * Dust, the world's signature: low drifts that creep over the ground in the wind, gusts that sweep
 * a cloud through the street (and set signs, lanterns and the wind pump moving), a rare dust devil
 * out on the plain, and the dust kicked up under hooves and wagon wheels. All of it is lit by the
 * sun (gold when backlit, grey-blue at dusk), and never dense enough to hide the scene.
 */
export const frontierDust: ComponentFactory<Params> = {
  type: 'frontierDust',
  version: 1,
  description: 'Sunlit dust: ground drifts, gusts through the street, dust devils, and dust under hooves and wheels of walking models.',
  schema,
  create(ctx: EnvironmentContext, p) {
    const s = frontier(ctx);
    const presence = floatUniform(1);
    const rand = seeded(p.seed * 3571);
    const reduced = ctx.quality.reducedMotion;
    const density = Math.min(1.5, Math.max(0.25, ctx.quality.particles)) * (ctx.quality.detail === 'low' ? 0.5 : 1) * (reduced ? 0.6 : 1);
    const puffs = new PuffSystem(ctx, s, ctx.quality.detail === 'low' ? 2000 : 6000, presence, { renderOrder: 2 });
    const drift = floatUniform(p.drift);
    const fu = ctx.uniforms;
    const fronts = [fu.wave0, fu.wave1, fu.wave2, fu.wave3];
    const view = new Vector3();
    const group = new Group();
    group.add(puffs.object);
    const [cr, cg, cb] = p.color;

    let clock = 0;
    let nextGust = 12 + rand() * p.gustEvery * 0.6;
    let gustT = -1;
    let gustDir = new Vector3(-1, 0, -0.35).normalize();
    let nextDevil = 40 + rand() * 60;
    let devil: { x: number; z: number; t: number; life: number } | null = null;
    let lastSection = 0;
    const tracked = new Map<Object3D, Vector3>();
    const wp = new Vector3();

    const startGust = () => {
      if (gustT >= 0) return;
      gustT = 0;
      const a = -0.35 + (rand() - 0.5) * 0.5;
      gustDir = new Vector3(-Math.cos(a), 0, Math.sin(a)).normalize();
    };

    return {
      object: group,
      reactive: { drift },
      update(frame) {
        tickFrontier(s, frame);
        const dt = Math.min(0.1, frame.dt);
        clock += dt;
        const now = frame.time;
        const night = s.u.night.value;
        // Wind: a steady breeze from the right, stronger with the bass (slow, large movement).
        const bass = s.u.bass.value;
        const gustK = gustT >= 0 ? Math.sin(Math.min(1, gustT / 7) * Math.PI) : 0;
        s.gust = gustK;
        const base = 2.0 + bass * 1.2;
        s.u.wind.value.set(-base * 0.93 + gustDir.x * 6 * gustK, 0, -base * 0.35 + gustDir.z * 6 * gustK);

        // Low drifts over the ground.
        for (const d of p.drifts) {
          const n = d.rate * density * dt * (1 - night * 0.6) * Math.max(0, drift.value);
          let k = Math.floor(n) + (rand() < n % 1 ? 1 : 0);
          while (k-- > 0) {
            const x = d.center[0] + (rand() * 2 - 1) * d.size[0];
            const zz = d.center[1] + (rand() * 2 - 1) * d.size[1];
            const y = ctx.ground.height(x, zz);
            puffs.emit(
              {
                x,
                y: y + 0.6,
                z: zz,
                vx: 0,
                vy: 0.05,
                vz: 0,
                life: 7 + rand() * 6,
                size0: 4,
                size1: 10 + rand() * 9,
                opacity: 0.025 + rand() * 0.025,
                r: cr,
                g: cg,
                b: cb,
                rise: 0.02,
                drag: 0.6,
                windy: 0.9,
              },
              now,
            );
          }
        }

        // Gusts: timer, big section rises and QUADs.
        const sect = frame.audio.sectionIntensity;
        if (sect - lastSection > 0.25) startGust();
        lastSection += (sect - lastSection) * Math.min(1, dt * 0.5);
        if (clock > nextGust) {
          startGust();
          nextGust = clock + p.gustEvery * (0.6 + rand() * 0.8);
        }
        if (gustT >= 0) {
          gustT += dt;
          const ga = p.gustArea;
          const n = 26 * density * dt * gustK * (1 - night * 0.5);
          let k = Math.floor(n) + (rand() < n % 1 ? 1 : 0);
          while (k-- > 0) {
            // Born on the upwind edge of the street and carried right through it.
            const along = (rand() * 2 - 1) * ga.size[1];
            const x = ga.center[0] - gustDir.x * ga.size[0] * 0.9 + gustDir.z * along;
            const zz = ga.center[1] - gustDir.z * ga.size[0] * 0.9 - gustDir.x * along;
            const y = ctx.ground.height(x, zz);
            const sp = 5 + rand() * 4;
            puffs.emit(
              {
                x,
                y: y + 0.4,
                z: zz,
                vx: gustDir.x * sp,
                vy: 0.5 + rand() * 0.8,
                vz: gustDir.z * sp,
                life: 6 + rand() * 4,
                size0: 3,
                size1: 10 + rand() * 8,
                opacity: 0.06 + rand() * 0.04,
                r: cr,
                g: cg,
                b: cb,
                rise: 0.04,
                drag: 0.25,
                windy: 0.4,
              },
              now,
            );
          }
          if (gustT > 7) gustT = -1;
        }

        // A dust devil now and then (daylight only).
        if (!devil && clock > nextDevil && night < 0.3 && !reduced) {
          const da = p.devilArea;
          devil = {
            x: da.center[0] + (rand() * 2 - 1) * da.size[0],
            z: da.center[1] + (rand() * 2 - 1) * da.size[1],
            t: 0,
            life: 9 + rand() * 6,
          };
          nextDevil = clock + 70 + rand() * 90;
        }
        if (devil) {
          devil.t += dt;
          devil.x += -1.6 * dt;
          devil.z += -0.5 * dt;
          const strength = Math.sin(Math.min(1, devil.t / devil.life) * Math.PI);
          const n = 30 * density * dt * strength;
          let k = Math.floor(n) + (rand() < n % 1 ? 1 : 0);
          while (k-- > 0) {
            const h = rand() * rand() * 22;
            const ang = rand() * Math.PI * 2;
            const rad = 0.6 + h * 0.18;
            const x = devil.x + Math.cos(ang) * rad;
            const zz = devil.z + Math.sin(ang) * rad;
            const y = ctx.ground.height(devil.x, devil.z) + h;
            const tang = 3.5;
            puffs.emit(
              {
                x,
                y,
                z: zz,
                vx: -Math.sin(ang) * tang,
                vy: 1.6,
                vz: Math.cos(ang) * tang,
                life: 2.5 + rand() * 2,
                size0: 1 + h * 0.08,
                size1: 2.5 + h * 0.2,
                opacity: 0.12,
                r: cr,
                g: cg,
                b: cb,
                rise: 0.3,
                drag: 1.4,
                windy: 0.3,
              },
              now,
            );
          }
          if (devil.t > devil.life) devil = null;
        }

        // The clear fronts: dust lifts off the plain along each front as it rolls outward.
        const motion = fu.waveMotion.value;
        if (p.front.rate > 0 && motion > 0.01) {
          const shape = fu.waveShape.value;
          const origin = fu.waveOrigin.value;
          ctx.view?.cameraPosition(view);
          for (const slot of fronts) {
            const w = slot.value;
            const age = now - w.x;
            if (age < 0 || w.y <= 0) continue;
            const f = age * shape.z;
            if (f >= w.z) continue;
            const dist = shape.x * Math.exp(f / Math.max(1e-4, shape.y));
            if (dist < 14 || dist > p.front.reach) continue;
            const alive = 1 - smoothstep(w.z * 0.55, w.z, f);
            // Longer arcs farther out get more puffs, so the skirt keeps its density.
            const n = p.front.rate * Math.min(1.5, w.y) * alive * motion * density * dt * (1 - night * 0.5) * Math.min(3, dist / 40);
            let k = Math.floor(n) + (rand() < n % 1 ? 1 : 0);
            while (k-- > 0) {
              const az = (rand() * 2 - 1) * 1.3;
              const ux = Math.sin(az);
              const uz = -Math.cos(az);
              const x = origin.x + ux * dist;
              const zz = origin.z + uz * dist;
              // Never in front of or behind the board on screen: skip the cone around the view axis.
              const toX = x - view.x;
              const toZ = zz - view.z;
              if (toZ < 0 && Math.abs(toX / toZ) < 0.26) continue;
              const y = ctx.ground.height(x, zz);
              const sp = 2 + rand() * 2.5;
              puffs.emit(
                {
                  x,
                  y: y + 0.3,
                  z: zz,
                  vx: ux * sp,
                  vy: 0.35 + rand() * 0.5,
                  vz: uz * sp,
                  life: 3.5 + rand() * 2.5,
                  size0: p.front.size * 0.4,
                  size1: p.front.size * (1 + rand()),
                  opacity: p.front.opacity * (0.7 + rand() * 0.6),
                  r: cr,
                  g: cg,
                  b: cb,
                  rise: 0.05,
                  drag: 0.7,
                  windy: 0.5,
                },
                now,
              );
            }
          }
        }

        // Hooves and wheels: anything of the other layers that walks along the ground.
        if (p.hooves.enabled && group.parent) {
          for (const layer of group.parent.children) {
            if (layer === group) continue;
            for (const walker of layer.children) {
              if (!(walker instanceof Group) || walker.children.length === 0) continue;
              walker.getWorldPosition(wp);
              const prev = tracked.get(walker);
              if (!prev) {
                tracked.set(walker, wp.clone());
                continue;
              }
              const speed = prev.distanceTo(wp) / Math.max(dt, 1e-3);
              prev.copy(wp);
              if (speed < 0.6 || speed > 40 || !walker.visible) continue;
              const ground = ctx.ground.height(wp.x, wp.z);
              if (Math.abs(wp.y - ground) > 2.5) continue;
              const n = (0.6 + speed * 0.55) * density * p.hooves.amount * dt * (1 - night * 0.5);
              let k = Math.floor(n) + (rand() < n % 1 ? 1 : 0);
              while (k-- > 0) {
                const big = Math.min(1, speed / 9);
                puffs.emit(
                  {
                    x: wp.x + (rand() - 0.5) * 1.6,
                    y: ground + 0.15,
                    z: wp.z + (rand() - 0.5) * 1.6,
                    vx: (rand() - 0.5) * 0.8,
                    vy: 0.25 + big * 0.6,
                    vz: (rand() - 0.5) * 0.8,
                    life: 2.5 + big * 2.5 + rand(),
                    size0: 0.5,
                    size1: 1.8 + big * 3,
                    opacity: 0.12 + big * 0.12,
                    r: cr,
                    g: cg,
                    b: cb,
                    rise: 0.05,
                    drag: 1.3,
                    windy: 0.7,
                  },
                  now,
                );
              }
            }
          }
        }
        puffs.flush();
      },
      onGameEvent(e: StageGameEvent) {
        if (e.kind === 'clear' && e.lines >= 4) startGust();
      },
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        puffs.dispose();
        releaseFrontier(ctx, s);
      },
    };
  },
};
