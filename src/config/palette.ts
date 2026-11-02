import type { PieceType } from '../game/pieces/pieces';

export type PiecePalette = Readonly<Record<PieceType, string>>;

/** Familiar genre hue families in Prismfall's own tones. Stages may tint, never swap, these. */
export const DEFAULT_PALETTE: PiecePalette = {
  I: '#4de3ff',
  O: '#ffd54d',
  T: '#b36bff',
  S: '#5cf28a',
  Z: '#ff5470',
  J: '#4d7cff',
  L: '#ff9a3d',
};

/** Colour-blind-safe set (Okabe–Ito derived) with maximal pairwise contrast. */
export const HIGH_CONTRAST_PALETTE: PiecePalette = {
  I: '#56b4e9',
  O: '#f0e442',
  T: '#cc79a7',
  S: '#009e73',
  Z: '#d55e00',
  J: '#0072b2',
  L: '#e69f00',
};

/** Face glyph per piece for the "piece glyphs" accessibility option. */
export const PIECE_GLYPHS: Readonly<Record<PieceType, string>> = {
  I: 'bar',
  O: 'ring',
  T: 'triangle',
  S: 'slash',
  Z: 'backslash',
  J: 'dot',
  L: 'plus',
};

export const GARBAGE_COLOR = '#7c7f99';

export function paletteFor(highContrast: boolean): PiecePalette {
  return highContrast ? HIGH_CONTRAST_PALETTE : DEFAULT_PALETTE;
}
