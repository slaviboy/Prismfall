/**
 * Protected playfield check (PROTECTED_PLAYFIELD.md). For every world it renders the board as the
 * player sees it in that world (the world's blocks, palette, light rig, grade, fog and camera) with
 * every environment renderable hidden, in Practice without gravity, with a fixed seed, a fixed stack
 * and a frozen, stepped clock, and saves a lossless PNG. A later run with --compare diffs a fresh
 * capture against that baseline pixel by pixel: any change to the board, the blocks, their materials
 * or lighting, the camera framing or the post pipeline shows up, and so does any environment change
 * that leaks onto the board (a world light that lights the blocks, a uniform the blocks read).
 * Environment lights stay on during the capture for that reason; only meshes, points, lines and
 * sprites outside the board and the light rig are hidden.
 *
 * It also saves a normal full-frame screenshot of each world with the same tall stack (the approved
 * composition, JPEG), which is for people to look at and is not compared.
 *
 * Usage:
 *   node scripts/playfield-baseline.ts --out reference-capture/protected/baseline
 *   node scripts/playfield-baseline.ts --compare reference-capture/protected/baseline [--out <dir>]
 * Options: --stages a,b  --size 2560x1080  --port 4174 --dist dist-test  --no-full
 * Writes <out>/board-<id>.png, <out>/full-<id>.jpg and <out>/summary.json; with --compare also
 * <out>/diff-<id>.png for worlds that differ and prints a table. Exit code 1 when any world differs
 * beyond the noise floor (see TOLERANCE).
 */
import { chromium, type Page } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? def) : def;
};
const only = opt('stages', '').split(',').filter(Boolean);
const compareDir = args.includes('--compare') ? resolve(ROOT, opt('compare', '')) : null;
const outDir = resolve(ROOT, opt('out', compareDir ? 'reference-capture/protected/compare' : 'reference-capture/protected/baseline'));
const [width, height] = opt('size', '2560x1080').split('x').map(Number) as [number, number];
const port = opt('port', '4174');
const dist = opt('dist', 'dist-test');
const full = !args.includes('--no-full');
const BASE = `http://localhost:${port}/`;

/**
 * Two captures of an unchanged build are expected to match exactly; this allows for GPU rounding:
 * no channel may differ by more than `maxDiff` levels, and at most `share` of the pixels by more
 * than 2 levels.
 */
const TOLERANCE = { maxDiff: 6, share: 0.0005 };

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

/**
 * A controllable clock installed before the app loads: `performance.now()` runs normally until
 * frozen; while frozen it returns the frozen value, and `step(ms, frames)` advances it by `ms` once
 * per animation frame, so the game, the board and every smoothed signal see exactly the same time
 * sequence on every run. Thawing continues from the frozen value (time never runs backwards).
 */
