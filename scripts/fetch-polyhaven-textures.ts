/**
 * Downloads Poly Haven PBR texture sets (JPG maps: Diffuse, OpenGL normal, roughness, ARM) into
 * assets/external/polyhaven/<id>/ and records them in source.json (URLs, sizes, MD5s, authors).
 * Files whose MD5 already matches are kept, so it also restores originals that are not committed.
 * Every Poly Haven asset is CC0 (https://polyhaven.com/license).
 *
 * Usage: node scripts/fetch-polyhaven-textures.ts <id> [<id> ...] [--res 1k] [--maps Diffuse,nor_gl,Rough,arm]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const res = option('--res', '1k');
const maps = option('--maps', 'Diffuse,nor_gl,Rough,arm').split(',');
const valued = new Set(['--res', '--maps']);
const ids = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''));
if (ids.length === 0) {
  console.error('usage: node scripts/fetch-polyhaven-textures.ts <id> [<id> ...] [--res 1k] [--maps Diffuse,nor_gl,Rough,arm]');
  process.exit(1);
}

interface FileRef {
  url: string;
  md5: string;
  size: number;
}
interface Info {
  name: string;
  type: number;
  authors?: Record<string, string>;
  dimensions?: number[];
  files_hash?: string;
}

for (const id of ids) {
  const info = (await (await fetch(`https://api.polyhaven.com/info/${id}`)).json()) as Info;
  if (info.type !== 1) throw new Error(`${id} is not a texture (Poly Haven type ${info.type})`);
  const files = (await (await fetch(`https://api.polyhaven.com/files/${id}`)).json()) as Record<string, Record<string, Record<string, FileRef>>>;
  const dir = join(ROOT, 'assets/external/polyhaven', id);
  mkdirSync(dir, { recursive: true });
  const list: { map: string; path: string; url: string; size: number; md5: string }[] = [];
  for (const map of maps) {
    const f = files[map]?.[res]?.jpg;
    if (!f) {
      console.log(`${id}: no ${map} JPG at ${res}`);
      continue;
    }
    const name = `${id}_${map.toLowerCase()}_${res}.jpg`;
    const path = join(dir, name);
    if (!existsSync(path) || createHash('md5').update(readFileSync(path)).digest('hex') !== f.md5) {
      const bytes = Buffer.from(await (await fetch(f.url)).arrayBuffer());
      const md5 = createHash('md5').update(bytes).digest('hex');
      if (md5 !== f.md5) throw new Error(`MD5 mismatch for ${name}: ${md5} != ${f.md5}`);
      writeFileSync(path, bytes);
    }
    list.push({ map, path: name, url: f.url, size: f.size, md5: f.md5 });
  }
  const sourcePath = join(dir, 'source.json');
  const previous = existsSync(sourcePath) ? (JSON.parse(readFileSync(sourcePath, 'utf8')) as Record<string, unknown>) : {};
  const source: Record<string, unknown> = {
    id,
    name: info.name,
    type: 'texture',
    generator: 'scripts/fetch-polyhaven-textures.ts',
    page: `https://polyhaven.com/a/${id}`,
    api: { info: `https://api.polyhaven.com/info/${id}`, files: `https://api.polyhaven.com/files/${id}` },
    authors: info.authors ?? {},
    license: 'CC0 1.0',
    licenseUrl: 'https://polyhaven.com/license',
    ...(info.dimensions ? { dimensionsMm: info.dimensions } : {}),
    resolution: res,
    ...(info.files_hash ? { filesHash: info.files_hash } : {}),
    files: list,
    downloaded: typeof previous.downloaded === 'string' ? previous.downloaded : new Date().toISOString().slice(0, 10),
  };
  if (previous.derived) source.derived = previous.derived;
  writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  console.log(`FETCH_OK ${id} ${res}: ${list.map((f) => f.map).join(', ')}`);
}
