/**
 * Frame sequence of one forced detonation in Ashen Vigil: the flash, the fireball and the fire in
 * the rising cap, the heat-wave ring, the shock's arrival (the world trembles, the board does not)
 * and the lingering heat shimmer. It clears the sky, sets off one detonation through the
 * nuclearDetonations component's capture hook (trigger) and screenshots it at the given ages.
 *
 * Usage: node scripts/detonation-shots.ts [--out reference-capture/detonation] [--size 2560x1080]
 *   [--times 0,0.15,1,3,6,10,12,13,20,40] [--azimuth -28] [--distance 620] [--play] [--backend webgl2]
 *   [--port 4174 --dist dist-test]
 * --play starts a Zen game first, so the board is in the frames. The shock arrives at about
 * 5 + distance / 110 seconds. Needs a test build (the debug hooks); the preview server for it is
 * started on the port if nothing answers there.
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
const outDir = resolve(ROOT, opt('out', 'reference-capture/detonation'));
const [W, H] = opt('size', '2560x1080').split('x').map(Number) as [number, number];
const times = opt('times', '0,0.15,1,3,6,10,12,13,20,40').split(',').map(Number);
const azimuth = Number(opt('azimuth', '-28'));
const distance = Number(opt('distance', '620'));
const play = args.includes('--play');
const backend = opt('backend', '');
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

type Hooks = { shell: Record<string, unknown>; updateSection(section: string, patch: unknown): void };
const run = (page: Page) => <T>(expr: (w: Hooks, arg: unknown) => T, arg: unknown = null) =>
  page.evaluate(({ e, a }) => new Function('w', 'a', `return (${e})(w, a)`)((window as unknown as { __PRISMFALL__: Hooks }).__PRISMFALL__, a), { e: expr.toString(), a: arg }) as Promise<T>;

const server = await ensureServer();
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'],
});
let errors = 0;
try {
  mkdirSync(outDir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('console', (m) => {
    if (m.type() === 'error') {
      errors++;
      console.log(`  [error] ${m.text().slice(0, 300)}`);
    }
  });
  page.on('pageerror', (e) => {
    errors++;
    console.log(`  [pageerror] ${e.message}`);
  });
  await page.goto(BASE + (backend ? `?backend=${backend}` : ''));
  await page.getByTestId('boot-start').click();
  await page.getByTestId('main-menu').waitFor();
  const hook = run(page);
  await hook((w) => w.updateSection('setup', { unlockAll: true }));
  if (!play) await page.addStyleTag({ content: '.ui-layer { visibility: hidden !important; }' });
  await hook((w) => (w.shell as { stageManager: { show(id: string, o: unknown): Promise<boolean> } }).stageManager.show('ashen-vigil', { transition: 0 }));
  if (play) {
    await hook((w) => (w.shell as { startGame(o: unknown): void }).startGame({ modeId: 'zen', variantId: 'still', stageId: 'ashen-vigil' }));
    for (let i = 0; i < 40; i++) {
      await hook((w) => (w.shell as { aiStep(): boolean }).aiStep());
      await page.waitForTimeout(60);
    }
  }
  await page.waitForTimeout(4000);
  // The component's capture hooks: clear the sky, then set off one detonation now.
  const fired = await hook(
    (w, a) => {
      type Built = { spec: { type: string }; component: { clear(): void; trigger(o: unknown): boolean } };
      const env = (w.shell as { stageManager: { render: { environments: { current: { built: Built[] } } } } }).stageManager.render.environments.current;
      const det = env.built.find((b) => b.spec.type === 'nuclearDetonations');
      if (!det) return false;
      det.component.clear();
      return det.component.trigger(a);
    },
    { azimuth, distance, wilson: true, collar: true, air: 0.1 },
  );
  if (!fired) throw new Error('no nuclearDetonations component in the current world');
  const t0 = Date.now();
  for (const t of times) {
    const wait = t * 1000 - (Date.now() - t0);
    if (wait > 0) await page.waitForTimeout(wait);
    const file = join(outDir, `detonation-${String(Math.round(t * 1000)).padStart(6, '0')}ms.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 88 });
    console.log(`${(Date.now() - t0) / 1000}s ${file}`);
  }
  console.log(`shock arrives at about ${(5 + distance / 110).toFixed(1)} s; ${errors} console errors`);
} finally {
  await browser.close();
  server?.kill();
}
if (errors > 0) process.exitCode = 1;
