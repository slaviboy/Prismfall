import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, openMenu } from './fixtures';

interface PathRun {
  style: string;
  config: string;
  onsetF: number | null;
  tempoError: number;
  octaveError: boolean;
  phaseErrorMaxMs: number | null;
  microsPerUpdate: number;
  updatesPerSecond: number;
}
interface FftTradeoff {
  longSize: number;
  subLeakageDb: number;
  bassRiseMs: number;
}

type Hooks = { __PRISMFALL__: { labProfile: () => Promise<{ profilePaths: (s: number) => Promise<{ runs: PathRun[]; fft: FftTradeoff[] }> }> } };

/**
 * Worklet vs. analyser path and long-FFT-size profiling over the rhythmic corpus styles.
 * Results go to test-results/analysis-profile.json (summarised in AUDIO_ANALYSIS.md).
 */
test('analysis path profiling: the default (worklet, 4096) is at least as accurate as the alternatives', async ({ page }) => {
  test.setTimeout(300_000);
  await openMenu(page);
  const result = await page.evaluate(async () => (await (window as unknown as Hooks).__PRISMFALL__.labProfile()).profilePaths(16));
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/analysis-profile.json', JSON.stringify(result, null, 2));

  // Per configuration: mean onset F (percussive styles), styles within ±2 % tempo, worst phase error, cost.
  const configs = [...new Set(result.runs.map((r) => r.config))];
  const summary = configs.map((config) => {
    const rs = result.runs.filter((r) => r.config === config);
    const fs = rs.map((r) => r.onsetF).filter((v): v is number => v !== null);
    const phases = rs.map((r) => r.phaseErrorMaxMs).filter((v): v is number => v !== null);
    return {
      config,
      meanOnsetF: fs.reduce((a, b) => a + b, 0) / fs.length,
      tempoOk: rs.filter((r) => r.tempoError < 0.02).length,
      styles: rs.length,
      worstPhaseMs: Math.max(...phases),
      microsPerUpdate: rs.reduce((a, b) => a + b.microsPerUpdate, 0) / rs.length,
      updatesPerSecond: rs.reduce((a, b) => a + b.updatesPerSecond, 0) / rs.length,
    };
  });
  writeFileSync('test-results/analysis-profile-summary.json', JSON.stringify({ summary, fft: result.fft }, null, 2));
  console.table(summary);
  console.table(result.fft);

  const def = summary.find((s) => s.config === 'worklet 4096');
  const alt = summary.find((s) => s.config === 'worklet 2048');
  expect(def).toBeDefined();
  for (const s of summary) expect(def?.meanOnsetF ?? 0, `default vs ${s.config}`).toBeGreaterThanOrEqual(s.meanOnsetF - 0.01);
  expect(def?.tempoOk).toBe(def?.styles);
  // Only the fixed-hop worklet keeps beat phase locked; the analyser is tied to the render rate.
  expect(def?.worstPhaseMs ?? 1e9).toBeLessThan(30);
  // Rhythm comes from the short FFT, so the long FFT size only affects the bands.
  expect(alt?.meanOnsetF).toBeCloseTo(def?.meanOnsetF ?? 0, 6);
  // The longer window separates the sub band better.
  const [f4096, f2048] = result.fft;
  expect(f4096?.subLeakageDb ?? 0).toBeLessThan(f2048?.subLeakageDb ?? 0);
});
