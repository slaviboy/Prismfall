import { test, expect, openMenu, hooks, canvasStats, startAndPlay } from './fixtures';

test.describe('renderer backends', () => {
  test('uses WebGPU on a real (non-fallback) adapter and renders the board', async ({ page }) => {
    await openMenu(page);
    const info = await hooks<{ backend: string; adapter: string; fallback: boolean }>(page, 'h.appStore.getState().renderer');
    expect(info.backend).toBe('webgpu');
    expect(info.fallback).toBe(false);
    expect(info.adapter.toLowerCase()).not.toContain('swiftshader');
    await startAndPlay(page);
    const stats = await canvasStats(page);
    expect(stats.stdDev).toBeGreaterThan(8);
    expect(stats.colorful).toBeGreaterThan(0.002);
    // Depth-based passes and motion vectors also work on WebGL 2.
    await page.evaluate(() => (window as unknown as { __PRISMFALL__: { updateSection(s: string, p: unknown): void } }).__PRISMFALL__.updateSection('graphics', { motionBlur: 0.8, depthOfField: true }));
    await page.waitForTimeout(800);
    expect((await canvasStats(page)).stdDev).toBeGreaterThan(8);
  });

  test('renders with the WebGL 2 backend when forced', async ({ page }) => {
    await openMenu(page, '?backend=webgl2');
    expect(await hooks<string>(page, 'h.appStore.getState().renderer.backend')).toBe('webgl2');
    await startAndPlay(page);
    const stats = await canvasStats(page);
    expect(stats.stdDev).toBeGreaterThan(8);
    expect(stats.colorful).toBeGreaterThan(0.002);
  });

  test('falls back to WebGL 2 when the browser has no WebGPU at all', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });
    });
    await openMenu(page);
    expect(await hooks<string>(page, 'h.appStore.getState().renderer.backend')).toBe('webgl2');
    await startAndPlay(page, 'zen', 6);
    expect((await canvasStats(page)).stdDev).toBeGreaterThan(8);
  });
});

test.describe('display handling', () => {
  test('tracks window resizes and keeps the HUD anchored to the board', async ({ page }) => {
    await openMenu(page);
    await startAndPlay(page, 'zen', 4);
    for (const [w, h] of [[1280, 720], [2560, 1080], [1024, 1280]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(250);
      const size = await page.evaluate(() => {
        const c = document.getElementById('scene') as HTMLCanvasElement;
        return { w: c.width, h: c.height, dpr: window.devicePixelRatio };
      });
      expect(size.w).toBe(Math.round(w * size.dpr));
      expect(size.h).toBe(Math.round(h * size.dpr));
      const rect = await hooks<{ x: number; y: number; w: number; h: number }>(page, 'h.hudStore.getState().boardRect');
      expect(rect.x).toBeGreaterThan(0);
      expect(rect.x + rect.w).toBeLessThan(w);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.y + rect.h).toBeLessThanOrEqual(h);
    }
  });

  test('renders at device pixel ratio 2', async ({ browser }) => {
    const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1200, height: 700 } });
    const page = await context.newPage();
    await openMenu(page);
    const size = await page.evaluate(() => {
      const c = document.getElementById('scene') as HTMLCanvasElement;
      return { w: c.width, h: c.height };
    });
    expect(size).toEqual({ w: 2400, h: 1400 });
    await context.close();
  });
});

test('post-processing and quality options apply live without errors', async ({ page }) => {
  await openMenu(page);
  await startAndPlay(page, 'zen', 8);
  const variants = [
    { postProcessing: false },
    { postProcessing: true, antialias: 'fxaa' },
    { antialias: 'smaa', ambientOcclusion: true, depthOfField: true },
    { antialias: 'smaa', motionBlur: 0.8 },
    { antialias: 'msaa', ambientOcclusion: false, depthOfField: false, motionBlur: 0, renderScale: 0.6, upscaler: 'fsr1' },
    { renderScale: 1.5, shadows: 'high' },
    { preset: 'low' },
    { preset: 'ultra' },
  ];
  for (const v of variants) {
    await page.evaluate((patch) => (window as unknown as { __PRISMFALL__: { updateSection(s: string, p: unknown): void } }).__PRISMFALL__.updateSection('graphics', patch), v);
    await page.waitForTimeout(500);
    const stats = await canvasStats(page);
    expect(stats.stdDev, JSON.stringify(v)).toBeGreaterThan(6);
  }
});

test('level up shifts the frame tint and surges its glow', async ({ page }) => {
  await openMenu(page);
  await page.getByTestId('menu-play').click();
  await page.getByTestId('mode-marathon').click();
  await page.getByTestId('setup-start').click();
  await expect.poll(() => hooks<string>(page, 'h.shell.session.status')).toBe('running');
  const before = await hooks<number[]>(page, '[...h.shell.renderSystem.board.frame.accent.value.toArray()]');
  await page.evaluate(() => (window as unknown as { __PRISMFALL__: { shell: { session: { engine: { setLevel(l: number): void } } } } }).__PRISMFALL__.shell.session.engine.setLevel(5));
  await expect.poll(() => hooks<number>(page, 'h.shell.renderSystem.board.frame.glow.value')).toBeGreaterThan(1.5);
  const after = await hooks<number[]>(page, '[...h.shell.renderSystem.board.frame.accent.value.toArray()]');
  expect(after.some((v, i) => Math.abs(v - (before[i] as number)) > 0.02)).toBe(true);
  // The surge settles back.
  await expect.poll(() => hooks<number>(page, 'h.shell.renderSystem.board.frame.glow.value'), { timeout: 5000 }).toBeLessThan(1.05);
});
