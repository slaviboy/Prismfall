/**
 * Downloads a Poly Haven model (glTF plus its .bin and textures) into assets/external/polyhaven/<id>/
 * and records its provenance in source.json. Every Poly Haven asset is CC0 (https://polyhaven.com/license).
 * Files whose MD5 already matches the API are not downloaded again (pass --force to re-download).
 *
 * Poly Haven's glTFs mark cut-out foliage MASK or BLEND but reference JPEG base colour textures, which have
 * no alpha channel; the cut-out ships as a separate "Alpha" map. When a material uses alpha, every map whose
 * name ends in "alpha" is downloaded too and listed in source.json as alphaMaps (import_external.py wires it).
 *
 * Usage: node scripts/fetch-polyhaven.ts <id> [--res 1k] [--force] [--out <dir>]
 *   --out  parent folder (default assets/external/polyhaven); the files go to <dir>/<id>/.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const API = 'https://api.polyhaven.com';

interface FileRef {
  url: string;
  size: number;
  md5: string;
}
interface GltfEntry extends FileRef {
  include?: Record<string, FileRef>;
}
interface Info {
  name: string;
  type: number;
  polycount?: number;
  dimensions?: number[];
  authors?: Record<string, string>;
  files_hash?: string;
  date_published?: number;
}

function option(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'User-Agent': 'prismfall-asset-pipeline' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

function md5(data: Uint8Array): string {
  return createHash('md5').update(data).digest('hex');
}

/** Resolves a relative path from the API inside `dir`, rejecting absolute paths and `..` escapes. */
function safeJoin(dir: string, rel: string): string {
  const target = normalize(join(dir, rel));
  if (isAbsolute(rel) || !target.startsWith(dir + sep)) throw new Error(`refusing unsafe path from API: ${rel}`);
  return target;
}

async function download(ref: FileRef, dest: string, force: boolean): Promise<'cached' | 'downloaded'> {
  if (!force && existsSync(dest) && md5(readFileSync(dest)) === ref.md5) return 'cached';
  const res = await fetch(ref.url, { headers: { 'User-Agent': 'prismfall-asset-pipeline' } });
  if (!res.ok) throw new Error(`${ref.url}: HTTP ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const hash = md5(data);
  if (hash !== ref.md5) throw new Error(`${ref.url}: MD5 ${hash} does not match the API (${ref.md5})`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, data);
  return 'downloaded';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const id = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--res' && args[i - 1] !== '--out');
  const res = option(args, '--res', '1k');
  const outRoot = resolve(ROOT, option(args, '--out', 'assets/external/polyhaven'));
  const force = args.includes('--force');
  if (!id || !/^[a-z0-9_]+$/.test(id)) {
    console.error('Usage: node scripts/fetch-polyhaven.ts <id> [--res 1k] [--force] [--out <dir>]');
    process.exit(1);
  }
  const infoUrl = `${API}/info/${id}`;
  const filesUrl = `${API}/files/${id}`;
  const info = await getJson<Info>(infoUrl);
  if (info.type !== 2) throw new Error(`${id} is not a model (Poly Haven type ${info.type})`);
  const files = await getJson<Record<string, Record<string, Record<string, FileRef>>> & { gltf?: Record<string, { gltf?: GltfEntry }> }>(filesUrl);
  const entry = files.gltf?.[res]?.gltf;
  if (!entry) throw new Error(`${id} has no glTF at ${res} (available: ${Object.keys(files.gltf ?? {}).join(', ')})`);

  const dir = join(outRoot, id);
  mkdirSync(dir, { recursive: true });
  const gltfName = entry.url.split('/').pop()!;
  const list: { path: string; url: string; size: number; md5: string }[] = [];
  let fresh = false;
  for (const [rel, ref] of [[gltfName, entry] as const, ...Object.entries(entry.include ?? {})]) {
    const state = await download(ref, safeJoin(dir, rel), force);
    fresh ||= state === 'downloaded';
    console.log(`  ${state === 'cached' ? 'cached    ' : 'downloaded'} ${rel} (${ref.size} B)`);
    list.push({ path: rel, url: ref.url, size: ref.size, md5: ref.md5 });
  }

  // Separate alpha maps for materials that use alpha (see the header comment).
  const gltfJson = JSON.parse(readFileSync(join(dir, gltfName), 'utf8')) as { materials?: { alphaMode?: string }[] };
  const alphaMaps: Record<string, string> = {};
  if ((gltfJson.materials ?? []).some((m) => m.alphaMode === 'MASK' || m.alphaMode === 'BLEND')) {
    for (const [key, byRes] of Object.entries(files)) {
      if (key === 'gltf' || !/(^|_)alpha$/i.test(key)) continue;
      const formats = byRes[res] as Record<string, FileRef> | undefined;
      const ref = formats?.png ?? formats?.jpg;
      if (!ref) continue;
      const rel = `textures/${id}_${key.toLowerCase()}_${res}.${formats?.png ? 'png' : 'jpg'}`;
      const state = await download(ref, safeJoin(dir, rel), force);
      fresh ||= state === 'downloaded';
      console.log(`  ${state === 'cached' ? 'cached    ' : 'downloaded'} ${rel} (${ref.size} B, alpha map)`);
      list.push({ path: rel, url: ref.url, size: ref.size, md5: ref.md5 });
      alphaMaps[key] = rel;
    }
  }
  // Keep the original download date when every file came from the cache.
  const sourcePath = join(dir, 'source.json');
  const previous = existsSync(sourcePath) ? (JSON.parse(readFileSync(sourcePath, 'utf8')) as { downloaded?: string; resolution?: string }) : null;
  const downloaded = !fresh && previous?.downloaded && previous.resolution === res ? previous.downloaded : new Date().toISOString().slice(0, 10);

  const source = {
    id,
    name: info.name,
    source: 'Poly Haven',
    page: `https://polyhaven.com/a/${id}`,
    api: { info: infoUrl, files: filesUrl },
    authors: info.authors ?? {},
    license: 'CC0 1.0',
    licenseUrl: 'https://polyhaven.com/license',
    polycount: info.polycount ?? null,
    dimensionsMm: info.dimensions ?? null,
    resolution: res,
    format: 'glTF 2.0 (.gltf + .bin + JPEG textures)',
    gltf: gltfName,
    gltfUrl: entry.url,
    filesHash: info.files_hash ?? null,
    files: list,
    alphaMaps,
    downloaded,
  };
  writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  console.log(`FETCH_OK ${id} ${res} -> ${relative(ROOT, join(dir, gltfName)).replaceAll('\\', '/')}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
