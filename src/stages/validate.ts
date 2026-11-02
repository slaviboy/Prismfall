import { migrateManifest, satisfiesRange, stageManifestSchema, type StageManifest } from './schema';

export interface ValidationResult {
  readonly manifest: StageManifest | null;
  readonly errors: string[];
  readonly warnings: string[];
}

export interface ValidationEnv {
  readonly sdkVersion: string;
  /** Component types available without loading the stage's own module. */
  readonly knownComponents: ReadonlySet<string>;
  /** Whether a stage-relative file exists. */
  readonly assetExists: (relativePath: string) => boolean;
  /** Folder name the manifest lives in (must equal the id). */
  readonly folder: string;
}

/** Pure manifest validation shared by the in-game registry and `npm run content:validate`. */
export function validateManifest(raw: unknown, env: ValidationEnv): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = stageManifestSchema.safeParse(migrateManifest(raw));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
    return { manifest: null, errors, warnings };
  }
  const m = parsed.data;
  if (m.id !== env.folder) errors.push(`id "${m.id}" must match its folder name "${env.folder}"`);
  if (!satisfiesRange(env.sdkVersion, m.requires.sdk)) errors.push(`needs Content SDK ${m.requires.sdk}, this build provides ${env.sdkVersion}`);
  if (m.module && !env.assetExists(m.module)) errors.push(`module "${m.module}" not found`);
  for (const layer of m.environment.layers) {
    if (!env.knownComponents.has(layer.type) && !m.module) errors.push(`unknown environment component "${layer.type}" (no stage module registers it)`);
    const src = layer.params.src;
    if (typeof src === 'string' && !env.assetExists(src)) errors.push(`layer "${layer.id ?? layer.type}": asset "${src}" not found`);
  }
  for (const track of m.music.tracks) {
    if (!env.assetExists(track.src)) errors.push(`music track "${track.id}": "${track.src}" not found`);
    if (track.meta && !env.assetExists(track.meta)) errors.push(`music track "${track.id}": metadata "${track.meta}" not found`);
  }
  if (m.music.defaultTrack && !m.music.tracks.some((t) => t.id === m.music.defaultTrack)) errors.push(`defaultTrack "${m.music.defaultTrack}" is not one of the tracks`);
  for (const [sfx, path] of Object.entries(m.sfx.overrides)) if (!env.assetExists(path)) errors.push(`sfx override "${sfx}": "${path}" not found`);
  if (m.thumbnail && !env.assetExists(m.thumbnail)) warnings.push(`thumbnail "${m.thumbnail}" not found (a generated card is shown)`);
  if (m.placeholder) warnings.push('marked as placeholder content');
  return { manifest: m, errors, warnings };
}

export const packManifestSchemaShape = {
  id: 'string',
  name: 'string',
  version: 'semver',
  engine: 'semver range',
} as const;
