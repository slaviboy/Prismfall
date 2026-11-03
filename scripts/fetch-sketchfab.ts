/**
 * Downloads a Sketchfab model through Sketchfab's official download API and prepares it for the
 * game. Sketchfab requires a (free) account for downloads, so this needs the owner's personal API
 * token in the SKETCHFAB_TOKEN environment variable (Sketchfab > Settings > Password & API). The
 * token is only sent to api.sketchfab.com and is never written anywhere.
 *
 * Only models whose licence allows use in the game are accepted: CC0, CC BY or CC BY-SA (the
 * attribution is recorded; NonCommercial and NoDerivatives licences are refused).
 *
 *   SKETCHFAB_TOKEN=... node scripts/fetch-sketchfab.ts <uid> <name> [--max-texture 1024]
 *
 * 1. Saves the glTF archive into assets/external/sketchfab/<name>/ with source.json (author, page,
 *    licence, download date, file MD5s).
 * 2. Packs it into one GLB, keeping its skeleton and animations, and optimises it with glTF-Transform
 *    (meshopt, WebP textures capped at --max-texture) into content/shared/creatures/<name>.glb.
 * 3. Prints the animation clips and the rows to add to ASSET_LICENSES.md.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const API = 'https://api.sketchfab.com/v3';
const GLTF_TRANSFORM = join(ROOT, 'node_modules/@gltf-transform/cli/bin/cli.js');
const ALLOWED = ['cc0', 'by', 'by-sa'];

const [uid, name] = process.argv.slice(2);
const opt = (flag: string, def: string): string => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
};
if (!uid || !name || !/^[a-z0-9-]+$/.test(name)) {
  console.error('usage: SKETCHFAB_TOKEN=... node scripts/fetch-sketchfab.ts <uid> <name: a-z0-9-> [--max-texture 1024]');
  process.exit(2);
}

interface ModelInfo {
  name: string;
  viewerUrl: string;
  user: { displayName: string; username: string; profileUrl: string };
  license: { slug: string; label: string; url: string } | null;
  isDownloadable: boolean;
  faceCount: number;
  vertexCount: number;
  animationCount: number;
}

const info = (await (await fetch(`${API}/models/${uid}`)).json()) as ModelInfo;
const slug = info.license?.slug ?? '';
if (!ALLOWED.includes(slug)) throw new Error(`"${info.name}" is licensed ${info.license?.label ?? 'unknown'}; only CC0, CC BY and CC BY-SA can be used`);
if (!info.isDownloadable) throw new Error(`"${info.name}" is not downloadable`);
const token = process.env.SKETCHFAB_TOKEN;
if (!token) throw new Error('set SKETCHFAB_TOKEN to your Sketchfab API token (Settings > Password & API); downloads need a free account');

const res = await fetch(`${API}/models/${uid}/download`, { headers: { Authorization: `Token ${token}` } });
if (!res.ok) throw new Error(`download request failed: ${res.status} ${res.statusText}`);
const links = (await res.json()) as { gltf?: { url: string; size: number } };
if (!links.gltf) throw new Error('no glTF download offered for this model');

const dir = join(ROOT, 'assets/external/sketchfab', name);
mkdirSync(dir, { recursive: true });
const zipPath = join(dir, `${name}.gltf.zip`);
console.log(`downloading ${info.name} (${Math.round(links.gltf.size / 1048576)} MB)...`);
const zip = Buffer.from(await (await fetch(links.gltf.url)).arrayBuffer());
writeFileSync(zipPath, zip);
const extracted = join(dir, 'gltf');
rmSync(extracted, { recursive: true, force: true });
mkdirSync(extracted, { recursive: true });
execFileSync('tar', ['-xf', zipPath, '-C', extracted]);
const gltfFile = readdirSync(extracted).find((f) => f.endsWith('.gltf'));
if (!gltfFile) throw new Error('the archive has no .gltf file');

const md5 = (buf: Buffer): string => createHash('md5').update(buf).digest('hex');
writeFileSync(
  join(dir, 'source.json'),
  `${JSON.stringify(
    {
      uid,
      name: info.name,
      page: info.viewerUrl,
      author: { name: info.user.displayName, username: info.user.username, profile: info.user.profileUrl },
      licence: info.license?.label,
      licenceUrl: info.license?.url,
      attribution: `"${info.name}" by ${info.user.displayName} (${info.viewerUrl}), ${info.license?.label}`,
      downloaded: new Date().toISOString().slice(0, 10),
      faces: info.faceCount,
      vertices: info.vertexCount,
      animations: info.animationCount,
      files: [{ path: `${name}.gltf.zip`, md5: md5(zip), size: zip.length, note: 'Sketchfab glTF archive (git-ignored); download again with this script' }],
    },
    null,
    2,
  )}\n`,
);

// One GLB, skeleton and clips intact, then meshopt and WebP textures.
const out = join(ROOT, 'content/shared/creatures', `${name}.glb`);
const raw = join(dir, `${name}.raw.glb`);
const tx = (...args: string[]) => execFileSync(process.execPath, [GLTF_TRANSFORM, ...args], { stdio: 'inherit' });
tx('copy', join(extracted, gltfFile), raw);
tx('optimize', raw, out, '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', opt('--max-texture', '1024'), '--simplify', 'false');
rmSync(raw, { force: true });

// Clip names, from the GLB's JSON chunk.
const glb = readFileSync(out);
const jsonLength = glb.readUInt32LE(12);
const doc = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8')) as { animations?: { name?: string }[]; skins?: unknown[] };
console.log(`\n${out}`);
console.log(`  skins: ${doc.skins?.length ?? 0}, clips: ${(doc.animations ?? []).map((a) => a.name).join(', ') || 'none'}`);
console.log(`\nASSET_LICENSES.md row:\n| \`content/shared/creatures/${name}.glb\` | Sketchfab "${info.name}" by ${info.user.displayName} (${info.viewerUrl}); glTF packed to GLB and optimised with glTF-Transform (meshopt, WebP textures) | ${info.license?.label} (attribution: ${info.user.displayName}) |`);
if (!existsSync(join(ROOT, '.gitignore')) || !readFileSync(join(ROOT, '.gitignore'), 'utf8').includes('assets/external/sketchfab/')) {
  console.log('\nNote: add assets/external/sketchfab/*/gltf/ and *.zip to .gitignore (keep source.json).');
}
