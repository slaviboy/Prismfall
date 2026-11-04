import type { BlockSurface } from './blockSurfaces';

/** Data-driven block surface presets; stages choose one and may override any field. */
export interface BlockMaterialPreset {
  /** Procedural surface pattern (see blockSurfaces.ts); 'plain' = colour and glow only. */
  readonly surface: BlockSurface;
  readonly roughness: number;
  readonly metalness: number;
  readonly clearcoat: number;
  readonly clearcoatRoughness: number;
  /** Constant self-illumination of the piece colour. */
  readonly emissive: number;
  /** Inner glow concentrated in face centres (fake internal illumination). */
  readonly core: number;
  /** Emissive strength along bevelled edges. */
  readonly edgeGlow: number;
  /** Edge glow colour; null = piece colour. */
  readonly edgeColor: readonly [number, number, number] | null;
  /** View-angle rim brightening. */
  readonly rim: number;
  /** Procedural micro-surface variation (0 = smooth). */
  readonly surfaceNoise: number;
  /** Darkening in creases between neighbouring blocks. */
  readonly ao: number;
  /** Multiplier on base colour (lower = deeper, glassier look). */
  readonly albedo: number;
  /** How strongly the music lifts the glow. */
  readonly musicGlow: number;
  readonly envIntensity: number;
  /** Saturation applied to the piece colour (1 = palette as is). */
  readonly saturation: number;
  /** Jelly squash and rebound when a block locks (0 or absent = rigid). */
  readonly wobble?: number;
}

