/**
 * Living-world survey (MUSIC_REACTIVE_ENVIRONMENTS.md): for every world, the layers and reactive
 * targets the built environment exposes, with their Background intensity classes, and how the
 * world's default track moves the Environment Music Director (rendered offline by the real
 * synthesiser and analysed by the game's DSP: per-section drive means, 90th percentiles and cue
 * rates). The worlds' living.json profiles are tuned against these numbers.
 *
 * Usage: node scripts/living-survey.ts [--stages a,b] [--out docs/living] [--targets-only] [--drives-only]
 *   [--port 4174 --dist dist-test]
 * Writes <out>/targets.json and <out>/drives.json.
 */
import { chromium } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? def) : def;
};
const only = opt('stages', '').split(',').filter(Boolean);
const outDir = resolve(ROOT, opt('out', 'docs/living'));
const port = opt('port', '4174');
const dist = opt('dist', 'dist-test');
const BASE = `http://localhost:${port}/`;
const doTargets = !args.includes('--drives-only');
const doDrives = !args.includes('--targets-only');

async function ensureServer(): Promise<ChildProcess | null> {
  try {
    if ((await fetch(BASE)).ok) return null;
  } catch {
    /* not running */
  }
  if (!existsSync(join(ROOT, dist, 'index.html'))) execSync(dist === 'dist-test' ? 'npm run build:test' : `npx vite build --mode test --outDir ${dist}`, { cwd: ROOT, stdio: 'inherit' });
  const server = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--mode', 'test', '--outDir', dist, '--port', port, '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      if ((await fetch(BASE)).ok) return server;
    } catch {
      /* starting */
    }
  }
  throw new Error('preview server did not start');
}

type Hooks = {
  __PRISMFALL__: {
    shell: { stageManager: { stages(): { id: string }[]; show(id: string, o: unknown): Promise<boolean>; activeId: string | null }; renderSystem: { environments: { current: { describeTargets(): unknown; manifest: { environment: { layers: { id?: string; type: string }[] }; events: { on: string; layer: string; action: string }[] }; warnings: string[] } | null } } };
    updateSection(s: string, p: unknown): void;
    lab(): Promise<{ measureWorldDrives(ids?: string[], o?: unknown): Promise<unknown[]> }>;
  };
};

const server = await ensureServer();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'] });
mkdirSync(outDir, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  await page.goto(BASE);
  await page.getByTestId('boot-start').click();
  await page.getByTestId('main-menu').waitFor();
  await page.evaluate(() => {
    const h = (window as unknown as Hooks).__PRISMFALL__;
    h.updateSection('setup', { unlockAll: true });
    h.updateSection('audio', { musicPreview: false });
  });
  const ids = ((await page.evaluate(() => (window as unknown as Hooks).__PRISMFALL__.shell.stageManager.stages().map((s) => s.id))) as string[]).filter((id) => only.length === 0 || only.includes(id));
  if (doTargets) {
    const targets: Record<string, unknown> = existsSync(join(outDir, 'targets.json')) ? (JSON.parse(readFileSync(join(outDir, 'targets.json'), 'utf8')) as Record<string, unknown>) : {};
    for (const id of ids) {
      const info = await page.evaluate(async (stage) => {
        const s = (window as unknown as Hooks).__PRISMFALL__.shell;
        await s.stageManager.show(stage, { transition: 0 });
        const env = s.renderSystem.environments.current;
        if (!env) return null;
        return { layers: env.manifest.environment.layers.map((l) => ({ id: l.id ?? '', type: l.type })), targets: env.describeTargets(), events: env.manifest.events.map((e) => `${e.on} -> ${e.layer}.${e.action}`), warnings: env.warnings };
      }, id);
      targets[id] = info;
      console.log(`${id}: ${info ? (info.targets as unknown[]).length : 0} targets`);
    }
    writeFileSync(join(outDir, 'targets.json'), `${JSON.stringify(targets, null, 1)}\n`);
  }
  if (doDrives) {
    const started = Date.now();
    const reports = await page.evaluate(async (list) => (await (window as unknown as Hooks).__PRISMFALL__.lab()).measureWorldDrives(list, { maxSeconds: 300 }), ids);
    const drives: Record<string, unknown> = existsSync(join(outDir, 'drives.json')) ? (JSON.parse(readFileSync(join(outDir, 'drives.json'), 'utf8')) as Record<string, unknown>) : {};
    for (const r of reports as { stage: string }[]) drives[r.stage] = r;
    writeFileSync(join(outDir, 'drives.json'), `${JSON.stringify(drives, null, 1)}\n`);
    console.log(`drives for ${reports.length} worlds in ${Math.round((Date.now() - started) / 1000)} s`);
  }
} finally {
  await browser.close();
  server?.kill();
}