const CLOCK = () => {
  const real = performance.now.bind(performance);
  let offset = 0;
  let frozen: number | null = null;
  performance.now = () => frozen ?? real() + offset;
  (window as unknown as Record<string, unknown>).__clock = {
    freeze(t: number) {
      const now = frozen ?? real() + offset;
      frozen = Math.max(now, t);
    },
    thaw() {
      if (frozen !== null) offset = frozen - real();
      frozen = null;
    },
    async step(ms: number, frames: number) {
      for (let i = 0; i < frames; i++) {
        frozen = (frozen ?? real() + offset) + ms;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      // One more frame at the final time, so what is on screen was rendered at it.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    },
    now: () => performance.now(),
  };
};

/** The fixed stack: two garbage rows, eleven rows full but for the right column, a ragged top. */
const INJECT = `(s) => {
  const e = s.session.engine;
  const snap = e.snapshot();
  const W = e.board.width, H = e.board.height;
  const cells = new Uint8Array(W * H);
  let seed = 20261104;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const fillRow = (y, gap) => {
    let x = 0;
    while (x < W) {
      const run = 2 + Math.floor(rnd() * 3), colour = 1 + Math.floor(rnd() * 7);
      for (let i = 0; i < run && x < W; i++, x++) if (x !== gap) cells[y * W + x] = colour;
    }
  };
  fillRow(0, 4);
  fillRow(1, 6);
  for (let r = 0; r < 11; r++) fillRow(2 + r, W - 1);
  for (let x = 0; x < W - 1; x++) if (rnd() < 0.45) cells[13 * W + x] = 1 + Math.floor(rnd() * 7);
  e.restore({
    ...snap,
    cells,
    active: { type: 'T', rotation: 0, x: 3, y: 16 },
    hold: 'I',
    holdUsed: false,
    queue: { items: ['S', 'L', 'O', 'Z', 'J', 'I', 'T', 'O', 'L', 'S', 'J', 'Z', 'T', 'I'], rng: [11, 22, 33, 44] },
    score: 0,
    lines: 0,
    level: 1,
    combo: -1,
    backToBackActive: false,
    backToBackCount: 0,
  });
}`;

/**
 * Hides every renderable in the scene except the board and the light rig (world lights stay on), or
 * shows them again. It empties their render-layer masks rather than toggling `visible`, because some
 * world components set `visible` themselves every frame (Red Horizon's drone beams do).
 */
const WORLD_MESHES = `(s, hide) => {
  const r = s.renderSystem;
  const keep = new Set([r.boardRoot, r.lights.group]);
  const visit = (o) => {
    if (keep.has(o)) return;
    if (o.isMesh || o.isPoints || o.isLine || o.isSprite) {
      if (hide) {
        if (!('__pfLayers' in o.userData)) o.userData.__pfLayers = o.layers.mask;
        o.layers.disableAll();
      } else if ('__pfLayers' in o.userData) {
        o.layers.mask = o.userData.__pfLayers;
        delete o.userData.__pfLayers;
      }
    }
    for (const c of o.children) visit(c);
  };
  visit(r.scene);
  r.fxRoot.visible = !hide;
}`;

type Run = (expr: string, arg?: unknown) => Promise<unknown>;
const runner = (page: Page): Run => (expr, arg = null) => page.evaluate(({ e, a }) => new Function('s', 'a', `return (${e})(s, a)`)((window as unknown as { __PRISMFALL__: { shell: unknown } }).__PRISMFALL__.shell, a), { e: expr, a: arg });

interface StageInfo {
  readonly id: string;
  readonly order: number;
}

interface Result {
  readonly id: string;
  readonly hash: string;
  readonly width: number;
  readonly height: number;
}

function pixelHash(png: PNG): string {
  return createHash('sha256').update(png.data).digest('hex').slice(0, 16);
}

function diff(a: PNG, b: PNG): { maxDiff: number; over2: number; share: number; mean: number; image: PNG } | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  const out = new PNG({ width: a.width, height: a.height });
  let maxDiff = 0;
  let over2 = 0;
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs((a.data[i] as number) - (b.data[i] as number)), Math.abs((a.data[i + 1] as number) - (b.data[i + 1] as number)), Math.abs((a.data[i + 2] as number) - (b.data[i + 2] as number)));
    maxDiff = Math.max(maxDiff, d);
    if (d > 2) over2++;
    sum += d;
    const v = Math.min(255, d * 16);
    out.data[i] = v;
    out.data[i + 1] = d > 2 ? 0 : v;
    out.data[i + 2] = d > 2 ? 0 : v;
    out.data[i + 3] = 255;
  }
  const n = a.width * a.height;
  return { maxDiff, over2, share: over2 / n, mean: sum / n, image: out };
}

