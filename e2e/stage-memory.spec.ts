import { test, expect, openMenu, hooks } from './fixtures';

interface MemoryInfo {
  geometries: number;
  textures: number;
}

/** Loading and unloading stages repeatedly must not leak GPU resources. */
test('stage load/unload cycles return GPU memory to baseline', async ({ page }) => {
  test.setTimeout(300_000);
  await openMenu(page);
  const ids = await hooks<string[]>(page, 'h.shell.stageManager.stages().map((s) => s.id)');
  const settle = async (): Promise<MemoryInfo> => {
    await page.evaluate(async () => {
      const h = (window as unknown as { __PRISMFALL__: { shell: { renderSystem: { environments: { deactivate(s: number): void; clearCache(): void } } } } }).__PRISMFALL__;
      h.shell.renderSystem.environments.deactivate(0.001);
      await new Promise((r) => setTimeout(r, 300));
      h.shell.renderSystem.environments.clearCache();
      await new Promise((r) => setTimeout(r, 300));
    });
    return hooks<MemoryInfo>(page, '({ geometries: h.shell.renderSystem.renderer.info.memory.geometries, textures: h.shell.renderSystem.renderer.info.memory.textures })');
  };
  const baseline = await settle();
  for (let cycle = 0; cycle < 10; cycle++) {
    for (const id of ids) {
      const ok = await page.evaluate((stageId) => (window as unknown as { __PRISMFALL__: { shell: { stageManager: { show(id: string, o: unknown): Promise<boolean> } } } }).__PRISMFALL__.shell.stageManager.show(stageId, { transition: 0 }), id);
      expect(ok, id).toBe(true);
      await page.waitForTimeout(120);
    }
  }
  const after = await settle();
  // Allow a small constant for lazily created shared resources (e.g. bloom mip chain).
  expect(after.geometries).toBeLessThanOrEqual(baseline.geometries + 4);
  expect(after.textures).toBeLessThanOrEqual(baseline.textures + 4);
});
