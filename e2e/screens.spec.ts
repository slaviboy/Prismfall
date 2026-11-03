import { test, expect, openMenu, hooks, autoplay } from './fixtures';

/** Captures key screens for visual review (not pixel assertions — GPU output varies). */
const shot = (name: string) => `test-results/screens/${name}.png`;

test.describe('screen captures', () => {
  test.use({ viewport: { width: 2560, height: 1080 } });

  test('menus, settings and gameplay at 21:9', async ({ page }) => {
    await openMenu(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot('main-menu') });
    await page.getByTestId('menu-settings').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('settings') });
    await page.keyboard.press('Escape');
    await page.getByTestId('menu-play').click();
    await page.getByTestId('mode-marathon').click();
    await page.screenshot({ path: shot('mode-setup') });
    await page.getByTestId('setup-start').click();
    await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 15_000 }).toBe('running');
    await autoplay(page, 40);
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('gameplay') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.screenshot({ path: shot('pause') });
  });
});