const server = await ensureServer();
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'],
});
mkdirSync(outDir, { recursive: true });
const results: Result[] = [];
let failed = 0;
try {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [error] ${m.text().slice(0, 300)}`);
  });
  await page.addInitScript(CLOCK);
  await page.goto(BASE);
  await page.getByTestId('boot-start').click();
  await page.getByTestId('main-menu').waitFor();
  // No music (the blocks' music glow would follow the audio clock), no audio reactivity, the
  // default graphics and the owner's accessibility defaults.
  await page.evaluate(() => {
    const h = (window as unknown as { __PRISMFALL__: { updateSection(s: string, p: unknown): void } }).__PRISMFALL__;
    h.updateSection('setup', { unlockAll: true });
    h.updateSection('audio', { enabled: false, musicPreview: false });
    h.updateSection('reactivity', { enabled: false });
    h.updateSection('interface', { liveWorldPreviews: false });
    // Practice without gravity: the falling piece stays exactly where the fixed stack puts it.
    h.updateSection('practice', { gravityMode: 'none', previewCount: 5, holdMode: 'normal', randomizer: 'bag7' });
  });
  const run = runner(page);
  const all = (await run('(s) => s.stageManager.stages().map((x) => ({ id: x.id, order: x.manifest ? x.manifest.order : 1000 }))')) as StageInfo[];
  const stages = all.filter((st) => only.length === 0 || only.includes(st.id)).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const hideUi = () => page.addStyleTag({ content: '.ui-layer { visibility: hidden !important; }' }).catch(() => undefined);
  const showUi = () => page.evaluate(() => document.querySelectorAll('style').forEach((st) => st.textContent?.includes('.ui-layer { visibility: hidden') && st.remove()));

  let started = false;
  for (const st of stages) {
    if (!started) {
      await run(`(s, id) => s.startGame({ modeId: 'practice', variantId: 'custom', stageId: id, seed: 4242 })`, st.id);
      for (let i = 0; i < 120 && (await run('(s) => s.session && s.session.status')) !== 'running'; i++) await page.waitForTimeout(250);
      // Past the intro countdown.
      await page.waitForTimeout(4500);
      started = true;
    } else {
      await run(`(s, id) => s.stageManager.show(id, { transition: 0 })`, st.id);
    }
    // Loading, block geometry, shader compiles and the 1.5 s camera blend, in real time.
    for (let i = 0; i < 80 && (await run('(s, id) => s.stageManager.activeId === id', st.id)) !== true; i++) await page.waitForTimeout(250);
    await page.waitForTimeout(5000);

    // Board only: frozen at a fixed time per world (monotonic in world order), stepped 60 frames.
    await hideUi();
    await run(WORLD_MESHES, true);
    const t0 = 2_000_000 + st.order * 200_000;
    await page.evaluate((t) => (window as unknown as { __clock: { freeze(t: number): void } }).__clock.freeze(t), t0);
    await run(INJECT);
    await page.evaluate(() => (window as unknown as { __clock: { step(ms: number, n: number): Promise<void> } }).__clock.step(1000 / 60, 60));
    // Anything a world created while stepping is hidden too; then two more frames at the same time.
    await run(WORLD_MESHES, true);
    await page.evaluate(() => (window as unknown as { __clock: { step(ms: number, n: number): Promise<void> } }).__clock.step(0, 0));
    const buf = await page.screenshot({ type: 'png' });
    const png = PNG.sync.read(buf);
    writeFileSync(join(outDir, `board-${st.id}.png`), buf);
    const hash = pixelHash(png);
    results.push({ id: st.id, hash, width: png.width, height: png.height });

    let verdict = 'captured';
    if (compareDir) {
      const basePath = join(compareDir, `board-${st.id}.png`);
      if (!existsSync(basePath)) verdict = 'no baseline';
      else {
        const base = PNG.sync.read(readFileSync(basePath));
        const d = diff(base, png);
        if (!d) {
          verdict = 'DIFFERENT SIZE';
          failed++;
        } else if (d.maxDiff === 0) verdict = 'identical';
        else {
          const ok = d.maxDiff <= TOLERANCE.maxDiff && d.share <= TOLERANCE.share;
          verdict = `${ok ? 'within noise' : 'CHANGED'}: max ${d.maxDiff}, ${(d.share * 100).toFixed(3)} % of pixels > 2 levels, mean ${d.mean.toFixed(4)}`;
          if (!ok) {
            failed++;
            writeFileSync(join(outDir, `diff-${st.id}.png`), PNG.sync.write(d.image));
          }
        }
      }
    }
    console.log(`${st.id.padEnd(22)} ${hash}  ${verdict}`);

    // The approved composition, for people: world shown, clock running, same stack.
    await run(WORLD_MESHES, false);
    await page.evaluate(() => (window as unknown as { __clock: { thaw(): void } }).__clock.thaw());
    if (full) {
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(outDir, `full-${st.id}.jpg`), type: 'jpeg', quality: 88 });
    }
    await showUi();
  }
  await run('(s) => s.quitToMenu()');
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify({ size: `${width}x${height}`, captured: new Date().toISOString(), results }, null, 2)}\n`);
} finally {
  await browser.close();
  server?.kill();
}
if (compareDir) {
  console.log(failed === 0 ? 'Playfield unchanged in every world.' : `${failed} world(s) changed beyond the noise floor; see ${outDir}`);
  process.exit(failed === 0 ? 0 : 1);
}
