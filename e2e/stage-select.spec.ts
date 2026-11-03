import { test, expect, openMenu, hooks } from './fixtures';

test.describe('world select', () => {
  test.use({ viewport: { width: 2560, height: 1080 } });

  test('cards preview their world live; choosing one starts the game there', async ({ page }) => {
    await openMenu(page);
    await page.evaluate(() => (window as unknown as { __PRISMFALL__: { updateSection(s: string, p: unknown): void } }).__PRISMFALL__.updateSection('setup', { unlockAll: true }));
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
    await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 15_000 }).toBe('running');
    expect(await hooks<string | null>(page, 'h.shell.stageManager.activeId')).toBe(target);
    await expect.poll(() => hooks<string | null>(page, 'h.shell.audio.stageId'), { timeout: 15_000 }).toBe(target);
  });

  test('locked worlds explain how to unlock them and cannot be chosen', async ({ page }) => {
    await openMenu(page);
    await page.getByTestId('menu-play').click();
    await page.getByTestId('mode-marathon').click();
    await page.getByTestId('setup-world').click();
    const locked = page.locator('.world-card.is-locked').first();
    await expect(locked).toBeVisible();
    await locked.focus();
    await expect(page.getByTestId('world-details')).toContainText('Voyage');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('stage-select')).toBeVisible();
    expect(await hooks<string>(page, 'h.getSettings().setup.stageId')).toBe('luminous-tide');
    // The developer switch is only offered in developer mode.
    await expect(page.getByTestId('world-unlock-all')).toHaveCount(0);
  });

  test('developer mode unlocks every world, with a switch on the world list', async ({ page }) => {
    await openMenu(page);
    await page.getByTestId('menu-settings').click();
    await page.getByRole('tab', { name: 'Data', exact: true }).click();
    await page.getByTestId('setting-developer').click();
    expect(await hooks<boolean>(page, 'h.getSettings().setup.unlockAll')).toBe(true);
    await page.keyboard.press('Escape');
    await page.getByTestId('menu-play').click();
    await page.getByTestId('mode-marathon').click();
    await page.getByTestId('setup-world').click();
    const toggle = page.getByTestId('world-unlock-all');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.world-card.is-locked')).toHaveCount(0);
    await toggle.click();
    await expect(page.locator('.world-card.is-locked').first()).toBeVisible();
    await toggle.click();
    await expect(page.locator('.world-card.is-locked')).toHaveCount(0);
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

  test('a long world list scrolls to its first and last worlds', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await openMenu(page);
    await page.getByTestId('menu-play').click();
    await page.getByTestId('mode-marathon').click();
    await page.getByTestId('setup-world').click();
    await expect(page.getByTestId('stage-select')).toBeVisible();
    const column = page.locator('.menu-column').first();
    const cards = page.locator('.world-card');
    const box = async (i: number) => (await cards.nth(i).boundingBox())!;
    const area = async () => (await column.boundingBox())!;
    expect(await column.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await column.evaluate((el) => el.scrollTo(0, 0));
    expect((await box(0)).y).toBeGreaterThanOrEqual((await area()).y - 1);
    await column.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const last = await box((await cards.count()) - 1);
    const view = await area();
    expect(last.y + last.height).toBeLessThanOrEqual(view.y + view.height + 1);
  });
});
