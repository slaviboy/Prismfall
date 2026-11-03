import type { ClearInfo, EffectContext, LineClearEffect } from '@prismfall/sdk';

/**
 * The Veil's line clears: the cleared blocks come apart into mist.
 *
 * - One line: every block dissolves into delicate wisps that lift and drift off sideways, tinted
 *   with its own colour fading into cold fog grey.
 * - Two or three: the wisps, and a low wave of mist rolling outwards from the board's base and
 *   sides into the world.
 * - QUAD: a wider, slower atmospheric wave of fog and fine motes spreading from the board (the
 *   atmosphere answers with a slow swell of light in the distant fog).
 * Combos build gradually: each step of a combo adds a little more mist and reach. The particles
 * are dim and leave the playfield quickly, so the board never sits under smoke; reduced motion
 * and the effects intensity setting scale everything down.
 */

const FOG: [number, number, number] = [0.42, 0.47, 0.55];

function mixc(a: readonly [number, number, number], b: readonly [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function dissolve(ctx: EffectContext, clear: ClearInfo, strength: number): void {
  const rand = Math.random;
  const per = 3.2 * strength * ctx.intensityScale * (ctx.reducedMotion ? 0.5 : 1);
  for (const cell of clear.cells) {
    const n = ctx.bursts.budget(per);
    const p = ctx.cellToWorld(cell.x, cell.y);
    const away = cell.x < 4.5 ? -1 : 1;
    for (let i = 0; i < n; i++) {
      const tint = mixc(cell.color, FOG, 0.45 + rand() * 0.35);
      const b = 0.32 + rand() * 0.22;
      ctx.bursts.emit(
        {
          x: p.x + (rand() - 0.5) * 0.9,
          y: p.y + (rand() - 0.5) * 0.9,
          z: p.z + 0.2 + rand() * 0.4,
          vx: away * (0.6 + rand() * 1.6),
          vy: 0.4 + rand() * 1.1,
          vz: -0.4 - rand() * 1.2,
          r: tint[0] * b,
          g: tint[1] * b,
          b: tint[2] * b,
          size: 0.45 + rand() * 0.75,
          life: 1.3 + rand() * 1.4,
          delay: rand() * 0.12,
          gravity: 0.5,
          drag: 0.9,
          shape: 'soft',
          swirl: 1.6 + rand() * 0.8,
        },
        clear.time,
      );
    }
    // A few fine motes that catch the light as the block comes apart.
    const m = ctx.bursts.budget(per * 0.5);
    for (let i = 0; i < m; i++) {
      const c = mixc(cell.color, [0.8, 0.86, 0.95], 0.5);
      ctx.bursts.emit({ x: p.x + (rand() - 0.5) * 0.8, y: p.y + (rand() - 0.5) * 0.8, z: p.z + 0.4, vx: away * rand() * 2.2, vy: 0.6 + rand() * 1.8, vz: -rand() * 1.5, r: c[0] * 0.9, g: c[1] * 0.9, b: c[2] * 0.9, size: 0.07 + rand() * 0.08, life: 1.4 + rand() * 1.2, delay: rand() * 0.2, gravity: 0.8, drag: 1.1, shape: 'soft', swirl: 2.4 }, clear.time);
    }
  }
}

/** A ring of mist rolling outwards from the board (multi-line clears and QUADs). */
function wave(ctx: EffectContext, clear: ClearInfo, reach: number, count: number, bright: number): void {
  const rand = Math.random;
  const n = ctx.bursts.budget(count * ctx.intensityScale * (ctx.reducedMotion ? 0.4 : 1));
  const rows = clear.rows;
  const cy = rows.reduce((s, r) => s + r, 0) / Math.max(1, rows.length);
  const centre = ctx.cellToWorld(4.5, cy);
  const base = ctx.cellToWorld(4.5, 0);
  for (let i = 0; i < n; i++) {
    // From the board's outline: its sides at the cleared rows and its base.
    const onSide = rand() < 0.65;
    const side = rand() < 0.5 ? -1 : 1;
    const x = onSide ? centre.x + side * (5.4 + rand() * 0.6) : base.x + (rand() - 0.5) * 11;
    const y = onSide ? centre.y + (rand() - 0.5) * (rows.length + 2) : base.y - 0.6 - rand() * 0.8;
    const ang = onSide ? (side > 0 ? 0 : Math.PI) + (rand() - 0.5) * 0.9 : (rand() < 0.5 ? 0 : Math.PI) + (rand() - 0.5) * 1.6;
    const speed = reach * (0.5 + rand() * 0.6);
    const c = mixc(FOG, [0.7, 0.78, 0.9], rand() * 0.5);
    const b = bright * (0.5 + rand() * 0.5);
    ctx.bursts.emit(
      {
        x,
        y,
        z: -0.5 - rand() * 1.5,
        vx: Math.cos(ang) * speed,
        vy: (rand() - 0.4) * speed * 0.12,
        vz: -speed * (0.2 + rand() * 0.5),
        r: c[0] * b,
        g: c[1] * b,
        b: c[2] * b,
        size: 2.2 + rand() * 3.4,
        life: 2.4 + rand() * 2.0,
        delay: rand() * 0.25,
        gravity: 0.15,
        drag: 0.75,
        shape: 'soft',
        swirl: 1.1,
      },
      clear.time,
    );
  }
}

export const veilDissolve: LineClearEffect = {
  id: 'veilDissolve',
  description: 'Cleared blocks dissolve into mist; multi-line clears send a wave of mist out of the board, QUADs a wide atmospheric wave.',
  trigger(ctx, clear) {
    const combo = Math.max(0, clear.combo);
    const build = 1 + Math.min(1, combo / 8) * 0.6;
    dissolve(ctx, clear, (0.8 + clear.intensity * 0.5) * build);
    if (clear.lines >= 2) {
      const quad = clear.lines >= 4;
      wave(ctx, clear, (quad ? 9 : 5.5) * build, (quad ? 170 : 80) * build, quad ? 0.075 : 0.06);
      if (quad || clear.perfectClear) wave(ctx, clear, 14 * build, 110, 0.05);
    }
  },
};
