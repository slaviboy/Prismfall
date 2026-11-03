import type { Page } from '@playwright/test';
import { test, expect, openMenu, hooks } from './fixtures';

/** Clears the board and fills the bottom row except under the active piece, so a hard drop clears one line. */
async function setUpOneLineClear(page: Page, linesBefore: number): Promise<void> {
  await expect.poll(() => hooks<boolean>(page, '!!h.shell.session?.engine.active'), { timeout: 10_000 }).toBe(true);
  await page.evaluate((lines: number) => {
    interface TestEngine {
      board: { clear(): void; set(x: number, y: number, v: number): void; version: number };
      activeCells(): { x: number; y: number }[];
      lines: number;
    }
    const e = (window as unknown as { __PRISMFALL__: { shell: { session: { engine: TestEngine } } } }).__PRISMFALL__.shell.session.engine;
    e.board.clear();
    const cells = e.activeCells();
    const low = Math.min(...cells.map((c) => c.y));
    const holes = new Set(cells.filter((c) => c.y === low).map((c) => c.x));
    for (let x = 0; x < 10; x++) if (!holes.has(x)) e.board.set(x, 0, 8);
    e.board.version++;
    e.lines = lines;
  }, linesBefore);
}

test.describe('voyage', () => {
  test('a run travels through the worlds mid-game and completing it unlocks them', async ({ page }) => {
    test.setTimeout(90_000);
    await openMenu(page);
    await page.getByTestId('menu-voyage').click();
    await expect(page.getByTestId('voyage-screen')).toBeVisible();
    // Only the first area is open on a fresh save.
    await expect(page.getByTestId('area-first-light')).not.toHaveClass(/is-locked/);
    await expect(page.getByTestId('area-under-pressure')).toHaveClass(/is-locked/);
    await page.getByTestId('area-under-pressure').click();
    await expect(page.getByTestId('voyage-screen')).toBeVisible();

    await page.getByTestId('area-first-light').click();
    await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 20_000 }).toBe('running');
    await expect(page.getByTestId('hud-voyage')).toContainText('Leg 1 of 12: Luminous Tide');
    const plan = await hooks<{ stage: string; endLines: number; level: number }[]>(page, 'h.shell.voyage.plan.legs.map((l) => ({ stage: l.stage, endLines: l.endLines, level: l.level }))');
    expect(plan.map((l) => l.stage)).toEqual(['luminous-tide', 'ancient-garden', 'frozen-kingdom', 'alpine-horizon', 'moving-sands', 'enchanted-wilderness', 'the-abyss', 'ember-foundry', 'ember-core', 'northern-lights', 'future-nights', 'celestial-drift']);

    // Reach the first leg's goal with a real line clear: the next world arrives on a bar line.
    await setUpOneLineClear(page, (plan[0] as { endLines: number }).endLines - 1);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('hud-voyage')).toContainText('Leg 2 of 12: Ancient Garden', { timeout: 5000 });
    await expect.poll(() => hooks<number>(page, 'h.shell.session.engine.level')).toBeGreaterThanOrEqual((plan[1] as { level: number }).level);
    await expect.poll(() => hooks<string | null>(page, 'h.shell.stageManager.activeId'), { timeout: 15_000 }).toBe('ancient-garden');
    await expect.poll(() => hooks<string | null>(page, 'h.shell.audio.stageId'), { timeout: 15_000 }).toBe('ancient-garden');
    // The board carried over the transition.
    expect(await hooks<string>(page, 'h.shell.session?.status')).toBe('running');

    // Jump to the last leg and finish the journey.
    const total = (plan[11] as { endLines: number }).endLines;
    await setUpOneLineClear(page, total - 1);
    await page.waitForTimeout(200);
    await expect(page.getByTestId('hud-voyage')).toContainText('Leg 12 of 12: Deep Cosmos', { timeout: 5000 });
    await setUpOneLineClear(page, total - 1);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('results-screen')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('results-screen')).toContainText('Voyage complete');
    await expect(page.getByTestId('results-legs')).toHaveText('12 of 12');
    await expect(page.getByTestId('results-unlocked')).toContainText('Ember Foundry');
    await expect(page.getByTestId('results-unlocked')).toContainText('Deep Cosmos');
    const progress = await hooks<{ legs: string[]; areas: string[] }>(page, '({ legs: h.progressStore.getState().progress.voyage.completedLegs, areas: h.progressStore.getState().progress.voyage.completedAreas })');
    expect(progress.legs.length).toBe(12);
    expect(progress.areas.length).toBe(4);

    // The unlocks persist: the worlds are open in world select and every area can be a start.
    await page.getByTestId('results-menu').click();
    await page.getByTestId('menu-voyage').click();
    await expect(page.getByTestId('area-under-pressure')).not.toHaveClass(/is-locked/);
    await page.reload();
    await page.getByTestId('boot-start').click();
    await page.getByTestId('menu-play').click();
    await page.getByTestId('mode-marathon').click();
    await page.getByTestId('setup-world').click();
    await expect(page.getByTestId('world-ember-foundry')).not.toHaveClass(/is-locked/);
  });
});
