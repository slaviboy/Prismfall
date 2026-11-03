import { test as base, expect, type Page } from '@playwright/test';

/** Fails the test on any console error or uncaught page error. */
export const test = base.extend<{ errors: string[] }>({
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
      });
      page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
      await use(errors);
      expect(errors, 'no console errors or page errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Loads the app and passes the boot screen. */
export async function openMenu(page: Page, query = ''): Promise<void> {
  await page.goto(`./${query}`);
  await page.getByTestId('boot-start').click();
  await expect(page.getByTestId('main-menu')).toBeVisible();
}

/** Evaluates against the dev/test debug hooks. */
export async function hooks<T>(page: Page, fn: string): Promise<T> {
  // Undefined until the app has installed its hooks, so early polls retry instead of throwing.
  return page.evaluate(`(() => { const h = window.__PRISMFALL__; if (!h) return undefined; return ${fn}; })()`) as Promise<T>;
}

/** Lets the built-in AI play the current session quickly by injecting timed inputs. */
export async function autoplay(page: Page, pieces: number): Promise<void> {
  await page.evaluate(async (n) => {
    const h = (window as unknown as { __PRISMFALL__: { shell: { session: unknown; aiStep: () => boolean } } }).__PRISMFALL__;
    for (let i = 0; i < n; i++) {
      if (!h.shell.aiStep()) break;
      await new Promise((r) => setTimeout(r, 20));
    }
  }, pieces);
}

import { PNG } from 'pngjs';

/** Screenshot-based "is something actually rendered" check (WebGPU canvases can't be read back reliably). */
export async function canvasStats(page: Page): Promise<{ mean: number; stdDev: number; colorful: number }> {
  const png = PNG.sync.read(await page.screenshot());
  let sum = 0;
  let sumSq = 0;
  let colorful = 0;
  const n = png.width * png.height;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i] as number;
    const g = png.data[i + 1] as number;
    const b = png.data[i + 2] as number;
    const l = (r + g + b) / 3;
    sum += l;
    sumSq += l * l;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 60) colorful++;
  }
  const mean = sum / n;
  return { mean, stdDev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)), colorful: colorful / n };
}

/** Starts a game in the given mode and lets the AI place some pieces so blocks are on screen. */
export async function startAndPlay(page: Page, mode = 'zen', pieces = 12): Promise<void> {
  await page.getByTestId('menu-play').click();
  await page.getByTestId(`mode-${mode}`).click();
  await page.getByTestId('setup-start').click();
  await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 15_000 }).toBe('running');
  await autoplay(page, pieces);
}

/**
 * Installs a scriptable standard-mapping gamepad (navigator.getGamepads is replaced before the app
 * loads). Use `padPress` to tap a button by its standard index.
 */
export async function installFakePad(page: Page, id = 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)'): Promise<void> {
  await page.addInitScript((padId: string) => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
    const pad = { id: padId, index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons, timestamp: performance.now(), vibrationActuator: null, hapticActuators: [] };
    (window as unknown as { __fakePad: typeof pad }).__fakePad = pad;
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad, null, null, null], configurable: true });
  }, id);
}

export async function padPress(page: Page, button: number, holdMs = 120): Promise<void> {
  const set = (down: boolean): Promise<void> =>
    page.evaluate(
      ([b, d]) => {
        const pad = (window as unknown as { __fakePad: { buttons: { pressed: boolean; value: number }[]; timestamp: number } }).__fakePad;
        const btn = pad.buttons[b as number];
        if (btn) {
          btn.pressed = d as boolean;
          btn.value = d ? 1 : 0;
        }
        pad.timestamp = performance.now();
      },
      [button, down] as const,
    );
  await set(true);
  await page.waitForTimeout(holdMs);
  await set(false);
  await page.waitForTimeout(80);
}
