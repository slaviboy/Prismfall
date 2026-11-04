/**
 * Downloads a Sketchfab model through Sketchfab's official download API and prepares it for the
 * game. Sketchfab requires a (free) account for downloads, so this needs the owner's personal API
 * token in the SKETCHFAB_TOKEN environment variable (Sketchfab > Settings > Password & API). The
 * token is only sent to api.sketchfab.com and is never written anywhere.
 *
 * Only models whose licence allows use in the game are accepted: CC0, CC BY or CC BY-SA (the
 * attribution is recorded; NonCommercial and NoDerivatives licences are refused).
 *
 *   SKETCHFAB_TOKEN=... node scripts/fetch-sketchfab.ts <uid> <name> [--max-texture 1024] [--max-triangles 60000] [--clips <a,b,...>] [--drop-tracks <node,...>] [--rest-pose <clip>]
 *   node scripts/fetch-sketchfab.ts <uid> <name> --zip <downloaded glTF zip> [--source-only]
 *
 * With --zip, a glTF archive the owner downloaded from the model's page is used instead of the API
 * download (no token needed); the licence and author still come from Sketchfab's public metadata.
 * With --source-only, it stops after step 1 (for models a stage's own build script prepares, such
 * as scripts/build-red-horizon-robot.ts).
 *
 * 1. Saves the glTF archive into assets/external/sketchfab/<name>/ with source.json (author, page,
 *    licence, download date, file MD5s).
 * 2. Packs it into one GLB, keeping its skeleton and animations, converts spec/gloss materials to
 *    metal/rough (three.js no longer reads spec/gloss), and optimises it with glTF-Transform
 *    (meshopt, WebP textures capped at --max-texture) into content/shared/creatures/<name>.glb.
 *    --clips keeps only the named animation clips (for rigs that ship a library of a hundred);
 *    --drop-tracks removes every clip's tracks on the named nodes (a stray key on the model's
 *    root node that turns it over in one clip); --rest-pose <clip> sets the nodes' own transforms
 *    to that clip's first frame (for rigs exported in a stray pose).
 *    Meshes over --max-triangles are simplified; when per-vertex normal splits stop the simplifier
 *    well short of the budget (typical of scans and generated models), the normals are dropped,
 *    the mesh welded and simplified, and smooth normals rebuilt.
 * 3. Prints the animation clips and the rows to add to ASSET_LICENSES.md.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Document, NodeIO, Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { flatten, join as joinPrimitives, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

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
const dir = join(ROOT, 'assets/external/sketchfab', name);
mkdirSync(dir, { recursive: true });
const zipPath = join(dir, `${name}.gltf.zip`);
const localZip = process.argv.includes('--zip') ? opt('--zip', '') : '';
let zip: Buffer;
if (localZip) {
  if (!existsSync(localZip)) throw new Error(`no such file: ${localZip}`);
  zip = readFileSync(localZip);
} else {
  const token = process.env.SKETCHFAB_TOKEN;
  if (!token) throw new Error('set SKETCHFAB_TOKEN to your Sketchfab API token (Settings > Password & API), or pass --zip with a glTF archive downloaded from the model page; downloads need a free account');
  const res = await fetch(`${API}/models/${uid}/download`, { headers: { Authorization: `Token ${token}` } });
  if (!res.ok) throw new Error(`download request failed: ${res.status} ${res.statusText}`);
  const links = (await res.json()) as { gltf?: { url: string; size: number } };
  if (!links.gltf) throw new Error('no glTF download offered for this model');
  console.log(`downloading ${info.name} (${Math.round(links.gltf.size / 1048576)} MB)...`);
  zip = Buffer.from(await (await fetch(links.gltf.url)).arrayBuffer());
}
writeFileSync(zipPath, zip);
const extracted = join(dir, 'gltf');
rmSync(extracted, { recursive: true, force: true });
mkdirSync(extracted, { recursive: true });
// Windows' own tar (bsdtar) reads zip archives; a GNU tar earlier on PATH (Git Bash) cannot.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tar, ['-xf', zipPath, '-C', extracted]);
// Some archives wrap everything in one folder: lift its contents to the top.
const top = readdirSync(extracted);
if (!top.some((f) => f.endsWith('.gltf')) && top.length === 1 && statSync(join(extracted, top[0]!)).isDirectory()) {
  const inner = join(extracted, top[0]!);
  for (const f of readdirSync(inner)) renameSync(join(inner, f), join(extracted, f));
  rmSync(inner, { recursive: true, force: true });
}
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

if (process.argv.includes('--source-only')) {
  console.log(`${dir}\n  source.json written, glTF extracted to ${extracted}`);
  console.log(`  attribution: "${info.name}" by ${info.user.displayName} (${info.viewerUrl}), ${info.license?.label}`);
  process.exit(0);
}

interface GlbJson {
  animations?: { name?: string }[];
  skins?: unknown[];
  nodes?: { mesh?: number }[];
  meshes?: { primitives: { indices?: number; mode?: number; attributes: Record<string, number> }[] }[];
  accessors?: { count: number }[];
}
/** The JSON chunk of a GLB. */
const glbJson = (path: string): GlbJson => {
  const glb = readFileSync(path);
  return JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as GlbJson;
};
/** Triangles drawn: per node, since optimisation lets identical meshes (a school of fish) share one. */
const triangles = (doc: GlbJson): number => {
  const perMesh = (doc.meshes ?? []).map((m) =>
    m.primitives.reduce((s, p) => {
      if ((p.mode ?? 4) !== 4) return s;
      const acc = doc.accessors?.[p.indices ?? (p.attributes.POSITION as number)];
      return s + Math.floor((acc?.count ?? 0) / 3);
    }, 0),
  );
  return (doc.nodes ?? []).reduce((sum, n) => sum + (n.mesh === undefined ? 0 : (perMesh[n.mesh] ?? 0)), 0);
};

