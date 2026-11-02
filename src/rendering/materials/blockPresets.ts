/** Data-driven block surface presets; stages choose one and may override any field. */
export interface BlockMaterialPreset {
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
}

export const BLOCK_PRESETS = {
  /** Default: polished prism glass with a lit core. */
  prism: { roughness: 0.2, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.06, emissive: 0.1, core: 0.32, edgeGlow: 0.55, edgeColor: null, rim: 0.22, surfaceNoise: 0.02, ao: 0.5, albedo: 0.85, musicGlow: 0.3, envIntensity: 1 },
  pearlGlass: { roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, emissive: 0.12, core: 0.75, edgeGlow: 0.45, edgeColor: [0.85, 0.95, 1], rim: 0.6, surfaceNoise: 0.01, ao: 0.4, albedo: 0.6, musicGlow: 0.4, envIntensity: 1.2 },
  forgedMetal: { roughness: 0.38, metalness: 0.85, clearcoat: 0.3, clearcoatRoughness: 0.3, emissive: 0.05, core: 0.15, edgeGlow: 1.3, edgeColor: [1, 0.55, 0.18], rim: 0.2, surfaceNoise: 0.12, ao: 0.6, albedo: 0.9, musicGlow: 0.55, envIntensity: 1.1 },
  stellarGlass: { roughness: 0.08, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.03, emissive: 0.1, core: 0.9, edgeGlow: 0.6, edgeColor: null, rim: 0.7, surfaceNoise: 0, ao: 0.35, albedo: 0.45, musicGlow: 0.5, envIntensity: 0.9 },
  frostedCrystal: { roughness: 0.45, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.35, emissive: 0.22, core: 0.6, edgeGlow: 0.5, edgeColor: [0.9, 1, 0.92], rim: 0.5, surfaceNoise: 0.06, ao: 0.4, albedo: 0.85, musicGlow: 0.3, envIntensity: 0.8 },
  neonWire: { roughness: 0.3, metalness: 0.4, clearcoat: 1, clearcoatRoughness: 0.1, emissive: 0.04, core: 0.1, edgeGlow: 2.2, edgeColor: null, rim: 0.3, surfaceNoise: 0.03, ao: 0.5, albedo: 0.25, musicGlow: 0.8, envIntensity: 1 },
  porcelain: { roughness: 0.35, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.2, emissive: 0.08, core: 0.25, edgeGlow: 0.25, edgeColor: [1, 0.97, 0.92], rim: 0.25, surfaceNoise: 0.015, ao: 0.55, albedo: 0.95, musicGlow: 0.2, envIntensity: 0.9 },
  sandstone: { roughness: 0.8, metalness: 0.05, clearcoat: 0.1, clearcoatRoughness: 0.6, emissive: 0.04, core: 0.1, edgeGlow: 0.9, edgeColor: [1, 0.8, 0.35], rim: 0.15, surfaceNoise: 0.18, ao: 0.65, albedo: 0.9, musicGlow: 0.35, envIntensity: 0.6 },
  glacierIce: { roughness: 0.15, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, emissive: 0.15, core: 0.7, edgeGlow: 0.6, edgeColor: [0.8, 0.95, 1], rim: 0.8, surfaceNoise: 0.05, ao: 0.35, albedo: 0.55, musicGlow: 0.4, envIntensity: 1.3 },
  abyssalGlow: { roughness: 0.3, metalness: 0, clearcoat: 0.9, clearcoatRoughness: 0.15, emissive: 0.3, core: 0.8, edgeGlow: 0.4, edgeColor: null, rim: 0.6, surfaceNoise: 0.04, ao: 0.45, albedo: 0.5, musicGlow: 0.5, envIntensity: 0.6 },
  livingCircuit: { roughness: 0.5, metalness: 0.1, clearcoat: 0.5, clearcoatRoughness: 0.3, emissive: 0.1, core: 0.3, edgeGlow: 1.1, edgeColor: [0.6, 1, 0.75], rim: 0.25, surfaceNoise: 0.1, ao: 0.5, albedo: 0.75, musicGlow: 0.6, envIntensity: 0.8 },
  washiPaper: { roughness: 0.9, metalness: 0, clearcoat: 0, clearcoatRoughness: 1, emissive: 0.06, core: 0.2, edgeGlow: 0.2, edgeColor: [1, 0.95, 0.85], rim: 0.1, surfaceNoise: 0.2, ao: 0.6, albedo: 0.95, musicGlow: 0.15, envIntensity: 0.5 },
} satisfies Record<string, BlockMaterialPreset>;

export type BlockPresetId = keyof typeof BLOCK_PRESETS;

export function resolveBlockPreset(id: string, overrides: Partial<BlockMaterialPreset> = {}): BlockMaterialPreset {
  const base = (BLOCK_PRESETS as Record<string, BlockMaterialPreset>)[id] ?? BLOCK_PRESETS.prism;
  return { ...base, ...overrides };
}
