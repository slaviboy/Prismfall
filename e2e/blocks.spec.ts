import { test, expect, openMenu, hooks, autoplay } from './fixtures';

/** Visual comparison of the Blender block designs (captures only). */
for (const design of ['soft', 'chamfer', 'faceted', 'pillow', 'framed']) {
  test(`block design ${design}`, async ({ page }) => {
    test.setTimeout(60_000);
    await openMenu(page, `?block=${design}`);
    await page.getByTestId('menu-play').click();
    await page.getByTestId('mode-zen').click();
    await page.getByTestId('setup-start').click();
    await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 15_000 }).toBe('running');
    await autoplay(page, 26);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/screens/block-${design}.png`, clip: { x: 520, y: 380, width: 560, height: 520 } });
  });
}
