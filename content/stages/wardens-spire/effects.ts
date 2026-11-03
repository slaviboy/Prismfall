import type { BurstParticle, ClearInfo, EffectContext, LineClearEffect } from '@prismfall/sdk';

/**
 * Line clears of The Warden's Spire. Molten energy runs through each cleared row as a hot front
 * (from one end to the other), and the stone dissolves behind it into glowing embers and dark
 * red shards. Two or three lines send an energy wave of sparks out from the board along the
 * rows; a QUAD adds a dark-energy implosion and a slow column of embers. Combos ramp the counts
 * and the heat. The world's own answer to a QUAD (the lava brightening, rarely the Warden
 * stirring) is the Warden's.
 */

const HOT: [number, number, number] = [1.0, 0.62, 0.26];
const MOLTEN: [number, number, number] = [1.0, 0.24, 0.05];
const DEEP: [number, number, number] = [0.55, 0.05, 0.01];

function emit(ctx: EffectContext, p: BurstParticle, t: number): void {
  ctx.bursts.emit(p, t);
}

export const wardenRend: LineClearEffect = {
  id: 'wardenRend',
  description: 'Molten energy runs through the cleared rows, which dissolve into embers and dark red shards; bigger clears send a red energy wave from the board.',
  trigger(ctx: EffectContext, clear: ClearInfo, params: Readonly<Record<string, unknown>>) {
    const rand = Math.random;
    const t = clear.time;
    const combo = Math.max(0, Math.min(8, clear.combo));
    const ramp = 1 + combo * 0.12;
    const calm = ctx.reducedMotion ? 0.45 : 1;
    const scale = (0.6 + clear.intensity * 0.6) * ctx.intensityScale * ramp * calm;
    const brightness = typeof params.brightness === 'number' ? params.brightness : 1;
    const dir = rand() < 0.5 ? 1 : -1;
    const frontSpeed = 0.022; // seconds per cell
    for (const row of clear.rows) {
      // The molten front: a bright crawl across the row.
      const fronts = ctx.bursts.budget(26 * scale);
      for (let i = 0; i < fronts; i++) {
        const k = i / Math.max(1, fronts - 1);
        const cx = dir > 0 ? -0.5 + k * 10 : 9.5 - k * 10;
        const p = ctx.cellToWorld(cx, row);
        emit(ctx, { x: p.x, y: p.y + (rand() - 0.5) * 0.5, z: p.z + 0.55, vx: dir * (1.5 + rand() * 2), vy: (rand() - 0.3) * 1.2, vz: 0.3, r: HOT[0] * 2.6 * brightness, g: HOT[1] * 2.6 * brightness, b: HOT[2] * 2.6 * brightness, size: 0.42 + rand() * 0.3, life: 0.22 + rand() * 0.12, delay: k * 10 * frontSpeed, drag: 3, shape: 'spark' }, t);
      }
    }
    for (const cell of clear.cells) {
      const p = ctx.cellToWorld(cell.x, cell.y);
      const order = dir > 0 ? cell.x + 0.5 : 9.5 - cell.x;
      const after = order * frontSpeed + 0.03;
      // Embers: the block's colour heated towards molten orange, rising and cooling away.
      const embers = ctx.bursts.budget(5 * scale);
      for (let i = 0; i < embers; i++) {
        const mix = 0.55 + rand() * 0.4;
        const r = (cell.color[0] * (1 - mix) + MOLTEN[0] * mix) * 2.2 * brightness;
        const g = (cell.color[1] * (1 - mix) + MOLTEN[1] * mix) * 2.2 * brightness;
        const b = (cell.color[2] * (1 - mix) + MOLTEN[2] * mix) * 2.2 * brightness;
        emit(ctx, { x: p.x + (rand() - 0.5) * 0.8, y: p.y + (rand() - 0.5) * 0.8, z: p.z + 0.3 + rand() * 0.3, vx: (rand() - 0.5) * 2.2, vy: 1.2 + rand() * 2.8 * calm, vz: (rand() - 0.3) * 1.4, r, g, b, size: 0.14 + rand() * 0.2, life: 0.9 + rand() * 1.0, delay: after + rand() * 0.05, gravity: 1.4, drag: 1.2, shape: 'soft', swirl: 0.8 * ramp }, t);
      }
      // Dark red shards falling away (the stone breaking).
      const shards = ctx.bursts.budget(2.5 * scale);
      for (let i = 0; i < shards; i++) {
        emit(ctx, { x: p.x + (rand() - 0.5) * 0.7, y: p.y + (rand() - 0.5) * 0.7, z: p.z + 0.4, vx: (rand() - 0.5) * 4, vy: 1 + rand() * 3, vz: (rand() - 0.2) * 2, r: DEEP[0] * 1.6 + cell.color[0] * 0.25, g: DEEP[1] * 1.6 + cell.color[1] * 0.25, b: DEEP[2] * 1.6 + cell.color[2] * 0.25, size: 0.12 + rand() * 0.16, life: 0.6 + rand() * 0.5, delay: after, gravity: -16, drag: 0.8, shape: 'shard', swirl: 0.3 }, t);
      }
    }
    const lines = clear.lines;
    if (lines >= 2) {
      // Energy wave out from the board along the cleared rows, to both sides.
      const sheet = ctx.bursts.budget((60 + lines * 30) * scale);
      for (let i = 0; i < sheet; i++) {
        const side = i % 2 === 0 ? 1 : -1;
        const row = clear.rows[i % clear.rows.length]!;
        const p = ctx.cellToWorld(side > 0 ? 9.5 : -0.5, row);
        const sp = (9 + rand() * 12) * calm;
        emit(ctx, { x: p.x, y: p.y + (rand() - 0.5) * 0.8, z: p.z + 0.3, vx: side * sp, vy: (rand() - 0.5) * 2.5, vz: (rand() - 0.5) * 3, r: MOLTEN[0] * 2 * brightness, g: MOLTEN[1] * 2 * brightness, b: MOLTEN[2] * 2 * brightness, size: 0.16 + rand() * 0.2, life: 0.5 + rand() * 0.35, delay: 0.12 + rand() * 0.06, drag: 1.6, shape: 'spark' }, t);
      }
    }
    if (lines >= 4 || clear.perfectClear) {
      // QUAD: dark-energy implosion then a slow column of embers rising off the board.
      const cy = clear.rows.reduce((s, r) => s + r, 0) / clear.rows.length;
      const c = ctx.cellToWorld(4.5, cy);
      const n = ctx.bursts.budget(160 * scale);
      for (let i = 0; i < n; i++) {
        const a = rand() * Math.PI * 2;
        const r = 4 + rand() * 6;
        const x = c.x + Math.cos(a) * r;
        const y = c.y + Math.sin(a) * r * 0.9;
        emit(ctx, { x, y, z: c.z + 0.5, vx: (c.x - x) * 1.6, vy: (c.y - y) * 1.6 + 1.5, vz: (rand() - 0.5) * 2, r: DEEP[0] * 2.4, g: DEEP[1] * 2.4, b: DEEP[2] * 2.4, size: 0.18 + rand() * 0.22, life: 0.55 + rand() * 0.3, delay: rand() * 0.08, drag: 2.4, shape: 'soft', swirl: 1.4 }, t);
      }
      const col = ctx.bursts.budget(120 * scale);
      for (let i = 0; i < col; i++) {
        emit(ctx, { x: c.x + (rand() - 0.5) * 9, y: c.y + (rand() - 0.5) * 3, z: c.z + rand() * 0.8, vx: (rand() - 0.5) * 1.5, vy: (2.5 + rand() * 4) * calm, vz: (rand() - 0.5) * 1.2, r: MOLTEN[0] * 2.4, g: MOLTEN[1] * 2.2, b: MOLTEN[2] * 2, size: 0.12 + rand() * 0.18, life: 1.6 + rand() * 1.2, delay: 0.35 + rand() * 0.5, gravity: 1.2, drag: 0.9, shape: 'soft', swirl: 1.2 }, t);
      }
    }
  },
};
