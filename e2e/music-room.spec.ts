import { test, expect, openMenu, hooks } from './fixtures';

/** A 16-bit mono WAV: low thumps on the beat and noise hats between, at `bpm`. */
function grooveWav(bpm: number, seconds: number, rate = 22050): Buffer {
  const n = Math.round(seconds * rate);
  const samples = new Float32Array(n);
  const spb = 60 / bpm;
  let seed = 11;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  for (let k = 0; k * spb * 0.5 < seconds; k++) {
    const start = Math.round(k * spb * 0.5 * rate);
    for (let i = 0; i < 0.15 * rate && start + i < n; i++) {
      const v = k % 2 === 0 ? Math.sin((2 * Math.PI * 60 * i) / rate) * 0.6 * Math.exp(-i / (0.03 * rate)) : rnd() * 0.2 * Math.exp(-i / (0.008 * rate));
      samples[start + i] = (samples[start + i] as number) + v;
    }
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((samples[i] as number) * 32767))), 44 + i * 2);
  return buf;
}

test.describe('music room', () => {
  test('plays world music, analyses an added file and uses it in free play', async ({ page }) => {
    test.setTimeout(90_000);
    await openMenu(page);
    await expect.poll(() => hooks<string>(page, 'h.shell.audio.engine.state'), { timeout: 10_000 }).toBe('running');
    await page.getByTestId('menu-music').click();
    await expect(page.getByTestId('music-room')).toBeVisible();

    // A world's track plays through the override.
    const world = page.locator('[data-testid^="track-stage:"]').first();
    await world.click();
    await expect(page.getByTestId('now-playing')).toBeVisible();
    await expect.poll(() => hooks<string | null>(page, 'h.shell.currentTrackId')).toMatch(/^stage:/);

    // Add a file: decoded, analysed in a worker and stored.
    await page.getByTestId('music-file').setInputFiles({ name: 'my groove.wav', mimeType: 'audio/wav', buffer: grooveWav(120, 16) });
    const userRow = page.locator('[data-testid^="track-user:"]');
    await expect(userRow).toHaveCount(1, { timeout: 30_000 });
    await expect(userRow).toContainText('my groove');
    const bpm = await hooks<number>(page, 'h.shell.catalog().then((c) => c.find((t) => t.source === "user").bpm)');
    expect(Math.abs(bpm - 120)).toBeLessThanOrEqual(2);
    await userRow.click();
    await expect.poll(() => hooks<string | null>(page, 'h.shell.currentTrackId')).toMatch(/^user:/);
    await expect.poll(() => hooks<boolean>(page, "'buffer' in (h.shell.audio.director.current ?? {})"), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => hooks<number>(page, 'h.shell.features.features.bpm')).toBeGreaterThan(115);

    // Choose it for free play, leave, and start Zen: it plays instead of the world's music.
    const id = await hooks<string>(page, 'h.shell.currentTrackId');
    await page.evaluate((trackId) => (window as unknown as { __PRISMFALL__: { updateSection(s: string, p: unknown): void } }).__PRISMFALL__.updateSection('setup', { music: trackId }), id);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('main-menu')).toBeVisible();
    await expect.poll(() => hooks<string | null>(page, 'h.shell.currentTrackId')).toBeNull();
    await page.getByTestId('menu-play').click();
    await page.getByTestId('mode-zen').click();
    await page.getByTestId('setup-start').click();
    await expect.poll(() => hooks<string>(page, 'h.shell.session?.status'), { timeout: 20_000 }).toBe('running');
    await expect.poll(() => hooks<string | null>(page, 'h.shell.currentTrackId')).toBe(id);
    await page.keyboard.press('Escape');
    await page.getByTestId('pause-quit').click();
    await expect.poll(() => hooks<string | null>(page, 'h.shell.currentTrackId')).toBeNull();

    // The file survives a reload and can be removed.
    await page.reload();
    await page.getByTestId('boot-start').click();
    await page.getByTestId('menu-music').click();
    await expect(page.locator('[data-testid^="track-user:"]')).toHaveCount(1);
    await page.locator('[data-testid^="remove-user:"]').click();
    await expect(page.locator('[data-testid^="track-user:"]')).toHaveCount(0);
    expect(await hooks<string>(page, 'h.getSettings().setup.music')).toBe('stage');
  });
});
