import type { GroundField } from '../../sdk/types';

/** Per-environment ground height: flat at `base` until a terrain component provides a function. */
export function createGround(base: number): GroundField {
  let provider: ((x: number, z: number) => number) | null = null;
  return {
    height: (x, z) => (provider ? provider(x, z) : base),
    provide(fn) {
      provider = fn;
    },
  };
}
