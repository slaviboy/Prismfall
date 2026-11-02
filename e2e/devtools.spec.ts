import { test, expect, openMenu, hooks } from './fixtures';

test.describe('developer tools', () => {
  test.use({ viewport: { width: 2560, height: 1080 } });

  test('audio dashboard draws live analysis and tuning applies to the engine', async ({ page }) => {
    await openMenu(page, '?devtools');
    await expect(page.getByTestId('audio-dashboard')).toBeVisible();
    await expect.poll(() => hooks<number>(page, 'h.shell.audio.engine.outputRms()'), { timeout: 15_000 }).toBeGreaterThan(0.004);
    await page.waitForTimeout(2500);
    // The canvas has real content (non-background pixels across the spectrum area).
    const lit = await page.evaluate(() => {
      const c = document.querySelector('.audio-dashboard canvas') as HTMLCanvasElement;
      const g = c.getContext('2d') as CanvasRenderingContext2D;
      const d = g.getImageData(0, 0, c.width, Math.round(c.height * 0.3)).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if ((d[i] as number) + (d[i + 1] as number) + (d[i + 2] as number) > 200) n++;
      return n;
    });
    expect(lit).toBeGreaterThan(2000);
    // Tuning: the sensitivity slider reaches the feature processor.
    const slider = page.locator('.dash-range input').first();
    await slider.fill('1.5');
    await expect.poll(() => hooks<number>(page, 'h.shell.audio.analysis.processor.tuning.sensitivity')).toBe(1.5);
    await page.screenshot({ path: 'test-results/screens/audio-dashboard.png' });
    // F9 closes it.
    await page.keyboard.press('F9');
    await expect(page.getByTestId('audio-dashboard')).toHaveCount(0);
  });

  test('developer tab lists every stage in the content report', async ({ page }) => {
    await openMenu(page, '?devtools');
    await page.keyboard.press('F9');
    await page.getByTestId('menu-settings').click();
    await page.getByRole('tab', { name: 'Developer', exact: true }).click();
    const ids = await hooks<string[]>(page, 'h.shell.stageManager.stages().map((s) => s.id)');
    await expect(page.getByTestId('content-report')).toContainText(`${ids.length} stages found`);
  });
});
