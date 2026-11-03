import type { Page } from '@playwright/test';
import { test, expect, hooks, openMenu, autoplay, canvasStats } from './fixtures';

/**
 * WebXR through Meta's Immersive Web Emulation Runtime (IWER): an emulated Quest 3 with Touch
 * controllers replaces navigator.xr, so the real session, frame loop and controller polling run.
 * What it can't prove (comfort, real tracking, controller feel, frame rate in a headset) is listed
 * in VR_TESTING.md (real headset checklist).
 */

async function installHeadset(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as {
      __PRISMFALL__: { xrEmulator: () => Promise<{ installXREmulator: () => unknown }>; shell: { xr: { detect: () => Promise<string> } } };
      __xr: { device: unknown; mod: unknown };
    };
    const mod = await w.__PRISMFALL__.xrEmulator();
    w.__xr = { device: mod.installXREmulator(), mod };
    await w.__PRISMFALL__.shell.xr.detect();
  });
}

async function press(page: Page, hand: 'left' | 'right', id: string): Promise<void> {
  await page.evaluate(
    async ([h, b]) => {
      const x = (window as unknown as { __xr: { device: unknown; mod: { pressButton: (d: unknown, h: string, b: string) => Promise<void> } } }).__xr;
      await x.mod.pressButton(x.device, h as string, b as string);
    },
    [hand, id] as const,
  );
}

async function stick(page: Page, hand: 'left' | 'right', dx: number, dy: number): Promise<void> {
  await page.evaluate(
    async ([h, x0, y0]) => {
      const x = (window as unknown as { __xr: { device: unknown; mod: { pushStick: (d: unknown, h: string, x: number, y: number) => Promise<void> } } }).__xr;
      await x.mod.pushStick(x.device, h as string, x0 as number, y0 as number);
    },
    [hand, dx, dy] as const,
  );
}

/** Moves the panel highlight with the right stick until `id` is selected. */
async function selectItem(page: Page, id: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    if ((await hooks<string>(page, 'h.shell.xr.panelItem')) === id) return;
    await stick(page, 'right', 0, 1);
  }
  expect(await hooks<string>(page, 'h.shell.xr.panelItem')).toBe(id);
}

const pieces = (page: Page): Promise<number> => hooks<number>(page, 'h.shell.session.engine.stats.pieces');
const paused = (page: Page): Promise<boolean> => hooks<boolean>(page, 'h.appStore.getState().paused');
const presenting = (page: Page): Promise<boolean> => hooks<boolean>(page, 'h.shell.xr.presenting');

