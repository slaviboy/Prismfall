/**
 * Stage artwork: renders each stage's world (menu view, no playfield) in Chrome with the real
 * GPU and saves content/stages/<id>/previews/thumb.jpg, recording it as the stage thumbnail, and
 * previews/backdrop.jpg (2560×1080), the picture menus show behind world select.
 *
 * Usage: npm run content:thumbnails -- [--stages a,b] [--settle 4] [--backdrops-only]
 * Requires a test build (npm run build:test); the preview server is started if needed.
 * --port and --dist capture a private test build instead (as in stage-shots.ts).
 * --progress 0.9 shows worlds as they look late in a run (game progress), for worlds that reveal
 * themselves as you play.
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
const settleS = Number(opt('settle', '4'));
const progress = opt('progress', '');
const backdropsOnly = args.includes('--backdrops-only');
const port = opt('port', '4174');
const dist = opt('dist', 'dist-test');
const BASE = `http://localhost:${port}/`;

async function ensureServer(): Promise<ChildProcess | null> {
  try {
    if ((await fetch(BASE)).ok) return null;
  } catch {
    /* not running */
  }
  if (!existsSync(join(ROOT, dist, 'index.html'))) execSync(`npx vite build --mode test --outDir ${dist}`, { cwd: ROOT, stdio: 'inherit' });
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

const server = await ensureServer();
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.goto(BASE);
  await page.getByTestId('boot-start').click();
  await page.getByTestId('main-menu').waitFor();
  type Hooks = { __PRISMFALL__: { shell: { stageManager: { stages(): { id: string; dir: string }[]; show(id: string, o: unknown): Promise<boolean> } } } };
  const stages = await page.evaluate(() => (window as unknown as Hooks).__PRISMFALL__.shell.stageManager.stages().map((s) => ({ id: s.id, dir: s.dir })));
  await page.addStyleTag({ content: '.ui-layer { display: none !important; }' });
  for (const s of stages) {
    if (only.length > 0 && !only.includes(s.id)) continue;
    await page.evaluate((id) => (window as unknown as Hooks).__PRISMFALL__.shell.stageManager.show(id, { transition: 0 }), s.id);
    if (progress) await page.evaluate((v) => ((window as unknown as { __PRISMFALL__: { shell: { previewProgress: number | null } } }).__PRISMFALL__.shell.previewProgress = v), Number(progress));
    await page.waitForTimeout(settleS * 1000);
    const folder = join(ROOT, s.dir.replace(/^\//, ''));
    mkdirSync(join(folder, 'previews'), { recursive: true });
    if (!backdropsOnly) await page.screenshot({ path: join(folder, 'previews/thumb.jpg'), type: 'jpeg', quality: 84 });
    // The wide picture menus show behind world select when live previews are off (21:9, so the
    // camera reframes for it; the board-free menu view, like the thumbnail).
    await page.setViewportSize({ width: 2560, height: 1080 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(folder, 'previews/backdrop.jpg'), type: 'jpeg', quality: 80 });
    await page.setViewportSize({ width: 960, height: 540 });
    const manifestPath = join(folder, 'stage.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    if (manifest.thumbnail !== 'previews/thumb.jpg') {
      manifest.thumbnail = 'previews/thumb.jpg';
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    console.log(`${s.id}: ${s.dir}/previews/thumb.jpg, backdrop.jpg`);
  }
} finally {
  await browser.close();
  server?.kill();
}
