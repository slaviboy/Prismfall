import { linear, type ClearInfo, type EffectContext, type LineClearEffect, type TransitionEffect } from '@prismfall/sdk';

/**
 * The Lost Kingdom's board effects. Cleared rows behave like carved stone waking: each cell's
 * carving glows for a moment and then the stone dissolves into fine gold and turquoise motes that
 * drift up like pollen in a sun shaft. Doubles and triples send an ancient pulse of jade light
 * along the rows before they dissolve; a QUAD adds a fall of stone dust and a rising spray of gold.
 * Combos make it denser and brighter, never longer. Everything is short-lived and stays on the
 * cleared rows, so the board stays readable; reduced motion keeps only the dissolve.
 */

const GOLD = linear('#e2b04c');
const TURQUOISE = linear('#3fc9b4');
const JADE = linear('#2fb58a');
const DUST = linear('#9c8f74');

type Rgb = { x: number; y: number; z: number };

const emit = (ctx: EffectContext, time: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, c: Rgb, brightness: number, size: number, life: number, extra: { delay?: number; gravity?: number; drag?: number; swirl?: number; shape?: 'soft' | 'spark' | 'shard' | 'square' | 'star' } = {}): void => {
  ctx.bursts.emit({ x, y, z, vx, vy, vz, r: c.x * brightness, g: c.y * brightness, b: c.z * brightness, size, life, shape: extra.shape ?? 'soft', delay: extra.delay ?? 0, gravity: extra.gravity ?? 0, drag: extra.drag ?? 1.2, swirl: extra.swirl ?? 0.6 }, time);
};

function dissolve(ctx: EffectContext, clear: ClearInfo, scale: number): void {
  const rand = Math.random;
  const per = ctx.bursts.budget(5 * scale);
  for (const cell of clear.cells) {
    const p = ctx.cellToWorld(cell.x, cell.y);
    // The carving flares: a short glow in the piece's own colour on the cell.
    emit(ctx, clear.time, p.x, p.y, p.z + 0.35, 0, 0, 0, { x: cell.color[0], y: cell.color[1], z: cell.color[2] }, 1.1, 0.95, 0.22, { shape: 'square', drag: 4, swirl: 0 });
    for (let i = 0; i < per; i++) {
      const c = rand() < 0.55 ? GOLD : TURQUOISE;
      const delay = 0.12 + rand() * 0.14;
      emit(ctx, clear.time, p.x + (rand() - 0.5) * 0.9, p.y + (rand() - 0.5) * 0.9, p.z + 0.3, (rand() - 0.5) * 1.4, 0.8 + rand() * 1.8, (rand() - 0.2) * 1.2, c, 1.5 + rand() * 0.8, 0.07 + rand() * 0.08, 1.1 + rand() * 0.9, { delay, gravity: 0.6, drag: 1.4, swirl: 1.6, shape: rand() < 0.3 ? 'spark' : 'soft' });
    }
  }
}

function pulse(ctx: EffectContext, clear: ClearInfo, scale: number): void {
  // A wave of jade light running out from the board's centre along each cleared row.
  const n = ctx.bursts.budget(26 * scale);
  for (const row of clear.rows) {
    for (const dir of [-1, 1]) {
      for (let i = 0; i < n / 2; i++) {
        const x = 4.5 + dir * (i / (n / 2)) * 5.2;
        const p = ctx.cellToWorld(x, row);
        const delay = (i / (n / 2)) * 0.18;
        emit(ctx, clear.time, p.x, p.y + (Math.random() - 0.5) * 0.3, p.z + 0.45, dir * 2.5, 0.2, 0, JADE, 1.6, 0.55, 0.45, { delay, drag: 3, swirl: 0.2, shape: 'soft' });
      }
    }
  }
}

