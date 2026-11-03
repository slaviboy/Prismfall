import type { PiecePalette } from './palette';

/**
 * Piece colours for block themes. Each keeps the familiar hue family per piece (I cyan, O yellow,
 * T purple, S green, Z red, J blue, L orange) so pieces stay distinguishable, in the theme's
 * material language. Stages reference these by copying them into `blocks.palette`.
 */
export const THEME_PALETTES = {
  stainedWood: { I: '#4f8fa3', O: '#d6a03c', T: '#8b5a9f', S: '#6c9a45', Z: '#b44a35', J: '#3d5c94', L: '#c97632' },
  paleIce: { I: '#8fe3ff', O: '#ffe7a0', T: '#c9aaff', S: '#9debc0', Z: '#ffa9bb', J: '#9cbcff', L: '#ffc999' },
  desertStone: { I: '#6fb3c2', O: '#e8bf6e', T: '#b282a6', S: '#98ac6c', Z: '#c9643f', J: '#6680b8', L: '#dc934f' },
  emberGlow: { I: '#33d6ff', O: '#ffcf33', T: '#c266ff', S: '#5cff7a', Z: '#ff3d3d', J: '#4d6bff', L: '#ff8a1f' },
} satisfies Record<string, PiecePalette>;
