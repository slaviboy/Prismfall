import { BASE_RECIPE, runRecipe, type ClearRecipe, type LineClearEffect } from '@prismfall/sdk';

const recipe = (r: Partial<ClearRecipe>): ClearRecipe => ({
  ...BASE_RECIPE,
  ...r,
});

/** Splintered timber: small shards in the piece colour, falling like wood chips. */
const SPLINTERS = recipe({
  shape: 'shard',
  perCell: 3,
  speed: [2.5, 6.5],
  motion: 'radial',
  spread: 0.7,
  gravity: -11,
  drag: 1.5,
  life: [0.6, 1.2],
  size: [0.08, 0.2],
  color: 'piece',
  brightness: 1.15,
  swirl: 0.4,
  streak: false,
});
/** Golden dust lifted off the row and carried away on the wind, lit by the low sun. */
const DUST = recipe({
  shape: 'soft',
  perCell: 5,
  speed: [0.8, 2.6],
  motion: 'wind',
  spread: 1,
  gravity: 0.25,
  drag: 1.1,
  life: [1.3, 2.4],
  size: [0.35, 0.8],
  color: 'accent',
  brightness: 0.42,
  swirl: 1.4,
  streak: false,
});
/** Warm motes settling. */
const MOTES = recipe({
  shape: 'soft',
  perCell: 2,
  speed: [0.4, 1.4],
  motion: 'rise',
  spread: 1.2,
  gravity: -0.3,
  drag: 0.9,
  life: [1.6, 2.8],
  size: [0.06, 0.14],
  color: 'highlight',
  brightness: 0.8,
  swirl: 1.8,
  streak: false,
});
/** Sparks off iron straps on a QUAD (a few, short: a forge, not fireworks). */
const SPARKS = recipe({
  shape: 'spark',
  perCell: 1.2,
  speed: [4, 10],
  motion: 'up',
  spread: 1.1,
  gravity: -14,
  drag: 0.8,
  life: [0.35, 0.8],
  size: [0.06, 0.14],
  color: 'highlight',
  brightness: 1.6,
  swirl: 0.2,
  streak: false,
});

/**
 * The Last Frontier's line clear: rows split into wood splinters and golden dust that the wind
 * carries out into the world; doubles and triples throw more, a QUAD adds a short shower of forge
 * sparks and a wide sweep of sunlit dust (the world answers with a gust, and soon a train). Combos
 * stir the dust harder. Never a cartoon explosion: no flash, no ring.
 */
export const dustAndTimber: LineClearEffect = {
  id: 'dustAndTimber',
  description: 'Rows split into wood splinters and golden dust blown away on the wind; QUADs add forge sparks.',
  trigger(ctx, clear) {
    const lines = Math.max(1, clear.lines);
    const combo = Math.max(0, clear.combo);
    const more = 1 + (lines - 1) * 0.35 + Math.min(0.6, combo * 0.08);
    runRecipe(ctx, clear, SPLINTERS, more);
    runRecipe(ctx, clear, { ...DUST, swirl: DUST.swirl * (1 + Math.min(1, combo / 5)) }, more);
    runRecipe(ctx, clear, MOTES, 0.6 + lines * 0.2);
    if (lines >= 4 || clear.perfectClear) {
      runRecipe(ctx, clear, SPARKS, ctx.reducedMotion ? 0.4 : 1);
      runRecipe(
        ctx,
        clear,
        {
          ...DUST,
          perCell: 4,
          speed: [2, 5],
          life: [1.8, 3],
          size: [0.5, 1.1],
          brightness: 0.36,
        },
        1,
      );
    }
  },
};
