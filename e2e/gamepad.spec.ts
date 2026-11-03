import { test, expect, hooks, installFakePad, padPress } from './fixtures';

/** Standard mapping: 0 = A/Cross, 1 = B/Circle, 12-15 = d-pad up/down/left/right, 4/5 = shoulders. */
test.describe('gamepad', () => {
  test('navigates every menu level, switches tabs and plays with a controller alone', async ({ page }) => {
    await installFakePad(page);
    await page.goto('./');
    await expect(page.getByTestId('boot-screen')).toBeVisible();
    // Buttons already down when a pad is first seen are ignored, so wait for it to register.
    await expect.poll(() => hooks<number>(page, 'h.shell.input.gamepad.connectedPads().length')).toBe(1);
    // The Gamepad API is polled once per frame: let the boot-time loading hitches pass first.
    await page.waitForTimeout(800);
    await padPress(page, 0);
    await expect(page.getByTestId('main-menu')).toBeVisible();
    await expect.poll(() => hooks<string>(page, 'h.appStore.getState().device')).toBe('gamepad');
    await expect.poll(() => hooks<string>(page, 'h.appStore.getState().padFamily')).toBe('playstation');
    // Button names follow the controller family.
    await expect(page.locator('.control-hints svg[aria-label="Cross"]')).toBeVisible();
    await expect(page.getByTestId('menu-play')).toBeFocused();
    await padPress(page, 13);
    await expect(page.getByTestId('menu-music')).toBeFocused();
    await padPress(page, 13);
    await padPress(page, 13);
    await expect(page.getByTestId('menu-settings')).toBeFocused();
    await padPress(page, 0);
    await expect(page.getByTestId('settings-panel')).toBeVisible();
    // Shoulder buttons change tabs.
    await padPress(page, 5);
    await expect(page.locator('.settings-header [role=tab][aria-selected=true]')).toHaveText('Controls');
    await padPress(page, 4);
    await expect(page.locator('.settings-header [role=tab][aria-selected=true]')).toHaveText('Gameplay');
    await padPress(page, 1);
    await expect(page.getByTestId('main-menu')).toBeVisible();
    // Into a game: Play → Marathon → Start.
    await expect(page.getByTestId('menu-settings')).toBeFocused();
    for (let i = 0; i < 3; i++) await padPress(page, 12);
    await expect(page.getByTestId('menu-play')).toBeFocused();
    await padPress(page, 0);
    await expect(page.getByTestId('mode-select')).toBeVisible();
    await padPress(page, 0);
    await expect(page.getByTestId('mode-setup')).toBeVisible();
    await expect(page.getByTestId('setup-start')).toBeFocused();
    await padPress(page, 0);
    await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 15_000 }).toBe('running');
    // D-pad up hard-drops; Options pauses; Cross resumes.
    await padPress(page, 12);
    await expect.poll(() => hooks<number>(page, 'h.shell.session.engine.stats.pieces')).toBe(1);
    await padPress(page, 9);
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await padPress(page, 0);
    await expect(page.getByTestId('pause-menu')).toBeHidden();
  });
});
