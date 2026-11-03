/**
 * External photoscan pipeline: fetch -> Blender import -> glTF-Transform optimise -> content/shared/scans/<id>.glb.
 *
 * For every asset in assets/external/scans.json (or only those whose id contains a filter argument):
 *   1. scripts/fetch-polyhaven.ts downloads the glTF into assets/external/polyhaven/<id>/ (cached by MD5);
 *   2. assets/blender/scripts/import_external.py joins, decimates to targetTris, puts the origin at the bottom
 *      centre, caps textures and exports assets/blender/exports/scans/<id>.glb (+ .preview.png, .report.json);
 *   3. glTF-Transform optimises it like scripts/build-blender-assets.ts does (meshopt + quantisation, WebP
 *      textures, no simplify/join/palette) with textures capped at maxTexture;
 *   4. writes content/shared/scans/<id>.meta.json and regenerates the scan section of assets/ASSET_CATALOG.md.
 *
 * Usage: npm run assets:scans [-- <id-filter>...] [--skip-fetch] [--force-fetch] [--no-preview]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const BLENDER = process.env.BLENDER_PATH ?? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
const GLTF_TRANSFORM = join(ROOT, 'node_modules/@gltf-transform/cli/bin/cli.js');
const MANIFEST = join(ROOT, 'assets/external/scans.json');
const EXPORTS = 'assets/blender/exports/scans';
const OUT = 'content/shared/scans';
const CATALOG = join(ROOT, 'assets/ASSET_CATALOG.md');
const SIZE_BUDGET = 3 * 1024 * 1024;

interface Options {
  source: 'polyhaven';
  res: string;
  maxTexture: number;
  alpha: 'auto' | 'opaque' | 'mask' | 'keep';
  /** Keep each top-level mesh as its own object (<id>_<suffix>, all at the origin) instead of joining. */
  split: boolean;
}
interface Entry extends Partial<Options> {
  id: string;
  targetTris: number;
}
interface Manifest {
  defaults: Options;
  assets: Entry[];
}
interface Source {
  id: string;
  name: string;
  page: string;
  authors: Record<string, string>;
  license: string;
  licenseUrl: string;
  polycount: number | null;
  dimensionsMm: number[] | null;
  resolution: string;
  format: string;
  gltf: string;
  gltfUrl: string;
  filesHash: string | null;
  /** Separate cut-out maps by Poly Haven map name (for MASK/BLEND foliage with JPEG base colour). */
  alphaMaps?: Record<string, string>;
  downloaded: string;
}
interface Part {
  name: string;
  sourceTriangles: number;
  triangles: number;
  dimensions: { width: number; depth: number; height: number };
}
interface Report {
  objects: Part[];
  droppedLods: string[];
  sourceTriangles: number;
  targetTriangles: number;
  triangles: number;
  dimensions: { width: number; depth: number; height: number };
  maxTexture: number;
  alphaModes: Record<string, string>;
  alphaChanges: Record<string, string>;
  occlusionAddedFromArm: string[];
}
interface GlbStats {
  triangles: number;
  bytes: number;
  materials: { name: string; alphaMode: string; textures: string[] }[];
  images: { name: string; mimeType: string; bytes: number }[];
  extensions: string[];
}
interface Meta {
  generator: string;
  id: string;
  name: string;
  file: string;
  source: string;
  page: string;
  downloadUrl: string;
  sourceFilesHash: string | null;
  downloaded: string;
  authors: Record<string, string>;
  license: string;
  licenseUrl: string;
  attribution: string;
  originalFormat: string;
  originalTriangles: number;
  modifications: string[];
  animation: string;
  triangles: number;
  dimensionsMetres: { width: number; depth: number; height: number };
  objects: Part[];
  materials: GlbStats['materials'];
  bytes: number;
}

const args = process.argv.slice(2);
const filters = args.filter((a) => !a.startsWith('--'));
const skipFetch = args.includes('--skip-fetch');
const forceFetch = args.includes('--force-fetch');
const noPreview = args.includes('--no-preview');

