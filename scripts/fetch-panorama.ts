/**
 * Fetches a Poly Haven HDRI as its tonemapped JPG and turns it into a horizon band for the sky
 * component's `panorama` option: the original goes to assets/external/polyhaven/<id>/ with a
 * source.json, the band (cropped to the given elevations, WebP) to content/stages/<stage>/textures/.
 * Prints the band's top-row colour, which the sky gradient above it should continue from.
 *
 * Usage: node scripts/fetch-panorama.ts <id> <stage> [--elevation -6,40] [--quality 86]
 * Requires ffmpeg on PATH. Poly Haven assets are CC0 (https://polyhaven.com/license).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const [id, stage] = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
};
if (!id || !stage) {
  console.error('usage: node scripts/fetch-panorama.ts <id> <stage> [--elevation -6,40] [--quality 86]');
  process.exit(1);
}
const [low, high] = opt('elevation', '-6,40').split(',').map(Number) as [number, number];
const quality = opt('quality', '86');

const files = (await (await fetch(`https://api.polyhaven.com/files/${id}`)).json()) as { tonemapped?: { url: string; md5: string; size: number } };
const info = (await (await fetch(`https://api.polyhaven.com/info/${id}`)).json()) as { name: string; authors: Record<string, string> };
const tm = files.tonemapped;
if (!tm) throw new Error(`${id} has no tonemapped JPG`);

const dir = join(ROOT, 'assets/external/polyhaven', id);
mkdirSync(dir, { recursive: true });
const original = join(dir, `${id}_tonemapped.jpg`);
if (!existsSync(original) || createHash('md5').update(readFileSync(original)).digest('hex') !== tm.md5) {
  const bytes = Buffer.from(await (await fetch(tm.url)).arrayBuffer());
  const md5 = createHash('md5').update(bytes).digest('hex');
  if (md5 !== tm.md5) throw new Error(`MD5 mismatch for ${id}: ${md5} != ${tm.md5}`);
  writeFileSync(original, bytes);
}

const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', original]).toString().trim();
const [w, h] = probe.split(',').map(Number) as [number, number];
// Equirectangular rows: elevation +90 at the top, -90 at the bottom.
const y0 = Math.round((0.5 - high / 180) * h);
const y1 = Math.round((0.5 - low / 180) * h);
const outDir = join(ROOT, 'content/stages', stage, 'textures');
mkdirSync(outDir, { recursive: true });
const band = join(outDir, `${id}_band.webp`);
// A mild unsharp mask: the band is magnified slightly on wide, high-resolution screens.
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', original, '-vf', `crop=${w}:${y1 - y0}:0:${y0},unsharp=5:5:0.6:5:5:0`, '-c:v', 'libwebp', '-quality', quality, band]);
const top = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', original, '-vf', `crop=${w}:${Math.max(2, Math.round(h / 100))}:0:${y0},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
const hex = `#${[...top.subarray(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

const source = {
  id,
  kind: 'hdri',
  name: info.name,
  page: `https://polyhaven.com/a/${id}`,
  api: { info: `https://api.polyhaven.com/info/${id}`, files: `https://api.polyhaven.com/files/${id}` },
  authors: info.authors,
  licence: 'CC0 1.0',
  licenceUrl: 'https://polyhaven.com/license',
  files: [{ path: `${id}_tonemapped.jpg`, url: tm.url, md5: tm.md5, size: tm.size }],
  downloaded: new Date().toISOString().slice(0, 10),
  derived: [{ path: `content/stages/${stage}/textures/${id}_band.webp`, how: `ffmpeg crop=${w}:${y1 - y0}:0:${y0} (elevations ${low}..${high} deg), unsharp 5:5:0.6, libwebp quality ${quality}` }],
};
writeFileSync(join(dir, 'source.json'), `${JSON.stringify(source, null, 2)}\n`);
console.log(`${band}\n  ${w}x${y1 - y0} px, elevations ${low}..${high}, top colour ${hex}, by ${Object.keys(info.authors).join(', ')}`);
