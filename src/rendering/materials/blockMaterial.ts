import { MeshPhysicalNodeMaterial, Vector3, type InstancedInterleavedBuffer } from 'three/webgpu';
import {
  abs,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  instancedBufferAttribute,
  length,
  max,
  mrt,
  min,
  mix,
  mod,
  normalView,
  positionGeometry,
  positionLocal,
  positionViewDirection,
  sin,
  smoothstep,
  step,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { frameUniforms, type FloatUniform } from '../shaders/uniforms';
import type { BlockMaterialPreset } from './blockPresets';

/** Floats per instance in the packed buffer: [r, g, b, glyph] [aoMask, dropRows, dropTime, lockTime]. */
export const BLOCK_STRIDE = 8;
const HALF = 0.47;
/** Fraction of block glow that reaches the bloom pass. */
const BLOOM_SHARE = 0.35;


export interface BlockMaterialHandle {
  readonly material: MeshPhysicalNodeMaterial;
  /** Brightness multiplier for the whole set (active piece lock dimming, pods). */
  readonly intensity: FloatUniform;
  /** Spawn time (s) for the materialize pulse; -1000 disables. */
  readonly spawnTime: FloatUniform;
  readonly glyphs: FloatUniform;
  readonly dropDuration: FloatUniform;
  /** Player's Block glow setting: scales self-illumination. */
  readonly glowScale: FloatUniform;
  apply(preset: BlockMaterialPreset): void;
}

/**
 * Bevelled glass/metal block material in TSL (works on WebGPU and WebGL 2).
 * All animation (collapse, lock flash, music glow) is computed on the GPU from per-instance times.
 */
export function createBlockMaterial(buffer: InstancedInterleavedBuffer, preset: BlockMaterialPreset): BlockMaterialHandle {
  const a0 = instancedBufferAttribute<'vec4'>(buffer, 'vec4', BLOCK_STRIDE, 0);
  const a1 = instancedBufferAttribute<'vec4'>(buffer, 'vec4', BLOCK_STRIDE, 4);
  const u = {
    emissive: uniform(preset.emissive),
    core: uniform(preset.core),
    edgeGlow: uniform(preset.edgeGlow),
    edgeColor: uniform(new Vector3(1, 1, 1)),
    edgeUsePiece: uniform(preset.edgeColor ? 0 : 1),
    rim: uniform(preset.rim),
    noise: uniform(preset.surfaceNoise),
    ao: uniform(preset.ao),
    albedo: uniform(preset.albedo),
    musicGlow: uniform(preset.musicGlow),
    saturation: uniform(preset.saturation),
  };
  const intensity = uniform(1);
  const spawnTime = uniform(-1000);
  const glyphs = uniform(0);
  const dropDuration = uniform(0.12);
  const glowScale = uniform(0.6);
  const t = frameUniforms.time;

  // Per-cell shading uses the raw geometry position: on an InstancedMesh, positionLocal already
  // includes the instance matrix (board space), which put edge glow and crease shading on the
  // board's centre lines instead of each cell's own edges.
  const p = positionGeometry;
  const ap = abs(p);
  const m1 = max(ap.x, max(ap.y, ap.z));
  const mn = min(ap.x, min(ap.y, ap.z));
  const m2 = ap.x.add(ap.y).add(ap.z).sub(m1).sub(mn);
  const edge = smoothstep(HALF - 0.075, HALF - 0.008, m2);

  // Crease occlusion from the neighbour bitmask (bits: left, right, down, up).
  const mask = a1.x;
  const bit = (i: number) => mod(floor(mask.div(2 ** i)), 2);
  const near = (v: Parameters<typeof smoothstep>[2]) => smoothstep(0.12, HALF, v);
  const occl = max(
    max(bit(0).mul(near(p.x.negate())), bit(1).mul(near(p.x))),
    max(bit(2).mul(near(p.y.negate())), bit(3).mul(near(p.y))),
  );
  const ao = float(1).sub(occl.mul(u.ao));

  // Row-collapse animation: blocks start `dropRows` higher and ease down (GPU-timed).
  const dropT = clamp(t.sub(a1.z).div(dropDuration), 0, 1);
  const dropRemain = dropT.oneMinus().pow(3);
  const lifted = positionLocal.add(vec3(0, a1.y.mul(dropRemain), 0));

  // Lock flash and spawn materialize pulse.
  const flash = exp(max(t.sub(a1.w), 0).mul(-10)).mul(step(0, t.sub(a1.w))).mul(frameUniforms.flashLimit);
  const spawnPulse = exp(max(t.sub(spawnTime), 0).mul(-14)).mul(0.9);

  // View-dependent terms.
  const ndv = clamp(dot(normalView, positionViewDirection), 0, 1);
  const rim = ndv.oneMinus().pow(3).mul(u.rim);
  const core = ndv.pow(2.5).mul(u.core);

  // Micro-surface variation (cheap hash noise on the local position).
  const h = fract(sin(dot(floor(p.mul(37)), vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
  const surface = float(1).sub(h.mul(u.noise));

  // Accessibility glyph inlay on the front face (id 1..7).
  const gid = a0.w;
  const front = smoothstep(HALF - 0.04, HALF - 0.005, p.z);
  const px = p.x;
  const py = p.y;
  const is = (k: number) => step(abs(gid.sub(k)), 0.5);
  const box = (hw: number, hh: number) => step(abs(px), hw).mul(step(abs(py), hh));
  const g1 = box(0.27, 0.05);
  const g2 = step(abs(length(p.xy).sub(0.19)), 0.045);
  const g3 = step(py, 0.2).mul(step(-0.17, py)).mul(step(abs(px), float(0.2).sub(py).mul(0.6)));
  const g4 = step(abs(px.sub(py)), 0.06).mul(box(0.25, 0.25));
  const g5 = step(abs(px.add(py)), 0.06).mul(box(0.25, 0.25));
  const g6 = step(length(p.xy), 0.1);
  const g7 = max(box(0.25, 0.05), box(0.05, 0.25));
  const glyph = is(1).mul(g1).add(is(2).mul(g2)).add(is(3).mul(g3)).add(is(4).mul(g4)).add(is(5).mul(g5)).add(is(6).mul(g6)).add(is(7).mul(g7));
  const glyphMask = clamp(glyph, 0, 1).mul(front).mul(glyphs);

  // Piece colour with a saturation lift, so lighting, clearcoat and bloom can't bleach it.
  const raw = a0.xyz;
  const base = max(mix(vec3(dot(raw, vec3(0.2126, 0.7152, 0.0722))), raw, u.saturation), 0);
  const music = frameUniforms.bass.mul(0.6).add(frameUniforms.beatPulse.mul(0.4)).mul(u.musicGlow).mul(frameUniforms.reactivity);
  const albedo = base.mul(u.albedo).mul(ao).mul(surface).mul(mix(float(1), float(0.3), glyphMask));
  // A preset edge colour only tints the piece colour (at most 40 %); pure white edges washed blocks out.
  const edgeTint = mix(mix(base, u.edgeColor, 0.4), base, u.edgeUsePiece);
  const glow = base
    .mul(u.emissive.add(core).add(rim).add(music).add(flash.mul(1.4)).add(spawnPulse))
    .add(edgeTint.mul(edge.mul(u.edgeGlow).mul(float(1).add(music))))
    .mul(ao)
    .mul(mix(float(1), float(0.35), glyphMask))
    .mul(intensity)
    .mul(glowScale);

  const material = new MeshPhysicalNodeMaterial();
  material.positionNode = lifted;
  material.colorNode = vec4(albedo, 1);
  material.emissiveNode = glow;
  // Blocks feed only part of their glow to bloom: full-strength halos merged neighbouring blocks
  // into a bright haze that was tiring to look at.
  material.mrtNode = mrt({ emissive: vec4(glow.mul(BLOOM_SHARE), 1) });

  const handle: BlockMaterialHandle = {
    material,
    intensity,
    spawnTime,
    glyphs,
    dropDuration,
    glowScale,
    apply(next: BlockMaterialPreset): void {
      material.roughness = next.roughness;
      material.metalness = next.metalness;
      material.clearcoat = next.clearcoat;
      material.clearcoatRoughness = next.clearcoatRoughness;
      material.envMapIntensity = next.envIntensity;
      u.emissive.value = next.emissive;
      u.core.value = next.core;
      u.edgeGlow.value = next.edgeGlow;
      u.edgeUsePiece.value = next.edgeColor ? 0 : 1;
      if (next.edgeColor) u.edgeColor.value.set(next.edgeColor[0], next.edgeColor[1], next.edgeColor[2]);
      u.rim.value = next.rim;
      u.noise.value = next.surfaceNoise;
      u.ao.value = next.ao;
      u.albedo.value = next.albedo;
      u.musicGlow.value = next.musicGlow;
      u.saturation.value = next.saturation;
    },
  };
  handle.apply(preset);
  return handle;
}