export const BLOCK_PRESETS = {
  /** Default: polished prism glass with a lit core. */
  prism: { surface: 'plain', roughness: 0.22, metalness: 0.05, clearcoat: 0.7, clearcoatRoughness: 0.08, emissive: 0.12, core: 0.3, edgeGlow: 0.5, edgeColor: null, rim: 0.18, surfaceNoise: 0.02, ao: 0.5, albedo: 0.9, musicGlow: 0.3, envIntensity: 0.55, saturation: 1.06 },
  pearlGlass: { surface: 'plain', roughness: 0.2, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.08, emissive: 0.14, core: 0.28, edgeGlow: 0.32, edgeColor: [0.85, 0.95, 1], rim: 0.16, surfaceNoise: 0.01, ao: 0.45, albedo: 0.92, musicGlow: 0.35, envIntensity: 0.45, saturation: 1.04 },
  forgedMetal: { surface: 'plain', roughness: 0.38, metalness: 0.7, clearcoat: 0.3, clearcoatRoughness: 0.3, emissive: 0.15, core: 0.28, edgeGlow: 0.95, edgeColor: null, rim: 0.2, surfaceNoise: 0.12, ao: 0.6, albedo: 0.75, musicGlow: 0.55, envIntensity: 0.75, saturation: 1.04 },
  stellarGlass: { surface: 'plain', roughness: 0.1, metalness: 0.1, clearcoat: 0.8, clearcoatRoughness: 0.04, emissive: 0.08, core: 0.45, edgeGlow: 0.45, edgeColor: null, rim: 0.35, surfaceNoise: 0, ao: 0.35, albedo: 0.55, musicGlow: 0.5, envIntensity: 0.6, saturation: 1.06 },
  frostedCrystal: { surface: 'plain', roughness: 0.45, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.35, emissive: 0.2, core: 0.5, edgeGlow: 0.45, edgeColor: [0.9, 1, 0.92], rim: 0.35, surfaceNoise: 0.06, ao: 0.4, albedo: 0.85, musicGlow: 0.3, envIntensity: 0.55, saturation: 1.08 },
  neonWire: { surface: 'plain', roughness: 0.3, metalness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.1, emissive: 0.04, core: 0.1, edgeGlow: 2.2, edgeColor: null, rim: 0.3, surfaceNoise: 0.03, ao: 0.5, albedo: 0.3, musicGlow: 0.8, envIntensity: 0.7, saturation: 1.08 },
  porcelain: { surface: 'plain', roughness: 0.35, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.2, emissive: 0.08, core: 0.22, edgeGlow: 0.25, edgeColor: [1, 0.97, 0.92], rim: 0.2, surfaceNoise: 0.015, ao: 0.55, albedo: 0.95, musicGlow: 0.2, envIntensity: 0.55, saturation: 1.06 },
  sandstone: { surface: 'plain', roughness: 0.8, metalness: 0.05, clearcoat: 0.1, clearcoatRoughness: 0.6, emissive: 0.05, core: 0.1, edgeGlow: 0.9, edgeColor: [1, 0.8, 0.35], rim: 0.15, surfaceNoise: 0.18, ao: 0.65, albedo: 0.92, musicGlow: 0.35, envIntensity: 0.45, saturation: 1.04 },
  glacierIce: { surface: 'plain', roughness: 0.15, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.05, emissive: 0.15, core: 0.6, edgeGlow: 0.55, edgeColor: [0.8, 0.95, 1], rim: 0.55, surfaceNoise: 0.05, ao: 0.35, albedo: 0.6, musicGlow: 0.4, envIntensity: 0.7, saturation: 1.06 },
  abyssalGlow: { surface: 'plain', roughness: 0.3, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.15, emissive: 0.3, core: 0.7, edgeGlow: 0.4, edgeColor: null, rim: 0.45, surfaceNoise: 0.04, ao: 0.45, albedo: 0.55, musicGlow: 0.5, envIntensity: 0.45, saturation: 1.06 },
  livingCircuit: { surface: 'plain', roughness: 0.5, metalness: 0.1, clearcoat: 0.4, clearcoatRoughness: 0.3, emissive: 0.1, core: 0.3, edgeGlow: 1.1, edgeColor: [0.6, 1, 0.75], rim: 0.2, surfaceNoise: 0.1, ao: 0.5, albedo: 0.8, musicGlow: 0.6, envIntensity: 0.55, saturation: 1.06 },
  washiPaper: { surface: 'plain', roughness: 0.9, metalness: 0, clearcoat: 0, clearcoatRoughness: 1, emissive: 0.07, core: 0.18, edgeGlow: 0.2, edgeColor: [1, 0.95, 0.85], rim: 0.1, surfaceNoise: 0.2, ao: 0.6, albedo: 0.95, musicGlow: 0.15, envIntensity: 0.4, saturation: 1.04 },
  // Themed surfaces (§25 block themes). Glow stays modest: the surface carries the look.
  frozenCrystal: { surface: 'ice', roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, emissive: 0.04, core: 0.18, edgeGlow: 0.25, edgeColor: [0.85, 0.95, 1], rim: 0.25, surfaceNoise: 0, ao: 0.35, albedo: 0.9, musicGlow: 0.2, envIntensity: 0.65, saturation: 1.05 },
  carvedWood: { surface: 'wood', roughness: 0.55, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.3, emissive: 0.0, core: 0.0, edgeGlow: 0.0, edgeColor: null, rim: 0.06, surfaceNoise: 0, ao: 0.6, albedo: 1, musicGlow: 0.05, envIntensity: 0.4, saturation: 1 },
  desertSandstone: { surface: 'sandstone', roughness: 0.85, metalness: 0, clearcoat: 0.05, clearcoatRoughness: 0.7, emissive: 0.0, core: 0.0, edgeGlow: 0.12, edgeColor: [1, 0.82, 0.45], rim: 0.08, surfaceNoise: 0, ao: 0.65, albedo: 1, musicGlow: 0.1, envIntensity: 0.4, saturation: 1 },
  volcanicObsidian: { surface: 'obsidian', roughness: 0.1, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.04, emissive: 0.0, core: 0.0, edgeGlow: 0.18, edgeColor: null, rim: 0.12, surfaceNoise: 0, ao: 0.45, albedo: 1, musicGlow: 0.3, envIntensity: 0.6, saturation: 1.05 },
  forestEmerald: { surface: 'emerald', roughness: 0.12, metalness: 0, clearcoat: 0.9, clearcoatRoughness: 0.06, emissive: 0.02, core: 0.08, edgeGlow: 0.2, edgeColor: null, rim: 0.15, surfaceNoise: 0, ao: 0.45, albedo: 1, musicGlow: 0.15, envIntensity: 0.6, saturation: 1.05 },
  cosmicCrystal: { surface: 'cosmic', roughness: 0.08, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.03, emissive: 0.02, core: 0.1, edgeGlow: 0.25, edgeColor: null, rim: 0.25, surfaceNoise: 0, ao: 0.35, albedo: 1, musicGlow: 0.25, envIntensity: 0.55, saturation: 1.05 },
  oceanGlass: { surface: 'aquatic', roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, emissive: 0.02, core: 0.08, edgeGlow: 0.22, edgeColor: [0.75, 0.95, 1], rim: 0.25, surfaceNoise: 0, ao: 0.4, albedo: 1, musicGlow: 0.2, envIntensity: 0.6, saturation: 1.05 },
  neonGlass: { surface: 'neon', roughness: 0.14, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.06, emissive: 0.02, core: 0.04, edgeGlow: 0.9, edgeColor: null, rim: 0.2, surfaceNoise: 0, ao: 0.5, albedo: 1, musicGlow: 0.4, envIntensity: 0.7, saturation: 1.08 },
  alpineStone: { surface: 'mineral', roughness: 0.3, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.2, emissive: 0.0, core: 0.0, edgeGlow: 0.1, edgeColor: [0.9, 0.95, 1], rim: 0.08, surfaceNoise: 0, ao: 0.6, albedo: 1, musicGlow: 0.05, envIntensity: 0.5, saturation: 1 },
  auroraCrystal: { surface: 'aurora', roughness: 0.1, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, emissive: 0.02, core: 0.06, edgeGlow: 0.22, edgeColor: [0.8, 1, 0.95], rim: 0.25, surfaceNoise: 0, ao: 0.4, albedo: 1, musicGlow: 0.25, envIntensity: 0.6, saturation: 1.05 },
  washiSheet: { surface: 'paper', roughness: 0.92, metalness: 0, clearcoat: 0, clearcoatRoughness: 1, emissive: 0.0, core: 0.0, edgeGlow: 0.05, edgeColor: [1, 0.96, 0.9], rim: 0.05, surfaceNoise: 0, ao: 0.6, albedo: 1, musicGlow: 0.05, envIntensity: 0.35, saturation: 1 },
  // Library designs (any world, the level creator and the Block design setting).
  lumenFrame: { surface: 'lumen', roughness: 0.16, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05, emissive: 0, core: 0, edgeGlow: 0.06, edgeColor: null, rim: 0.12, surfaceNoise: 0, ao: 0.4, albedo: 1, musicGlow: 0.3, envIntensity: 0.6, saturation: 1.1 },
  dichroicGlass: { surface: 'dichroic', roughness: 0.05, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.03, emissive: 0, core: 0.06, edgeGlow: 0.16, edgeColor: null, rim: 0.12, surfaceNoise: 0, ao: 0.4, albedo: 1, musicGlow: 0.2, envIntensity: 0.65, saturation: 1.05 },
  polishedIngot: { surface: 'ingot', roughness: 0.2, metalness: 1, clearcoat: 0.5, clearcoatRoughness: 0.08, emissive: 0.03, core: 0, edgeGlow: 0, edgeColor: null, rim: 0.04, surfaceNoise: 0, ao: 0.6, albedo: 1, musicGlow: 0.05, envIntensity: 1.15, saturation: 1 },
  ribbonGlass: { surface: 'ribbon', roughness: 0.08, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, emissive: 0, core: 0.05, edgeGlow: 0.14, edgeColor: null, rim: 0.18, surfaceNoise: 0, ao: 0.45, albedo: 1, musicGlow: 0.15, envIntensity: 0.6, saturation: 1.06 },
  jellyGel: { surface: 'gel', roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, emissive: 0.02, core: 0.05, edgeGlow: 0.08, edgeColor: null, rim: 0.2, surfaceNoise: 0, ao: 0.4, albedo: 1, musicGlow: 0.2, envIntensity: 0.7, saturation: 1.08, wobble: 1 },
  rosetteLacquer: { surface: 'rosette', roughness: 0.4, metalness: 0.15, clearcoat: 0.6, clearcoatRoughness: 0.15, emissive: 0, core: 0, edgeGlow: 0.05, edgeColor: [1, 0.9, 0.7], rim: 0.06, surfaceNoise: 0, ao: 0.6, albedo: 1, musicGlow: 0.05, envIntensity: 0.6, saturation: 1.02 },
  glassMarble: { surface: 'marble', roughness: 0.03, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, emissive: 0.02, core: 0.08, edgeGlow: 0, edgeColor: null, rim: 0.22, surfaceNoise: 0, ao: 0.3, albedo: 1, musicGlow: 0.2, envIntensity: 0.75, saturation: 1.06 },
  paperLantern: { surface: 'lantern', roughness: 0.88, metalness: 0, clearcoat: 0, clearcoatRoughness: 1, emissive: 0, core: 0, edgeGlow: 0.03, edgeColor: [1, 0.9, 0.75], rim: 0.04, surfaceNoise: 0, ao: 0.55, albedo: 1, musicGlow: 0.15, envIntensity: 0.35, saturation: 1.02 },
  wardenBasalt: { surface: 'basalt', roughness: 0.34, metalness: 0.15, clearcoat: 0.55, clearcoatRoughness: 0.12, emissive: 0, core: 0, edgeGlow: 0.04, edgeColor: [1, 0.55, 0.3], rim: 0.08, surfaceNoise: 0, ao: 0.6, albedo: 1, musicGlow: 0.12, envIntensity: 0.6, saturation: 1.06 },
  smokedVeil: { surface: 'veil', roughness: 0.42, metalness: 0.04, clearcoat: 0.35, clearcoatRoughness: 0.38, emissive: 0, core: 0.04, edgeGlow: 0.06, edgeColor: [0.78, 0.86, 1], rim: 0.12, surfaceNoise: 0, ao: 0.45, albedo: 1, musicGlow: 0.1, envIntensity: 0.28, saturation: 1.04 },
  carvedJade: { surface: 'jade', roughness: 0.22, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.12, emissive: 0, core: 0.03, edgeGlow: 0.04, edgeColor: [1, 0.85, 0.5], rim: 0.1, surfaceNoise: 0, ao: 0.55, albedo: 1, musicGlow: 0.08, envIntensity: 0.55, saturation: 1.06 },
  machinedGunmetal: { surface: 'machined', roughness: 0.28, metalness: 0.92, clearcoat: 0.3, clearcoatRoughness: 0.18, emissive: 0, core: 0, edgeGlow: 0, edgeColor: null, rim: 0.05, surfaceNoise: 0, ao: 0.6, albedo: 1, musicGlow: 0.08, envIntensity: 1.0, saturation: 1.08 },
  frontierTimber: { surface: 'frontier', roughness: 0.66, metalness: 0, clearcoat: 0.12, clearcoatRoughness: 0.45, emissive: 0, core: 0, edgeGlow: 0, edgeColor: null, rim: 0.05, surfaceNoise: 0, ao: 0.62, albedo: 1, musicGlow: 0, envIntensity: 0.38, saturation: 1.06 },
  stormCrystal: { surface: 'storm', roughness: 0.22, metalness: 0.06, clearcoat: 0.5, clearcoatRoughness: 0.3, emissive: 0, core: 0.03, edgeGlow: 0.04, edgeColor: [0.82, 0.88, 1], rim: 0.1, surfaceNoise: 0, ao: 0.5, albedo: 1, musicGlow: 0.08, envIntensity: 0.28, saturation: 1.08 },
} satisfies Record<string, BlockMaterialPreset>;

export type BlockPresetId = keyof typeof BLOCK_PRESETS;

export function resolveBlockPreset(id: string, overrides: Partial<BlockMaterialPreset> = {}): BlockMaterialPreset {
  const base = (BLOCK_PRESETS as Record<string, BlockMaterialPreset>)[id] ?? BLOCK_PRESETS.prism;
  return { ...base, ...overrides };
}
