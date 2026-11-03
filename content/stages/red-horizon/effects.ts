import { BASE_RECIPE, runRecipe, type ClearInfo, type EffectContext, type LineClearEffect, type TransitionEffect } from '@prismfall/sdk';

/**
 * Red Horizon's board effects. The background never reacts to them: the machines keep their own
 * business. Everything respects the effect intensity setting, the particle budget, reduced motion
 * and flash reduction (read from the shared frame uniforms).
 *
 *  - one or two lines: the cells shear into machined metal shards and red-hot sparks;
 *  - three lines: an energy pulse runs out along every cleared row from the centre;
 *  - four lines (QUAD): a controlled red electrical event, a few jagged discharges crackling
 *    across the cleared rows between the walls, then the pulse and a heavier spark shower;
 *  - combos ramp the spark count and heat.
 */

function hex(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  const f = (x: number) => {
    const c = x / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}

const RED = hex('#ff2a10');
const HOT = hex('#ffb070');
const STEEL = hex('#c8ccd4');

/** Flash limit (1 normal, 0.45 with flash reduction), from the shared frame uniforms. */
function flashOf(ctx: EffectContext): number {
  return (ctx.uniforms as unknown as { flashLimit: { value: number } }).flashLimit.value;
}

function pulse(ctx: EffectContext, clear: ClearInfo, strength: number): void {
  const soft = flashOf(ctx) < 0.99 ? 0.45 : 1;
  for (const row of clear.rows) {
    const n = ctx.bursts.budget(26 * ctx.intensityScale);
    for (let i = 0; i < n; i++) {
      const t = i / Math.max(1, n - 1);
      const side = t < 0.5 ? -1 : 1;
      const x = Math.abs(t - 0.5) * 2;
      const p = ctx.cellToWorld(4.5 + side * x * 5, row);
      const k = (1.6 - x * 0.6) * strength * soft;
      ctx.bursts.emit({ x: p.x, y: p.y, z: 0.75, vx: side * 7, vy: 0, vz: 0, r: RED[0] * 2.6 * k, g: RED[1] * 2.6 * k + 0.05, b: RED[2] * 2.6 * k, size: 0.8, life: 0.36, delay: x * 0.09, drag: 2.6, shape: 'soft' }, clear.time);
    }
  }
}

function arcs(ctx: EffectContext, clear: ClearInfo, bolts: number): void {
  const soft = flashOf(ctx) < 0.99;
  const rand = Math.random;
  for (let b = 0; b < bolts; b++) {
    const row = clear.rows[b % clear.rows.length]! + (rand() - 0.5) * 0.8;
    const delay = b * (soft ? 0.12 : 0.05) + rand() * 0.04;
    let y = row;
    const steps = 22;
    for (let s = 0; s <= steps; s++) {
      const x = -0.5 + (s / steps) * 10;
      y += (rand() - 0.5) * 0.55;
      y = row + Math.max(-0.9, Math.min(0.9, y - row));
      const p = ctx.cellToWorld(x, y);
      const k = (soft ? 0.5 : 1) * (0.7 + rand() * 0.6);
      ctx.bursts.emit({ x: p.x, y: p.y, z: 0.9, vx: (rand() - 0.5) * 0.6, vy: (rand() - 0.5) * 0.6, vz: 0, r: (RED[0] * 2.2 + 0.4) * k, g: (RED[1] * 2.2 + 0.25) * k, b: (RED[2] * 2.2 + 0.35) * k, size: 0.26, life: soft ? 0.32 : 0.2, delay: delay + s * 0.004, drag: 3, shape: 'spark' }, clear.time);
    }
  }
}

export const shearSparks: LineClearEffect = {
  id: 'redHorizonShear',
  description: 'Rows shear into machined metal shards and red-hot sparks; bigger clears send an energy pulse along the rows; a QUAD crackles with red discharges.',
  trigger(ctx, clear) {
    const combo = Math.max(0, clear.combo);
    const heat = 1 + Math.min(1, combo / 6) * 0.8;
    // Machined shards: pale steel, heavy, falling.
    runRecipe(ctx, clear, { ...BASE_RECIPE, shape: 'shard', perCell: 3, speed: [3, 8], motion: 'radial', gravity: -14, drag: 1.1, life: [0.6, 1.2], size: [0.14, 0.32], color: 'highlight', brightness: 1.3, swirl: 0.2, streak: clear.lines >= 2 });
    // Red-hot sparks: fast, gravity-bound, more and hotter with combos.
    const n = Math.round((3 + combo * 0.6) * (ctx.reducedMotion ? 0.5 : 1));
    for (const cell of clear.cells) {
      const c = ctx.bursts.budget(n * ctx.intensityScale);
      const p = ctx.cellToWorld(cell.x, cell.y);
      for (let i = 0; i < c; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 4 + Math.random() * 9;
        const hot = Math.random() < 0.3 ? HOT : RED;
        const k = (1.8 + Math.random() * 1.6) * heat;
        ctx.bursts.emit({ x: p.x + (Math.random() - 0.5) * 0.7, y: p.y + (Math.random() - 0.5) * 0.7, z: p.z + 0.4, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.7 + 2.5, vz: (Math.random() - 0.3) * 3, r: hot[0] * k, g: hot[1] * k, b: hot[2] * k, size: 0.07 + Math.random() * 0.09, life: 0.45 + Math.random() * 0.7, gravity: -18, drag: 0.7, shape: 'spark', swirl: 0 }, clear.time);
      }
    }
    if (clear.lines >= 3) pulse(ctx, clear, clear.lines >= 4 ? 1.2 : 0.8);
    if (clear.lines >= 4 || clear.perfectClear) {
      arcs(ctx, clear, ctx.reducedMotion ? 2 : 4);
      // A slow fall of glowing steel flakes after the discharge.
      runRecipe(ctx, clear, { ...BASE_RECIPE, shape: 'square', perCell: 1.5, speed: [1, 3], motion: 'up', gravity: -3, drag: 1.8, life: [1.2, 2.0], size: [0.06, 0.14], color: 'accent', brightness: 1.6, swirl: 1.2, streak: false });
    }
  },
};

/** The entrance: ash and embers lifting out of the smoke, a few red sparks streaking past. */
export const arrival: TransitionEffect = {
  id: 'redHorizonArrival',
  description: 'Ash and embers rise through the smoke as the machine world fades in.',
  play(ctx) {
    const scale = ctx.intensityScale * (ctx.reducedMotion ? 0.35 : 1);
    const rand = Math.random;
    const range = (a: number, b: number) => a + rand() * (b - a);
    for (let i = 0, n = ctx.bursts.budget(700 * scale); i < n; i++) {
      const c = rand() < 0.7 ? RED : HOT;
      const k = range(1.4, 2.8);
      ctx.bursts.emit({ x: range(-40, 40), y: range(-20, -10), z: range(-18, 8), vx: range(-1, 2), vy: range(4, 9), vz: 0, r: c[0] * k, g: c[1] * k, b: c[2] * k, size: range(0.06, 0.16), life: range(2, 3.2), delay: rand() * ctx.duration * 0.8, drag: 0.35, swirl: 1.4, shape: 'spark' }, ctx.time);
    }
    for (let i = 0, n = ctx.bursts.budget(160 * scale); i < n; i++) {
      ctx.bursts.emit({ x: range(-40, 40), y: range(-18, -6), z: range(-24, -6), vx: range(-0.6, 0.6), vy: range(1.2, 2.6), vz: 0, r: 0.045, g: 0.035, b: 0.03, size: range(1.6, 3.2), life: range(2.6, 3.6), delay: rand() * ctx.duration * 0.6, drag: 0.4, shape: 'soft' }, ctx.time);
    }
    for (let i = 0, n = ctx.bursts.budget(40 * scale); i < n; i++) {
      const k = range(2, 3);
      ctx.bursts.emit({ x: range(-30, 30), y: range(-10, 12), z: range(-6, 4), vx: range(18, 30) * (rand() < 0.5 ? -1 : 1), vy: range(-2, 2), vz: 0, r: STEEL[0] * k * 0.6 + RED[0], g: STEEL[1] * k * 0.3, b: STEEL[2] * k * 0.3, size: range(0.05, 0.1), life: range(0.6, 1), delay: rand() * ctx.duration * 0.7, drag: 0.2, shape: 'spark' }, ctx.time);
    }
  },
};