/**
 * Area-weighted smooth normals over every face at a vertex's position, so UV seams do not show;
 * faces turned more than `crease` degrees from the vertex's own are left out (thin two-sided parts).
 */
function smoothNormals(pos: ArrayLike<number>, idx: ArrayLike<number>, crease: number): Float32Array<ArrayBuffer> {
  const nv = pos.length / 3;
  const nt = Math.floor(idx.length / 3);
  const fn = new Float64Array(nt * 3);
  const own = new Float64Array(nv * 3);
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3]! * 3, b = idx[t * 3 + 1]! * 3, c = idx[t * 3 + 2]! * 3;
    const ux = pos[b]! - pos[a]!, uy = pos[b + 1]! - pos[a + 1]!, uz = pos[b + 2]! - pos[a + 2]!;
    const vx = pos[c]! - pos[a]!, vy = pos[c + 1]! - pos[a + 1]!, vz = pos[c + 2]! - pos[a + 2]!;
    fn[t * 3] = uy * vz - uz * vy;
    fn[t * 3 + 1] = uz * vx - ux * vz;
    fn[t * 3 + 2] = ux * vy - uy * vx;
    for (const v of [a / 3, b / 3, c / 3]) for (let k = 0; k < 3; k++) own[v * 3 + k]! += fn[t * 3 + k]!;
  }
  // Faces around each distinct position.
  const group = new Map<string, number>();
  const gid = new Uint32Array(nv);
  for (let v = 0; v < nv; v++) {
    const key = `${pos[v * 3]},${pos[v * 3 + 1]},${pos[v * 3 + 2]}`;
    let g = group.get(key);
    if (g === undefined) group.set(key, (g = group.size));
    gid[v] = g;
  }
  const faces: number[][] = Array.from({ length: group.size }, () => []);
  for (let k = 0; k < nt * 3; k++) faces[gid[idx[k]!]!]!.push((k / 3) | 0);
  const cosC = Math.cos((crease * Math.PI) / 180);
  const out = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    const ol = Math.hypot(own[v * 3]!, own[v * 3 + 1]!, own[v * 3 + 2]!) || 1;
    const o = [own[v * 3]! / ol, own[v * 3 + 1]! / ol, own[v * 3 + 2]! / ol] as const;
    let x = 0, y = 0, z = 0;
    for (const t of faces[gid[v]!]!) {
      const fx = fn[t * 3]!, fy = fn[t * 3 + 1]!, fz = fn[t * 3 + 2]!;
      const l = Math.hypot(fx, fy, fz) || 1;
      if ((fx * o[0] + fy * o[1] + fz * o[2]) / l < cosC) continue;
      x += fx;
      y += fy;
      z += fz;
    }
    const l = Math.hypot(x, y, z);
    out.set(l > 0 ? [x / l, y / l, z / l] : o, v * 3);
  }
  return out;
}

