/**
 * Fetches a Poly Haven HDRI as its tonemapped JPG and turns it into a horizon band for the sky
 * component's `panorama` option: the original goes to assets/external/polyhaven/<id>/ with a
 * source.json, the band (cropped to the given elevations, WebP) to content/stages/<stage>/textures/.
 * Prints the band's top-row colour, which the sky gradient above it should continue from.
 *
 * Usage: node scripts/fetch-panorama.ts <id> <stage> [--elevation -6,40] [--quality 86]
 *          [--detail --center 0.7 --azimuth 70 [--keep-hdr]]
 * --detail also builds <id>_detail.webp: the visible directions (centre +- azimuth degrees) at the
 * full HDR resolution (20k when available), for crisp horizons on wide and 4K screens.
 * Requires ffmpeg on PATH. Poly Haven assets are CC0 (https://polyhaven.com/license).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

// --detail: a high-resolution crop of the directions the camera can see, from the full-resolution
// HDR, tone-mapped to match Poly Haven's own grade (scripts/panorama_match.py). The sky shader
// uses it inside `uRange` and the low-resolution band everywhere else.
let detail: { path: string; uRange: [number, number]; size: string; source: string } | null = null;
if (process.argv.includes('--detail')) {
  const hdri = (files as unknown as { hdri: Record<string, { hdr?: { url: string; md5: string; size: number } }> }).hdri;
  const res = ['20k', '16k', '8k'].find((r) => hdri[r]?.hdr);
  const hdr = res ? hdri[res]?.hdr : undefined;
  if (!hdr || !res) throw new Error(`${id} has no HDR download`);
  const centre = Number(opt('center', '0.5'));
  const half = Number(opt('azimuth', '70')) / 360;
  const hdrPath = join(dir, `${id}_${res}.hdr`);
  if (!existsSync(hdrPath) || statSync(hdrPath).size !== hdr.size) {
    console.log(`downloading ${res} HDR (${Math.round(hdr.size / 1048576)} MB)...`);
    writeFileSync(hdrPath, Buffer.from(await (await fetch(hdr.url)).arrayBuffer()));
  }
  const [hw, hh] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', hdrPath]).toString().trim().split(',').map(Number) as [number, number];
  const crop = (W: number, H: number) => {
    const x0 = Math.round((centre - half) * W);
    const cw = Math.round(2 * half * W);
    const top = Math.round((0.5 - high / 180) * H);
    const ch = Math.round((0.5 - low / 180) * H) - top;
    if (x0 < 0 || x0 + cw > W) throw new Error('the detail crop wraps around the panorama seam; choose another --center');
    return { x0, cw, top, ch };
  };
  const big = crop(hw, hh);
  const ref = crop(w, h);
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const ff = (...a: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { maxBuffer: 1 << 30 });
  ff('-i', hdrPath, '-vf', `crop=${big.cw}:${big.ch}:${big.x0}:${big.top}`, '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', join(tmp, 'full.f32'));
  ff('-i', hdrPath, '-vf', `crop=${big.cw}:${big.ch}:${big.x0}:${big.top},scale=${ref.cw}:${ref.ch}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', join(tmp, 'small.f32'));
  ff('-i', original, '-vf', `crop=${ref.cw}:${ref.ch}:${ref.x0}:${ref.top}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', join(tmp, 'ref.rgb'));
  execFileSync('python', [join(ROOT, 'scripts/panorama_match.py'), join(tmp, 'full.f32'), String(big.cw), String(big.ch), join(tmp, 'small.f32'), join(tmp, 'ref.rgb'), String(ref.cw), String(ref.ch), join(tmp, 'out.rgb')], { stdio: 'inherit' });
  const detailPath = join(outDir, `${id}_detail.webp`);
  ff('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${big.cw}x${big.ch}`, '-i', join(tmp, 'out.rgb'), '-vf', 'unsharp=3:3:0.3:3:3:0', '-c:v', 'libwebp', '-quality', '90', detailPath);
  rmSync(tmp, { recursive: true, force: true });
  if (!process.argv.includes('--keep-hdr')) rmSync(hdrPath, { force: true });
  detail = { path: detailPath, uRange: [big.x0 / hw, (big.x0 + big.cw) / hw], size: `${big.cw}x${big.ch}`, source: `${res} HDR ${hdr.url} (md5 ${hdr.md5})` };
  console.log(`detail ${detailPath}\n  ${detail.size} px, uRange [${detail.uRange.map((u) => u.toFixed(4)).join(', ')}]`);
}

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
  derived: [
    { path: `content/stages/${stage}/textures/${id}_band.webp`, how: `ffmpeg crop=${w}:${y1 - y0}:0:${y0} (elevations ${low}..${high} deg), unsharp 5:5:0.6, libwebp quality ${quality}` },
    ...(detail ? [{ path: `content/stages/${stage}/textures/${id}_detail.webp`, how: `${detail.source}: crop ${detail.size} (uRange ${detail.uRange.map((u) => u.toFixed(4)).join('..')}), tone curve matched to the tonemapped JPG (scripts/panorama_match.py), libwebp quality 90` }] : []),
  ],
};
writeFileSync(join(dir, 'source.json'), `${JSON.stringify(source, null, 2)}\n`);
console.log(`${band}\n  ${w}x${y1 - y0} px, elevations ${low}..${high}, top colour ${hex}, by ${Object.keys(info.authors).join(', ')}`);
