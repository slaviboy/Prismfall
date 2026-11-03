import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, hooks, openMenu } from './fixtures';

/**
 * Soak: the AI plays Zen continuously, moving to the next world every few minutes (full stage
 * unload and load), while heap size, renderer GPU resource counts and frame times are sampled.
 * Run with `npm run test:soak` (see playwright.soak.config.ts). Not part of the normal e2e run.
 */
const MINUTES = Number(process.env.SOAK_MINUTES ?? 30);
const SAMPLE_S = 30;
const STAGE_EVERY_S = 300;

interface Sample {
  readonly t: number;
  readonly heapMb: number | null;
  readonly geometries: number;
  readonly textures: number;
  readonly frameP50: number;
  readonly frameP95: number;
  readonly pieces: number;
  readonly stage: string;
}

test('the game stays stable over a long session', async ({ page }, info) => {
  const query = (info.project.metadata as { query?: string }).query ?? '';
  await openMenu(page, query);
  // Frame-time recorder alongside the game's own loop.
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[] };
    w.__frames = [];
    let last = performance.now();
    const tick = (now: number): void => {
      w.__frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.evaluate(() => (window as unknown as { __PRISMFALL__: { updateSection: (s: string, v: unknown) => void } }).__PRISMFALL__.updateSection('setup', { unlockAll: true }));
  const worlds = await hooks<string[]>(page, "h.shell['xrHost']().stages().map((s) => s.id)");
  expect(worlds.length).toBeGreaterThan(3);

  const start = async (stageId: string): Promise<void> => {
    await page.evaluate((id) => {
      const h = (window as unknown as { __PRISMFALL__: { shell: { quitToMenu: () => void; startGame: (o: unknown) => void; session: unknown } } }).__PRISMFALL__;
      if (h.shell.session) h.shell.quitToMenu();
      h.shell.startGame({ modeId: 'zen', variantId: 'still', stageId: id });
    }, stageId);
    await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 30_000 }).toBe('running');
  };

  const samples: Sample[] = [];
  const sample = async (t: number, stage: string): Promise<void> => {
    const s = await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __PRISMFALL__: { shell: { renderSystem: { renderer: { info: { memory: { geometries: number; textures: number } } } }; session: { engine: { stats: { pieces: number } } } } } };
      const frames = w.__frames.splice(0).sort((a, b) => a - b);
      const q = (p: number): number => frames[Math.min(frames.length - 1, Math.floor(frames.length * p))] ?? 0;
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      const info = w.__PRISMFALL__.shell.renderSystem.renderer.info.memory;
      return { heapMb: mem ? mem.usedJSHeapSize / 1048576 : null, geometries: info.geometries, textures: info.textures, frameP50: q(0.5), frameP95: q(0.95), pieces: w.__PRISMFALL__.shell.session.engine.stats.pieces };
    });
    samples.push({ t, stage, ...s });
  };

  const t0 = Date.now();
  let stageIndex = 0;
  let stage = worlds[0]!;
  await start(stage);
  let nextSample = SAMPLE_S;
  let nextStage = STAGE_EVERY_S;
  while ((Date.now() - t0) / 1000 < MINUTES * 60) {
    // About six placements a second through the normal input path.
    await page.evaluate(async () => {
      const h = (window as unknown as { __PRISMFALL__: { shell: { aiStep: () => boolean } } }).__PRISMFALL__;
      for (let i = 0; i < 12; i++) {
        h.shell.aiStep();
        await new Promise((r) => setTimeout(r, 160));
      }
    });
    const elapsed = (Date.now() - t0) / 1000;
    if (elapsed >= nextSample) {
      await sample(Math.round(elapsed), stage);
      nextSample += SAMPLE_S;
    }
    if (elapsed >= nextStage) {
      stageIndex = (stageIndex + 1) % worlds.length;
      stage = worlds[stageIndex]!;
      await start(stage);
      nextStage += STAGE_EVERY_S;
    }
  }
  // Finish on the first world again so GPU resource counts are comparable.
  await start(worlds[0]!);
  await page.waitForTimeout(5000);
  await sample(Math.round((Date.now() - t0) / 1000), worlds[0]!);

  const dir = join(process.cwd(), 'perf-results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `soak-${info.project.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ project: info.project.name, minutes: MINUTES, samples }, null, 2));
  console.log(`soak results: ${file}`);

  // Stable means: GPU resources back near the first visit's level, heap without runaway growth,
  // and frame times not trending upward (last third vs first third, medians of p95).
  const first = samples.find((s) => s.stage === worlds[0]) ?? samples[0]!;
  const last = samples[samples.length - 1]!;
  expect(last.geometries, 'geometries return near the first visit').toBeLessThanOrEqual(first.geometries * 1.15 + 20);
  expect(last.textures, 'textures return near the first visit').toBeLessThanOrEqual(first.textures * 1.15 + 10);
  const heaps = samples.map((s) => s.heapMb).filter((v): v is number => v !== null);
  if (heaps.length > 4) {
    const early = Math.min(...heaps.slice(0, Math.ceil(heaps.length / 3)));
    const late = Math.min(...heaps.slice(-Math.ceil(heaps.length / 3)));
    expect(late, 'heap floor does not grow by more than 30%').toBeLessThan(early * 1.3 + 20);
  }
  const median = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
  const third = Math.max(1, Math.floor(samples.length / 3));
  const p95Early = median(samples.slice(0, third).map((s) => s.frameP95));
  const p95Late = median(samples.slice(-third).map((s) => s.frameP95));
  expect(p95Late, 'frame time p95 does not trend upward').toBeLessThan(p95Early * 1.35 + 2);
});
