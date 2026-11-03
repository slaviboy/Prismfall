import { test, expect, openMenu, hooks, installFakePad, padPress } from './fixtures';

test.describe('controls and controllers', () => {
  test('keyboard rebinding with conflict handling works in game and persists', async ({ page }) => {
    await openMenu(page);
    await page.getByTestId('menu-settings').click();
    await page.getByRole('tab', { name: 'Controls', exact: true }).click();
    await expect(page.getByTestId('controls-panel')).toBeVisible();

    // A free key: assigned directly.
    await page.getByTestId('bind-keyboard-hardDrop-0').click();
    await expect(page.getByTestId('capture-prompt')).toBeVisible();
    await page.keyboard.press('KeyW');
    await expect.poll(() => hooks<string[]>(page, 'h.getSettings().keyboard.hardDrop')).toEqual(['KeyW']);

    // A key used by another action: swap.
    await page.getByTestId('bind-keyboard-hold-0').click();
    await page.keyboard.press('KeyZ');
    await expect(page.getByTestId('binding-conflict')).toContainText('Rotate Counter-clockwise');
    await page.getByTestId('conflict-swap').click();
    expect(await hooks<string[]>(page, 'h.getSettings().keyboard.hold')).toContain('KeyZ');
    expect(await hooks<string[]>(page, 'h.getSettings().keyboard.rotateCCW')).toContain('KeyC');

    // Escape cancels a capture without changing anything.
    await page.getByTestId('bind-keyboard-moveLeft-0').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('capture-prompt')).toBeHidden();
    expect(await hooks<string[]>(page, 'h.getSettings().keyboard.moveLeft')).toEqual(['ArrowLeft']);

    // The rebound key hard-drops in game.
    await page.keyboard.press('Escape');
    await page.getByTestId('menu-play').click();
    await page.getByTestId('mode-marathon').click();
    await page.getByTestId('setup-start').click();
    await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 15_000 }).toBe('running');
    await page.keyboard.press('KeyW');
    await expect.poll(() => hooks<number>(page, 'h.shell.session.engine.stats.pieces')).toBe(1);

    // Persisted across a reload; defaults restore everything.
    await page.reload();
    await page.getByTestId('boot-start').click();
    expect(await hooks<string[]>(page, 'h.getSettings().keyboard.hardDrop')).toEqual(['KeyW']);
    await page.getByTestId('menu-settings').click();
    await page.getByRole('tab', { name: 'Controls', exact: true }).click();
    await page.getByTestId('bindings-reset').click();
    expect(await hooks<string[]>(page, 'h.getSettings().keyboard.hardDrop')).toEqual(['Space']);
  });

  test('controller tab lists the pad, tests buttons, renames buttons and rebinds', async ({ page }) => {
    await installFakePad(page);
    await openMenu(page);
    await expect.poll(() => hooks<number>(page, 'h.shell.input.gamepad.connectedPads().length')).toBe(1);
    await page.waitForTimeout(600);
    await page.getByTestId('menu-settings').click();
    await page.getByRole('tab', { name: 'Controller', exact: true }).click();
    await expect(page.getByTestId('pad-0')).toContainText('DualShock 4');
    // Live tester lights the pressed button.
    await page.getByTestId('pad-test-0').click();
    await page.evaluate(() => {
      const pad = (window as unknown as { __fakePad: { buttons: { pressed: boolean; value: number }[]; timestamp: number } }).__fakePad;
      (pad.buttons[3] as { pressed: boolean; value: number }).pressed = true;
      (pad.buttons[3] as { pressed: boolean; value: number }).value = 1;
      pad.timestamp = performance.now();
    });
    await expect(page.locator('[data-control="button:3"]')).toHaveClass(/is-down/);
    await page.evaluate(() => {
      const pad = (window as unknown as { __fakePad: { buttons: { pressed: boolean; value: number }[] } }).__fakePad;
      (pad.buttons[3] as { pressed: boolean; value: number }).pressed = false;
      (pad.buttons[3] as { pressed: boolean; value: number }).value = 0;
    });
    // Button names follow the override.
    await page.getByTestId('pad-family-0').click();
    await expect.poll(() => hooks<string | undefined>(page, 'Object.values(h.getSettings().controller.profiles)[0]?.family')).toBe('playstation');

    // Rebind hold to Triangle (used by rotate 180): replace.
    await page.getByRole('tab', { name: 'Controls', exact: true }).click();
    await page.getByRole('tab', { name: 'Controller', exact: true }).nth(1).click();
    await page.getByTestId('bind-gamepad-hold-0').click();
    await padPress(page, 3);
    await expect(page.getByTestId('binding-conflict')).toBeVisible();
    await page.getByTestId('conflict-replace').click();
    expect(await hooks<string[]>(page, 'h.getSettings().gamepad.hold')).toContain('button:3');
    expect(await hooks<string[]>(page, 'h.getSettings().gamepad.rotate180')).not.toContain('button:3');
  });
});
