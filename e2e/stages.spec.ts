import { test, expect, openMenu, hooks, autoplay, canvasStats } from './fixtures';

/** Every discovered stage loads, renders and plays without console errors. */
test('every stage loads, renders and plays', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 2560, height: 1080 });
  await openMenu(page, '?');
  await page.evaluate(() => (window as unknown as { __PRISMFALL__: { updateSection(s: string, p: unknown): void } }).__PRISMFALL__.updateSection('setup', { unlockAll: true }));
  const ids = await hooks<string[]>(page, 'h.shell.stageManager.stages().map((s) => s.id)');
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    await page.evaluate((stageId) => {
      const h = (window as unknown as { __PRISMFALL__: { shell: { startGame(o: unknown): void } } }).__PRISMFALL__;
      h.shell.startGame({ modeId: 'zen', variantId: 'still', stageId });
    }, id);
    await expect.poll(() => hooks<string>(page, 'h.shell.stageManager.activeId'), { timeout: 60_000 }).toBe(id);
    await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 20_000 }).toBe('running');
    await autoplay(page, 30);
    await page.waitForTimeout(2600);
    await page.screenshot({ path: `test-results/screens/stage-${id}.png` });
    const stats = await canvasStats(page);
    expect(stats.stdDev, id).toBeGreaterThan(10);
    await page.evaluate(() => (window as unknown as { __PRISMFALL__: { shell: { quitToMenu(): void } } }).__PRISMFALL__.shell.quitToMenu());
  }
});

test('stages wire their reactivity profiles with layer scopes', async ({ page }) => {
  await openMenu(page);
  const expected: Record<string, number> = { 'luminous-tide': 10, 'celestial-drift': 4, 'ember-foundry': 5, 'moving-sands': 10, 'dead-acre': 10 };
  for (const [id, count] of Object.entries(expected)) {
    await page.evaluate((stage) => (window as unknown as { __PRISMFALL__: { shell: { stageManager: { show(i: string, o: unknown): Promise<boolean> } } } }).__PRISMFALL__.shell.stageManager.show(stage, { transition: 0 }), id);
    await expect.poll(() => hooks<string | undefined>(page, 'h.shell.renderSystem.environments.current?.manifest.id'), { timeout: 20_000 }).toBe(id);
    expect(await hooks<number>(page, 'h.shell.renderSystem.environments.current.reactivity.size'), id).toBe(count);
  }
});
