import { Color, Group } from 'three/webgpu';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { PARTICLE_SHAPES, type ParticleShape } from '../../particles/BurstSystem';
import { seeded, zColor, zVec3 } from './common';

const schema = z.object({
  positions: z.array(zVec3).min(1),
  /** When to emit: every beat, every bar, or continuously at `rate` per second. */
  trigger: z.enum(['beat', 'bar', 'rate', 'clear']).default('bar'),
  rate: z.number().default(10),
  count: z.number().default(40),
  shape: z.enum(Object.keys(PARTICLE_SHAPES) as [ParticleShape, ...ParticleShape[]]).default('spark'),
  color: zColor.default('#ffb050'),
  colorB: zColor.optional(),
  intensity: z.number().default(2),
  size: z.number().default(0.35),
  speed: z.number().default(9),
  direction: zVec3.default([0, 1, 0]),
  spread: z.number().default(0.6),
  gravity: z.number().default(-12),
  drag: z.number().default(0.6),
  life: z.number().default(1.4),
  swirl: z.number().default(0),
});

/** Periodic particle bursts at fixed points (forge sparks, geysers, embers) synced to the music. */
export const emitterComponent: ComponentFactory<z.infer<typeof schema>> = {
  type: 'emitter',
  version: 1,
  description: 'Beat-, bar- or rate-driven particle bursts from fixed points.',
  schema,
  create(ctx, p) {
    const rand = seeded(17);
    const a = new Color(p.color).convertSRGBToLinear();
    const b = new Color(p.colorB ?? p.color).convertSRGBToLinear();
    const dir = { x: p.direction[0], y: p.direction[1], z: p.direction[2] };
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const u = { amount: { value: 1 } };
    let carry = 0;
    let cursor = 0;
    const burst = (n: number, time: number): void => {
      const pos = p.positions[cursor++ % p.positions.length] as [number, number, number];
      const count = ctx.bursts.budget(n * u.amount.value);
      for (let i = 0; i < count; i++) {
        const t = rand();
        const sx = (rand() - 0.5) * 2 * p.spread;
        const sz = (rand() - 0.5) * 2 * p.spread;
        const speed = p.speed * (0.5 + rand() * 0.8);
        ctx.bursts.emit(
          {
            x: pos[0] + (rand() - 0.5) * 0.6,
            y: pos[1] + (rand() - 0.5) * 0.6,
            z: pos[2] + (rand() - 0.5) * 0.6,
            vx: (dir.x / len + sx) * speed,
            vy: (dir.y / len + (rand() - 0.5) * p.spread) * speed,
            vz: (dir.z / len + sz) * speed,
            r: (a.r + (b.r - a.r) * t) * p.intensity,
            g: (a.g + (b.g - a.g) * t) * p.intensity,
            b: (a.b + (b.b - a.b) * t) * p.intensity,
            size: p.size * (0.5 + rand()),
            life: p.life * (0.6 + rand() * 0.6),
            gravity: p.gravity,
            drag: p.drag,
            shape: p.shape,
            swirl: p.swirl,
          },
          time,
        );
      }
    };
    return {
      object: new Group(),
      reactive: u.amount ? { amount: u.amount } : undefined,
      update(frame) {
        if (p.trigger !== 'rate') return;
        carry += frame.dt * p.rate;
        while (carry >= 1) {
          carry -= 1;
          burst(Math.max(1, Math.round(p.count / Math.max(1, p.rate))), frame.time);
        }
      },
      onBeat(beat) {
        if (p.trigger === 'beat' || (p.trigger === 'bar' && beat.downbeat)) burst(p.count, beat.time / 1000);
      },
      onGameEvent(e) {
        if (p.trigger === 'clear' && e.kind === 'clear') burst(p.count * (0.5 + e.intensity), ctx.uniforms.time.value);
      },
      dispose() {
        /* particles live in the shared burst system */
      },
    };
  },
};
