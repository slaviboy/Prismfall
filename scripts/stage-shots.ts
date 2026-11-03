/**
 * Artistic acceptance captures: for each stage, a world view (no UI) and gameplay shots a few
 * seconds apart (so animation and creatures can be judged), at an ultrawide and a 16:9 size.
 *
 * Usage: npm run content:shots -- [--stages a,b] [--out docs/acceptance] [--settle 5] [--sizes 2560x1080,1920x1080]
 *   [--port 4174 --dist dist-test]
 * Requires a test build (npm run build:test, or `vite build --mode test --outDir <dist>`); the
 * preview server for that build is started on the port if needed. A separate --dist and --port let
 * parallel work capture its own build without disturbing the shared test build.
 */
import { chromium, type Page } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? def) : def;
};
const only = opt('stages', '').split(',').filter(Boolean);
const outDir = resolve(ROOT, opt('out', 'docs/acceptance'));
const settleS = Number(opt('settle', '5'));
const sizes = opt('sizes', '2560x1080').split(',').map((s) => s.split('x').map(Number) as [number, number]);
const gameplay = !args.includes('--world-only');
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

type Shell = {
  stageManager: { stages(): { id: string }[]; show(id: string, o: unknown): Promise<boolean>; activeId: string | null };
  startGame(o: unknown): void;
  aiStep(): boolean;
  quitToMenu(): void;
  session: { status: string } | null;
};
const shell = (page: Page) => (expr: (s: Shell, arg: string) => unknown, arg = '') => page.evaluate(({ e, a }) => new Function('s', 'a', `return (${e})(s, a)`)((window as unknown as { __PRISMFALL__: { shell: Shell } }).__PRISMFALL__.shell, a), { e: expr.toString(), a: arg });

const server = await ensureServer();
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (const [w, h] of sizes) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`  [${m.type()}] ${m.text().slice(0, 300)}`);
    });
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    await page.goto(BASE);
    await page.getByTestId('boot-start').click();
    await page.getByTestId('main-menu').waitFor();
    await page.evaluate(() => (window as unknown as { __PRISMFALL__: { updateSection(s: string, p: unknown): void } }).__PRISMFALL__.updateSection('setup', { unlockAll: true }));
    const run = shell(page);
    const ids = (await run((s) => s.stageManager.stages().map((x) => x.id))) as string[];
    for (const id of ids) {
      if (only.length > 0 && !only.includes(id)) continue;
      const dir = join(outDir, id);
      mkdirSync(dir, { recursive: true });
      const tag = `${w}x${h}`;
      await page.addStyleTag({ content: '.ui-layer { visibility: hidden !important; }' }).catch(() => undefined);
      await run((s, stage) => s.stageManager.show(stage, { transition: 0 }), id);
      await page.waitForTimeout(settleS * 1000);
      await page.screenshot({ path: join(dir, `world-${tag}.jpg`), type: 'jpeg', quality: 86 });
      await page.waitForTimeout(4000);
      await page.screenshot({ path: join(dir, `world-${tag}-b.jpg`), type: 'jpeg', quality: 86 });
      await page.evaluate(() => document.querySelectorAll('style').forEach((st) => st.textContent?.includes('.ui-layer { visibility: hidden') && st.remove()));
      if (gameplay) {
        await run((s, stage) => s.startGame({ modeId: 'zen', variantId: 'still', stageId: stage }), id);
        for (let i = 0; i < 80; i++) {
          if ((await run((s) => s.session?.status)) === 'running') break;
          await page.waitForTimeout(250);
        }
        for (let i = 0; i < 40; i++) {
          await run((s) => s.aiStep());
          await page.waitForTimeout(60);
        }
        await page.waitForTimeout(1500);
        await page.screenshot({ path: join(dir, `play-${tag}.jpg`), type: 'jpeg', quality: 86 });
        for (let i = 0; i < 25; i++) {
          await run((s) => s.aiStep());
          await page.waitForTimeout(60);
        }
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(dir, `play-${tag}-b.jpg`), type: 'jpeg', quality: 86 });
        await run((s) => s.quitToMenu());
        await page.waitForTimeout(800);
      }
      console.log(`${id} ${tag}: ${dir}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
  server?.kill();
}
