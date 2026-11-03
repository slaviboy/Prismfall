import type { Settings } from './schema';

type Graphics = Settings['graphics'];
export type QualityPreset = Exclude<Graphics['preset'], 'custom'>;

/** Fields controlled by quality presets (everything else is a user preference). */
export type PresetFields = Pick<
  Graphics,
  | 'renderScale'
  | 'antialias'
  | 'bloom'
  | 'shadows'
  | 'particleDensity'
  | 'environmentDetail'
  | 'reflections'
  | 'ambientOcclusion'
  | 'postProcessing'
  | 'depthOfField'
  | 'screenSpaceEffects'
>;

export const QUALITY_PRESETS: Record<QualityPreset, PresetFields> = {
  low: {
    renderScale: 0.75,
    antialias: 'fxaa',
    bloom: 0.7,
    shadows: 'off',
    particleDensity: 0.35,
    environmentDetail: 'low',
    reflections: 'off',
    ambientOcclusion: false,
    postProcessing: true,
    depthOfField: false,
    screenSpaceEffects: false,
  },
  medium: {
    renderScale: 1,
    antialias: 'smaa',
    bloom: 0.9,
    shadows: 'low',
    particleDensity: 0.65,
    environmentDetail: 'medium',
    reflections: 'low',
    ambientOcclusion: false,
    postProcessing: true,
    depthOfField: false,
    screenSpaceEffects: true,
  },
  high: {
    renderScale: 1,
    antialias: 'msaa',
    bloom: 1,
    shadows: 'medium',
    particleDensity: 1,
    environmentDetail: 'high',
    reflections: 'low',
    ambientOcclusion: false,
    postProcessing: true,
    depthOfField: false,
    screenSpaceEffects: true,
  },
  ultra: {
    // Depth-based passes are active, so MSAA is replaced by SMAA + supersampling.
    renderScale: 1.25,
    antialias: 'smaa',
    bloom: 1.1,
    shadows: 'high',
    particleDensity: 1.5,
    environmentDetail: 'ultra',
    reflections: 'high',
    ambientOcclusion: true,
    postProcessing: true,
    // Off in every preset: blurring the background softens the photographic horizons.
    depthOfField: false,
    screenSpaceEffects: true,
  },
};

export function applyPreset(graphics: Graphics, preset: QualityPreset): Graphics {
  return { ...graphics, ...QUALITY_PRESETS[preset], preset };
}

/** Returns the preset whose fields all match, or 'custom'. */
export function detectPreset(graphics: Graphics): Graphics['preset'] {
  for (const [name, fields] of Object.entries(QUALITY_PRESETS) as [QualityPreset, PresetFields][]) {
    if ((Object.keys(fields) as (keyof PresetFields)[]).every((k) => graphics[k] === fields[k])) return name;
  }
  return 'custom';
}

export interface GpuInfo {
  readonly backend: 'webgpu' | 'webgl2';
  readonly vendor: string;
  readonly architecture: string;
  readonly description: string;
  readonly isFallbackAdapter: boolean;
}

/** Recommended preset from coarse adapter information. */
export function recommendPreset(gpu: GpuInfo | null): QualityPreset {
  if (!gpu || gpu.isFallbackAdapter) return 'low';
  const text = `${gpu.vendor} ${gpu.architecture} ${gpu.description}`.toLowerCase();
  if (/swiftshader|llvmpipe|software|basic render/.test(text)) return 'low';
  const integrated = /intel|uhd|iris|apple m1|mali|adreno|powervr|vega 8|radeon graphics|integrated/.test(text);
  if (integrated) return 'medium';
  const highEnd = /rdna-?[34]|rx 7|rx 9|rtx 3|rtx 4|rtx 5|lovelace|ampere|blackwell|9070|7900|4080|4090|5080|5090/.test(text);
  if (highEnd) return 'ultra';
  return gpu.backend === 'webgpu' ? 'high' : 'medium';
}
