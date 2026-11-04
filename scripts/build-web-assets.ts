/**
 * Prepares The Web's models from the owner's Sketchfab downloads (imported with
 * `node scripts/fetch-sketchfab.ts <uid> <name> --zip <zip> --source-only`, so each lives in
 * assets/external/sketchfab/<name>/gltf/ with its source.json).
 *
 *   node scripts/build-web-assets.ts [--only <name,name>]
 *
 * For every model: drop what the world does not use (the black widow's leaf-and-web set, empty
 * clips), simplify heavy scans to a triangle budget with meshoptimizer, resize textures and store
 * them as WebP, and compress geometry with meshopt. Spiders keep their skeleton and walk clips.
 * Writes content/stages/the-web/models/<out>.glb and prints sizes, triangle counts, bounds and clip
 * names (the rows ASSET_LICENSES.md needs come from each source.json).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NodeIO, type Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { dedup, getBounds, prune, quantize, reorder, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'assets/external/sketchfab');
const OUT = join(ROOT, 'content/stages/the-web/models');

interface Job {
  name: string;
  out: string;
  /** Triangle budget (simplified when above it). */
  triangles?: number;
  /** Largest texture side. */
  texture: number;
  /** Keep only skinned meshes (drops props baked into a creature's scene). */
  skinnedOnly?: boolean;
  /** Clip names to drop (empty or helper actions). */
  dropClips?: RegExp;
}

const JOBS: Job[] = [
  { name: 'goliath-birdeater', out: 'goliath', texture: 2048, dropClips: /CircleAction/ },
  { name: 'black-widow', out: 'widow', texture: 2048, skinnedOnly: true },
  { name: 'wolf-spider', out: 'wolf', texture: 1024, dropClips: /ArmatureAction$/ },
  { name: 'huntsman-spider', out: 'huntsman', texture: 1024, triangles: 18000 },
  { name: 'gothic-chapel', out: 'chapel', texture: 2048, triangles: 170000 },
  { name: 'stone-gate', out: 'gate', texture: 2048, triangles: 90000 },
  { name: 'cave-rocks', out: 'cave', texture: 2048 },
  { name: 'gargoyle', out: 'gargoyle', texture: 1024, triangles: 32000 },
  { name: 'cobwebs', out: 'cobwebs', texture: 1024 },
];

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? new Set((process.argv[i + 1] ?? '').split(',')) : null;
})();

await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
mkdirSync(OUT, { recursive: true });

const triangles = (doc: Document): number =>
  doc
    .getRoot()
    .listMeshes()
    .reduce((s, m) => s + m.listPrimitives().reduce((t, p) => t + Math.floor((p.getIndices()?.getCount() ?? p.getAttribute('POSITION')!.getCount()) / 3), 0), 0);

// Floor textures (Poly Haven, CC0), downloaded by scripts/fetch-polyhaven-textures.ts: WebP at 1024 px.
const POLY = join(ROOT, 'assets/external/polyhaven');
const TEX_OUT = join(ROOT, 'content/stages/the-web/textures');
const TEXTURES = [
  { id: 'castle_wall_varriation', out: 'flags', maps: { diffuse: 'diff', nor_gl: 'nor', arm: 'arm' } },
  { id: 'brown_mud_leaves_01', out: 'mud', maps: { diffuse: 'diff', nor_gl: 'nor', arm: 'arm' } },
];
if (!only || only.has('textures')) {
  mkdirSync(TEX_OUT, { recursive: true });
  for (const t of TEXTURES) {
    for (const [from, to] of Object.entries(t.maps)) {
      const src = join(POLY, t.id, `${t.id}_${from}_2k.jpg`);
      if (!existsSync(src)) {
        console.log(`skip ${src}`);
        continue;
      }
      const dst = join(TEX_OUT, `${t.out}_${to}.webp`);
      const info = await sharp(src).resize(1024, 1024).webp({ quality: to === 'diff' ? 86 : 90, effort: 6 }).toFile(dst);
      console.log(`textures/${t.out}_${to}.webp  ${Math.round(info.size / 1024)} KB  (Poly Haven ${t.id})`);
    }
  }
}

for (const job of JOBS) {
  if (only && !only.has(job.name) && !only.has(job.out)) continue;
  const file = join(SRC, job.name, 'gltf', 'scene.gltf');
  if (!existsSync(file)) {
    console.log(`skip ${job.name}: no ${file}`);
    continue;
  }
  const doc = await io.read(file);
  const root = doc.getRoot();
  if (job.skinnedOnly) {
    for (const node of root.listNodes()) {
      if (node.getMesh() && !node.getSkin()) {
        node.getMesh()!.dispose();
        node.setMesh(null);
      }
    }
  }
  if (job.dropClips) for (const a of root.listAnimations()) if (job.dropClips.test(a.getName())) a.dispose();
  // Unused UV sets and the specular extension's extra maps cost bandwidth for nothing.
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const sem of prim.listSemantics()) if (/^TEXCOORD_[1-9]$/.test(sem)) prim.setAttribute(sem, null);
    }
  }
  for (const m of root.listMaterials()) {
    m.setExtension('KHR_materials_specular', null);
    m.setExtension('KHR_materials_clearcoat', null);
  }
  await doc.transform(prune(), dedup());
  const before = triangles(doc);
  if (job.triangles && before > job.triangles) {
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: job.triangles / before, error: 0.02, lockBorder: false }));
  }
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [job.texture, job.texture], quality: 88 }),
    prune(),
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    quantize(),
  );
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  const out = join(OUT, `${job.out}.glb`);
  writeFileSync(out, await io.writeBinary(doc));
  const b = getBounds(root.listScenes()[0]!);
  const size = b.max.map((v, i) => +(v - b.min[i]!).toFixed(3));
  const clips = root.listAnimations().map((a) => a.getName());
  const skins = root.listSkins().map((s) => s.listJoints().length);
  const meta = JSON.parse(readFileSync(join(SRC, job.name, 'source.json'), 'utf8')) as { attribution: string };
  console.log(`${job.out}.glb  ${Math.round(statSync(out).size / 1024)} KB  tris ${before} -> ${triangles(doc)}  size ${size.join(' x ')}  min ${b.min.map((v) => +v.toFixed(3)).join(',')}  skins ${skins.join(',') || '-'}  clips ${clips.join(' | ') || '-'}`);
  console.log(`   ${meta.attribution}`);
}
