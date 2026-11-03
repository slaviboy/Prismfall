import { Color } from 'three/webgpu';
import { registries } from '../../sdk/registry';
import type { TransitionContext, TransitionEffect } from '../../sdk/types';
import type { BurstParticle } from '../particles/BurstSystem';

/**
 * Themed stage transitions: the incoming world announces itself while the environments crossfade
 * (sand sweeping in, frost growing around the playfield, stars rushing past, petals drifting...).
 * Everything is fire-and-forget GPU burst particles, so a mid-game Voyage transition costs no
 * per-frame work. Particles stay sparse over the playfield so play remains readable.
 */

const tmp = new Color();
function rgb(hex: string, scale = 1): [number, number, number] {
  tmp.set(hex).convertSRGBToLinear();
  return [tmp.r * scale, tmp.g * scale, tmp.b * scale];
}

const rand = Math.random;
const range = (a: number, b: number): number => a + rand() * (b - a);
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;

/** True for points inside the playfield rectangle (kept clear except for a light dusting). */
const overBoard = (x: number, y: number): boolean => Math.abs(x) < 6.2 && Math.abs(y) < 11;

function emitter(ctx: TransitionContext) {
  const scale = ctx.intensityScale * (ctx.reducedMotion ? 0.35 : 1);
  return {
    count: (n: number): number => ctx.bursts.budget(n * scale),
    emit: (p: BurstParticle): void => ctx.bursts.emit(p, ctx.time),
  };
}

function colors(ctx: TransitionContext, params: Readonly<Record<string, unknown>>, fallback: readonly string[]): [number, number, number][] {
  const list = Array.isArray(params.colors) ? (params.colors as string[]) : fallback.map((c) => (c === 'accent' ? ctx.palette.accent : c === 'highlight' ? ctx.palette.highlight : c === 'secondary' ? ctx.palette.secondary : c));
  return list.map((c) => rgb(c));
}

const make = (id: string, description: string, play: TransitionEffect['play']): TransitionEffect => ({ id, description, play });

