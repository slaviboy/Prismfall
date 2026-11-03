import type { Page } from '@playwright/test';
import { test, expect, openMenu, hooks } from './fixtures';

/** Steps a choice row forward (its "›" arrow) until its value reads `label`. */
async function choose(page: Page, testId: string, label: RegExp): Promise<void> {
  const row = page.getByTestId(testId);
  for (let i = 0; i < 80; i++) {
    if (label.test((await row.locator('.choice-value').textContent()) ?? '')) return;
    await row.locator('.choice-arrow').last().click();
  }
  throw new Error(`${testId} never showed ${label}`);
}

test.describe('level creator', () => {
  test('a player level brings its world, music and blocks into play, and is saved', async ({ page }) => {
    await openMenu(page);
    await page.evaluate(() => (window as unknown as { __PRISMFALL__: { updateSection: (s: string, v: object) => void } }).__PRISMFALL__.updateSection('setup', { unlockAll: true }));
    await page.getByTestId('menu-creator').click();
    await expect(page.getByTestId('level-creator')).toBeVisible();
    await page.getByTestId('creator-new').click();
    await page.getByTestId('level-name').fill('Night swim');
    await choose(page, 'level-world', /^The Abyss$/);
    await expect(page.getByTestId('level-preview')).toContainText('Night swim');
    await choose(page, 'level-music', /^Silver Schools/);
    await choose(page, 'level-blocks', /^Marble$/);
    await page.getByTestId('level-play').click();

    // Saved with the settings, and chosen for play.
    expect(await hooks<number>(page, 'h.getSettings().creator.levels.length')).toBe(1);
    expect(await hooks<string>(page, 'h.getSettings().setup.stageId')).toBe('the-abyss');

    await page.getByTestId('mode-marathon').click();
    await expect(page.getByTestId('setup-world')).toContainText('Your level');
    await expect(page.getByTestId('setup-world')).toContainText('Night swim');
    await page.getByTestId('setup-start').click();
    await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 20_000 }).toBe('running');
    expect(await hooks<string>(page, 'h.shell.stageManager.activeId')).toBe('the-abyss');
    await expect.poll(() => hooks<string | null>(page, 'h.shell.currentTrackId'), { timeout: 15_000 }).toMatch(/silver-schools/);
    expect(await hooks<string | null>(page, 'h.shell.renderSystem.blockOverride')).toBe('marble');

    // Back in the setup, the world can be played as it is again.
    await page.evaluate(() => (window as unknown as { __PRISMFALL__: { shell: { quitToMenu: () => void } } }).__PRISMFALL__.shell.quitToMenu());
    await page.getByTestId('menu-play').click();
    await page.getByTestId('mode-marathon').click();
    await page.getByTestId('setup-clear-level').click();
    await expect(page.getByTestId('setup-world')).not.toContainText('Your level');
    await page.getByTestId('setup-start').click();
    await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 20_000 }).toBe('running');
    expect(await hooks<string | null>(page, 'h.shell.renderSystem.blockOverride')).toBeNull();
  });
});
