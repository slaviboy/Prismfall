import type { ClearInfo, EffectContext, LineClearEffect, TransitionEffect } from '@prismfall/sdk';

/**
 * The Web's line clears.
 *
 * - One line: each block comes apart into dark motes with a faint violet ember, drifting down and
 *   out of the board.
 * - Two or three: strands of silk unspool outwards from the board, each a beaded line of light
 *   thrown along its own direction, like threads flung from a web.
 * - QUAD: a wider ring of luminous silk and a few crystalline fragments.
 * Combos build gradually. Particles leave the playfield quickly so falling pieces stay clear;
 * reduced motion and the effects intensity setting scale everything down.
 */

const VIOLET: [number, number, number] = [0.42, 0.3, 0.72];
const SILK: [number, number, number] = [0.62, 0.66, 0.78];
const DARK: [number, number, number] = [0.05, 0.045, 0.07];

function mixc(a: readonly [number, number, number], b: readonly [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function dissolve(ctx: EffectContext, clear: ClearInfo, strength: number): void {
  const rand = Math.random;
  const per = 3 * strength * ctx.intensityScale * (ctx.reducedMotion ? 0.5 : 1);
  for (const cell of clear.cells) {
    const n = ctx.bursts.budget(per);
    const p = ctx.cellToWorld(cell.x, cell.y);
    const away = cell.x < 4.5 ? -1 : 1;
    for (let i = 0; i < n; i++) {
      const ember = rand() < 0.22;
      const c = ember ? mixc(cell.color, VIOLET, 0.6) : mixc(cell.color, DARK, 0.75);
      const k = ember ? 0.9 + rand() * 0.5 : 0.5;
      ctx.bursts.emit(
        {
          x: p.x + (rand() - 0.5) * 0.9,
          y: p.y + (rand() - 0.5) * 0.9,
          z: p.z + 0.1 + rand() * 0.5,
          vx: away * (0.8 + rand() * 1.8),
          vy: -0.4 - rand() * 0.9,
          vz: -0.3 - rand() * 1.1,
          r: c[0] * k,
          g: c[1] * k,
          b: c[2] * k,
          size: ember ? 0.05 + rand() * 0.05 : 0.12 + rand() * 0.16,
          life: 0.9 + rand() * 0.9,
          delay: rand() * 0.2,
          gravity: 0.4,
          drag: 0.8,
          shape: ember ? 'spark' : 'soft',
          swirl: 0.5,
        },
        clear.time,
      );
    }
  }
}

/** Strands of silk thrown outwards from the board's cleared rows: beads along each direction. */
function strands(ctx: EffectContext, clear: ClearInfo, count: number, reach: number, brightness: number): void {
  const rand = Math.random;
  const scale = ctx.intensityScale * (ctx.reducedMotion ? 0.4 : 1);
  const rows = clear.rows.length ? clear.rows : [0];
  const midRow = rows.reduce((a, b) => a + b, 0) / rows.length;
  const centre = ctx.cellToWorld(4.5, midRow);
  const n = Math.max(4, Math.round(count * scale));
  for (let s = 0; s < n; s++) {
    // Mostly sideways (out of the board), never straight up the playfield.
    const side = s % 2 === 0 ? -1 : 1;
    const ang = (rand() - 0.5) * 1.3;
    const dx = Math.cos(ang) * side;
    const dy = Math.sin(ang) * 0.6;
    const beads = ctx.bursts.budget(9 * scale);
    for (let b = 0; b < beads; b++) {
      const f = (b + 1) / beads;
      const speed = reach * f * (0.8 + rand() * 0.3);
      const c = mixc(SILK, VIOLET, rand() * 0.35);
      const k = brightness * (1 - f * 0.4);
      ctx.bursts.emit(
        {
          x: centre.x + dx * 5.2,
          y: centre.y + dy * 2,
          z: centre.z + 0.3,
          vx: dx * speed,
          vy: dy * speed + (rand() - 0.5) * 0.3,
          vz: -0.5 - rand() * 1.5,
          r: c[0] * k,
          g: c[1] * k,
          b: c[2] * k,
          size: 0.035 + rand() * 0.03,
          life: 1.1 + rand() * 0.7,
          delay: f * 0.18 + rand() * 0.04,
          gravity: 0.1,
          drag: 1.4,
          shape: 'spark',
        },
        clear.time,
      );
    }
  }
}

function shards(ctx: EffectContext, clear: ClearInfo, count: number): void {
  const rand = Math.random;
  const n = ctx.bursts.budget(count * ctx.intensityScale * (ctx.reducedMotion ? 0.4 : 1));
  for (let i = 0; i < n; i++) {
    const cell = clear.cells[Math.floor(rand() * clear.cells.length)];
    if (!cell) break;
    const p = ctx.cellToWorld(cell.x, cell.y);
    const away = cell.x < 4.5 ? -1 : 1;
    const c = mixc(cell.color, SILK, 0.5);
    ctx.bursts.emit(
      { x: p.x, y: p.y, z: p.z + 0.4, vx: away * (3 + rand() * 6), vy: 1 + rand() * 3, vz: -1 - rand() * 3, r: c[0], g: c[1], b: c[2], size: 0.1 + rand() * 0.14, life: 1.2 + rand() * 0.6, delay: rand() * 0.1, gravity: 1.2, drag: 0.6, shape: 'shard', swirl: 0.4 },
      clear.time,
    );
  }
}

export const silkUnravel: LineClearEffect = {
  id: 'webSilkUnravel',
  description: 'Blocks dissolve into dark motes with violet embers; multi-line clears throw silk strands out of the board; QUADs a ring of luminous silk and crystal fragments.',
  trigger(ctx, clear) {
    const combo = Math.max(0, clear.combo);
    const build = 1 + Math.min(1, combo / 8) * 0.6;
    dissolve(ctx, clear, (0.8 + clear.intensity * 0.5) * build);
    if (clear.lines >= 2) {
      const quad = clear.lines >= 4 || clear.perfectClear;
      strands(ctx, clear, (quad ? 22 : 10 + clear.lines * 3) * build, (quad ? 26 : 16) * build, quad ? 1.5 : 1.05);
      if (quad) shards(ctx, clear, 40 * build);
    }
  },
};

export const webArrival: TransitionEffect = {
  id: 'webArrival',
  description: 'Silk threads drift across the view and dark motes settle as the ruins fade in.',
  play(ctx) {
    const scale = ctx.intensityScale * (ctx.reducedMotion ? 0.35 : 1);
    const rand = Math.random;
    const range = (a: number, b: number) => a + rand() * (b - a);
    for (let i = 0, n = ctx.bursts.budget(380 * scale); i < n; i++) {
      const k = range(0.4, 0.9);
      ctx.bursts.emit({ x: range(-40, 40), y: range(-12, 18), z: range(-20, 6), vx: range(0.6, 2.2) * (rand() < 0.5 ? -1 : 1), vy: range(-0.4, 0.4), vz: 0, r: SILK[0] * k, g: SILK[1] * k, b: SILK[2] * k, size: range(0.03, 0.06), life: range(1.6, 2.8), delay: rand() * ctx.duration * 0.8, drag: 0.5, swirl: 0.6, shape: 'spark' }, ctx.time);
    }
    for (let i = 0, n = ctx.bursts.budget(140 * scale); i < n; i++) {
      ctx.bursts.emit({ x: range(-40, 40), y: range(-6, 16), z: range(-24, -4), vx: range(-0.3, 0.3), vy: range(-1.2, -0.4), vz: 0, r: DARK[0], g: DARK[1], b: DARK[2], size: range(1.2, 2.6), life: range(2.4, 3.4), delay: rand() * ctx.duration * 0.6, drag: 0.4, shape: 'soft' }, ctx.time);
    }
  },
};
