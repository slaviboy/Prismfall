/**
 * Performance benchmark: plays Zen with the built-in AI in Chrome (real GPU) across resolutions,
 * quality presets, backends and stages, recording frame time, GPU time and renderer counters.
 *
 * Usage: npm run perf -- [--quick] [--stages a,b] [--presets high,ultra] [--backends webgpu,webgl2] [--seconds 8]
 * Requires a test build (npm run build:test); started automatically if dist-test is missing.
 */
import { chromium, type Page } from '@playwright/test';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? def) : def;
};
const quick = args.includes('--quick');
const seconds = Number(opt('seconds', quick ? '5' : '8'));
const presets = opt('presets', quick ? 'high,ultra' : 'low,medium,high,ultra').split(',');
const backends = opt('backends', 'webgpu,webgl2').split(',');
const stages = opt('stages', '').split(',').filter(Boolean);
const RESOLUTIONS = quick
  ? [{ name: '2560x1080', w: 2560, h: 1080, dpr: 1 }, { name: '3840x2160', w: 1920, h: 1080, dpr: 2 }]
  : [
      { name: '2560x1080', w: 2560, h: 1080, dpr: 1 },
      { name: '2560x1440', w: 2560, h: 1440, dpr: 1 },
      { name: '3840x2160', w: 1920, h: 1080, dpr: 2 },
    ];

interface Result {
  stage: string;
  backend: string;
  preset: string;
  resolution: string;
  fps: number;
  frameMs: number;
  p95Ms: number;
  p99Ms: number;
  gpuMs: number | null;
  cpu: Record<string, number>;
  drawCalls: number;
  triangles: number;
  adapter: string;
}

async function ensureServer(): Promise<ChildProcess | null> {
  try {
    const res = await fetch('http://localhost:4174/');
    if (res.ok) return null;
  } catch {
    /* not running */
  }
  if (!existsSync(join(ROOT, 'dist-test/index.html'))) execSync('npm run build:test', { cwd: ROOT, stdio: 'inherit' });
  const server = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--mode', 'test', '--outDir', 'dist-test'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      if ((await fetch('http://localhost:4174/')).ok) return server;
    } catch {
      /* wait */
    }
  }
  throw new Error('preview server did not start');
}

/** Shape of the dev/test debug hooks used here (window.__PRISMFALL__). */
interface Hooks {
  shell: { aiStep(): boolean; startGame(o: { modeId: string; variantId: string; stageId: string }): void; quitToMenu(): void };
  perfStore: { getState(): Record<string, unknown> };
  updateSection(section: string, patch: unknown): void;
  getSettings(): { setup: { stageId: string } };
}

async function measure(page: Page): Promise<Omit<Result, 'stage' | 'backend' | 'preset' | 'resolution'>> {
  return page.evaluate(async (secs) => {
    const h = (window as unknown as { __PRISMFALL__: Hooks }).__PRISMFALL__;
    const end = performance.now() + secs * 1000;
    // Measure while the AI keeps placing pieces (effects, clears and collapses included).
    while (performance.now() < end) {
      h.shell.aiStep();
      await new Promise((r) => setTimeout(r, 120));
    }
    const s = h.perfStore.getState();
    return {
      fps: s.fps as number,
      frameMs: s.frameMs as number,
      p95Ms: s.p95Ms as number,
      p99Ms: s.p99Ms as number,
      gpuMs: s.gpuMs as number | null,
      cpu: s.cpu as Record<string, number>,
      drawCalls: s.drawCalls as number,
      triangles: s.triangles as number,
      adapter: s.adapter as string,
    };
  }, seconds);
}

const server = await ensureServer();
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--autoplay-policy=no-user-gesture-required'],
});
const results: Result[] = [];
const stageList = stages.length > 0 ? stages : ['default'];
try {
  for (const backend of backends) {
    for (const res of RESOLUTIONS) {
      const context = await browser.newContext({ viewport: { width: res.w, height: res.h }, deviceScaleFactor: res.dpr });
      const page = await context.newPage();
      await page.goto(`http://localhost:4174/?backend=${backend}`);
      await page.getByTestId('boot-start').click();
      for (const stage of stageList) {
        for (const preset of presets) {
          await page.evaluate(
            ({ p, st }) => {
              const h = (window as unknown as { __PRISMFALL__: Hooks }).__PRISMFALL__;
              h.updateSection('graphics', { preset: p, showPerfOverlay: false });
              if (st !== 'default') h.updateSection('setup', { stageId: st, unlockAll: true });
              h.updateSection('setup', { lastMode: 'zen' });
            },
            { p: preset, st: stage },
          );
          await page.evaluate(() => {
            const h = (window as unknown as { __PRISMFALL__: Hooks }).__PRISMFALL__;
            h.shell.startGame({ modeId: 'zen', variantId: 'still', stageId: h.getSettings().setup.stageId });
          });
          await page.waitForTimeout(2500);
          const m = await measure(page);
          const row: Result = { stage, backend, preset, resolution: res.name, ...m };
          results.push(row);
          console.log(`${backend.padEnd(7)} ${res.name.padEnd(10)} ${stage.padEnd(16)} ${preset.padEnd(7)} ${m.fps.toFixed(0).padStart(4)} fps  p95 ${m.p95Ms.toFixed(2)} ms  GPU ${m.gpuMs !== null ? m.gpuMs.toFixed(2) : ' n/a'} ms  draws ${m.drawCalls}`);
          await page.evaluate(() => (window as unknown as { __PRISMFALL__: Hooks }).__PRISMFALL__.shell.quitToMenu());
        }
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  server?.kill();
}

mkdirSync(join(ROOT, 'perf-results'), { recursive: true });
const file = join(ROOT, 'perf-results', `perf-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), seconds, results }, null, 2));
console.log(`\nSaved ${file}`);