function run(cmd: string, argv: string[]): string {
  return execFileSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Reads triangle, material and image statistics from a GLB's JSON chunk (works with meshopt buffers). */
function glbStats(path: string): GlbStats {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path} is not a GLB`);
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')) as {
    meshes?: { primitives: { indices?: number; mode?: number; attributes: Record<string, number> }[] }[];
    accessors: { count: number }[];
    materials?: Record<string, unknown>[];
    textures?: { source?: number; extensions?: Record<string, { source?: number }> }[];
    images?: { name?: string; mimeType?: string; bufferView?: number }[];
    bufferViews?: { byteLength: number }[];
    extensionsUsed?: string[];
  };
  let triangles = 0;
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      if ((prim.mode ?? 4) !== 4) continue;
      const count = prim.indices !== undefined ? json.accessors[prim.indices]!.count : json.accessors[prim.attributes.POSITION!]!.count;
      triangles += count / 3;
    }
  }
  const textureSlots = ['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture', 'occlusionTexture', 'emissiveTexture'];
  const materials = (json.materials ?? []).map((m) => {
    const pbr = (m.pbrMetallicRoughness ?? {}) as Record<string, unknown>;
    return {
      name: String(m.name ?? ''),
      alphaMode: String(m.alphaMode ?? 'OPAQUE'),
      textures: textureSlots.filter((slot) => slot in m || slot in pbr).map((slot) => slot.replace('Texture', '')),
    };
  });
  const images = (json.images ?? []).map((img) => ({
    name: img.name ?? '',
    mimeType: img.mimeType ?? '',
    bytes: img.bufferView !== undefined ? json.bufferViews![img.bufferView]!.byteLength : 0,
  }));
  return { triangles, bytes: buf.length, materials, images, extensions: json.extensionsUsed ?? [] };
}

const fmtInt = (n: number): string => n.toLocaleString('en-US');
const fmtBytes = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(0)} KB`);

