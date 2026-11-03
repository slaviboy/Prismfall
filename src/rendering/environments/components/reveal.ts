import { cameraPosition, float, length, mx_noise_float, positionWorld, smoothstep, step } from 'three/tsl';
import type { Node } from 'three/webgpu';

/**
 * Opacity mask for opaque scenery during stage crossfades: the world is revealed outward from the
 * viewer as presence rises (with a ragged, organic edge) instead of popping in or fading to black.
 * Use with `material.alphaTest = 0.5`. At presence 1 everything is visible.
 */
export function revealMask(presence: Node<'float'>, reach = 1400): Node<'float'> {
  const dist = length(positionWorld.sub(cameraPosition));
  const edge = mx_noise_float(positionWorld.mul(0.045)).mul(0.08);
  const front = smoothstep(0, 1, presence).mul(1.12);
  return step(dist.div(reach).add(edge).add(float(0.02)), front) as Node<'float'>;
}
