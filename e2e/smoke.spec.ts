import { test, expect, openMenu, hooks, autoplay } from './fixtures';

test('boots to the title screen and opens the main menu', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByTestId('boot-screen')).toBeVisible();
  await expect(page.locator('.boot-title')).toHaveText('Prismfall');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('main-menu')).toBeVisible();
});

test('menus are navigable with the keyboard alone', async ({ page }) => {
  await openMenu(page);
  await expect(page.getByTestId('menu-play')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('menu-music')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('mode-select')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('main-menu')).toBeVisible();
});

test('plays a complete Sprint session to the results screen and records it', async ({ page }) => {
  await openMenu(page);
  await page.getByTestId('menu-play').click();
  await page.getByTestId('mode-sprint').click();
  await expect(page.getByTestId('mode-setup')).toBeVisible();
  // Choose the 20-line variant.
  while (!(await page.getByTestId('setup-variant').innerText()).includes('20 Lines')) await page.getByTestId('setup-variant').click();
  await page.getByTestId('setup-start').click();
  await expect(page.getByTestId('hud')).toBeVisible();
  await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 15_000 }).toBe('running');
  await autoplay(page, 300);
  await expect(page.getByTestId('results-screen')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('results-headline')).toHaveText(/\d+:\d{2}\.\d{2}/);
  // The replay viewer: plays, pauses, changes speed, seeks and restarts.
  await page.getByTestId('results-replay').click();
  await expect(page.getByTestId('replay-bar')).toBeVisible();
  await expect.poll(() => hooks<number>(page, 'h.shell.replaySession.positionMs')).toBeGreaterThan(300);
  await page.getByTestId('replay-pause').click();
  const paused = await hooks<number>(page, 'h.shell.replaySession.positionMs');
  await page.waitForTimeout(300);
  expect(await hooks<number>(page, 'h.shell.replaySession.positionMs')).toBe(paused);
  await page.getByTestId('replay-forward').click();
  expect(await hooks<number>(page, 'h.shell.replaySession.positionMs')).toBeGreaterThanOrEqual(Math.min(paused + 10_000, await hooks<number>(page, 'h.shell.replaySession.durationMs')));
  const forward = await hooks<number>(page, 'h.shell.replaySession.positionMs');
  await page.getByTestId('replay-back').click();
  expect(await hooks<number>(page, 'h.shell.replaySession.positionMs')).toBe(Math.max(0, forward - 10_000));
  await page.getByTestId('replay-speed').click();
  expect(await hooks<number>(page, 'h.shell.replaySession.speed')).toBe(2);
  await page.getByTestId('replay-restart').click();
  expect(await hooks<number>(page, 'h.shell.replaySession.positionMs')).toBe(0);
  await expect(page.getByTestId('replay-time')).toContainText('/');
  await page.getByTestId('replay-close').click();
  await expect(page.getByTestId('results-screen')).toBeVisible();
  await page.getByTestId('results-menu').click();
  await page.getByTestId('menu-highscores').click();
  while (!(await page.getByTestId('highscores-table').innerText()).includes('Sprint: 20 Lines')) await page.getByTestId('highscores-table').click();
  await expect(page.getByTestId('highscores-list').locator('li')).toHaveCount(1);
});

test('pauses, resumes, restarts and quits', async ({ page }) => {
  await openMenu(page);
  await page.getByTestId('menu-play').click();
  await page.getByTestId('mode-marathon').click();
  await page.getByTestId('setup-start').click();
  await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 15_000 }).toBe('running');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  const tickPaused = await hooks<number>(page, 'h.shell.session.engine.tick');
  await page.waitForTimeout(400);
  expect(await hooks<number>(page, 'h.shell.session.engine.tick')).toBe(tickPaused);
  await page.keyboard.press('Enter'); // Resume (focused)
  await expect(page.getByTestId('pause-menu')).toBeHidden();
  await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 15_000 }).toBe('running');
  await page.keyboard.press('Space'); // hard drop
  await expect.poll(() => hooks<number>(page, 'h.shell.session.engine.stats.pieces')).toBe(1);
  await page.keyboard.press('Escape');
  await page.getByTestId('pause-restart').click();
  await expect.poll(() => hooks<number>(page, 'h.shell.session.engine.stats.pieces')).toBe(0);
  await page.keyboard.press('Escape');
  await page.getByTestId('pause-quit').click();
  await expect(page.getByTestId('main-menu')).toBeVisible();
});

test('changes a setting and keeps it after a reload', async ({ page }) => {
  await openMenu(page);
  await page.getByTestId('menu-settings').click();
  const row = page.getByTestId('setting-gameplay-arrMs');
  await row.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  await expect(row).toContainText('28 ms');
  await page.waitForTimeout(700); // debounced save
  await page.reload();
  await page.getByTestId('boot-start').click();
  await page.getByTestId('menu-settings').click();
  await expect(page.getByTestId('setting-gameplay-arrMs')).toContainText('28 ms');
});
