import type { Node } from 'three/webgpu';
import { exp, float, length, log, max, mix, positionWorld, smoothstep, step } from 'three/tsl';
import { frameUniforms } from './uniforms';

/**
 * The world clear wave in a shader (since SDK 1.5). After every line clear a front leaves the board
 * and rolls outward through the world, from the stage's `clearWave.near` to `far` in `travel`
 * seconds: a sharp leading edge and a soft tail, thicker, brighter and reaching further for bigger
 * clears (a single dies halfway out; a QUAD reaches the horizon). It moves at a constant speed in
 * log distance, so on screen it sweeps evenly from the board to the horizon.
 *
 * Same maths as `frontValue` in src/rendering/environments/worldSignals.ts (unit-tested there).
 * Up to four fronts overlap; the sum is capped at 1.5.
 *
 * - `clearFront(p)`: for light (glints, sheen, glow). Scaled by the gameplay-effects strength and
 *   the screen-effects setting, halved with flash reduction, reduced with calm or no world events.
 * - `clearFrontMotion(p)`: for movement (sway, stir). Scaled by the gameplay-effects strength,
 *   a quarter under reduced motion, halved with calm world events and 0 with none.
 * - `clearFrontRaw(p)`: unscaled (0..1.5), when a component applies its own limits.
 *
 * `p` is a world position (default `positionWorld`; in a vertex `positionNode` pass the position
 * the vertex is built from, since `positionWorld` is not available there).
 */
export function clearFrontRaw(position: Node<'vec3'> = positionWorld as unknown as Node<'vec3'>): Node<'float'> {
  const u = frameUniforms;
  const shape = u.waveShape;
  const d = max(length(position.sub(u.waveOrigin)), shape.x);
  // 0 at the board, 1 at the far distance.
  const x = log(d.div(shape.x)).mul(shape.y);
  let sum: Node<'float'> = float(0);
  for (const slot of [u.wave0, u.wave1, u.wave2, u.wave3]) {
    const age = u.time.sub(slot.x);
    const f = age.mul(shape.z);
    const s = x.sub(f);
    const lead = s.div(slot.w.mul(0.85));
    const ahead = exp(lead.mul(lead).negate());
    // The tail only exists behind the front (s <= 0); clamp so the unused branch stays finite.
    const behind = exp(s.min(0).div(slot.w.mul(1.6)));
    const band = mix(behind, ahead, step(0, s));
    const alive = float(1).sub(smoothstep(slot.z.mul(0.55), slot.z, f)).mul(step(0, age));
    sum = sum.add(band.mul(alive).mul(slot.y));
  }
  return sum.min(1.5) as Node<'float'>;
}

/** The clear front for light uses (see clearFrontRaw), accessibility-scaled. */
export function clearFront(position?: Node<'vec3'>): Node<'float'> {
  return clearFrontRaw(position).mul(frameUniforms.waveLight) as Node<'float'>;
}

/** The clear front for motion uses (see clearFrontRaw), accessibility-scaled. */
export function clearFrontMotion(position?: Node<'vec3'>): Node<'float'> {
  return clearFrontRaw(position).mul(frameUniforms.waveMotion) as Node<'float'>;
}
