import { Color, DoubleSide, MeshBasicNodeMaterial, MeshStandardNodeMaterial, Vector3, type InstancedBufferAttribute, type Node } from 'three/webgpu';
import {
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  instancedBufferAttribute,
  length,
  max,
  min,
  mix,
  mod,
  normalView,
  positionGeometry,
  positionViewDirection,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { frameUniforms, noBloom, type ColorUniform, type FloatUniform } from '../shaders/uniforms';

const HALF = 0.47;

/**
 * Depth-only pre-pass for the ghost, so the translucent ghost colours only its front-most surface;
 * otherwise the inner side faces of neighbouring cells add up into notches and seams.
 */
export function createGhostDepthMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.colorWrite = false;
  material.depthWrite = true;
  // In the transparent pass (render order 1000), after the semi-transparent back plate: an
  // opaque-pass pre-pass would depth-reject the plate behind the ghost and show the world through.
  material.transparent = true;
  noBloom(material);
  return material;
}

/**
 * Ghost piece: an even translucent body in the piece colour with an outline on the piece's
 * outer silhouette only (per-cell neighbour mask: bits left, right, down, up), so it reads as
 * one shape. Cells are drawn slightly enlarged so they meet; the depth pre-pass resolves overlaps.
 */
export function createGhostMaterial(mask: InstancedBufferAttribute): { material: MeshBasicNodeMaterial; color: ColorUniform; opacity: FloatUniform } {
  const color = uniform(new Vector3(1, 1, 1));
  const opacity = uniform(0.5);
  const p = positionGeometry;
  const m = (instancedBufferAttribute(mask, 'vec4') as unknown as Node<'vec4'>).x;
  const bit = (i: number) => mod(floor(m.div(2 ** i)), 2);
  const near = (v: Parameters<typeof smoothstep>[2]) => smoothstep(HALF - 0.1, HALF - 0.015, v);
  const outer = max(
    max(bit(0).oneMinus().mul(near(p.x.negate())), bit(1).oneMinus().mul(near(p.x))),
    max(bit(2).oneMinus().mul(near(p.y.negate())), bit(3).oneMinus().mul(near(p.y))),
  );
  // Outline only toward the front, so the silhouette reads from the camera.
  const front = smoothstep(0, HALF - 0.02, p.z);
  const outline = outer.mul(front) as unknown as Node<'float'>;
  const ndv = clamp(dot(normalView, positionViewDirection), 0, 1);
  const shimmer = float(0.9).add(frameUniforms.beatPulse.mul(0.1));
  const body = float(0.12).add(ndv.oneMinus().mul(0.06));
  const alpha = clamp(body.add(outline.mul(0.9)), 0, 1).mul(opacity).mul(shimmer);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = vec4(color.mul(float(0.8).add(outline.mul(0.9))), alpha);
  material.transparent = true;
  material.depthWrite = false;
  noBloom(material);
  return { material, color, opacity };
}

export interface PlateUniforms {
  readonly tint: ColorUniform;
  readonly accent: ColorUniform;
  readonly grid: FloatUniform;
  readonly opacity: FloatUniform;
}

/** Back plate of the well: dark glass with a fine grid, danger tint and beat shimmer along the floor. */
export function createPlateMaterial(): { material: MeshBasicNodeMaterial; u: PlateUniforms } {
  const u: PlateUniforms = {
    tint: uniform(new Vector3(0.006, 0.006, 0.018)),
    accent: uniform(new Vector3(0.45, 0.55, 1)),
    grid: uniform(1),
    opacity: uniform(0.93),
  };
  const st = uv().mul(vec2(10, 20));
  const cell = fract(st);
  const lineW = 0.035;
  const gx = smoothstep(lineW, 0, min(cell.x, cell.x.oneMinus()));
  const gy = smoothstep(lineW, 0, min(cell.y, cell.y.oneMinus()));
  const gridLine = max(gx, gy).mul(u.grid);
  const vy = uv().y;
  const floorGlow = exp(vy.mul(-9)).mul(float(0.35).add(frameUniforms.beatPulse.mul(0.4).mul(frameUniforms.reactivity)));
  const danger = frameUniforms.danger.mul(smoothstep(0.55, 1, vy)).mul(0.5);
  const accent = u.accent;
  const base = u.tint.add(accent.mul(gridLine.mul(0.035))).add(accent.mul(floorGlow.mul(0.06))).add(vec3(0.9, 0.15, 0.25).mul(danger));
  const material = new MeshBasicNodeMaterial();
  material.colorNode = vec4(base, u.opacity);
  material.transparent = true;
  material.depthWrite = true;
  noBloom(material);
  return { material, u };
}

/** Frame rails: dark satin metal with an emissive inner light line in the stage accent colour. */
export function createFrameMaterial(): { material: MeshStandardNodeMaterial; accent: ColorUniform; glow: FloatUniform } {
  const accent = uniform(new Vector3(0.45, 0.55, 1));
  const glow = uniform(1);
  const material = new MeshStandardNodeMaterial();
  material.color = new Color(0.012, 0.012, 0.02);
  material.roughness = 0.32;
  material.metalness = 0.85;
  material.envMapIntensity = 0.25;
  const ndv = clamp(dot(normalView, positionViewDirection), 0, 1);
  const pulse = float(0.55).add(frameUniforms.beatPulse.mul(0.35).mul(frameUniforms.reactivity)).add(frameUniforms.clearPulse.mul(0.8));
  const danger = mix(accent, vec3(1, 0.25, 0.35), frameUniforms.danger.mul(0.85));
  material.emissiveNode = danger.mul(ndv.pow(6).mul(0.32).add(0.035)).mul(pulse).mul(glow);
  return { material, accent, glow };
}

/** Soft dark ellipse behind the well that keeps the playfield readable over busy worlds. */
export function createDimMaterial(): { material: MeshBasicNodeMaterial; strength: FloatUniform } {
  const strength = uniform(0.25);
  const d = length(uv().sub(0.5).mul(vec2(1.6, 1)));
  const alpha = smoothstep(0.5, 0.12, d).mul(strength);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = vec4(vec3(0.02, 0.015, 0.05), alpha);
  material.transparent = true;
  material.depthWrite = false;
  material.side = DoubleSide;
  noBloom(material);
  return { material, strength };
}
