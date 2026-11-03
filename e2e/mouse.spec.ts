import { test, expect, openMenu, hooks } from './fixtures';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

test.describe('mouse control', () => {
  test('the piece follows the pointer; clicks hard drop, rotate and hold; the setting turns it off', async ({ page }) => {
    await openMenu(page);
    await page.evaluate(() => (window as unknown as { __PRISMFALL__: { updateSection: (s: string, v: object) => void } }).__PRISMFALL__.updateSection('gameplay', { mouseControl: true }));
    await page.getByTestId('menu-play').click();
    await page.getByTestId('mode-marathon').click();
    await page.getByTestId('setup-start').click();
    await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 15_000 }).toBe('running');

    const r = await hooks<Rect>(page, 'h.shell.renderSystem.boardRect()');
    const y = r.y + r.h * 0.5;
    const minX = () => hooks<number>(page, 'Math.min(...h.shell.session.engine.activeCells().map((c) => c.x))');
    const maxX = () => hooks<number>(page, 'Math.max(...h.shell.session.engine.activeCells().map((c) => c.x))');
    const pieces = () => hooks<number>(page, 'h.shell.session.engine.stats.pieces');

    // The piece slides under the pointer, wall to wall.
    await page.mouse.move(r.x + r.w * 0.04, y, { steps: 3 });
    await expect.poll(minX).toBe(0);
    await page.mouse.move(r.x + r.w * 0.96, y, { steps: 3 });
    await expect.poll(maxX).toBe(9);

    // Right click rotates (the O piece has no visible rotation, so hold past it first if needed).
    if ((await hooks<string>(page, 'h.shell.session.engine.active.type')) === 'O') {
      await page.mouse.click(r.x + r.w * 0.5, y, { button: 'middle' });
      await expect.poll(() => hooks<string | null>(page, 'h.shell.session.engine.hold')).toBe('O');
    }
    const rot = await hooks<number>(page, 'h.shell.session.engine.active.rotation');
    await page.mouse.click(r.x + r.w * 0.5, y, { button: 'right' });
    await expect.poll(() => hooks<number>(page, 'h.shell.session.engine.active.rotation')).toBe((rot + 1) % 4);

    // Left click hard drops in the column under the pointer.
    await page.mouse.click(r.x + r.w * 0.04, y);
    await expect.poll(pieces).toBe(1);
    expect(await hooks<boolean>(page, '[0, 1, 2, 3].some((row) => h.shell.session.engine.board.get(0, row) > 0)')).toBe(true);

    // Middle click holds.
    if ((await hooks<string | null>(page, 'h.shell.session.engine.hold')) === null) {
      await page.mouse.click(r.x + r.w * 0.5, y, { button: 'middle' });
      await expect.poll(() => hooks<string | null>(page, 'h.shell.session.engine.hold')).not.toBeNull();
    }

    // Turned off, the mouse no longer plays.
    await page.evaluate(() => (window as unknown as { __PRISMFALL__: { updateSection: (s: string, v: object) => void } }).__PRISMFALL__.updateSection('gameplay', { mouseControl: false }));
    const before = await minX();
    await page.mouse.move(r.x + r.w * 0.96, y, { steps: 3 });
    await page.mouse.click(r.x + r.w * 0.96, y);
    await page.waitForTimeout(300);
    expect(await pieces()).toBe(1);
    expect(await minX()).toBe(before);
  });
});
