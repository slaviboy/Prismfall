import type { ClearInfo, EffectContext, LineClearEffect, TransitionEffect } from '@prismfall/sdk';

/**
 * Dark Storm's line clears: the cleared rows discharge.
 *
 * - One line: a controlled electrical wave: a jagged arc crackles along the row from end to end
 *   and every block breaks into cold sparks tinted with its own colour, thrown out along the row.
 * - Two or three: brighter arcs that leap out past the board's sides into the storm, more sparks,
 *   and (from the world) a flicker inside the clouds.
 * - QUAD: arcs fork along every row and out into the world on both sides, a burst of fine charged
 *   rain around the board, and the storm answers with a strike of its own and its thunder.
 * Combos build gradually. Everything is quick and dim at the core of the board, so the playfield
 * is never covered; the effects-intensity and reduced-motion settings scale it all down.
 */

const ARC: [number, number, number] = [0.72, 0.82, 1.0];

function mixc(a: readonly [number, number, number], b: readonly [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** A jagged arc from x0 to x1 at height y (board units): points by midpoint displacement. */
function arcPoints(x0: number, x1: number, y: number, jag: number, levels: number): [number, number][] {
  let pts: [number, number][] = [
    [x0, y],
    [x1, y],
  ];
  let amp = jag;
  for (let l = 0; l < levels; l++) {
    const next: [number, number][] = [pts[0]!];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i]!;
      const [bx, by] = pts[i + 1]!;
      next.push([(ax + bx) / 2 + (Math.random() - 0.5) * amp * 0.3, (ay + by) / 2 + (Math.random() - 0.5) * amp], [bx, by]);
    }
    pts = next;
    amp *= 0.55;
  }
  return pts;
}

/** Emits a crackling arc along a row: bright points that light in a quick sweep, then die. */
function arc(ctx: EffectContext, clear: ClearInfo, row: number, x0: number, x1: number, bright: number, sweep: number): void {
  const pts = arcPoints(x0, x1, row, 1.1, 5);
  const per = ctx.reducedMotion ? 1 : 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[i + 1]!;
    const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) * 3 * per));
    const n = ctx.bursts.budget(steps);
    for (let k = 0; k < n; k++) {
      const t = (k + Math.random()) / Math.max(1, n);
      const cx = ax + (bx - ax) * t;
      const cy = ay + (by - ay) * t;
      const p = ctx.cellToWorld(cx, cy);
      const along = (cx - x0) / Math.max(0.001, x1 - x0);
      const b = bright * (0.7 + Math.random() * 0.6);
      ctx.bursts.emit({ x: p.x, y: p.y, z: p.z + 0.55, vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4, vz: 0.2, r: ARC[0] * b, g: ARC[1] * b, b: ARC[2] * b, size: 0.09 + Math.random() * 0.07, life: 0.16 + Math.random() * 0.14, delay: Math.abs(along) * sweep, gravity: 0, drag: 2, shape: 'spark', swirl: 0 }, clear.time);
    }
  }
}

function sparks(ctx: EffectContext, clear: ClearInfo, strength: number): void {
  const per = 3.2 * strength * ctx.intensityScale * (ctx.reducedMotion ? 0.5 : 1);
  for (const cell of clear.cells) {
    const n = ctx.bursts.budget(per);
    const p = ctx.cellToWorld(cell.x, cell.y);
    const away = cell.x < 4.5 ? -1 : 1;
    for (let i = 0; i < n; i++) {
      const tint = mixc(cell.color, ARC, 0.45 + Math.random() * 0.4);
      const b = 0.9 + Math.random() * 0.7;
      const speed = 3 + Math.random() * 5 * strength;
      ctx.bursts.emit(
        {
          x: p.x + (Math.random() - 0.5) * 0.8,
          y: p.y + (Math.random() - 0.5) * 0.8,
          z: p.z + 0.4,
          vx: away * speed * (0.6 + Math.random() * 0.6),
          vy: (Math.random() - 0.35) * speed * 0.45,
          vz: (Math.random() - 0.2) * 2,
          r: tint[0] * b,
          g: tint[1] * b,
          b: tint[2] * b,
          size: 0.06 + Math.random() * 0.07,
          life: 0.35 + Math.random() * 0.45,
          delay: Math.random() * 0.08,
          gravity: 3.5,
          drag: 1.8,
          shape: 'spark',
          swirl: 0.3,
        },
        clear.time,
      );
    }
    // A faint cold glow left behind where the block was.
    if (ctx.bursts.budget(1) > 0) {
      const c = mixc(cell.color, ARC, 0.6);
      ctx.bursts.emit({ x: p.x, y: p.y, z: p.z + 0.3, vx: 0, vy: 0.2, vz: 0, r: c[0] * 0.25, g: c[1] * 0.25, b: c[2] * 0.25, size: 1.1, life: 0.45, delay: 0, gravity: 0, drag: 1, shape: 'soft', swirl: 0 }, clear.time);
    }
  }
}

