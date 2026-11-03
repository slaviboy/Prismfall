import { test, expect, openMenu, hooks } from './fixtures';

test.describe('audio and reactivity settings', () => {
  test('audio tab changes volume live and the reactivity tab reports the analysis path', async ({ page }) => {
    await openMenu(page);
    await expect.poll(() => hooks<number>(page, 'h.shell.audio.engine.outputRms()'), { timeout: 15_000 }).toBeGreaterThan(0.004);
    await page.getByTestId('menu-settings').click();
    await page.getByRole('tab', { name: 'Audio', exact: true }).click();
    await expect(page.getByTestId('settings-tab-audio')).toBeVisible();
    // Mute from the UI silences the output.
    await page.getByTestId('setting-audio-muted').click();
    await expect.poll(() => hooks<boolean>(page, 'h.getSettings().audio.muted')).toBe(true);
    await expect.poll(() => hooks<number>(page, 'h.shell.audio.engine.outputRms()'), { timeout: 3000 }).toBeLessThan(0.0005);
    await page.getByTestId('setting-audio-muted').click();
    // Reactivity tab: live analysis status.
    await page.getByRole('tab', { name: 'Reactivity', exact: true }).click();
    await expect(page.getByTestId('analysis-info')).toContainText('Audio worklet');
    await expect(page.getByTestId('analysis-info')).toContainText('frames/s');
    // Switching the analysis method rebuilds the engine on the analyser path.
    await page.getByTestId('setting-reactivity-analysisPath').click();
    await page.getByTestId('setting-reactivity-analysisPath').click();
    await expect.poll(() => hooks<string>(page, 'h.getSettings().reactivity.analysisPath')).toBe('analyser');
    await expect.poll(() => hooks<string>(page, 'h.shell.audio.analysisPath'), { timeout: 5000 }).toBe('analyser');
    await expect(page.getByTestId('analysis-info')).toContainText('Analyser node');
  });

  test('sound test plays a world\u2019s material sounds on their own buses and settings persist', async ({ page }) => {
    await openMenu(page);
    await expect.poll(() => hooks<string>(page, 'h.shell.audio.engine.state'), { timeout: 10_000 }).toBe('running');
    await page.getByTestId('menu-settings').click();
    await page.getByRole('tab', { name: 'Audio', exact: true }).click();
    await expect(page.getByTestId('audio-test')).toBeVisible();
    // Choose the desert: its sandstone palette is rendered (material layers come from the worker).
    await page.evaluate(() => (window as unknown as { __PRISMFALL__: { shell: { auditionStage(id: string): Promise<void> } } }).__PRISMFALL__.shell.auditionStage('moving-sands'));
    await expect.poll(() => hooks<string>(page, 'h.shell.audio.stage?.materialKey'), { timeout: 10_000 }).toBe('sandstone');
    await expect.poll(() => hooks<boolean>(page, 'h.shell.audio.sfx.has("signature") && h.shell.audio.sfx.has("footstep") && h.shell.audio.sfx.has("hardDropHeavy")'), { timeout: 10_000 }).toBe(true);
    // Hard drop variants exist (round robin) and the effect is audible over silence.
    expect(await hooks<number>(page, 'h.shell.audio.sfx.buffers.get("hardDrop").length')).toBe(3);
    await page.evaluate(() => (window as unknown as { __PRISMFALL__: { shell: { audio: { director: { stop(f: number): void } } } } }).__PRISMFALL__.shell.audio.director.stop(0.05));
    await page.waitForTimeout(600);
    await page.getByTestId('sfx-hardDrop').click();
    await expect.poll(() => hooks<number>(page, 'h.shell.audio.engine.outputRms()'), { timeout: 2000 }).toBeGreaterThan(0.002);
    // The hard-drop slider controls the impacts bus only.
    await page.evaluate(() => (window as unknown as { __PRISMFALL__: { updateSection(s: string, p: unknown): void } }).__PRISMFALL__.updateSection('audio', { hardDrop: 0, sfxVariation: 0.2, adaptiveMusic: false }));
    await expect.poll(() => hooks<number>(page, 'h.shell.audio.engine.impacts.gain.value'), { timeout: 2000 }).toBeLessThan(0.01);
    expect(await hooks<number>(page, 'h.shell.audio.engine.sfx.gain.value')).toBeGreaterThan(0.1);
    expect(await hooks<number>(page, 'h.shell.audio.sfx.variation')).toBeCloseTo(0.2);
    await page.waitForTimeout(900); // debounced save
    await page.reload();
    await page.getByTestId('boot-start').click();
    await expect.poll(() => hooks<boolean>(page, 'h.getSettings().audio.adaptiveMusic')).toBe(false);
    expect(await hooks<number>(page, 'h.getSettings().audio.hardDrop')).toBe(0);
  });

  test('tap-along calibration measures and applies an audio offset', async ({ page }) => {
    test.setTimeout(60_000);
    await openMenu(page);
    await expect.poll(() => hooks<string>(page, 'h.shell.audio.engine.state'), { timeout: 10_000 }).toBe('running');
    await page.getByTestId('menu-settings').click();
    await page.getByRole('tab', { name: 'Audio', exact: true }).click();
    await page.getByTestId('calibration-start').click();
    await expect(page.getByTestId('calibration-pad')).toBeVisible();
    // Steady taps once per click (600 ms at 100 BPM); their phase relative to the clicks is arbitrary
    // but constant, so the result must be a consistent offset.
    for (let i = 0; i < 21; i++) {
      await page.keyboard.press('Space');
      await page.waitForTimeout(600);
    }
    await expect(page.getByTestId('calibration-result')).toBeVisible({ timeout: 5000 });
    const apply = page.getByTestId('calibration-apply');
    await expect(apply).toBeVisible();
    await apply.click();
    const offset = await hooks<number>(page, 'h.getSettings().audio.latencyOffsetMs');
    expect(Math.abs(offset)).toBeLessThanOrEqual(250);
    // Music returns to full level after calibration.
    await expect.poll(() => hooks<number>(page, 'h.shell.audio.engine.outputRms()'), { timeout: 5000 }).toBeGreaterThan(0.004);
  });
});

test.describe('visual sound cues', () => {
  test.use({ viewport: { width: 2560, height: 1080 } });

  test('beat lamp follows the music and denied holds are captioned', async ({ page }) => {
    await openMenu(page);
    await page.evaluate(() => (window as unknown as { __PRISMFALL__: { updateSection(s: string, p: unknown): void } }).__PRISMFALL__.updateSection('accessibility', { visualAudioCues: true }));
    await page.getByTestId('menu-play').click();
    await page.getByTestId('mode-zen').click();
    await page.getByTestId('setup-start').click();
    await expect.poll(() => hooks<string>(page, 'h.shell.session.status')).toBe('running');
    await expect(page.getByTestId('sound-cues')).toBeVisible();
    // The lamp animates on every heard beat of the stage music.
    const pulses = await page.evaluate(async () => {
      const lamp = document.querySelector('.sound-cue-lamp') as HTMLElement;
      let count = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 3000) {
        if (lamp.getAnimations().length > 0) count++;
        await new Promise((r) => setTimeout(r, 100));
      }
      return count;
    });
    expect(pulses).toBeGreaterThan(5);
    // Hold, then hold again with the same piece: the buzz is captioned.
    await page.keyboard.press('KeyC');
    await page.waitForTimeout(50);
    await page.keyboard.press('KeyC');
    await expect(page.getByTestId('sound-cues')).toContainText('Hold already used');
    await page.screenshot({ path: 'test-results/screens/sound-cues.png' });
  });
});