test.describe('VR (emulated Quest 3)', () => {
  test('reports no headset without a VR runtime and offers guidance', async ({ page }) => {
    await openMenu(page);
    await expect.poll(() => hooks<string>(page, 'h.shell.xr.availability')).not.toBe('checking');
    await expect(page.getByTestId('menu-vr')).toHaveCount(0);
    await page.getByTestId('menu-settings').click();
    await page.locator('.settings-header [role=tab]', { hasText: 'VR' }).click();
    await expect(page.getByTestId('vr-status')).toBeVisible();
    await expect(page.getByTestId('vr-enter')).toHaveCount(0);
    await expect(page.getByTestId('vr-bindings')).toBeVisible();
  });

  test('enters VR mid-game, plays with controllers, and returns with the game intact', async ({ page }) => {
    await openMenu(page);
    await installHeadset(page);
    await expect(page.getByTestId('menu-vr')).toBeVisible();

    await page.getByTestId('menu-play').click();
    await page.getByTestId('mode-marathon').click();
    await page.getByTestId('setup-start').click();
    await expect.poll(() => hooks<string>(page, 'h.shell.session.status')).toBe('running');
    await autoplay(page, 4);
    const placed = await pieces(page);
    const score = await hooks<number>(page, 'h.hudStore.getState().score');

    // Pause → Play in VR.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.getByTestId('menu-vr').click();
    await expect.poll(() => presenting(page), { timeout: 15_000 }).toBe(true);
    await expect(page.getByTestId('vr-overlay')).toBeVisible();
    // The session drives frames now; the game is exactly where it was.
    expect(await pieces(page)).toBe(placed);
    expect(await paused(page)).toBe(true);
    const scale = await hooks<number>(page, 'h.shell.renderSystem.boardRoot.scale.x');
    expect(scale).toBeCloseTo(1 / 20, 3);
    // Head tracking reaches three (eye cameras exist) and the headset view shows the scene.
    await expect.poll(() => hooks<boolean>(page, 'h.shell.xr.head !== null')).toBe(true);
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.id = 'hide-page';
      style.textContent = '#root, #scene { visibility: hidden !important; }';
      document.head.append(style);
    });
    const view = await canvasStats(page);
    await page.evaluate(() => document.getElementById('hide-page')?.remove());
    expect(view.stdDev, 'headset view has contrast').toBeGreaterThan(6);
    expect(view.colorful, 'pieces are visible in the headset view').toBeGreaterThan(0.001);

    // B is "back" in menus: resume (after the resume countdown, a piece is in play).
    await press(page, 'right', 'b-button');
    await expect.poll(() => paused(page)).toBe(false);
    await expect.poll(() => hooks<string>(page, 'h.shell.session.status'), { timeout: 10_000 }).toBe('running');
    await expect.poll(() => hooks<boolean>(page, 'h.shell.session.engine.active !== null')).toBe(true);

    // Trigger rotates, stick moves, grip holds, A hard-drops.
    const rotation = await hooks<number>(page, 'h.shell.session.engine.active.rotation');
    await press(page, 'right', 'trigger');
    await expect.poll(() => hooks<number>(page, 'h.shell.session.engine.active.rotation')).toBe((rotation + 1) % 4);
    const x = await hooks<number>(page, 'h.shell.session.engine.active.x');
    await stick(page, 'left', -1, 0);
    await expect.poll(() => hooks<number>(page, 'h.shell.session.engine.active.x')).toBeLessThan(x);
    const held = await hooks<string | null>(page, 'h.shell.session.engine.hold');
    await press(page, 'right', 'squeeze');
    await expect.poll(() => hooks<string | null>(page, 'h.shell.session.engine.hold')).not.toBe(held);
    await press(page, 'right', 'a-button');
    await expect.poll(() => pieces(page)).toBe(placed + 1);

    // Y pauses; the VR panel answers the stick and trigger.
    await press(page, 'left', 'y-button');
    await expect.poll(() => paused(page)).toBe(true);
    await expect.poll(() => hooks<boolean>(page, 'h.shell.xr.panelShown')).toBe(true);

    // Exit from the page; state preserved, desktop view restored. (The emulator draws its own
    // full-page canvas over the page, so the click is dispatched to the button directly.)
    await page.getByTestId('vr-exit').dispatchEvent('click');
    await expect.poll(() => presenting(page)).toBe(false);
    await expect(page.getByTestId('vr-overlay')).toHaveCount(0);
    expect(await pieces(page)).toBe(placed + 1);
    expect(await hooks<number>(page, 'h.hudStore.getState().score')).toBeGreaterThanOrEqual(score);
    expect(await hooks<number>(page, 'h.shell.renderSystem.boardRoot.scale.x')).toBeCloseTo(1, 3);
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.getByTestId('pause-resume').click();
    await expect.poll(() => paused(page)).toBe(false);
    // The desktop loop runs again (after the resume countdown).
    await expect.poll(() => hooks<string>(page, 'h.shell.session.status'), { timeout: 10_000 }).toBe('running');
    await expect.poll(() => hooks<boolean>(page, 'h.shell.session.engine.active !== null')).toBe(true);
    await page.keyboard.press('Space');
    await expect.poll(() => pieces(page)).toBe(placed + 2);
  });

  test('the VR menu starts a game and exits VR from the headset', async ({ page }) => {
    await openMenu(page);
    await installHeadset(page);
    await page.getByTestId('menu-vr').click();
    await expect.poll(() => presenting(page), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => hooks<boolean>(page, 'h.shell.xr.panelShown')).toBe(true);
    await selectItem(page, 'marathon');
    // Confirm with the trigger: Marathon.
    await press(page, 'right', 'trigger');
    await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 15_000 }).toBe('running');
    await expect.poll(() => hooks<boolean>(page, 'h.shell.session.engine.active !== null')).toBe(true);
    await press(page, 'right', 'a-button');
    await expect.poll(() => pieces(page)).toBe(1);
    // Pause, then move down to "Exit VR" and confirm.
    await press(page, 'left', 'y-button');
    await expect.poll(() => paused(page)).toBe(true);
    await expect.poll(() => hooks<boolean>(page, 'h.shell.xr.panelShown')).toBe(true);
    await selectItem(page, 'exit');
    await press(page, 'right', 'trigger');
    await expect.poll(() => presenting(page)).toBe(false);
    expect(await pieces(page)).toBe(1);
  });
});
