import { test, expect, openMenu, hooks } from './fixtures';

test.describe('world select', () => {
  test.use({ viewport: { width: 2560, height: 1080 } });

  test('cards preview their world live; choosing one starts the game there', async ({ page }) => {
    await openMenu(page);
    await page.getByTestId('menu-play').click();
    await page.getByTestId('mode-marathon').click();
    await page.getByTestId('setup-world').click();
    await expect(page.getByTestId('stage-select')).toBeVisible();
    const ids = await hooks<string[]>(page, 'h.shell.stageManager.stages().map((s) => s.id)');
    for (const id of ids) await expect(page.getByTestId(`world-${id}`)).toBeVisible();
    // Every card has artwork.
    expect(await page.locator('.world-card img.stage-art').count()).toBe(ids.length);
    const target = ids.find((i) => i !== 'luminous-tide') as string;
    await page.getByTestId(`world-${target}`).focus();
    await expect(page.getByTestId('world-details')).toContainText(await hooks<string>(page, `h.shell.stageManager.stages().find((s) => s.id === '${target}').manifest.name`));
    await expect.poll(() => hooks<string | null>(page, 'h.shell.stageManager.activeId'), { timeout: 15_000 }).toBe(target);
    await page.waitForTimeout(800);
    await page.screenshot({ path: 'test-results/screens/world-select.png' });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('mode-setup')).toBeVisible();
    expect(await hooks<string>(page, 'h.getSettings().setup.stageId')).toBe(target);
    await page.getByTestId('setup-start').click();
    await expect.poll(() => hooks<string>(page, 'h.shell.session.status'), { timeout: 15_000 }).toBe('running');
    expect(await hooks<string | null>(page, 'h.shell.stageManager.activeId')).toBe(target);
    await expect.poll(() => hooks<string | null>(page, 'h.shell.audio.stageId'), { timeout: 15_000 }).toBe(target);
  });

  test('backing out restores the selected world; music previews can be turned off', async ({ page }) => {
    await openMenu(page);
    await page.evaluate(() => (window as unknown as { __PRISMFALL__: { updateSection(s: string, p: unknown): void } }).__PRISMFALL__.updateSection('audio', { musicPreview: false }));
    await page.getByTestId('menu-play').click();
    await page.getByTestId('mode-zen').click();
    const selected = await hooks<string>(page, 'h.getSettings().setup.stageId');
    await expect.poll(() => hooks<string | null>(page, 'h.shell.audio.stageId'), { timeout: 15_000 }).toBe(selected);
    await page.getByTestId('setup-world').click();
    const ids = await hooks<string[]>(page, 'h.shell.stageManager.stages().map((s) => s.id)');
    const other = ids.find((i) => i !== selected) as string;
    await page.getByTestId(`world-${other}`).focus();
    await expect.poll(() => hooks<string | null>(page, 'h.shell.stageManager.activeId'), { timeout: 15_000 }).toBe(other);
    // Music stays with the selected world while previews are off.
    expect(await hooks<string | null>(page, 'h.shell.audio.stageId')).toBe(selected);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('mode-setup')).toBeVisible();
    await expect.poll(() => hooks<string | null>(page, 'h.shell.stageManager.activeId'), { timeout: 15_000 }).toBe(selected);
  });
});
