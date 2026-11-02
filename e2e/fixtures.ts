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
  return page.evaluate(`(() => { const h = window.__PRISMFALL__; return ${fn}; })()`) as Promise<T>;
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
