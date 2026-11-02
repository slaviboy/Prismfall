import { z } from 'zod';

export const STAGE_SCHEMA_VERSION = 1;

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const quality = z.enum(['low', 'medium', 'high', 'ultra']);

/** Audio features and game signals a binding may follow. */
export const BINDABLE_FEATURES = [
  'subBass', 'bass', 'lowMid', 'mid', 'highMid', 'treble', 'overallEnergy', 'waveformRms', 'spectralFlux',
  'spectralCentroid', 'transientIntensity', 'beatPulse', 'barPulse', 'beatPhase', 'barPhase', 'sectionIntensity', 'anticipation',
  'game.danger', 'game.clearPulse', 'game.combo', 'game.level', 'game.progress',
] as const;

export const bindingSchema = z.object({
  /** Layer id, `type:<componentType>`, or `*` for every layer exposing the target. */
  layer: z.string().default('*'),
  /** Name of a reactive uniform the component exposes. */
  target: z.string(),
  feature: z.enum(BINDABLE_FEATURES),
  amount: z.number().default(0.5),
  mode: z.enum(['mul', 'add']).default('mul'),
  curve: z.enum(['linear', 'smooth', 'pow2', 'sqrt']).default('smooth'),
  attackMs: z.number().min(0).default(40),
  releaseMs: z.number().min(0).default(260),
  category: z.enum(['particles', 'environment', 'lighting']).default('environment'),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type Binding = z.infer<typeof bindingSchema>;

export const layerSchema = z.object({
  id: z.string().optional(),
  type: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  bind: z.array(bindingSchema).default([]),
  /** Lowest environment-detail level that includes this layer. */
  minDetail: quality.default('low'),
});
export type LayerSpec = z.infer<typeof layerSchema>;

const unlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('always') }),
  z.object({ type: z.literal('voyageLeg'), leg: z.string() }),
  z.object({ type: z.literal('stageCompleted'), stage: z.string() }),
  z.object({ type: z.literal('score'), mode: z.string(), score: z.number() }),
]);

const trackSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(['composition', 'file']),
  /** Stage-relative module (composition) or audio file path. */
  src: z.string(),
  /** Stage-relative track.json metadata for file tracks. */
  meta: z.string().optional(),
  artist: z.string().default('Prismfall'),
});

export const stageManifestSchema = z.object({
  schemaVersion: z.literal(STAGE_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'kebab-case id'),
  name: z.string().min(1),
  description: z.string(),
  order: z.number().default(1000),
  tags: z.array(z.string()).default([]),
  thumbnail: z.string().optional(),
  intensity: z.number().min(0).max(1).default(0.6),
  recommendedQuality: quality.default('high'),
  placeholder: z.boolean().default(false),
  requires: z.object({ sdk: z.string().default('^1.0.0'), components: z.array(z.string()).default([]) }).prefault({}),
  module: z.string().optional(),
  palette: z.object({
    accent: color,
    secondary: color,
    highlight: color,
    fog: color,
    plate: color.default('#05060f'),
    pieceTint: z.number().min(0).max(0.5).default(0),
  }),
  fog: z.object({ color, density: z.number().min(0).max(0.05) }).optional(),
  backdrop: z.object({ top: color, bottom: color, glow: color }).optional(),
  lighting: z.object({
    key: z.object({ color, intensity: z.number(), azimuth: z.number(), elevation: z.number() }),
    rim: z.object({ color, intensity: z.number() }),
    ambient: z.object({ sky: color, ground: color, intensity: z.number() }),
    accents: z.array(z.object({ color, intensity: z.number(), x: z.number(), y: z.number(), z: z.number() })).max(2),
    beatResponse: z.number().default(0.4),
  }),
  grade: z
    .object({
      exposure: z.number().default(1),
      saturation: z.number().default(1.1),
      contrast: z.number().default(1.04),
      tint: vec3.default([1, 1, 1]),
      vignette: z.number().default(0.4),
      bloomThreshold: z.number().default(0.2),
      bloomRadius: z.number().default(0.4),
      toneMapping: z.enum(['aces', 'agx', 'neutral']).default('aces'),
      envIntensity: z.number().default(0.3),
    })
    .prefault({}),
  camera: z.object({ pitch: z.number().default(4), yaw: z.number().default(0), sway: z.number().default(0.6), targetY: z.number().default(0) }).prefault({}),
  blocks: z
    .object({
      geometry: z.string().default('framed'),
      material: z.string().default('prism'),
      overrides: z.record(z.string(), z.unknown()).default({}),
    })
    .prefault({}),
  environment: z.object({ layers: z.array(layerSchema).min(1) }),
  reactivity: z.object({ profiles: z.array(z.string()).default([]), bindings: z.array(bindingSchema).default([]) }).prefault({}),
  effects: z
    .object({
      lineClear: z.object({ effect: z.string(), params: z.record(z.string(), z.unknown()).default({}) }).default({ effect: 'prismBurst', params: {} }),
      landing: z.object({ shape: z.string().default('soft'), color: color.optional() }).prefault({}),
    })
    .prefault({}),
  music: z.object({ bpm: z.number().min(30).max(300), beatsPerBar: z.number().int().default(4), tracks: z.array(trackSchema).default([]), defaultTrack: z.string().optional() }),
  ambience: z.object({ preset: z.string(), level: z.number().default(1) }).optional(),
  sfx: z.object({ preset: z.string().default('glass'), overrides: z.record(z.string(), z.string()).default({}) }).prefault({}),
  unlock: unlockSchema.default({ type: 'always' }),
});

export type StageManifest = z.infer<typeof stageManifestSchema>;

/** Placeholder for structural migrations of older manifest versions. */
export function migrateManifest(raw: unknown): unknown {
  return raw;
}

/** Minimal semver range check supporting ^x.y.z, >=x.y.z, exact x.y.z and *. */
export function satisfiesRange(version: string, range: string): boolean {
  const parse = (v: string): number[] => v.replace(/^[^\d]*/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [maj, min, pat] = parse(version);
  if (range === '*' || range === '') return true;
  const [rm, rn, rp] = parse(range);
  const cmp = (a: number[], b: number[]): number => (a[0]! - b[0]!) || (a[1]! - b[1]!) || (a[2]! - b[2]!);
  const v = [maj!, min!, pat!];
  const r = [rm!, rn!, rp!];
  if (range.startsWith('^')) return v[0] === r[0] && cmp(v, r) >= 0;
  if (range.startsWith('>=')) return cmp(v, r) >= 0;
  return cmp(v, r) === 0;
}
