import type { GroundField } from '../../sdk/types';

/** Per-environment ground height: flat at `base` until a terrain component provides a function. */
export function createGround(base: number): GroundField {
  let provider: ((x: number, z: number) => number) | null = null;
  let water: number | null = null;
  const height = (x: number, z: number): number => (provider ? provider(x, z) : base);
  return {
    height,
    provide(fn) {
      provider = fn;
    },
    surface: (x, z) => Math.max(height(x, z), water ?? -Infinity),
    setWaterLevel(y) {
      water = y;
    },
  };
}