function processAsset(entry: Entry, opts: Options): Meta {
  const { id } = entry;
  const dir = join(ROOT, 'assets/external/polyhaven', id);
  if (opts.source !== 'polyhaven') throw new Error(`${id}: unsupported source ${String(opts.source)}`);

  // 1. Fetch.
  if (!skipFetch || !existsSync(join(dir, 'source.json'))) {
    const out = run(process.execPath, [join(ROOT, 'scripts/fetch-polyhaven.ts'), id, '--res', opts.res, ...(forceFetch ? ['--force'] : [])]);
    console.log(`  ${out.trim().split('\n').pop()}`);
  }
  const source = JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8')) as Source;

  // 2. Blender: join, decimate, origin, textures, preview.
  if (!existsSync(BLENDER)) throw new Error(`Blender not found at ${BLENDER}. Set BLENDER_PATH.`);
  const raw = join(ROOT, EXPORTS, `${id}.glb`);
  const t0 = Date.now();
  const log = run(BLENDER, [
    '-b', '--factory-startup', '--python-exit-code', '1',
    '--python', join(ROOT, 'assets/blender/scripts/import_external.py'), '--',
    '--input', join(dir, source.gltf), '--output', raw, '--name', id,
    '--target-tris', String(entry.targetTris), '--max-texture', String(opts.maxTexture), '--alpha', opts.alpha,
    ...Object.entries(source.alphaMaps ?? {}).flatMap(([key, rel]) => ['--alpha-map', `${key}=${join(dir, rel)}`]),
    ...(opts.split ? ['--split'] : []),
    ...(noPreview ? ['--no-preview'] : []),
  ]);
  for (const line of log.split('\n').filter((l) => l.startsWith('  ') && l.includes(' triangles, '))) console.log(`  ${line.trim()}`);
  console.log(`  ${log.split('\n').find((l) => l.startsWith('IMPORT_OK'))?.trim() ?? 'Blender finished'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const report = JSON.parse(readFileSync(join(ROOT, EXPORTS, `${id}.report.json`), 'utf8')) as Report;

  // 3. Optimise (same flags as scripts/build-blender-assets.ts, plus the texture size cap).
  mkdirSync(join(ROOT, OUT), { recursive: true });
  const file = `${OUT}/${id}.glb`;
  run(process.execPath, [
    GLTF_TRANSFORM, 'optimize', raw, join(ROOT, file),
    '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', String(opts.maxTexture),
    '--simplify', 'false', '--instance', 'false', '--flatten', 'false', '--join', 'false', '--palette', 'false',
  ]);
  const stats = glbStats(join(ROOT, file));
  console.log(`  ${file}: ${fmtInt(statSync(raw).size)} B -> ${fmtInt(stats.bytes)} B, ${fmtInt(stats.triangles)} triangles`);
  if (stats.bytes > SIZE_BUDGET) console.warn(`  WARNING: ${file} is over the ${fmtBytes(SIZE_BUDGET)} budget`);
  for (const m of stats.materials) {
    const expected = report.alphaModes[m.name];
    if (expected && expected !== 'keep' && expected !== m.alphaMode) console.warn(`  WARNING: ${m.name} exported as ${m.alphaMode}, expected ${expected}`);
  }

  // 4. Metadata.
  const split = report.objects.length > 1;
  const modifications = [
    ...(report.droppedLods.length ? [`kept LOD0 only (dropped ${report.droppedLods.join(', ')})`] : []),
    split
      ? `kept as ${report.objects.length} separate objects (${report.objects.map((o) => `\`${o.name}\``).join(', ')}); collapse-decimated from ${fmtInt(report.sourceTriangles)} to ${fmtInt(stats.triangles)} triangles in total (target ${fmtInt(entry.targetTris)}, shared by source triangle count), UVs kept`
      : `meshes joined into one object; collapse-decimated from ${fmtInt(report.sourceTriangles)} to ${fmtInt(stats.triangles)} triangles (target ${fmtInt(entry.targetTris)}), UVs kept`,
    'custom normals cleared, smooth shading',
    split
      ? 'each object\'s origin moved to the bottom centre of its bounding box and every object placed at the world origin, transforms applied'
      : 'origin moved to the bottom centre of the bounding box, transforms applied',
    `textures capped at ${opts.maxTexture} px (${source.resolution} source) and re-encoded as WebP`,
  ];
  if (report.occlusionAddedFromArm.length) modifications.push('ambient occlusion wired from the red channel of the packed ARM texture');
  const changedAlpha = Object.entries(report.alphaChanges);
  if (changedAlpha.length) {
    modifications.push(`alpha mode changed: ${changedAlpha.map(([n, change]) => `${n} ${change}`).join('; ')}`);
  }
  modifications.push('meshopt compression and quantisation (glTF-Transform optimize)');
  const meta: Meta = {
    generator: 'scripts/process-external.ts (fetch-polyhaven.ts, import_external.py, glTF-Transform optimize)',
    id,
    name: source.name,
    file,
    source: 'Poly Haven',
    page: source.page,
    downloadUrl: source.gltfUrl,
    sourceFilesHash: source.filesHash,
    downloaded: source.downloaded,
    authors: source.authors,
    license: source.license,
    licenseUrl: source.licenseUrl,
    attribution: 'None required (CC0); credit given anyway',
    originalFormat: `${source.format}, ${source.resolution}`,
    originalTriangles: report.sourceTriangles,
    modifications,
    animation: 'none',
    triangles: stats.triangles,
    dimensionsMetres: report.dimensions,
    objects: report.objects,
    materials: stats.materials,
    bytes: stats.bytes,
  };
  writeFileSync(join(ROOT, OUT, `${id}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

const dim = (d: Part['dimensions']): string => `${d.width.toFixed(2)} × ${d.depth.toFixed(2)} × ${d.height.toFixed(2)} m`;

function catalogSection(metas: Meta[]): string {
  const rows = metas.map((m) => {
    const authors = Object.entries(m.authors).map(([name, role]) => `${name} (${role.toLowerCase()})`).join(', ');
    const d = m.dimensionsMetres;
    const objects = m.objects ?? [];
    const parts = objects.length > 1 ? objects.map((o) => `\`${o.name}\` ${fmtInt(o.triangles)}`).join(', ') : '';
    return [
      `### ${m.name} (\`${m.id}\`)`,
      '',
      '| Field | Value |',
      '|---|---|',
      `| Name | ${m.name} |`,
      `| Source URL | ${m.page} |`,
      `| Author(s) | ${authors} |`,
      `| Original download URL | ${m.downloadUrl} (the \`.bin\` and textures are listed in \`assets/external/polyhaven/${m.id}/source.json\`) |`,
      `| Licence | ${m.license} (${m.licenseUrl}) |`,
      `| Attribution requirement | ${m.attribution} |`,
      `| Original format | ${m.originalFormat}; ${fmtInt(m.originalTriangles)} triangles; downloaded ${m.downloaded} |`,
      `| Modifications | ${m.modifications.join('; ')} |`,
      `| Final format / path | GLB (meshopt, quantised, WebP textures), \`${m.file}\` |`,
      `| Animation | None |`,
      `| Final triangle count | ${fmtInt(m.triangles)}${parts ? ` (${parts})` : ''} |`,
      objects.length > 1
        ? `| Dimensions (width × depth × height) | ${objects.map((o) => `\`${o.name}\` ${dim(o.dimensions)}`).join('; ')} |`
        : `| Dimensions (width × depth × height) | ${dim(d)} |`,
      `| Final file size | ${fmtBytes(m.bytes)} (${fmtInt(m.bytes)} B) |`,
      '',
    ].join('\n');
  });
  const summary = [
    '| Asset | Triangles | Size | File |',
    '|---|---:|---:|---|',
    ...metas.map((m) => `| ${m.name} | ${fmtInt(m.triangles)} | ${fmtBytes(m.bytes)} | \`${m.file}\` |`),
    '',
  ].join('\n');
  return `${summary}\n${rows.join('\n')}`;
}

function writeCatalog(manifest: Manifest): void {
  const metas = manifest.assets
    .map((e) => join(ROOT, OUT, `${e.id}.meta.json`))
    .filter((p) => existsSync(p))
    .map((p) => JSON.parse(readFileSync(p, 'utf8')) as Meta);
  const begin = '<!-- scans:begin (generated by scripts/process-external.ts) -->';
  const end = '<!-- scans:end -->';
  const block = `${begin}\n${catalogSection(metas)}${end}`;
  const current = existsSync(CATALOG) ? readFileSync(CATALOG, 'utf8') : `# Asset catalog\n\n## Photoscanned models\n\n${begin}\n${end}\n`;
  const start = current.indexOf(begin.slice(0, 18));
  const stop = current.indexOf(end);
  if (start < 0 || stop < 0) throw new Error(`${CATALOG} has no scan markers`);
  writeFileSync(CATALOG, current.slice(0, start) + block + current.slice(stop + end.length));
  console.log(`\nassets/ASSET_CATALOG.md: ${metas.length} scans`);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
const selected = manifest.assets.filter((e) => filters.length === 0 || filters.some((f) => e.id.includes(f)));
if (selected.length === 0) {
  console.error(`No asset in ${MANIFEST} matches ${filters.join(', ')}`);
  process.exit(1);
}
let failed = 0;
for (const entry of selected) {
  console.log(`\n▸ ${entry.id} (target ${fmtInt(entry.targetTris)} triangles)`);
  try {
    processAsset(entry, { ...manifest.defaults, ...entry });
  } catch (err) {
    failed++;
    const e = err as { message?: string; stdout?: string; stderr?: string };
    console.error(`  FAILED: ${e.message ?? String(err)}`);
    const tail = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n');
    if (tail) console.error(tail);
  }
}
writeCatalog(manifest);
if (failed) {
  console.error(`${failed} asset(s) failed`);
  process.exit(1);
}
