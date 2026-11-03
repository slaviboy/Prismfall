import { test, expect, openMenu, hooks } from './fixtures';

/** Every block theme compiles and renders on both backends (shader errors surface as console errors). */
for (const backend of ['webgpu', 'webgl2']) {
  test(`all block themes render (${backend})`, async ({ page }) => {
    test.setTimeout(120_000);
    await openMenu(page, backend === 'webgl2' ? '?backend=webgl2' : '');
    await page.getByTestId('menu-play').click();
    await page.getByTestId('mode-zen').click();
    await page.getByTestId('setup-start').click();
    await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 20_000 }).toBe('running');
    const names = await page.evaluate(async () => Object.keys((await (window as unknown as { __PRISMFALL__: { blockPresets(): Promise<{ BLOCK_PRESETS: Record<string, unknown> }> } }).__PRISMFALL__.blockPresets()).BLOCK_PRESETS));
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      await page.evaluate(async (n) => {
        const h = (window as unknown as { __PRISMFALL__: { blockPresets(): Promise<{ resolveBlockPreset(id: string): unknown }>; shell: { renderSystem: { board: { setPreset(p: unknown): void } } } } }).__PRISMFALL__;
        h.shell.renderSystem.board.setPreset((await h.blockPresets()).resolveBlockPreset(n));
      }, name);
      await page.waitForTimeout(250);
    }
    // Classic style overrides the theme.
    await page.evaluate(() => (window as unknown as { __PRISMFALL__: { updateSection(s: string, p: unknown): void } }).__PRISMFALL__.updateSection('graphics', { blockStyle: 'classic' }));
    await expect.poll(() => hooks<string>(page, 'h.shell.renderSystem.board.settled.handle.surface')).toBe('plain');
  });
}
