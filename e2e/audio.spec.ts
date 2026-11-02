import { test, expect, openMenu, hooks } from './fixtures';

/** Live audio checks (the test Chrome runs with --autoplay-policy=no-user-gesture-required). */
test.describe('audio engine', () => {
  test('unlocks, plays stage music through the analysis path and publishes features', async ({ page }) => {
    await openMenu(page);
    await expect.poll(() => hooks<string>(page, 'h.shell.audio.engine.state'), { timeout: 10_000 }).toBe('running');
    await expect.poll(() => hooks<string>(page, 'h.shell.audio.analysisPath'), { timeout: 10_000 }).toBe('worklet');
    await expect.poll(() => hooks<number>(page, 'h.shell.audio.engine.outputRms()'), { timeout: 15_000 }).toBeGreaterThan(0.004);
    // Features come from real analysis: bands move and beats are reported on the music grid.
    await page.waitForTimeout(3000);
    const f = await hooks<{ bass: number; treble: number; bpm: number; beat: number; section: string }>(page, '({ bass: h.shell.features.features.bass, treble: h.shell.features.features.treble, bpm: h.shell.features.features.bpm, beat: h.shell.features.features.beat, section: h.shell.features.features.section })');
    expect(f.beat).toBeGreaterThan(2);
    expect(f.bpm).toBeGreaterThan(60);
    expect(f.bass + f.treble).toBeGreaterThan(0.02);
    expect(f.section.length).toBeGreaterThan(0);
  });

  test('mute silences the output and volume scales it', async ({ page }) => {
    await openMenu(page);
    await expect.poll(() => hooks<number>(page, 'h.shell.audio.engine.outputRms()'), { timeout: 15_000 }).toBeGreaterThan(0.004);
    const measure = async (): Promise<number> => {
      let sum = 0;
      for (let i = 0; i < 20; i++) {
        sum += await hooks<number>(page, 'h.shell.audio.engine.outputRms()');
        await page.waitForTimeout(50);
      }
      return sum / 20;
    };
    const loud = await measure();
    await page.evaluate(() => (window as unknown as { __PRISMFALL__: { updateSection(s: string, p: unknown): void } }).__PRISMFALL__.updateSection('audio', { master: 0.3 }));
    await page.waitForTimeout(400);
    const quiet = await measure();
    expect(quiet).toBeLessThan(loud * 0.5);
    await page.evaluate(() => (window as unknown as { __PRISMFALL__: { updateSection(s: string, p: unknown): void } }).__PRISMFALL__.updateSection('audio', { muted: true }));
    await page.waitForTimeout(400);
    expect(await measure()).toBeLessThan(0.0005);
  });

  test('pausing in stop mode freezes the musical position; resuming continues it', async ({ page }) => {
    await openMenu(page);
    await page.evaluate(() => (window as unknown as { __PRISMFALL__: { updateSection(s: string, p: unknown): void } }).__PRISMFALL__.updateSection('audio', { pauseBehavior: 'stop' }));
    await page.getByTestId('menu-play').click();
    await page.getByTestId('mode-zen').click();
    await page.getByTestId('setup-start').click();
    await expect.poll(() => hooks<string>(page, 'h.shell.session.status')).toBe('running');
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const b1 = await hooks<number>(page, 'h.shell.audio.director.current.beatAt(h.shell.audio.engine.now)');
    await page.waitForTimeout(1200);
    const b2 = await hooks<number>(page, 'h.shell.audio.director.current.beatAt(h.shell.audio.engine.now)');
    expect(Math.abs(b2 - b1)).toBeLessThan(0.01);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const b3 = await hooks<number>(page, 'h.shell.audio.director.current.beatAt(h.shell.audio.engine.now)');
    expect(b3).toBeGreaterThan(b2 + 0.5);
  });

  test('switching stages crossfades the music on a bar line', async ({ page }) => {
    await openMenu(page);
    await expect.poll(() => hooks<number>(page, 'h.shell.audio.engine.outputRms()'), { timeout: 15_000 }).toBeGreaterThan(0.004);
    const ids = await hooks<string[]>(page, 'h.shell.stageManager.stages().map((s) => s.id)');
    const current = await hooks<string>(page, 'h.shell.stageManager.activeId');
    const other = ids.find((i) => i !== current) as string;
    await page.evaluate((id) => (window as unknown as { __PRISMFALL__: { shell: { stageManager: { show(i: string, o: unknown): Promise<boolean> } } } }).__PRISMFALL__.shell.stageManager.show(id, { transition: 1 }), other);
    await expect.poll(() => hooks<string | null>(page, 'h.shell.audio.stageId'), { timeout: 15_000 }).toBe(other);
    // The crossfade is scheduled once the new stage's sound palette has been rendered.
    await expect.poll(() => hooks<boolean>(page, 'h.shell.audio.director.lastTransition !== null'), { timeout: 15_000 }).toBe(true);
    const t = await hooks<{ outgoingBeat: number; beatsPerBar: number }>(page, 'h.shell.audio.director.lastTransition');
    const offBar = t.outgoingBeat % t.beatsPerBar;
    expect(Math.min(offBar, t.beatsPerBar - offBar)).toBeLessThan(0.02);
  });
});

test.describe('user music files', () => {
  test('a WAV with beat metadata plays through the file path and its beat clock matches the audio', async ({ page }) => {
    test.setTimeout(60_000);
    await openMenu(page);
    await expect.poll(() => hooks<string>(page, 'h.shell.audio.engine.state'), { timeout: 10_000 }).toBe('running');
    const track = await page.evaluate(async () => {
      const h = (window as unknown as { __PRISMFALL__: { lab: () => Promise<{ makeTestFileTrack: () => Promise<{ url: string; bpm: number; offset: number; bars: number }> }>; shell: { audio: { setOverride(t: unknown): Promise<void> } } } }).__PRISMFALL__;
      const t = await (await h.lab()).makeTestFileTrack();
      await h.shell.audio.setOverride({
        id: 'user-file-test',
        bpm: t.bpm,
        beatsPerBar: 4,
        composition: null,
        file: { url: t.url, meta: { title: 'Test file', bpm: t.bpm, offset: t.offset, loop: { startBar: 0, endBar: t.bars } } },
        ambience: null,
        ambienceLevel: 0,
        sfxPreset: 'glass',
      });
      return t;
    });
    await expect.poll(() => hooks<string>(page, 'h.shell.audio.director.current?.id'), { timeout: 10_000 }).toBe('user-file-test');
    expect(await hooks<boolean>(page, "'buffer' in h.shell.audio.director.current")).toBe(true);
    // Let the old track fade out and the analysis lock onto the file.
    await page.waitForTimeout(9000);
    const s = await hooks<{ bpm: number; detected: number; trackPhase: number; detectedPhase: number; confidence: number }>(
      page,
      '({ bpm: h.shell.features.features.bpm, detected: h.shell.audio.analysis.processor.tempo.bpm, trackPhase: h.shell.features.features.beatPhase, detectedPhase: h.shell.audio.analysis.processor.tempo.phase, confidence: h.shell.audio.analysis.processor.tempo.confidence })',
    );
    expect(s.bpm).toBe(track.bpm);
    expect(Math.abs(s.detected - track.bpm) / track.bpm).toBeLessThan(0.02);
    // The file's metadata beat clock and the beat detected in its audio agree (live jitter allowed).
    let d = s.trackPhase - s.detectedPhase;
    d -= Math.round(d);
    expect(Math.abs(d) * (60 / track.bpm) * 1000).toBeLessThan(40);
  });
});
