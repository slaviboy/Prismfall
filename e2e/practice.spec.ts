import { test, expect, openMenu, hooks } from './fixtures';

test.describe('practice mode', () => {
  test('options configure the rules; undo and board reset work from the keyboard', async ({ page }) => {
    await openMenu(page);
    await page.getByTestId('menu-play').click();
    await page.getByTestId('mode-practice').click();
    // Park the mouse: the setup screen opens under the pointer, and hovering a row selects it.
    await page.mouse.move(2, 2);
    await expect(page.getByTestId('practice-options')).toBeVisible();
    // Gravity: By level -> Custom -> None (two steps right).
    const gravity = page.getByTestId('practice-gravity');
    await gravity.focus();
    await expect(gravity).toBeFocused();
    // One step at a time: under a loaded machine two quick presses can land before the first applies.
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => hooks<string>(page, 'h.getSettings().practice.gravityMode')).toBe('custom');
    // Custom gravity inserts a row under the resting mouse pointer: focus must stay on gravity.
    await expect(gravity).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => hooks<string>(page, 'h.getSettings().practice.gravityMode')).toBe('none');
    // Drill only I pieces.
    await page.getByTestId('practice-randomizer').focus();
    await expect(page.getByTestId('practice-randomizer')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => hooks<string>(page, 'h.getSettings().practice.randomizer')).not.toBe('bag7');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => hooks<string>(page, 'h.getSettings().practice.randomizer')).toBe('drill');
    // The drill can't be emptied, so add I before removing the default T.
    await page.getByTestId('practice-drill-I').click();
    await page.getByTestId('practice-drill-T').click();
    await expect.poll(() => hooks<string[]>(page, 'h.getSettings().practice.drillPieces')).toEqual(['I']);

    await page.getByTestId('setup-start').click();
    await expect.poll(() => hooks<string>(page, 'h.shell.session.status')).toBe('running');
    expect(await hooks<string[]>(page, 'h.shell.session.engine.preview(5)')).toEqual(['I', 'I', 'I', 'I', 'I']);
    // No gravity: the piece stays put (sampled once it has settled after spawning).
    await expect.poll(() => hooks<boolean>(page, '!!h.shell.session.engine.active && h.shell.session.engine.tick > 300')).toBe(true);
    const y0 = await hooks<number>(page, 'h.shell.session.engine.active.y');
    await page.waitForTimeout(1500);
    expect(await hooks<number>(page, 'h.shell.session.engine.active.y')).toBe(y0);

    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Space');
      await page.waitForTimeout(120);
    }
    await expect.poll(() => hooks<number>(page, 'h.shell.session.engine.stats.pieces')).toBe(3);
    await page.keyboard.press('Backspace');
    await expect.poll(() => hooks<number>(page, 'h.shell.session.engine.stats.pieces')).toBe(2);
    await page.keyboard.press('KeyR');
    await expect.poll(() => hooks<number>(page, 'h.shell.session.engine.stats.pieces')).toBe(0);
    expect(await hooks<number>(page, 'h.shell.session.engine.board.stackHeight()')).toBe(0);
  });
});
