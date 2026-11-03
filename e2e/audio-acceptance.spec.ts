import { writeFileSync, mkdirSync } from 'node:fs';
import { test, expect, openMenu } from './fixtures';

/**
 * §24 acceptance corpus: nine synthesized styles rendered offline by the real synthesizer and
 * scored against the sequencer's exact note log. Metrics are written to test-results for the docs.
 */

interface StyleReport {
  id: string;
  peakDb: number;
  dc: number;
  nan: boolean;
  onsetF: number | null;
  onsetPrecision: number | null;
  onsetRecall: number | null;
  bpm: number;
  estimatedBpm: number;
  octaveNormalizedError: number;
  octaveError: boolean;
  tempoConfidence: number;
  phaseErrorMean: number | null;
  phaseErrorMax: number | null;
  phaseSamples: number[];
  meanBands: Record<string, number>;
  maxEnergyStep: number;
  minFeature: number;
  maxFeature: number;
  silentEnergy: number | null;
}

type Lab = { lab: () => Promise<Record<string, ((...a: unknown[]) => unknown) | undefined>> };

test.describe('music analysis acceptance corpus', () => {
  test.setTimeout(240_000);

  test('every style meets the onset, tempo, band and stability thresholds', async ({ page }) => {
    await openMenu(page);
    const reports = (await page.evaluate(async () => {
      const lab = await (window as unknown as { __PRISMFALL__: Lab }).__PRISMFALL__.lab();
      return (await lab.runCorpus!(16)) as unknown[];
    })) as (StyleReport & { curves: Record<string, number[]> })[];
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/audio-corpus.json', JSON.stringify(reports, null, 2));
    const by = Object.fromEntries(reports.map((r) => [r.id, r]));
    expect(Object.keys(by).sort()).toEqual(['ambient', 'bassHeavy', 'cinematic', 'electronic', 'fast', 'orchestral', 'percussion', 'quietPassages', 'slow']);

    for (const r of reports) {
      // Signal integrity: headroom, no NaN, no DC; analysis outputs finite and within 0..1.
      expect.soft(r.nan, `${r.id} NaN`).toBe(false);
      expect.soft(r.peakDb, `${r.id} peak`).toBeLessThanOrEqual(-1);
      expect.soft(Math.abs(r.dc), `${r.id} DC`).toBeLessThan(0.005);
      expect.soft(r.minFeature, `${r.id} min feature`).toBeGreaterThanOrEqual(0);
      expect.soft(r.maxFeature, `${r.id} max feature`).toBeLessThanOrEqual(1.0001);
      if (r.onsetF !== null) expect(r.onsetF, `${r.id} onset F (P ${r.onsetPrecision?.toFixed(2)} R ${r.onsetRecall?.toFixed(2)})`).toBeGreaterThanOrEqual(0.85);
    }

    // Tempo within ±2% on rhythmic styles; octave errors are flagged, not hidden.
    for (const id of ['electronic', 'percussion', 'bassHeavy', 'slow', 'fast', 'orchestral']) {
      const r = by[id] as StyleReport;
      expect.soft(r.octaveNormalizedError, `${id}: est ${r.estimatedBpm.toFixed(1)} vs ${r.bpm}`).toBeLessThan(0.02);
    }
    for (const id of ['electronic', 'percussion', 'bassHeavy']) expect.soft((by[id] as StyleReport).octaveError, `${id} octave`).toBe(false);
    // Estimated beat phase stays within 30 ms of the true grid once locked (sampled every 0.5 s from 10 s).
    for (const id of ['electronic', 'percussion', 'bassHeavy', 'slow', 'fast', 'orchestral']) {
      const r = by[id] as StyleReport;
      expect.soft(r.phaseErrorMax ?? 1, `${id} beat phase error (mean ${((r.phaseErrorMean ?? 1) * 1000).toFixed(1)} ms; samples ${r.phaseSamples.join(' ')})`).toBeLessThan(0.03);
    }
    // Beatless material reports low tempo confidence.
    expect.soft((by['cinematic'] as StyleReport).tempoConfidence, 'cinematic tempo confidence').toBeLessThan(0.5);

    // Band dominance matches each style's arrangement.
    const bands = (id: string): Record<"subBass" | "bass" | "highMid" | "treble" | "spectralFlux" | "transientIntensity", number> => (by[id] as StyleReport).meanBands as never;
    expect(bands('bassHeavy').subBass + bands('bassHeavy').bass).toBeGreaterThan(bands('bassHeavy').highMid + bands('bassHeavy').treble);
    expect(bands('percussion').transientIntensity).toBeGreaterThan(bands('ambient').transientIntensity * 2);
    expect(bands('electronic').spectralFlux).toBeGreaterThan(bands('ambient').spectralFlux);
    expect(bands('ambient').transientIntensity).toBeLessThan(0.25);

    // Quiet passages: energy falls to rest during the silence and the response never jumps.
    const q = by['quietPassages'] as StyleReport;
    expect(q.silentEnergy).not.toBeNull();
    expect(q.silentEnergy as number).toBeLessThan(0.15);
    for (const r of reports) expect.soft(r.maxEnergyStep, `${r.id} energy step per hop`).toBeLessThan(0.35);
  });

  test('material impacts: hard drop outweighs lock and soft drop, and each world has its own colour', async ({ page }) => {
    await openMenu(page);
    type Row = { material: string; id: string; rms: number; peakDb: number; centroid: number; seconds: number };
    const rows = await page.evaluate(async () => {
      const lab = await (window as unknown as { __PRISMFALL__: { lab(): Promise<Record<string, (...a: unknown[]) => Promise<unknown>>> } }).__PRISMFALL__.lab();
      return (await lab.impactReport!(['sandstone', 'ice', 'wood', 'cosmic', 'mineral', 'water', 'organic', 'obsidian', 'aurora', 'neon'])) as Row[];
    });
    const get = (material: string, id: string): Row => rows.find((r) => r.material === material && r.id === id) as Row;
    for (const material of new Set(rows.map((r) => r.material))) {
      const energy = (id: string): number => get(material, id).rms * Math.sqrt(get(material, id).seconds);
      expect.soft(energy('hardDrop'), `${material} hard drop > lock`).toBeGreaterThan(energy('lock') * 1.3);
      expect.soft(energy('lock'), `${material} lock > soft drop`).toBeGreaterThan(energy('softDrop'));
      expect.soft(energy('hardDropHeavy'), `${material} full-height drop >= hard drop`).toBeGreaterThanOrEqual(energy('hardDrop') * 0.95);
      for (const r of rows.filter((x) => x.material === material)) expect.soft(r.peakDb, `${material}/${r.id} peak`).toBeLessThanOrEqual(-1);
    }
    // Brightness follows the material: ice rings above sandstone, wood and water stay darker than glassy worlds.
    expect(get('ice', 'hardDrop').centroid).toBeGreaterThan(get('sandstone', 'hardDrop').centroid);
    expect(get('aurora', 'hardDrop').centroid).toBeGreaterThan(get('water', 'hardDrop').centroid);
    // Sand carries a granular tail; wood is a short knock.
    expect(get('sandstone', 'hardDrop').seconds).toBeGreaterThan(get('wood', 'lock').seconds);
  });

  test('every SFX in every preset and every shipped track keeps headroom without NaN or DC', async ({ page }) => {
    await openMenu(page);
    const result = await page.evaluate(async () => {
      const lab = await (window as unknown as { __PRISMFALL__: Lab }).__PRISMFALL__.lab();
      const names = (await lab.sfxPresetNames!()) as string[];
      const effects = (await lab.checkSfx!(names)) as { id: string; preset: string; peakDb: number; nan: boolean }[];
      const tracks = (await lab.checkCompositions!(await lab.shippedCompositions!(), 24)) as { id: string; peakDb: number; dc: number; nan: boolean }[];
      return { effects, tracks };
    });
    expect(result.effects.length).toBeGreaterThan(20);
    for (const e of result.effects) {
      expect.soft(e.nan, `${e.preset}/${e.id}`).toBe(false);
      expect.soft(e.peakDb, `${e.preset}/${e.id} peak`).toBeLessThanOrEqual(-1);
      expect.soft(e.peakDb, `${e.preset}/${e.id} audible`).toBeGreaterThan(-40);
    }
    expect(result.tracks.length).toBeGreaterThanOrEqual(3);
    for (const t of result.tracks) {
      expect.soft(t.nan, t.id).toBe(false);
      expect.soft(t.peakDb, `${t.id} peak`).toBeLessThanOrEqual(-1);
      expect.soft(Math.abs(t.dc), `${t.id} DC`).toBeLessThan(0.005);
    }
  });
});
