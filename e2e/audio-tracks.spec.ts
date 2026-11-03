import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, openMenu } from './fixtures';

/**
 * Whole-track measurements of every composition listed in a stage manifest: each track's first
 * pass (plus the loop seam) is rendered offline by the real synthesizer through the game's
 * limiter and analysed by the game's own DSP (src/audio/lab/trackReport.ts). Results go to
 * test-results/audio-tracks.json. It takes about half a minute per track, so it runs on demand:
 * `AUDIO_TRACKS=1 npx playwright test e2e/audio-tracks.spec.ts` (add `PW_DEV=1` for the dev
 * server); `TRACKS=id,id` limits it to some tracks. The default suite's headroom check in
 * audio-acceptance.spec.ts covers every track's opening and loudest section.
 */

interface Section {
  name: string;
  kind: string;
  intensity: number;
  lufs: number;
  peakDb: number;
  onsetsPerSec: number;
  features: Record<string, number>;
}

interface Report {
  id: string;
  bpm: number;
  beatsPerBar: number;
  passSeconds: number;
  loopSeconds: number;
  peakDb: number;
  dc: number;
  nan: boolean;
  lufs: number;
  bandsDb: number[];
  bandShare: number[];
  tempoRatio: number;
  tempoConfidence: number;
  phaseErrorMs: number | null;
  onsetsPerSec: number;
  sections: Section[];
  sectionLoudnessRange: number;
  sectionCentroidRange: number;
}

/**
 * Against the dev server (PW_DEV=1), content edits elsewhere make Vite reload the page, which would
 * restart a long run. This stand-in for Vite's HMR client keeps CSS working and ignores updates.
 */
const STATIC_VITE_CLIENT = `
import '/@vite/env';
const sheets = new Map();
export function updateStyle(id, css) { let s = sheets.get(id); if (!s) { s = document.createElement('style'); s.dataset.viteDevId = id; document.head.appendChild(s); sheets.set(id, s); } s.textContent = css; }
export function removeStyle(id) { sheets.get(id)?.remove(); sheets.delete(id); }
export function injectQuery(url) { return url; }
export function createHotContext() { return { data: {}, accept() {}, acceptExports() {}, dispose() {}, prune() {}, decline() {}, invalidate() {}, on() {}, off() {}, send() {} }; }
export class ErrorOverlay extends HTMLElement {}
`;

type Lab = { lab: () => Promise<{ measureShippedTracks: (ids?: string[]) => Promise<Report[]>; shippedCompositions: () => Promise<{ id: string }[]>; worldTracks: () => Promise<{ stage: string; defaultTrack: string; tracks: string[] }[]> }> };

test.describe('world tracks', () => {
  test('every track keeps headroom, a full spectrum, steady loudness and an audible section arc', async ({ page }) => {
    test.skip(!process.env.AUDIO_TRACKS && !process.env.TRACKS, 'whole-track renders run on demand: set AUDIO_TRACKS=1');
    test.setTimeout(40 * 60_000);
    if (process.env.PW_DEV === '1') await page.route('**/@vite/client', (route) => route.fulfill({ contentType: 'text/javascript', body: STATIC_VITE_CLIENT }));
    await openMenu(page);
    const shipped = await page.evaluate(async () => (await (await (window as unknown as { __PRISMFALL__: Lab }).__PRISMFALL__.lab()).shippedCompositions()).map((c) => c.id));
    const worlds = await page.evaluate(async () => (await (window as unknown as { __PRISMFALL__: Lab }).__PRISMFALL__.lab()).worldTracks());
    const only = process.env.TRACKS?.split(',');
    const ids = only ? shipped.filter((id) => only.includes(id)) : shipped;
    // One track per call, so progress shows and a dev-server reload costs only the current track.
    const reports: Report[] = [];
    for (const id of ids) {
      for (let attempt = 0; ; attempt++) {
        try {
          await page.waitForFunction(() => !!(window as unknown as { __PRISMFALL__?: unknown }).__PRISMFALL__);
          const [report] = await page.evaluate(async (track) => (await (window as unknown as { __PRISMFALL__: Lab }).__PRISMFALL__.lab()).measureShippedTracks([track]), id);
          if (!report) throw new Error(`no report for ${id}`);
          reports.push(report);
          console.log(`${id}: ${report.lufs.toFixed(1)} LUFS, peak ${report.peakDb.toFixed(1)} dBFS`);
          break;
        } catch (err) {
          if (attempt >= 2 || !String(err).includes('Execution context was destroyed')) throw err;
        }
      }
    }
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/audio-tracks.json', JSON.stringify(reports, null, 2));
    expect(reports.length).toBeGreaterThan(0);
    // Loudness: no track far from the soundtrack's median, and a world's tracks, which take turns,
    // close to its default track.
    const loudness = reports.map((r) => r.lufs).sort((a, b) => a - b);
    const median = loudness[Math.floor(loudness.length / 2)] as number;
    const byId = new Map(reports.map((r) => [r.id, r]));
    for (const w of worlds) {
      const main = byId.get(w.defaultTrack);
      for (const id of w.tracks) {
        const r = byId.get(id);
        if (main && r && r !== main) expect.soft(Math.abs(r.lufs - main.lufs), `${id} ${r.lufs.toFixed(1)} LUFS vs ${main.id} ${main.lufs.toFixed(1)} LUFS`).toBeLessThan(4);
      }
    }
    const defaults = new Set(worlds.map((w) => w.defaultTrack));
    for (const r of reports) {
      expect.soft(r.nan, `${r.id} NaN`).toBe(false);
      expect.soft(r.peakDb, `${r.id} peak`).toBeLessThanOrEqual(-1);
      expect.soft(Math.abs(r.dc), `${r.id} DC`).toBeLessThan(0.005);
      expect.soft(Math.abs(r.lufs - median), `${r.id} loudness ${r.lufs.toFixed(1)} LUFS vs median ${median.toFixed(1)}`).toBeLessThan(7);
      // The arrangement bar applies to added tracks; each world's default track predates it.
      if (defaults.has(r.id)) continue;
      expect.soft(r.loopSeconds, `${r.id} loop length`).toBeGreaterThan(100);
      // A real low end and real highs, not all mids: sub + bass carry weight, the top two bands are present.
      const [sub, bass, , mid, highMid, treble] = r.bandsDb as [number, number, number, number, number, number];
      expect.soft(Math.max(sub, bass) - mid, `${r.id} low end vs mids (dB)`).toBeGreaterThan(0);
      expect.soft(Math.max(highMid, treble) - mid, `${r.id} highs vs mids (dB)`).toBeGreaterThan(-26);
      // The arrangement has a shape: sections differ in loudness and brightness, and the most
      // intense section is among the loudest.
      expect.soft(r.sectionLoudnessRange, `${r.id} section loudness range (LU)`).toBeGreaterThan(3);
      const peakSection = [...r.sections].sort((a, b) => b.intensity - a.intensity)[0] as Section;
      const loudest = Math.max(...r.sections.map((s) => s.lufs));
      expect.soft(loudest - peakSection.lufs, `${r.id} "${peakSection.name}" is among the loudest sections`).toBeLessThan(3);
      // Something for the beat-driven visuals: onsets and spectral change in the peak section.
      expect.soft(peakSection.onsetsPerSec, `${r.id} onsets/s in "${peakSection.name}"`).toBeGreaterThan(1);
      expect.soft(peakSection.features.spectralFlux ?? 0, `${r.id} flux in "${peakSection.name}"`).toBeGreaterThan(0.05);
    }
  });
});
