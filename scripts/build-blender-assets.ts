/**
 * Runs every Blender generator headless and optimises the exported GLBs into content/.
 * Requires Blender (set BLENDER_PATH, defaults to the standard Windows install).
 * The game itself never needs Blender: optimised outputs are committed.
 *
 * Usage: npm run assets:blender [-- <script-name-filter>] [--no-preview]
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const BLENDER = process.env.BLENDER_PATH ?? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith('--'));
const noPreview = args.includes('--no-preview');

interface Pipeline {
  generators: { script: string; outputs: { from: string; to: string }[] }[];
}

const pipeline = JSON.parse(readFileSync(join(ROOT, 'assets/blender/pipeline.json'), 'utf8')) as Pipeline;
if (!existsSync(BLENDER)) {
  console.error(`Blender not found at ${BLENDER}. Set BLENDER_PATH.`);
  process.exit(1);
}

for (const gen of pipeline.generators) {
  if (filter && !gen.script.includes(filter)) continue;
  const script = join(ROOT, 'assets/blender/scripts', gen.script);
  console.log(`\n▸ ${gen.script}`);
  const t0 = Date.now();
  const out = execFileSync(BLENDER, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', ...(noPreview ? ['--no-preview'] : [])], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ok = out.split('\n').find((l) => l.includes('_OK'));
  console.log(`  ${ok ?? 'done'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  for (const o of gen.outputs) {
    const from = join(ROOT, o.from);
    const to = join(ROOT, o.to);
    mkdirSync(to, { recursive: true });
    for (const file of readdirSync(from)) {
      const src = join(from, file);
      if (file.endsWith('.glb')) {
        const dst = join(to, file);
        execFileSync(process.execPath, [join(ROOT, 'node_modules/@gltf-transform/cli/bin/cli.js'), 'optimize', src, dst, '--compress', 'meshopt', '--texture-compress', 'webp', '--simplify', 'false', '--instance', 'false', '--flatten', 'false', '--join', 'false'], { cwd: ROOT, stdio: 'pipe' });
        console.log(`  ${file}: ${statSync(src).size} B -> ${statSync(dst).size} B`);
      } else if (file.endsWith('.json')) {
        copyFileSync(src, join(to, file));
      }
    }
  }
}
