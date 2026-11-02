import { z } from 'zod';
import { SDK_VERSION } from '../sdk/version';
import { registries } from '../sdk/registry';
import type { StageModule } from '../sdk/types';
import { satisfiesRange, type Binding, type StageManifest } from './schema';
import { validateManifest } from './validate';

// Build-time discovery: every stage folder (core and local packs) is picked up automatically.
const CORE_MANIFESTS = import.meta.glob('/content/stages/*/stage.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const PACK_STAGE_MANIFESTS = import.meta.glob('/content/packs/*/stages/*/stage.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const PACK_MANIFESTS = import.meta.glob('/content/packs/*/pack.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const STAGE_MODULES = import.meta.glob('/content/**/stage.ts') as Record<string, () => Promise<{ default: StageModule }>>;
const MUSIC_MODULES = import.meta.glob('/content/**/music/*.ts') as Record<string, () => Promise<{ default: unknown }>>;
const ASSET_URLS = import.meta.glob('/content/**/*.{glb,gltf,png,jpg,jpeg,webp,avif,ogg,mp3,wav,flac,m4a,opus}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const JSON_FILES = import.meta.glob('/content/**/music/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const PROFILES = import.meta.glob('/content/shared/reactivity/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

export const ENGINE_VERSION_STRING = '1.0.0';

const packSchema = z.object({ id: z.string(), name: z.string(), version: z.string(), engine: z.string().default('*') });

export interface StageInfo {
  readonly id: string;
  /** Absolute content folder, e.g. "/content/stages/luminous-tide". */
  readonly dir: string;
  readonly manifest: StageManifest | null;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly source: string;
  readonly available: boolean;
}

function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

function existsInContent(path: string): boolean {
  return path in ASSET_URLS || path in STAGE_MODULES || path in MUSIC_MODULES || path in JSON_FILES;
}

/** Resolves a stage-relative path to a served URL (hashed in production builds). */
export function resolveAsset(dir: string, relative: string): string | null {
  const clean = relative.replace(/^\.\//, '');
  const shared = clean.startsWith('/') ? clean : `${dir}/${clean}`;
  return ASSET_URLS[shared] ?? null;
}

let cache: StageInfo[] | null = null;

/** All discovered stages, validated, sorted by `order` then name. Invalid stages are kept with errors. */
export function discoverStages(): StageInfo[] {
  if (cache) return cache;
  const known = new Set(registries.components.keys());
  const packs = new Map<string, { ok: boolean; error?: string }>();
  for (const [path, raw] of Object.entries(PACK_MANIFESTS)) {
    const parsed = packSchema.safeParse(raw);
    const dir = folderOf(path);
    if (!parsed.success) packs.set(dir, { ok: false, error: 'pack.json is invalid' });
    else if (!satisfiesRange(ENGINE_VERSION_STRING, parsed.data.engine)) packs.set(dir, { ok: false, error: `pack requires engine ${parsed.data.engine}` });
    else packs.set(dir, { ok: true });
  }
  const entries = [...Object.entries(CORE_MANIFESTS).map(([p, m]) => [p, m, 'core'] as const), ...Object.entries(PACK_STAGE_MANIFESTS).map(([p, m]) => [p, m, p.split('/')[3] ?? 'pack'] as const)];
  const infos: StageInfo[] = [];
  const seen = new Set<string>();
  for (const [path, raw, source] of entries) {
    const dir = folderOf(path);
    const folder = dir.slice(dir.lastIndexOf('/') + 1);
    const result = validateManifest(raw, {
      sdkVersion: SDK_VERSION,
      knownComponents: known,
      folder,
      assetExists: (rel) => existsInContent(`${dir}/${rel.replace(/^\.\//, '')}`) || existsInContent(rel),
    });
    const errors = [...result.errors];
    if (source !== 'core') {
      const packDir = dir.split('/stages/')[0] ?? '';
      const pack = packs.get(packDir);
      if (!pack) errors.push('content pack has no pack.json');
      else if (!pack.ok) errors.push(pack.error ?? 'pack invalid');
    }
    const id = result.manifest?.id ?? folder;
    if (seen.has(id)) errors.push(`duplicate stage id "${id}"`);
    seen.add(id);
    infos.push({ id, dir, manifest: result.manifest, errors, warnings: result.warnings, source, available: errors.length === 0 && result.manifest !== null });
  }
  infos.sort((a, b) => (a.manifest?.order ?? 1e9) - (b.manifest?.order ?? 1e9) || a.id.localeCompare(b.id));
  for (const s of infos) if (!s.available) console.warn(`[stages] "${s.id}" unavailable:`, s.errors.join('; '));
  cache = infos;
  return infos;
}

export function getStage(id: string): StageInfo | undefined {
  return discoverStages().find((s) => s.id === id);
}

export function availableStages(): StageInfo[] {
  return discoverStages().filter((s) => s.available);
}

/** Loads (once) and runs a stage's custom module so its components/effects are registered. */
const loadedModules = new Set<string>();
export async function loadStageModule(info: StageInfo): Promise<void> {
  const rel = info.manifest?.module;
  if (!rel || loadedModules.has(info.dir)) return;
  const key = `${info.dir}/${rel.replace(/^\.\//, '')}`;
  const loader = STAGE_MODULES[key];
  if (!loader) throw new Error(`stage module ${key} missing`);
  const mod = (await loader()).default;
  if (!satisfiesRange(SDK_VERSION, mod.sdkVersion.startsWith('^') ? mod.sdkVersion : `^${mod.sdkVersion}`)) {
    throw new Error(`stage module targets SDK ${mod.sdkVersion}`);
  }
  mod.register(registries);
  loadedModules.add(info.dir);
}

export async function loadMusicModule(info: StageInfo, src: string): Promise<unknown> {
  const loader = MUSIC_MODULES[`${info.dir}/${src.replace(/^\.\//, '')}`];
  if (!loader) throw new Error(`music module ${src} not found in ${info.dir}`);
  return (await loader()).default;
}

export function readTrackMeta(info: StageInfo, src: string): unknown {
  return JSON_FILES[`${info.dir}/${src.replace(/^\.\//, '')}`];
}

/** Reusable reactivity profiles (content/shared/reactivity/<name>.json → { bindings: Binding[] }). */
export function reactivityProfile(name: string): Binding[] {
  const raw = PROFILES[`/content/shared/reactivity/${name}.json`] as { bindings?: Binding[] } | undefined;
  return raw?.bindings ?? [];
}

/** Clears the discovery cache (tests, hot reload). */
export function resetStageCache(): void {
  cache = null;
}