// One GLB, skeleton and clips intact, then meshopt and WebP textures. Heavy scans are simplified to
// --max-triangles (meshoptimizer keeps UVs and skin weights: it only collapses edges onto existing
// vertices), so no model costs more than its budget to load or, when drawn solid, to render.
const out = join(ROOT, 'content/shared/creatures', `${name}.glb`);
const raw = join(dir, `${name}.raw.glb`);
const tx = (...args: string[]) => execFileSync(process.execPath, [GLTF_TRANSFORM, ...args], { stdio: 'inherit' });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const edit = async (path: string, change: (doc: Document) => Promise<void> | void): Promise<void> => {
  const doc = await io.read(path);
  await change(doc);
  await io.write(path, doc);
};
tx('copy', join(extracted, gltfFile), raw);
// three.js no longer reads spec/gloss materials (their diffuse texture would be lost): convert them.
if (readFileSync(join(extracted, gltfFile), 'utf8').includes('KHR_materials_pbrSpecularGlossiness')) tx('metalrough', raw, raw);
const list = (flag: string): string[] =>
  opt(flag, '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
const keepClips = list('--clips');
const dropTracks = list('--drop-tracks');
const restPose = opt('--rest-pose', '');
if (keepClips.length > 0 || dropTracks.length > 0 || restPose) {
  await edit(raw, (doc) => {
    const anims = doc.getRoot().listAnimations();
    const missing = [...keepClips, ...(restPose ? [restPose] : [])].filter((c) => !anims.some((a) => a.getName() === c));
    if (missing.length > 0) throw new Error(`no clip named ${missing.join(', ')}; the clips are: ${anims.map((a) => a.getName()).join(', ')}`);
    // The nodes' own transforms become the clip's first frame: a model whose rest pose is a stray
    // export pose (a donkey lying askew) then stands right before any clip plays, and fits its bounds.
    for (const c of anims.find((a) => a.getName() === restPose)?.listChannels() ?? []) {
      const node = c.getTargetNode();
      const sampler = c.getSampler();
      const output = sampler?.getOutput();
      if (!node || !sampler || !output) continue;
      // Cubic spline outputs hold (in-tangent, value, out-tangent) per key.
      const v: number[] = output.getElement(sampler.getInterpolation() === 'CUBICSPLINE' ? 1 : 0, []);
      if (c.getTargetPath() === 'rotation') node.setRotation(v as [number, number, number, number]);
      else if (c.getTargetPath() === 'translation') node.setTranslation(v as [number, number, number]);
      else if (c.getTargetPath() === 'scale') node.setScale(v as [number, number, number]);
    }
    for (const a of anims) {
      if (keepClips.length > 0 && !keepClips.includes(a.getName())) {
        for (const c of a.listChannels()) c.dispose();
        for (const s of a.listSamplers()) s.dispose();
        a.dispose();
        continue;
      }
      for (const c of a.listChannels()) {
        if (!dropTracks.includes(c.getTargetNode()?.getName() ?? '')) continue;
        console.log(`  ${a.getName()}: dropped the ${c.getTargetPath()} track on ${c.getTargetNode()?.getName()}`);
        const sampler = c.getSampler();
        c.dispose();
        if (sampler && !sampler.listParents().some((p) => p.propertyType === 'AnimationChannel')) sampler.dispose();
      }
    }
  });
}
const maxTriangles = Number(opt('--max-triangles', '60000'));
const sourceTriangles = triangles(glbJson(raw));
const ratio = Math.min(1, maxTriangles / sourceTriangles);
// Open borders stay put first: collapsing along a UV seam that is an open border smears the texture
// (dark and stray patches across a horse's coat). Only when that misses the budget are they let go.
let lockBorder = true;
const optimize = (simplified: boolean) =>
  tx('optimize', raw, out, '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', opt('--max-texture', '1024'), ...(simplified ? ['--simplify', 'true', '--simplify-ratio', ratio.toFixed(4), '--simplify-error', '0.01', '--simplify-lock-border', String(lockBorder)] : ['--simplify', 'false']));
const overBudget = () => triangles(glbJson(out)) > maxTriangles * 1.25;
optimize(ratio < 1);
if (ratio < 1 && overBudget()) {
  console.log(`\n${triangles(glbJson(out))} triangles with the borders locked: simplifying again with them free`);
  lockBorder = false;
  optimize(true);
}
if (overBudget()) {
  // Split normals (a seam at nearly every vertex) lock the simplifier: weld without them, simplify, rebuild smooth ones.
  console.log(`\n${triangles(glbJson(out))} triangles is well over the budget: simplifying again without the split normals`);
  await edit(raw, async (doc) => {
    for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) prim.setAttribute('NORMAL', null).setAttribute('TANGENT', null);
    await doc.transform(flatten(), joinPrimitives(), weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01 }), prune());
    for (const mesh of doc.getRoot().listMeshes())
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
        const position = prim.getAttribute('POSITION')!;
        const indices = prim.getIndices()?.getArray() ?? Uint32Array.from({ length: position.getCount() }, (_, i) => i);
        const normals = smoothNormals(position.getArray()!, indices, 75);
        prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(normals).setBuffer(position.getBuffer()));
      }
  });
  optimize(false);
}
rmSync(raw, { force: true });

// Clip names, from the GLB's JSON chunk.
const doc = glbJson(out);
console.log(`\n${out}`);
console.log(`  triangles: ${sourceTriangles} -> ${triangles(doc)} (budget ${maxTriangles}), ${Math.round(readFileSync(out).length / 1024)} KB`);
console.log(`  skins: ${doc.skins?.length ?? 0}, clips: ${(doc.animations ?? []).map((a) => a.name).join(', ') || 'none'}`);
console.log(`\nASSET_LICENSES.md row:\n| \`content/shared/creatures/${name}.glb\` | Sketchfab "${info.name}" by ${info.user.displayName} (${info.viewerUrl}); glTF packed to GLB and optimised with glTF-Transform (meshopt, WebP textures) | ${info.license?.label} (attribution: ${info.user.displayName}) |`);
if (!existsSync(join(ROOT, '.gitignore')) || !readFileSync(join(ROOT, '.gitignore'), 'utf8').includes('assets/external/sketchfab/')) {
  console.log('\nNote: add assets/external/sketchfab/*/gltf/ and *.zip to .gitignore (keep source.json).');
}
