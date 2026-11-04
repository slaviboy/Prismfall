import { test, expect, openMenu, hooks } from './fixtures';

interface MemoryInfo {
  geometries: number;
  textures: number;
}

/**
 * Load cycles over every world: enough that one world leaking a single geometry or texture per load
 * exceeds the tolerance below (+4).
 */
const CYCLES = 5;

/** Loading and unloading stages repeatedly must not leak GPU resources. */
test('stage load/unload cycles return GPU memory to baseline', async ({ page }) => {
  test.setTimeout(120_000);
  await openMenu(page);
  const ids = await hooks<string[]>(page, 'h.shell.stageManager.stages().map((s) => s.id)');
  // Every world builds CYCLES times; the heaviest take about 5 s each, so budget by the world count.
  test.setTimeout(120_000 + ids.length * (CYCLES + 1) * 5_000);
  const settle = async (): Promise<MemoryInfo> => {
    await page.evaluate(async () => {
      const h = (window as unknown as { __PRISMFALL__: { shell: { renderSystem: { environments: { deactivate(s: number): void; clearCache(): void; activeCount: number } } } } }).__PRISMFALL__;
      const env = h.shell.renderSystem.environments;
      env.deactivate(0.001);
      // The fade-out finishes on the next rendered frame, which can wait for a world's first shader
      // compiles; clearCache keeps what is still on screen, so wait for it to leave.
      for (let i = 0; i < 100 && env.activeCount > 0; i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 100));
      env.clearCache();
      await new Promise((r) => setTimeout(r, 300));
    });
    return hooks<MemoryInfo>(page, '({ geometries: h.shell.renderSystem.renderer.info.memory.geometries, textures: h.shell.renderSystem.renderer.info.memory.textures })');
  };
  const visitAll = async (): Promise<void> => {
    for (const id of ids) {
      const ok = await page.evaluate((stageId) => (window as unknown as { __PRISMFALL__: { shell: { stageManager: { show(id: string, o: unknown): Promise<boolean> } } } }).__PRISMFALL__.shell.stageManager.show(stageId, { transition: 0 }), id);
      expect(ok, id).toBe(true);
      await page.waitForTimeout(120);
    }
  };
  // One pass first: resources created once and shared afterwards (the shadow map, a stage module's
  // noise textures) are in place before the baseline, so only growth per load is measured.
  await visitAll();
  const baseline = await settle();
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    await visitAll();
  }
  const after = await settle();
  // Allow a small constant for lazily created shared resources (e.g. bloom mip chain).
  expect(after.geometries).toBeLessThanOrEqual(baseline.geometries + 4);
  expect(after.textures).toBeLessThanOrEqual(baseline.textures + 4);
});