export const BUILTIN_TRANSITIONS: readonly TransitionEffect[] = [
  make('warp', 'Light streaks rush past toward the viewer.', (ctx) => {
    const e = emitter(ctx);
    const c = rgb(ctx.palette.accent, 2.5);
    for (let i = 0, n = e.count(500); i < n; i++) {
      const a = rand() * Math.PI * 2;
      const r = 6 + rand() * 30;
      e.emit({ x: Math.cos(a) * r, y: Math.sin(a) * r * 0.6, z: -60 - rand() * 80, vx: 0, vy: 0, vz: 70 + rand() * 60, r: c[0], g: c[1], b: c[2], size: 0.3 + rand() * 0.5, life: 1.2 + rand() * 0.6, delay: rand() * 0.8, drag: 0.1, shape: 'spark' });
    }
  }),
  make('sand', 'Golden sand and dust sweep in on the wind.', (ctx, params) => {
    const e = emitter(ctx);
    const pal = colors(ctx, params, ['#ffd08a', '#f0a95a', 'accent', 'highlight']);
    const d = ctx.duration;
    for (let i = 0, n = e.count(1600); i < n; i++) {
      const y = range(-15, 15);
      const c = pick(pal);
      const k = range(0.6, 1.4);
      e.emit({ x: range(-55, -38), y, z: range(-22, 4), vx: range(24, 42), vy: range(-0.5, 2), vz: range(-1, 1), r: c[0] * k, g: c[1] * k, b: c[2] * k, size: range(0.05, 0.16), life: range(1.8, 2.8), delay: rand() * d * 0.7, drag: 0.25, swirl: 1.4, shape: 'soft' });
    }
    // Dust clouds trailing the sweep.
    for (let i = 0, n = e.count(160); i < n; i++) {
      const c = pick(pal);
      e.emit({ x: range(-55, -40), y: range(-14, 2), z: range(-30, -10), vx: range(16, 26), vy: range(0.2, 1.2), vz: 0, r: c[0] * 0.05, g: c[1] * 0.05, b: c[2] * 0.05, size: range(1.4, 2.8), life: range(2.4, 3.4), delay: 0.2 + rand() * d * 0.6, drag: 0.35, swirl: 0.8, shape: 'soft' });
    }
  }),
  make('frost', 'Ice crystals grow around the playfield, then snow drifts across.', (ctx, params) => {
    const e = emitter(ctx);
    const pal = colors(ctx, params, ['#dff4ff', '#9fdcff', 'highlight']);
    const d = ctx.duration;
    // Crystals bloom along the frame from the bottom up.
    for (let i = 0, n = e.count(520); i < n; i++) {
      const side = rand();
      let x: number;
      let y: number;
      if (side < 0.7) {
        x = (rand() < 0.5 ? -1 : 1) * range(5.6, 7.5);
        y = range(-10.8, 10.8);
      } else {
        x = range(-7, 7);
        y = rand() < 0.5 ? range(-11.8, -10.6) : range(10.6, 11.8);
      }
      const out = Math.sign(x) || 1;
      const c = pick(pal);
      const k = range(1.2, 2.6);
      e.emit({ x, y, z: range(0.2, 1.4), vx: out * range(0.2, 1.4), vy: range(-0.3, 0.6), vz: range(0, 0.8), r: c[0] * k, g: c[1] * k, b: c[2] * k, size: range(0.12, 0.42), life: range(1.4, 2.4), delay: ((y + 11) / 22) * d * 0.45 + rand() * 0.2, drag: 2.2, shape: rand() < 0.5 ? 'star' : 'shard' });
    }
    for (let i = 0, n = e.count(700); i < n; i++) {
      const x = range(-40, 40);
      const y = range(14, 20);
      const c = pick(pal);
      e.emit({ x, y, z: range(-20, 8), vx: range(1, 4), vy: range(-7, -4), vz: 0, r: c[0] * 1.3, g: c[1] * 1.3, b: c[2] * 1.3, size: range(0.08, 0.22), life: range(3, 4.5), delay: rand() * d * 0.8, drag: 0.2, swirl: 1.2, shape: 'soft' });
    }
  }),
  make('stars', 'Stars expand into view from the depths.', (ctx, params) => {
    const e = emitter(ctx);
    const pal = colors(ctx, params, ['#ffffff', '#cfe0ff', 'accent']);
    for (let i = 0, n = e.count(900); i < n; i++) {
      const a = rand() * Math.PI * 2;
      const r = range(0.5, 4);
      const speed = range(10, 34);
      const c = pick(pal);
      const k = range(1.4, 3);
      e.emit({ x: Math.cos(a) * r, y: Math.sin(a) * r * 0.7, z: range(-120, -60), vx: Math.cos(a) * speed, vy: Math.sin(a) * speed * 0.7, vz: range(30, 60), r: c[0] * k, g: c[1] * k, b: c[2] * k, size: range(0.12, 0.45), life: range(1.4, 2.4), delay: rand() * ctx.duration * 0.6, drag: 0.15, shape: rand() < 0.3 ? 'star' : 'spark' });
    }
  }),
  make('petals', 'Blossom petals drift in on a breeze.', (ctx, params) => {
    const e = emitter(ctx);
    const pal = colors(ctx, params, ['#ffc4d8', '#ff9ec0', '#fff0f4']);
    for (let i = 0, n = e.count(700); i < n; i++) {
      const x = range(-48, 30);
      const y = range(12, 22);
      const c = pick(pal);
      e.emit({ x, y, z: range(-18, 9), vx: range(3, 8), vy: range(-5, -2.5), vz: range(-0.5, 0.5), r: c[0] * 1.2, g: c[1] * 1.2, b: c[2] * 1.2, size: range(0.18, 0.42), life: range(3.5, 5), delay: rand() * ctx.duration * 0.8, drag: 0.3, swirl: 2.4, shape: 'petal' });
    }
  }),
  make('leaves', 'Leaves and glowing spores swirl past.', (ctx, params) => {
    const e = emitter(ctx);
    const pal = colors(ctx, params, ['#9be36a', '#e3c25a', '#5fc48c']);
    for (let i = 0, n = e.count(600); i < n; i++) {
      const c = pick(pal);
      e.emit({ x: range(-50, -30), y: range(-8, 16), z: range(-18, 8), vx: range(10, 18), vy: range(-2, 2), vz: range(-0.5, 0.5), r: c[0], g: c[1], b: c[2], size: range(0.2, 0.45), life: range(3, 4.2), delay: rand() * ctx.duration * 0.7, drag: 0.35, swirl: 3, shape: 'petal' });
    }
    const spore = rgb(ctx.palette.highlight, 2);
    for (let i = 0, n = e.count(300); i < n; i++) e.emit({ x: range(-40, 40), y: range(-14, 0), z: range(-15, 6), vx: range(-0.5, 0.5), vy: range(1, 3), vz: 0, r: spore[0], g: spore[1], b: spore[2], size: range(0.06, 0.14), life: range(2.5, 4), delay: rand() * ctx.duration, drag: 0.4, swirl: 1.5, shape: 'soft' });
  }),
  make('bubbles', 'Bubbles rise and rippling light reveals the deep.', (ctx, params) => {
    const e = emitter(ctx);
    const pal = colors(ctx, params, ['#bff4ff', '#7fd8ff', 'highlight']);
    for (let i = 0, n = e.count(800); i < n; i++) {
      const x = range(-40, 40);
      const big = rand() < 0.15;
      const c = pick(pal);
      if (overBoard(x, 0) && rand() < 0.7) continue;
      e.emit({ x, y: range(-20, -13), z: range(-18, 8), vx: range(-0.6, 0.6), vy: range(5, big ? 7 : 13), vz: 0, r: c[0] * 1.3, g: c[1] * 1.3, b: c[2] * 1.3, size: big ? range(0.5, 0.9) : range(0.1, 0.32), life: range(2.5, 3.5), delay: rand() * ctx.duration * 0.75, drag: 0.4, swirl: 1.6, shape: 'bubble' });
    }
    const shaft = rgb(ctx.palette.secondary, 0.25);
    for (let i = 0, n = e.count(60); i < n; i++) e.emit({ x: range(-35, 35), y: range(6, 16), z: range(-30, -10), vx: range(-0.4, 0.4), vy: range(-1.5, -0.5), vz: 0, r: shaft[0], g: shaft[1], b: shaft[2], size: range(3, 6), life: range(2, 3), delay: rand() * ctx.duration * 0.5, drag: 0.5, shape: 'soft' });
  }),
  make('aurora', 'Ribbons of aurora light flow across the sky.', (ctx, params) => {
    const e = emitter(ctx);
    const pal = colors(ctx, params, ['#5dffb0', '#3fd4ff', '#b47cff']);
    for (let band = 0; band < 3; band++) {
      const c = pal[band % pal.length] as [number, number, number];
      const baseY = 9 + band * 2.6;
      for (let i = 0, n = e.count(320); i < n; i++) {
        const x0 = range(-60, -40);
        const phase = rand() * Math.PI * 2;
        e.emit({ x: x0, y: baseY + Math.sin(phase) * 1.6, z: range(-30, -12) - band * 4, vx: range(18, 26), vy: Math.cos(phase) * 0.8, vz: 0, r: c[0] * 0.9, g: c[1] * 0.9, b: c[2] * 0.9, size: range(0.6, 1.4), life: range(3, 4), delay: band * 0.2 + rand() * ctx.duration * 0.6, drag: 0.2, swirl: 0.6, shape: 'soft' });
      }
    }
  }),
  make('embers', 'Embers and ash rise from below.', (ctx, params) => {
    const e = emitter(ctx);
    const pal = colors(ctx, params, ['#ffb24a', '#ff6a2a', '#ffd88a']);
    for (let i = 0, n = e.count(900); i < n; i++) {
      const c = pick(pal);
      const k = range(1.6, 3);
      e.emit({ x: range(-40, 40), y: range(-20, -12), z: range(-18, 8), vx: range(-1, 1.5), vy: range(5, 11), vz: 0, r: c[0] * k, g: c[1] * k, b: c[2] * k, size: range(0.06, 0.18), life: range(2, 3.2), delay: rand() * ctx.duration * 0.8, drag: 0.3, swirl: 1.8, shape: 'spark' });
    }
    for (let i = 0, n = e.count(120); i < n; i++) e.emit({ x: range(-40, 40), y: range(-18, -8), z: range(-25, -6), vx: range(-0.5, 0.5), vy: range(1.5, 3), vz: 0, r: 0.05, g: 0.04, b: 0.035, size: range(1.5, 3), life: range(2.5, 3.5), delay: rand() * ctx.duration * 0.6, drag: 0.4, shape: 'soft' });
  }),
  make('digital', 'Neon pixels and rain streak across the city.', (ctx, params) => {
    const e = emitter(ctx);
    const pal = colors(ctx, params, ['#ff3df0', '#3dfcff', 'accent']);
    for (let i = 0, n = e.count(700); i < n; i++) {
      const c = pick(pal);
      const k = range(1.6, 3);
      e.emit({ x: range(38, 55), y: range(-15, 15), z: range(-18, 8), vx: -range(30, 50), vy: 0, vz: 0, r: c[0] * k, g: c[1] * k, b: c[2] * k, size: range(0.12, 0.3), life: range(1.4, 2), delay: Math.floor(rand() * 12) * (ctx.duration / 16), drag: 0.1, shape: 'square' });
    }
    for (let i = 0, n = e.count(600); i < n; i++) e.emit({ x: range(-40, 40), y: range(14, 22), z: range(-20, 6), vx: -2, vy: -range(26, 36), vz: 0, r: 0.5, g: 0.6, b: 0.8, size: range(0.05, 0.1), life: range(1, 1.4), delay: rand() * ctx.duration * 0.8, drag: 0, shape: 'spark' });
  }),
  make('mist', 'Soft mist rolls through and clears.', (ctx, params) => {
    const e = emitter(ctx);
    const pal = colors(ctx, params, ['highlight', 'secondary']);
    for (let i = 0, n = e.count(220); i < n; i++) {
      const c = pick(pal);
      e.emit({ x: range(-50, -30), y: range(-12, 10), z: range(-30, -5), vx: range(12, 20), vy: range(-0.3, 0.3), vz: 0, r: c[0] * 0.2, g: c[1] * 0.2, b: c[2] * 0.2, size: range(3, 7), life: range(3, 4), delay: rand() * ctx.duration * 0.5, drag: 0.3, shape: 'soft' });
    }
  }),
];

let registered = false;
export function registerBuiltinTransitions(): void {
  if (registered) return;
  registered = true;
  for (const t of BUILTIN_TRANSITIONS) registries.transitions.register(t);
}

