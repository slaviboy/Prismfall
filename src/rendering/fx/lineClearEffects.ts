import { Color } from 'three/webgpu';
import { registries } from '../../sdk/registry';
import type { ClearInfo, EffectContext, LineClearEffect } from '../../sdk/types';
import type { ParticleShape } from '../particles/BurstSystem';

/** Data-driven line-clear recipe; stages pick a named recipe and may override any field. */
export interface ClearRecipe {
  shape: ParticleShape;
  perCell: number;
  speed: [number, number];
  /** radial: away from row centre · up · down · sweep: along the row · implode: pull in then burst · rise: gentle float */
  motion: 'radial' | 'up' | 'down' | 'sweep' | 'implode' | 'rise';
  spread: number;
  gravity: number;
  drag: number;
  life: [number, number];
  size: [number, number];
  color: 'piece' | 'accent' | 'white' | 'mix' | 'highlight';
  brightness: number;
  swirl: number;
  /** Extra light streak along each cleared row. */
  streak: boolean;
  /** Secondary particles (embers, sparks, seeds). */
  secondary?: Partial<ClearRecipe> & { share: number };
}

const BASE: ClearRecipe = {
  shape: 'shard',
  perCell: 4,
  speed: [3, 9],
  motion: 'radial',
  spread: 0.8,
  gravity: -6,
  drag: 1.2,
  life: [0.5, 1.1],
  size: [0.18, 0.42],
  color: 'piece',
  brightness: 2.2,
  swirl: 0.5,
  streak: true,
};

export const CLEAR_RECIPES: Record<string, Partial<ClearRecipe>> = {
  prismBurst: {},
  tideSpray: { shape: 'soft', motion: 'sweep', speed: [6, 14], gravity: -9, drag: 1.4, color: 'mix', swirl: 1.2, secondary: { share: 0.5, shape: 'bubble', motion: 'rise', speed: [1, 3], gravity: 2, life: [1, 2], size: [0.1, 0.25], color: 'highlight' } },
  igniteQuench: { shape: 'spark', speed: [6, 16], motion: 'up', gravity: -16, drag: 0.7, color: 'white', brightness: 3, size: [0.12, 0.3], secondary: { share: 0.6, shape: 'soft', motion: 'rise', speed: [0.5, 2], gravity: 1.5, life: [1.2, 2.2], size: [0.4, 0.9], color: 'accent', brightness: 0.6 } },
  supernova: { shape: 'star', motion: 'implode', speed: [8, 20], gravity: 0, drag: 1.6, color: 'mix', brightness: 3.2, life: [0.8, 1.6], size: [0.15, 0.4], swirl: 0.2 },
  petalShatter: { shape: 'petal', speed: [3, 8], motion: 'radial', gravity: -2.5, drag: 1.8, swirl: 2.2, life: [1, 2], size: [0.25, 0.5], color: 'mix' },
  glitchSlice: { shape: 'square', motion: 'sweep', speed: [8, 18], gravity: 0, drag: 3, swirl: 0, life: [0.3, 0.7], size: [0.12, 0.32], color: 'piece', brightness: 2.6 },
  bubbleAscent: { shape: 'bubble', motion: 'rise', speed: [2, 5], gravity: 3, drag: 1.2, swirl: 1.4, life: [1.4, 2.4], size: [0.15, 0.45], color: 'highlight', brightness: 1.6, streak: false },
  crumbleDust: { shape: 'soft', motion: 'down', speed: [1, 4], gravity: -5, drag: 2.2, swirl: 1.6, life: [1.2, 2.2], size: [0.3, 0.7], color: 'accent', brightness: 0.9, secondary: { share: 0.5, shape: 'shard', motion: 'down', speed: [2, 5], gravity: -14, size: [0.1, 0.2], color: 'piece' } },
  frostShatter: { shape: 'shard', speed: [5, 13], motion: 'radial', gravity: -7, drag: 1.4, color: 'white', brightness: 2.4, secondary: { share: 0.5, shape: 'star', motion: 'rise', speed: [0.5, 2], gravity: 0.5, life: [1.2, 2], size: [0.1, 0.22], color: 'highlight' } },
  bloomSeeds: { shape: 'petal', motion: 'up', speed: [2, 6], gravity: -1.2, drag: 1.6, swirl: 2.6, life: [1.4, 2.6], size: [0.2, 0.42], color: 'mix', secondary: { share: 0.4, shape: 'soft', motion: 'rise', speed: [0.5, 1.5], gravity: 0.8, life: [2, 3], size: [0.08, 0.16], color: 'highlight' } },
  fadeToLight: { shape: 'soft', motion: 'rise', speed: [0.8, 2.4], gravity: 1.2, drag: 0.8, swirl: 0.6, life: [1.6, 2.8], size: [0.25, 0.6], color: 'white', brightness: 1.5, streak: true },
};

const tmp = new Color();

function rgb(hex: string): [number, number, number] {
  tmp.set(hex).convertSRGBToLinear();
  return [tmp.r, tmp.g, tmp.b];
}

