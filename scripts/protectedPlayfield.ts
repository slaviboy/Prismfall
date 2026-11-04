/**
 * The protected playfield (PROTECTED_PLAYFIELD.md): the files and world-manifest fields that decide
 * how the board, the seven pieces and the gameplay feedback look. The background work must not touch
 * them; `scripts/protectedPlayfield.test.ts` compares them with the snapshot in
 * `scripts/protected-playfield.json`, and `scripts/playfield-baseline.ts` compares the rendered board.
 *
 *   node scripts/protectedPlayfield.ts            report changes against the snapshot
 *   node scripts/protectedPlayfield.ts --update   write a new snapshot (only for a deliberate board change)
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
export const SNAPSHOT_PATH = join(ROOT, 'scripts', 'protected-playfield.json');

/**
 * Source files and folders whose content decides the board's look and behaviour. Folders are taken
 * recursively; test files are left out (tests may change).
 */
export const PROTECTED_SOURCES: readonly string[] = [
  'src/game',
  'src/rendering/board',
  'src/rendering/materials',
  'src/rendering/camera',
  'src/rendering/lighting',
  'src/rendering/postprocessing',
  'src/rendering/fx/FeedbackDirector.ts',
  'src/rendering/fx/lineClearEffects.ts',
  'src/rendering/particles/BurstSystem.ts',
  'src/rendering/shaders/uniforms.ts',
  'content/shared/blocks',
];

/**
 * Manifest fields that reach the board: the palette (frame line, plate, clear colours), the light
 * rig that lights the blocks, the grade and tone mapping (the whole frame, board included), scene
 * fog (blocks are fogged too), the camera framing, the block theme and the board's clear and
 * landing effects.
 */
export const PROTECTED_FIELDS: readonly string[] = ['palette', 'lighting', 'grade', 'fog', 'camera', 'blocks', 'effects.lineClear', 'effects.landing'];

export interface Snapshot {
  readonly note: string;
  readonly sources: Record<string, string>;
  readonly manifests: Record<string, string>;
}

function walk(path: string, out: string[]): void {
  const abs = join(ROOT, path);
  if (!existsSync(abs)) return;
  if (statSync(abs).isDirectory()) {
    for (const name of readdirSync(abs).sort()) walk(`${path}/${name}`, out);
  } else if (!/\.test\.ts$/.test(path)) out.push(path);
}

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex').slice(0, 20);

/** Line endings are normalised so a checkout with CRLF conversion hashes the same. */
function fileHash(path: string): string {
  const buf = readFileSync(join(ROOT, path));
  const text = /\.(ts|tsx|json|js)$/.test(path) ? Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n')) : buf;
  return sha(text);
}

/** JSON with sorted keys, so field order does not matter. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function pick(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined;
  return cur;
}

/** The protected part of one world manifest, as canonical JSON. */
export function protectedManifest(raw: Record<string, unknown>): string {
  return canonical(Object.fromEntries(PROTECTED_FIELDS.map((f) => [f, pick(raw, f) ?? null])));
}

export function currentSnapshot(): Snapshot {
  const files: string[] = [];
  for (const p of PROTECTED_SOURCES) walk(p, files);
  const sources = Object.fromEntries(files.map((f) => [f, fileHash(f)]));
  const stagesDir = join(ROOT, 'content', 'stages');
  const manifests: Record<string, string> = {};
  for (const id of readdirSync(stagesDir).sort()) {
    const path = join(stagesDir, id, 'stage.json');
    if (!existsSync(path)) continue;
    manifests[id] = sha(protectedManifest(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>));
  }
  return { note: 'Protected playfield snapshot; regenerate only for a deliberate board change: node scripts/protectedPlayfield.ts --update', sources, manifests };
}

export interface Changes {
  readonly changedSources: string[];
  readonly missingSources: string[];
  readonly addedSources: string[];
  readonly changedManifests: string[];
  readonly missingManifests: string[];
}

/** What differs from the snapshot. New worlds are not protected and are not reported. */
export function compare(snapshot: Snapshot, now: Snapshot = currentSnapshot()): Changes {
  return {
    changedSources: Object.keys(snapshot.sources).filter((f) => f in now.sources && now.sources[f] !== snapshot.sources[f]),
    missingSources: Object.keys(snapshot.sources).filter((f) => !(f in now.sources)),
    addedSources: Object.keys(now.sources).filter((f) => !(f in snapshot.sources)),
    changedManifests: Object.keys(snapshot.manifests).filter((id) => id in now.manifests && now.manifests[id] !== snapshot.manifests[id]),
    missingManifests: Object.keys(snapshot.manifests).filter((id) => !(id in now.manifests)),
  };
}

export function readSnapshot(): Snapshot {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  if (process.argv.includes('--update')) {
    const snap = currentSnapshot();
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snap, null, 2)}\n`);
    console.log(`wrote ${relative(ROOT, SNAPSHOT_PATH)}: ${Object.keys(snap.sources).length} files, ${Object.keys(snap.manifests).length} worlds`);
  } else {
    const c = compare(readSnapshot());
    const lines = [
      ...c.changedSources.map((f) => `changed  ${f}`),
      ...c.missingSources.map((f) => `missing  ${f}`),
      ...c.addedSources.map((f) => `added    ${f}`),
      ...c.changedManifests.map((id) => `changed  content/stages/${id}/stage.json (protected fields)`),
      ...c.missingManifests.map((id) => `missing  content/stages/${id}/stage.json`),
    ];
    console.log(lines.length === 0 ? 'Protected playfield: unchanged.' : lines.join('\n'));
    process.exit(lines.length === 0 ? 0 : 1);
  }
}
