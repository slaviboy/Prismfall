import { AdditiveBlending, Color, InstancedBufferAttribute, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, Vector4 } from 'three/webgpu';
import {
  Fn,
  abs,
  attribute,
  cos,
  float,
  instancedBufferAttribute,
  mix,
  mrt,
  mx_noise_float,
  normalLocal,
  positionGeometry,
  select,
  sin,
  smoothstep,
  step,
  uniformArray,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { vec4At } from '../../creatures/rig';
import { SWARM_KINDS, swarmGeometry, type SwarmKind } from '../../creatures/swarmGeometry';
import { Noise2 } from '../terrain/heightfield';
import { additiveFog } from '../../shaders/uniforms';
import { colorUniform, floatUniform, seeded, zColor, zVec3 } from './common';
import { revealMask } from './reveal';

const motion = z.discriminatedUnion('kind', [
  /** Circling a centre (gulls over a bay, fish around a reef). */
  z.object({ kind: z.literal('orbit'), center: zVec3, radius: zVec3.default([40, 4, 25]), speed: z.number().default(4) }),
  /** Meandering inside a box (schools, butterflies, jellyfish drifting). */
  z.object({ kind: z.literal('wander'), center: zVec3, size: zVec3.default([80, 10, 50]), speed: z.number().default(3) }),
  /** Crossing from one point to another, then returning after a rest. */
  z.object({ kind: z.literal('cross'), from: zVec3, to: zVec3, speed: z.number().default(6), rest: z.number().default(8) }),
]);

const schema = z.object({
  kind: z.enum(SWARM_KINDS),
  /** Individuals in total, spread over the flocks. */
  count: z.number().int().min(1).max(4000).default(40),
  flocks: z.number().int().min(1).max(32).default(2),
  motion,
  /** How far members spread around their flock centre (world units). */
  spread: zVec3.default([8, 2, 6]),
  size: z.tuple([z.number().positive(), z.number().positive()]).default([1, 1.4]),
  color: zColor.default('#d8dde6'),
  colorB: zColor.default('#9aa4b4'),
  /** Emissive glow (jellyfish, fireflies, ember birds); 0 for lit creatures. */
  glow: z.number().min(0).default(0),
  /** Animation rate multiplier (wingbeats, tail beats, pulses). */
  tempo: z.number().positive().default(1),
  seed: z.number().default(1),
});

type Params = z.infer<typeof schema>;

const FLAP: Record<SwarmKind, { freq: number; amp: number }> = {
  bird: { freq: 9, amp: 0.75 },
  eagle: { freq: 2.4, amp: 0.45 },
  butterfly: { freq: 14, amp: 1.1 },
  fish: { freq: 7, amp: 0.12 },
  koi: { freq: 3.2, amp: 0.1 },
  whale: { freq: 0.45, amp: 0.06 },
  jellyfish: { freq: 1.3, amp: 0.18 },
  ray: { freq: 1.4, amp: 0.22 },
  turtle: { freq: 1.1, amp: 0.55 },
};

/**
 * Flocks and schools of procedural creatures (birds, eagles, butterflies, fish, koi, jellyfish,
 * rays, turtles, whales). Flock centres move on the CPU (a handful of points per frame); every
 * member's offset, wingbeat, tail beat, bell pulse and banking runs in the vertex shader.
 */
export const swarmComponent: ComponentFactory<Params> = {
  type: 'swarm',
  version: 1,
  description: 'Procedurally animated flocks and schools: birds, eagles, butterflies, fish, koi, jellyfish, rays, turtles, whales.',
  schema,
  create(ctx, p) {
    const detail = ctx.quality.detail === 'low' ? 0.4 : ctx.quality.detail === 'medium' ? 0.7 : 1;
    const count = Math.max(p.flocks, Math.round(p.count * detail));
    const rand = seeded(p.seed * 7717 + count);
    const geometry = swarmGeometry(p.kind);
    // Per member: flock index, seed, size, formation offset packed into two vec4s.
    const a = new Float32Array(count * 4);
    const b = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const r = Math.sqrt(rand());
      const ang = rand() * Math.PI * 2;
      a.set([i % p.flocks, rand(), p.size[0] + (p.size[1] - p.size[0]) * rand(), rand() * Math.PI * 2], i * 4);
      b.set([Math.cos(ang) * r, (rand() * 2 - 1), Math.sin(ang) * r, rand()], i * 4);
    }
    const attrA = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(a, 4), 'vec4');
    const attrB = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(b, 4), 'vec4');
    // Flock state: position + yaw, and pitch, roll, fade, speed.
    const stateA = Array.from({ length: p.flocks }, () => new Vector4());
    const stateB = Array.from({ length: p.flocks }, () => new Vector4(0, 0, 1, 1));
    const flockA = uniformArrayOf(stateA);
    const flockB = uniformArrayOf(stateB);
    const u = { presence: floatUniform(1), glow: floatUniform(p.glow), tempo: floatUniform(1), music: floatUniform(0) };
    // The wingbeat clock is integrated on the CPU (tempo is reactive: a change must not jump the strokes).
    const flapClock = floatUniform(0);
    const flap = FLAP[p.kind];
    const part = attribute<'vec4'>('part', 'vec4');

    const posed = Fn(() => {
      const fa = vec4At(flockA, attrA.x.toInt());
      const fb = vec4At(flockB, attrA.x.toInt());
      const seed = attrA.y;
      const phase = attrA.w;
      const t = flapClock;
      const side = part.x;
      const span = part.y;
      const along = part.z;
      const special = part.w;
      const g = positionGeometry.toVar();
      const f = float(flap.freq).mul(float(0.85).add(seed.mul(0.3)));
      const beat = sin(t.mul(f).add(phase));
      switch (p.kind) {
        case 'bird':
        case 'eagle':
        case 'butterfly': {
          // Eagles glide most of the time and beat their wings in bursts.
          const glide = p.kind === 'eagle' ? smoothstep(0.55, 0.95, sin(t.mul(0.21).add(seed.mul(9))).mul(0.5).add(0.5)) : float(1);
          const angle = beat.mul(flap.amp).mul(glide).add(p.kind === 'eagle' ? 0.08 : 0);
          const bend = span.mul(0.35).add(0.65);
          const r = abs(g.x);
          const wing = vec3(side.mul(r.mul(cos(angle.mul(bend)))), g.y.add(r.mul(sin(angle.mul(bend)))), g.z);
          g.assign(select(abs(side).greaterThan(0.5), wing, g));
          // Body bobs against the wings.
          g.y.subAssign(beat.mul(0.02).mul(glide));
          break;
        }
        case 'fish':
        case 'koi': {
          const tailWeight = float(1).sub(along).mul(0.5).pow(2);
          g.x.addAssign(sin(t.mul(f).sub(along.mul(3)).add(phase)).mul(flap.amp).mul(tailWeight));
          break;
        }
        case 'whale': {
          const tailWeight = float(1).sub(along).mul(0.5).pow(2.2);
          g.y.addAssign(sin(t.mul(f).sub(along.mul(2.2)).add(phase)).mul(flap.amp * 14).mul(tailWeight));
          break;
        }
        case 'jellyfish': {
          // The bell contracts (pushing the jelly up) and tentacles trail in waves.
          const pulse = sin(t.mul(f).add(phase));
          const squeeze = float(1).add(pulse.mul(flap.amp).mul(span).mul(step(special, 0.5)));
          g.x.mulAssign(squeeze);
          g.z.mulAssign(squeeze);
          const wave = sin(t.mul(1.7).add(along.mul(5)).add(phase)).mul(0.12).mul(span).mul(step(0.5, special));
          g.x.addAssign(wave);
          g.z.addAssign(cos(t.mul(1.3).add(along.mul(4)).add(phase)).mul(0.1).mul(span).mul(step(0.5, special)));
          g.y.addAssign(pulse.mul(0.06));
          break;
        }
        case 'ray': {
          g.y.addAssign(sin(t.mul(f).sub(abs(g.x).mul(3)).add(phase)).mul(flap.amp).mul(span));
          g.x.addAssign(sin(t.mul(f).add(phase)).mul(0.15).mul(step(0.5, special)).mul(float(1).sub(along)));
          break;
        }
        case 'turtle': {
          const front = step(0, along);
          const paddle = sin(t.mul(f).add(phase).add(front.mul(Math.PI))).mul(flap.amp).mul(span);
          g.y.addAssign(paddle.mul(abs(g.x)).mul(0.8));
          g.z.addAssign(paddle.mul(0.12));
          break;
        }
      }
      // Member offset inside the flock: a slow individual drift around a formation slot.
      const spread = vec3(...p.spread);
      const drift = vec3(sin(t.mul(0.31).add(seed.mul(23))), sin(t.mul(0.23).add(seed.mul(41))).mul(0.6), cos(t.mul(0.27).add(seed.mul(17)))).mul(0.35);
      const offset = attrB.xyz.add(drift).mul(spread);
      // Orientation: yaw, pitch, bank (banking more for birds).
      const yaw = fa.w.add(sin(t.mul(0.4).add(seed.mul(13))).mul(0.12));
      const pitch = fb.x;
      const roll = fb.y;
      const size = attrA.z.mul(fb.z).mul(u.presence.mul(0.5).add(0.5));
      const rot = (v: Node<'vec3'>): Node<'vec3'> => {
        // Rz(roll) → Rx(pitch) → Ry(yaw).
        const cr = cos(roll);
        const sr = sin(roll);
        const v1 = vec3(v.x.mul(cr).sub(v.y.mul(sr)), v.x.mul(sr).add(v.y.mul(cr)), v.z);
        const cp = cos(pitch);
        const sp = sin(pitch);
        const v2 = vec3(v1.x, v1.y.mul(cp).sub(v1.z.mul(sp)), v1.y.mul(sp).add(v1.z.mul(cp)));
        const cy = cos(yaw);
        const sy = sin(yaw);
        return vec3(v2.x.mul(cy).add(v2.z.mul(sy)), v2.y, v2.x.negate().mul(sy).add(v2.z.mul(cy))) as Node<'vec3'>;
      };
      normalLocal.assign(rot(normalLocal));
      return rot(g.mul(size) as Node<'vec3'>).add(fa.xyz).add(offset);
    })();

    const base = mix(colorUniform(p.color), colorUniform(p.colorB), attrA.y);
    let colorNode: Node<'vec3'> = base as Node<'vec3'>;
    if (p.kind === 'koi') {
      // Koi patterns: orange and black patches on white, different on every fish.
      const n = mx_noise_float(positionGeometry.mul(9).add(vec3(attrA.y.mul(31), 0, 0)));
      const orange = colorUniform(p.color);
      const white = new Color('#f4f1ea');
      colorNode = mix(vec3(white.r, white.g, white.b), orange, step(0.05, n)).mul(float(1).sub(step(0.55, n).mul(0.85))) as Node<'vec3'>;
    }
    const additive = p.kind === 'jellyfish';
    let material: MeshStandardNodeMaterial | MeshBasicNodeMaterial;
    if (additive) {
      const m = new MeshBasicNodeMaterial();
      const rim = float(0.35).add(attribute<'vec4'>('part', 'vec4').y.mul(0.65));
      const light = colorNode.mul(rim).mul(u.glow.add(0.4)).mul(float(1).add(u.music.mul(0.5))).mul(u.presence);
      m.colorNode = vec4(additiveFog(light as Node<'vec3'>), 1);
      m.transparent = true;
      m.depthWrite = false;
      m.blending = AdditiveBlending;
      m.fog = false;
      m.mrtNode = mrt({ emissive: vec4(light.mul(0.6), 1) });
      material = m;
    } else {
      const m = new MeshStandardNodeMaterial();
      m.colorNode = vec4(colorNode, 1);
      m.roughness = p.kind === 'whale' || p.kind === 'turtle' ? 0.7 : 0.55;
      m.metalness = 0;
      m.opacityNode = revealMask(u.presence);
      m.alphaTest = 0.5;
      if (p.glow > 0) {
        const glow = colorNode.mul(u.glow).mul(float(1).add(u.music.mul(0.5))).mul(u.presence);
        m.emissiveNode = glow;
        m.mrtNode = mrt({ emissive: vec4(glow, 1) });
      }
      material = m;
    }
    material.positionNode = posed;
    const mesh = new Mesh(geometry, material);
    mesh.count = count;
    mesh.frustumCulled = false;
    mesh.renderOrder = additive ? -3 : 0;

    // Flock motion (CPU, a few points per frame).
    const noise = new Noise2(p.seed * 97 + 3);
    const flockSeeds = Array.from({ length: p.flocks }, (_, i) => ({ phase: (i / p.flocks) * Math.PI * 2 + rand() * 0.6, seed: rand() * 100, yaw: 0, last: [0, 0, 0] as [number, number, number], init: false }));
    const pos = (fi: number, t: number): [number, number, number] => {
      const m = p.motion;
      const fs = flockSeeds[fi]!;
      if (m.kind === 'orbit') {
        const ang = (t * m.speed) / Math.max(1, (m.radius[0] + m.radius[2]) / 2) + fs.phase;
        return [m.center[0] + Math.cos(ang) * m.radius[0], m.center[1] + Math.sin(t * 0.3 + fs.seed) * m.radius[1], m.center[2] + Math.sin(ang) * m.radius[2]];
      }
      if (m.kind === 'wander') {
        const k = (t * m.speed) / Math.max(m.size[0], m.size[2]);
        return [
          m.center[0] + noise.get(k + fs.seed, 1.7) * m.size[0] * 0.5,
          m.center[1] + noise.get(k * 0.7 + fs.seed, 9.1) * m.size[1] * 0.5,
          m.center[2] + noise.get(k + fs.seed, 23.3) * m.size[2] * 0.5,
        ];
      }
      const len = Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1], m.to[2] - m.from[2]);
      const cycle = len / m.speed + m.rest;
      const local = (t + (fs.phase / (Math.PI * 2)) * cycle) % cycle;
      const k = Math.min(1, (local * m.speed) / len);
      return [m.from[0] + (m.to[0] - m.from[0]) * k, m.from[1] + (m.to[1] - m.from[1]) * k + Math.sin(t * 0.5 + fs.seed) * 2, m.from[2] + (m.to[2] - m.from[2]) * k];
    };
    const crossFade = (fi: number, t: number): number => {
      const m = p.motion;
      if (m.kind !== 'cross') return 1;
      const len = Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1], m.to[2] - m.from[2]);
      const cycle = len / m.speed + m.rest;
      const local = (t + (flockSeeds[fi]!.phase / (Math.PI * 2)) * cycle) % cycle;
      const d = local * m.speed;
      return d >= len ? 0 : Math.min(1, d / 15, (len - d) / 15);
    };
    const reduced = ctx.quality.reducedMotion;
    let clock = rand() * 100;
    return {
      object: mesh,
      reactive: { glow: u.glow, tempo: u.tempo },
      update(frame) {
        clock += Math.min(0.1, frame.dt) * (reduced ? 0.5 : 1) * u.tempo.value;
        flapClock.value += Math.min(0.1, frame.dt) * Math.max(0, u.tempo.value) * p.tempo;
        u.music.value = frame.audio.bass * 0.5 + frame.audio.beatPulse * 0.5;
        for (let i = 0; i < p.flocks; i++) {
          const fs = flockSeeds[i]!;
          const [x, y, zz] = pos(i, clock);
          const dx = x - fs.last[0];
          const dy = y - fs.last[1];
          const dz = zz - fs.last[2];
          const speed = Math.hypot(dx, dz);
          if (!fs.init || speed > 50) {
            fs.init = true;
            fs.last = [x, y, zz];
            const [nx, , nz] = pos(i, clock + 0.1);
            fs.yaw = Math.atan2(-(nx - x), -(nz - zz));
          } else if (speed > 1e-4) {
            const target = Math.atan2(-dx, -dz);
            let d = target - fs.yaw;
            d = Math.atan2(Math.sin(d), Math.cos(d));
            const turn = d * Math.min(1, frame.dt * 3);
            fs.yaw += turn;
            // Bank into turns; pitch with climbs.
            stateB[i]!.y = Math.max(-0.7, Math.min(0.7, (stateB[i]!.y * 0.9) - turn * 6));
            stateB[i]!.x = Math.max(-0.5, Math.min(0.5, Math.atan2(dy, speed) * 0.8));
          }
          fs.last = [x, y, zz];
          stateA[i]!.set(x, y, zz, fs.yaw);
          stateB[i]!.z = crossFade(i, clock);
        }
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        geometry.dispose();
        material.dispose();
      },
    };
  },
};

function uniformArrayOf(values: Vector4[]) {
  return uniformArray(values, 'vec4');
}