function pickColor(mode: ClearRecipe['color'], cell: readonly [number, number, number], ctx: EffectContext, r: number): [number, number, number] {
  switch (mode) {
    case 'accent':
      return rgb(ctx.palette.accent);
    case 'highlight':
      return rgb(ctx.palette.highlight);
    case 'white':
      return [1, 0.96, 0.9];
    case 'mix': {
      const a = rgb(ctx.palette.highlight);
      return r < 0.5 ? [cell[0], cell[1], cell[2]] : a;
    }
    default:
      return [cell[0], cell[1], cell[2]];
  }
}

/** Runs a recipe over every cleared cell. Counts scale with intensity and the particle budget. */
export function runRecipe(ctx: EffectContext, clear: ClearInfo, recipe: ClearRecipe, shareOfCells = 1): void {
  const scale = (0.55 + clear.intensity * 0.9) * ctx.intensityScale;
  const perCell = recipe.perCell * scale * shareOfCells;
  const swirl = recipe.swirl * (1 + Math.min(1, clear.combo / 6));
  const rand = Math.random;
  const centerX = 0;
  for (const cell of clear.cells) {
    const n = ctx.bursts.budget(perCell);
    const p = ctx.cellToWorld(cell.x, cell.y);
    for (let i = 0; i < n; i++) {
      const speed = recipe.speed[0] + rand() * (recipe.speed[1] - recipe.speed[0]);
      let vx: number;
      let vy: number;
      let vz = (rand() - 0.2) * recipe.spread * speed * 0.6;
      let delay = 0;
      switch (recipe.motion) {
        case 'up':
          vx = (rand() - 0.5) * recipe.spread * speed;
          vy = speed;
          break;
        case 'down':
          vx = (rand() - 0.5) * recipe.spread * speed;
          vy = -speed * 0.4;
          break;
        case 'rise':
          vx = (rand() - 0.5) * recipe.spread * speed;
          vy = speed * (0.6 + rand() * 0.6);
          break;
        case 'sweep':
          vx = (cell.x < 5 ? -1 : 1) * speed;
          vy = (rand() - 0.3) * recipe.spread * speed;
          delay = Math.abs(cell.x - 4.5) * 0.012;
          break;
        case 'implode':
          vx = (p.x - centerX) * -0.4 + (rand() - 0.5) * speed;
          vy = (rand() - 0.5) * speed * 1.4;
          vz = (rand() - 0.5) * speed;
          delay = 0.06 + rand() * 0.05;
          break;
        default: {
          const a = rand() * Math.PI * 2;
          vx = Math.cos(a) * speed + (p.x - centerX) * 0.25;
          vy = Math.sin(a) * speed * 0.8 + 1.5;
        }
      }
      const [r, g, b] = pickColor(recipe.color, cell.color, ctx, rand());
      const life = recipe.life[0] + rand() * (recipe.life[1] - recipe.life[0]);
      ctx.bursts.emit(
        {
          x: p.x + (rand() - 0.5) * 0.8,
          y: p.y + (rand() - 0.5) * 0.8,
          z: p.z + (rand() - 0.5) * 0.6 + 0.3,
          vx,
          vy,
          vz,
          r: r * recipe.brightness,
          g: g * recipe.brightness,
          b: b * recipe.brightness,
          size: recipe.size[0] + rand() * (recipe.size[1] - recipe.size[0]),
          life,
          delay,
          gravity: recipe.gravity,
          drag: recipe.drag,
          shape: recipe.shape,
          swirl,
        },
        clear.time,
      );
    }
  }
  if (recipe.streak) {
    for (const row of clear.rows) {
      const n = ctx.bursts.budget(18 * ctx.intensityScale);
      for (let i = 0; i < n; i++) {
        const t = i / Math.max(1, n - 1);
        const p = ctx.cellToWorld(-0.5 + t * 10, row);
        const c = pickColor('highlight', [1, 1, 1], ctx, 1);
        ctx.bursts.emit({ x: p.x, y: p.y, z: 0.7, vx: 0, vy: 0.4, vz: 0, r: c[0] * 2.5, g: c[1] * 2.5, b: c[2] * 2.5, size: 0.9, life: 0.32, delay: t * 0.08, drag: 2, shape: 'soft' }, clear.time);
      }
    }
  }
  if (recipe.secondary && shareOfCells === 1) {
    const { share, ...rest } = recipe.secondary;
    runRecipe(ctx, clear, { ...recipe, ...rest, secondary: undefined, streak: false }, share);
  }
}

export function makeRecipeEffect(id: string, partial: Partial<ClearRecipe>, description: string): LineClearEffect {
  return {
    id,
    description,
    trigger(ctx, clear, params) {
      runRecipe(ctx, clear, { ...BASE, ...partial, ...(params as Partial<ClearRecipe>) });
    },
  };
}

let registered = false;
export function registerBuiltinEffects(): void {
  if (registered) return;
  registered = true;
  for (const [id, recipe] of Object.entries(CLEAR_RECIPES)) registries.lineClearEffects.register(makeRecipeEffect(id, recipe, `Built-in ${id} clear`));
}

export { BASE as BASE_RECIPE };
