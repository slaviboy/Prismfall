import type { Node } from 'three/webgpu';
import { dot, float, floor, fract, fwidth, length, max, sin, smoothstep, step, vec2 } from 'three/tsl';

const hash = (id: Node<'vec2'>, k: number): Node<'float'> => fract(sin(dot(id, vec2(127.1 + k * 37.3, 311.7 + k * 19.1))).mul(43758.5453));

/**
 * Point glints on a surface (sand grains, wave facets catching the light): each cell of a grid
 * holds one candidate at a random spot, drawn as a soft dot a few pixels across. Several cell
 * sizes cover every distance, and each is used only where its cells span roughly 6 to 40 pixels,
 * so the glints keep about the same size and spacing on screen near and far and never alias into
 * squares. `density` (0..1) is the share of cells that hold a glint; they twinkle at `rate`.
 * Returns 0..1 per pixel. Use only in fragment shaders (it measures the pixel footprint).
 */
export function glintField(xz: Node<'vec2'>, density: Node<'float'>, time: Node<'float'>, rate = 7, scales: readonly number[] = [0.12, 0.5, 2, 8]): Node<'float'> {
  const pix = max(max(fwidth(xz.x), fwidth(xz.y)), 1e-5);
  let sum: Node<'float'> = float(0);
  scales.forEach((cs, k) => {
    const g = xz.div(cs);
    const id = floor(g);
    const at = vec2(hash(id, k * 3), hash(id, k * 3 + 1)).mul(0.6).add(0.2);
    const seed = hash(id, k * 3 + 2);
    const d = length(fract(g).sub(at)).mul(cs);
    const dotShape = smoothstep(pix.mul(2), pix.mul(0.3), d);
    const on = step(float(1).sub(density), seed);
    const twinkle = sin(time.mul(rate * (0.7 + 0.3 * ((k * 0.37) % 1))).add(seed.mul(97))).mul(0.5).add(0.5);
    const cellPx = pix.div(cs).reciprocal();
    const band = smoothstep(5, 9, cellPx).mul(smoothstep(48, 30, cellPx));
    sum = sum.add(dotShape.mul(on).mul(twinkle.mul(twinkle).mul(twinkle)).mul(band));
  });
  return sum.min(1) as Node<'float'>;
}