/** Charged rain: fine bright drops falling around the board for a moment (QUADs). */
function chargedRain(ctx: EffectContext, clear: ClearInfo, count: number): void {
  const n = ctx.bursts.budget(count * ctx.intensityScale * (ctx.reducedMotion ? 0.4 : 1));
  for (let i = 0; i < n; i++) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = 4.5 + side * (6 + Math.random() * 7);
    const y = 4 + Math.random() * 18;
    const p = ctx.cellToWorld(x, y);
    const b = 0.5 + Math.random() * 0.6;
    ctx.bursts.emit({ x: p.x, y: p.y, z: p.z - Math.random() * 3, vx: -1.5, vy: -14 - Math.random() * 6, vz: 0, r: ARC[0] * b, g: ARC[1] * b, b: ARC[2] * b, size: 0.05 + Math.random() * 0.04, life: 0.6 + Math.random() * 0.5, delay: Math.random() * 0.35, gravity: 0, drag: 0, shape: 'spark', swirl: 0 }, clear.time);
  }
}

export const stormSurge: LineClearEffect = {
  id: 'stormSurge',
  description: 'Cleared rows discharge: a crackling arc runs along each row and the blocks break into cold sparks; bigger clears arc out into the storm.',
  trigger(ctx, clear) {
    const combo = Math.max(0, clear.combo);
    const build = 1 + Math.min(1, combo / 8) * 0.6;
    const quad = clear.lines >= 4 || clear.perfectClear;
    const bright = (0.9 + clear.lines * 0.25) * build * ctx.intensityScale;
    for (const row of clear.rows) {
      const reach = clear.lines >= 2 ? 2.5 + clear.lines * 1.6 * build : 0;
      arc(ctx, clear, row, -0.4 - reach, 9.4 + reach, bright, 0.07);
      if (quad) arc(ctx, clear, row + (Math.random() - 0.5) * 0.6, 9.4 + reach, -0.4 - reach, bright * 0.7, 0.05);
    }
    sparks(ctx, clear, (0.7 + clear.intensity * 0.5) * build);
    if (quad) chargedRain(ctx, clear, 260 * build);
  },
};

/** The world's entrance: a front of wind-driven rain sweeps across, lit by a flicker of lightning. */
export const stormFront: TransitionEffect = {
  id: 'stormFront',
  description: 'A squall line sweeps in: sheets of wind-driven rain cross the view, lit by a flicker of lightning.',
  play(ctx, params) {
    const colors = (params.colors as string[] | undefined) ?? [];
    const toRgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
    const palette = colors.length > 0 ? colors.map(toRgb) : [[0.55, 0.62, 0.74] as [number, number, number], [0.32, 0.36, 0.44] as [number, number, number]];
    const n = ctx.bursts.budget(900 * ctx.intensityScale * (ctx.reducedMotion ? 0.35 : 1));
    for (let i = 0; i < n; i++) {
      const c = palette[i % palette.length]!;
      const b = 0.35 + Math.random() * 0.5;
      const delay = Math.random() * ctx.duration * 0.7;
      ctx.bursts.emit(
        {
          x: 22 + Math.random() * 10,
          y: -14 + Math.random() * 36,
          z: -6 - Math.random() * 20,
          vx: -26 - Math.random() * 14,
          vy: -12 - Math.random() * 6,
          vz: 0,
          r: c[0] * b,
          g: c[1] * b,
          b: c[2] * b,
          size: 0.06 + Math.random() * 0.06,
          life: 1.4 + Math.random() * 0.8,
          delay,
          gravity: 0,
          drag: 0,
          shape: 'spark',
          swirl: 0,
        },
        ctx.time,
      );
    }
  },
};
