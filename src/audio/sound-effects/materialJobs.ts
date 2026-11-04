import { renderCrawl, renderSilk, renderSkitter, renderWebHum } from './creatureSynth';
import { renderGrains, renderImpact, type StereoSamples } from './impactSynth';
import { withOverrides, type MaterialAudioProfile } from './materialAudio';

/**
 * The material-dependent layer of each effect (pure; runs in the SFX worker). Strength tiers keep
 * soft drops, landings, locks and hard drops clearly different; line clears get a material break
 * under their musical accent.
 */
export interface MaterialJob {
  readonly variants: number;
  render(m: MaterialAudioProfile, seed: number, sampleRate: number): StereoSamples | null;
}

/** Weight of each skitter and crawl variant, lightest first (playback picks by gain). */
export const CREATURE_WEIGHTS = [0.1, 0.28, 0.46, 0.64, 0.82, 1] as const;

export const MATERIAL_JOBS: Readonly<Record<string, MaterialJob>> = {
  softDrop: { variants: 3, render: (m, s, sr) => renderGrains(m, 2, 0.03, s, sr, 0.3) },
  land: { variants: 3, render: (m, s, sr) => renderImpact(m, 0.26, s, sr, { layers: ['transient', 'body', 'sub'], gain: 0.55, maxSeconds: 0.5 }) },
  lock: { variants: 3, render: (m, s, sr) => renderImpact(m, 0.36, s, sr, { layers: ['transient', 'body'], gain: 0.62, maxSeconds: 0.5 }) },
  hardDrop: { variants: 3, render: (m, s, sr) => renderImpact(m, 0.72, s, sr) },
  hardDropHeavy: { variants: 2, render: (m, s, sr) => renderImpact(m, 1, s, sr) },
  spawn: { variants: 2, render: (m, s, sr) => renderGrains(m, 6, 0.12, s, sr, 0.18, true) },
  clear1: { variants: 2, render: (m, s, sr) => renderImpact(m, 0.5, s, sr, { layers: ['transient', 'body', 'scatter'], gain: 0.7 }) },
  clear2: { variants: 2, render: (m, s, sr) => renderImpact(m, 0.68, s, sr, { layers: ['transient', 'body', 'scatter', 'tail'], gain: 0.75 }) },
  clear3: { variants: 2, render: (m, s, sr) => renderImpact(m, 0.85, s, sr, { gain: 0.8 }) },
  clear4: { variants: 1, render: (m, s, sr) => renderImpact(m, 1, s, sr, { gain: 0.85 }) },
  /** The world's own answer to a four-line clear (stage-effects bus). */
  signature: {
    variants: 1,
    render: (m, s, sr) =>
      renderImpact(withOverrides(m, m.signature ?? { tail: { ...m.tail, level: m.tail.level + 0.2, decay: 1.6 }, reverb: { wet: 0.4, size: 1.6 } }), 1, s, sr, { maxSeconds: 3, gain: 0.8 }),
  },
  /** Optional environmental answer to hard drops (stage-effects bus). */
  impactResponse: { variants: 2, render: (m, s, sr) => (m.response ? renderImpact(withOverrides(m, m.response), 0.8, s, sr, { gain: 0.7 }) : null) },
  /** Distant creature footfalls (spatial, stage-effects bus). */
  footstep: { variants: 4, render: (m, s, sr) => renderImpact(m, 0.16, s, sr, { layers: ['body', 'scatter'], gain: 0.45, maxSeconds: 0.45 }) },
  // Creature sounds (spatial, stage-effects bus). They ignore the block material: claws on stone
  // sound the same in any world. Skitter and crawl variants run light to heavy (CREATURE_WEIGHTS).
  skitter: { variants: 6, render: (_m, s, sr) => renderSkitter(CREATURE_WEIGHTS[s - 1] ?? 0.5, s, sr) },
  crawl: { variants: 6, render: (_m, s, sr) => renderCrawl(CREATURE_WEIGHTS[s - 1] ?? 0.5, s, sr) },
  silk: { variants: 3, render: (_m, s, sr) => renderSilk(s, sr) },
  webHum: { variants: 3, render: (_m, s, sr) => renderWebHum(s, sr) },
};

export interface MaterialRenderResult {
  readonly id: string;
  readonly variant: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
}

/** Jobs that ignore the material (creature sounds): the bank renders them once and keeps them across worlds. */
export const SHARED_JOB_IDS: ReadonlySet<string> = new Set(['skitter', 'crawl', 'silk', 'webHum']);

/** Renders every material layer for a profile (worker or main thread), with or without the shared jobs. */
export function renderMaterialSet(profile: MaterialAudioProfile, sampleRate: number, includeShared = true): MaterialRenderResult[] {
  const out: MaterialRenderResult[] = [];
  for (const [id, job] of Object.entries(MATERIAL_JOBS)) {
    if (!includeShared && SHARED_JOB_IDS.has(id)) continue;
    for (let v = 0; v < job.variants; v++) {
      const r = job.render(profile, v + 1, sampleRate);
      if (r) out.push({ id, variant: v, left: r.left, right: r.right });
    }
  }
  return out;
}