function quad(ctx: EffectContext, clear: ClearInfo, scale: number): void {
  const rand = Math.random;
  const dust = ctx.bursts.budget(3 * scale);
  for (const cell of clear.cells) {
    const p = ctx.cellToWorld(cell.x, cell.y);
    for (let i = 0; i < dust; i++) {
      emit(ctx, clear.time, p.x + (rand() - 0.5), p.y + (rand() - 0.5), p.z + 0.2, (rand() - 0.5) * 2.5, -0.5 - rand() * 1.5, (rand() - 0.3) * 1.5, DUST, 0.55, 0.35 + rand() * 0.4, 1.4 + rand() * 0.8, { delay: 0.05 + rand() * 0.1, gravity: -3, drag: 2.2, swirl: 1.4 });
    }
  }
  const gold = ctx.bursts.budget(90 * scale);
  const mid = clear.rows.reduce((a, r) => a + r, 0) / Math.max(1, clear.rows.length);
  for (let i = 0; i < gold; i++) {
    const p = ctx.cellToWorld(rand() * 9, mid + (rand() - 0.5) * clear.rows.length);
    emit(ctx, clear.time, p.x, p.y, p.z + 0.4, (rand() - 0.5) * 3, 3 + rand() * 5, (rand() - 0.2) * 2, GOLD, 2.0, 0.06 + rand() * 0.06, 1.0 + rand() * 0.8, { delay: 0.2 + rand() * 0.2, gravity: -4, drag: 1.0, swirl: 1.0, shape: 'spark' });
  }
}

export const jadeAwakening: LineClearEffect = {
  id: 'jadeAwakening',
  description: 'Carved cells glow, then dissolve into gold and turquoise motes; multi-line clears send a jade pulse along the rows; QUADs add stone dust and a spray of gold.',
  trigger(ctx, clear) {
    const combo = Math.min(1, Math.max(0, clear.combo) / 6);
    const scale = (0.6 + clear.intensity * 0.6 + combo * 0.5) * ctx.intensityScale;
    dissolve(ctx, clear, scale);
    if (ctx.reducedMotion) return;
    if (clear.lines >= 2) pulse(ctx, clear, scale);
    if (clear.lines >= 4 || clear.perfectClear) quad(ctx, clear, scale);
  },
};

/** Entrance: leaves and pollen drift down through a shaft of light, then a breath of mist. */
export const canopyFall: TransitionEffect = {
  id: 'canopyFall',
  description: 'Leaves and pollen drift down through slanting sunlight while mist breathes across the plaza.',
  play(ctx) {
    const rand = Math.random;
    const n = ctx.bursts.budget(380 * ctx.intensityScale * (ctx.reducedMotion ? 0.35 : 1));
    const leaf = [linear('#5c7a2c'), linear('#8aa046'), linear('#a8823a'), linear('#3f5f24')];
    for (let i = 0; i < n; i++) {
      const isLeaf = i % 3 !== 0;
      const c = isLeaf ? (leaf[i % leaf.length] as Rgb) : rand() < 0.5 ? GOLD : linear('#f4eccc');
      ctx.bursts.emit(
        {
          x: (rand() - 0.5) * 36,
          y: 12 + rand() * 10,
          z: (rand() - 0.5) * 10,
          vx: 0.8 + rand() * 1.2,
          vy: -(1.2 + rand() * 1.6),
          vz: (rand() - 0.5),
          r: c.x * (isLeaf ? 0.9 : 1.6),
          g: c.y * (isLeaf ? 0.9 : 1.6),
          b: c.z * (isLeaf ? 0.9 : 1.6),
          size: isLeaf ? 0.25 + rand() * 0.2 : 0.06 + rand() * 0.05,
          life: ctx.duration * (0.7 + rand() * 0.5),
          delay: rand() * ctx.duration * 0.4,
          gravity: -0.4,
          drag: 0.8,
          swirl: isLeaf ? 2.4 : 1.2,
          shape: isLeaf ? 'petal' : 'soft',
        },
        ctx.time,
      );
    }
  },
};
