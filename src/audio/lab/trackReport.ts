import { createAudioFeatures } from '../analysis/features';
import { FeatureProcessor } from '../analysis/dsp/featureProcessor';
import { FRAME, FrameAnalyzer } from '../analysis/dsp/frameAnalyzer';
import { CompositionPlayer } from '../music-director/tracks';
import { expandComposition, type Composition } from '../sequencer/composition';

/**
 * Whole-track mix and reactivity measurements (dev/test builds only). A track's first pass, plus
 * a few bars past the loop point, is rendered offline in chunks by the real synthesizer through
 * the game's limiter, then analysed by the same DSP core the game uses.
 */

const SR = 48000;
const HOP = 512;
const BANDS = ['subBass', 'bass', 'lowMid', 'mid', 'highMid', 'treble'] as const;
const FEATURES = ['overallEnergy', 'spectralFlux', 'spectralCentroid', 'transientIntensity', ...BANDS] as const;

export interface TrackSectionStats {
  readonly name: string;
  readonly kind: string;
  /** Composed intensity (metadata). */
  readonly intensity: number;
  readonly startS: number;
  readonly endS: number;
  readonly rmsDb: number;
  /** Gated integrated loudness of the section (LUFS, BS.1770 K-weighting). */
  readonly lufs: number;
  readonly peakDb: number;
  readonly onsetsPerSec: number;
  /** Mean band power (dBFS) over the section, sub to treble. */
  readonly bandsDb: readonly number[];
  /** Mean normalised analysis features (0..1) over the section. */
  readonly features: Readonly<Record<string, number>>;
}

export interface TrackReport {
  readonly id: string;
  readonly title: string;
  readonly bpm: number;
  readonly beatsPerBar: number;
  readonly key: string;
  readonly scale: string;
  /** Rendered length (first pass plus the loop seam). */
  readonly seconds: number;
  /** Length of the first pass and of the looping part. */
  readonly passSeconds: number;
  readonly loopSeconds: number;
  readonly peakDb: number;
  readonly dc: number;
  readonly nan: boolean;
  readonly rmsDb: number;
  readonly lufs: number;
  /** Loudest and quietest 3 s short-term loudness (LUFS). */
  readonly maxShortTerm: number;
  readonly minShortTerm: number;
  /** Mean band power (dBFS) and each band's share of the total power. */
  readonly bandsDb: readonly number[];
  readonly bandShare: readonly number[];
  /** Detected tempo, confidence and the ratio to the track tempo (1 = exact, 0.5/2 = octave, 1/3 = compound pulse). */
  readonly estimatedBpm: number;
  readonly tempoConfidence: number;
  readonly tempoRatio: number;
  /** Median beat-phase error against the true grid after 10 s (ms). */
  readonly phaseErrorMs: number | null;
  readonly onsetsPerSec: number;
  readonly sections: readonly TrackSectionStats[];
  /** Section-to-section spread: loudest minus quietest section (LU), brightest minus darkest centroid. */
  readonly sectionLoudnessRange: number;
  readonly sectionCentroidRange: number;
  /** Wall-clock render and analysis time. */
  readonly renderMs: number;
}

/** BS.1770 K-weighting at 48 kHz (high shelf + RLB high-pass), streaming with persistent state. */
class KWeight {
  private readonly s = new Float64Array(8);
  private static readonly B1 = [1.53512485958697, -2.69169618940638, 1.19839281085285];
  private static readonly A1 = [-1.69065929318241, 0.73248077421585];
  private static readonly B2 = [1, -2, 1];
  private static readonly A2 = [-1.99004745483398, 0.99007225036621];

  process(x: number): number {
    const s = this.s;
    const [b0, b1, b2] = KWeight.B1 as [number, number, number];
    const [a1, a2] = KWeight.A1 as [number, number];
    const y1 = b0 * x + b1 * (s[0] as number) + b2 * (s[1] as number) - a1 * (s[2] as number) - a2 * (s[3] as number);
    s[1] = s[0] as number;
    s[0] = x;
    s[3] = s[2] as number;
    s[2] = y1;
    const [c0, c1, c2] = KWeight.B2 as [number, number, number];
    const [d1, d2] = KWeight.A2 as [number, number];
    const y2 = c0 * y1 + c1 * (s[4] as number) + c2 * (s[5] as number) - d1 * (s[6] as number) - d2 * (s[7] as number);
    s[5] = s[4] as number;
    s[4] = y1;
    s[7] = s[6] as number;
    s[6] = y2;
    return y2;
  }
}

/** Gated integrated loudness from 100 ms K-weighted mean squares (400 ms blocks, 75 % overlap). */
function integratedLufs(sub: readonly number[]): number {
  const blocks: number[] = [];
  for (let i = 0; i + 4 <= sub.length; i++) blocks.push(((sub[i] as number) + (sub[i + 1] as number) + (sub[i + 2] as number) + (sub[i + 3] as number)) / 4);
  const lufs = (z: number): number => -0.691 + 10 * Math.log10(Math.max(1e-12, z));
  const abs = blocks.filter((z) => lufs(z) > -70);
  if (abs.length === 0) return -70;
  const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((z) => lufs(z) > rel);
  return lufs(gated.reduce((a, b) => a + b, 0) / Math.max(1, gated.length));
}

/** Renders `seconds` of a composition from `fromBeat`, with `preroll` seconds of lead-in so long notes are already sounding. */
export async function renderSpan(c: Composition, fromBeat: number, seconds: number, preroll: number, intensity = 0.5): Promise<AudioBuffer> {
  const spb = 60 / c.bpm;
  const ctx = new OfflineAudioContext(2, Math.ceil((preroll + seconds) * SR), SR);
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 4;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.2;
  const fader = ctx.createGain();
  fader.gain.value = 0.64;
  fader.connect(limiter).connect(ctx.destination);
  const player = new CompositionPlayer(ctx, c, fader);
  player.setIntensity(intensity);
  // Beat `fromBeat` lands `preroll` seconds in; the player skips notes before audio time 0.
  player.start(preroll - fromBeat * spb);
  player.fadeTo(1, 0, 0.001);
  player.schedule(preroll + seconds);
  return ctx.startRendering();
}

/** The first pass's sections in seconds. */
export function sectionTimeline(c: Composition): { name: string; kind: string; intensity: number; startS: number; endS: number }[] {
  const spb = 60 / c.bpm;
  let beat = 0;
  return expandComposition(c).map((s) => {
    const start = beat;
    beat += s.beats;
    return { name: s.spec.name, kind: s.spec.kind, intensity: s.spec.intensity, startS: start * spb, endS: beat * spb };
  });
}

/**
 * Renders and measures a whole track. `intensity` is the game's music intensity (0.5 = the
 * menu/default; layers gated above it stay silent, as in play at that intensity).
 */
export async function measureTrack(c: Composition, opts: { intensity?: number; seamBars?: number; chunkSeconds?: number; maxSeconds?: number; parallel?: number } = {}): Promise<TrackReport> {
  const started = performance.now();
  const spb = 60 / c.bpm;
  const timeline = sectionTimeline(c);
  const passS = timeline[timeline.length - 1]?.endS ?? 0;
  const loopS = passS - (timeline[c.loopFrom]?.startS ?? 0);
  const totalS = Math.min(opts.maxSeconds ?? Infinity, passS + (opts.seamBars ?? 4) * c.beatsPerBar * spb);
  const chunkBeats = Math.max(c.beatsPerBar, Math.round((opts.chunkSeconds ?? 24) / spb / c.beatsPerBar) * c.beatsPerBar);
  const totalBeats = totalS / spb;
  const preroll = 8;

  const analyzer = new FrameAnalyzer(SR, 4096, 2048, HOP);
  const processor = new FeatureProcessor(HOP / SR);
  processor.onsetLatencyS = (2048 + HOP) / 2 / SR;
  const f = createAudioFeatures();
  const frame = new Float32Array(FRAME.size);
  const hop = new Float32Array(HOP);
  let hopFill = 0;
  let t = 0;
  const kl = new KWeight();
  const kr = new KWeight();
  const subMs: number[] = [];
  let subAcc = 0;
  let subN = 0;
  let peak = 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  let nan = false;
  const bandPow = BANDS.map(() => 0);
  let frames = 0;
  let lastOnsets = 0;
  const onsetTimes: number[] = [];
  const phaseErrs: number[] = [];
  let nextPhaseCheck = 10;
  type Acc = { sumSq: number; n: number; peak: number; frames: number; bandPow: number[]; feat: Record<string, number> };
  const secAcc: Acc[] = timeline.map(() => ({ sumSq: 0, n: 0, peak: 0, frames: 0, bandPow: BANDS.map(() => 0), feat: Object.fromEntries(FEATURES.map((k) => [k, 0])) }));
  const sectionAt = (time: number): number => {
    for (let i = 0; i < timeline.length; i++) if (time < (timeline[i]?.endS ?? 0)) return i;
    return -1;
  };

  // Chunks render concurrently (each offline context has its own audio thread) and are analysed in order.
  const chunks: { fromBeat: number; toBeat: number; pre: number }[] = [];
  for (let fromBeat = 0; fromBeat < totalBeats - 1e-6; fromBeat += chunkBeats) chunks.push({ fromBeat, toBeat: Math.min(totalBeats, fromBeat + chunkBeats), pre: fromBeat === 0 ? 0 : preroll });
  const pending: (Promise<AudioBuffer> | undefined)[] = [];
  const parallel = Math.max(1, opts.parallel ?? 4);
  const launch = (i: number): void => {
    const ch = chunks[i];
    if (ch && !pending[i]) pending[i] = renderSpan(c, ch.fromBeat, (ch.toBeat - ch.fromBeat) * spb, ch.pre, opts.intensity ?? 0.5);
  };
  for (let i = 0; i < parallel; i++) launch(i);
  for (let ci = 0; ci < chunks.length; ci++) {
    const { fromBeat, toBeat, pre } = chunks[ci] as (typeof chunks)[number];
    const buffer = await (pending[ci] as Promise<AudioBuffer>);
    pending[ci] = undefined;
    launch(ci + parallel);
    const l = buffer.getChannelData(0);
    const r = buffer.getChannelData(1);
    const first = Math.round(pre * SR);
    const last = Math.min(l.length, first + Math.round((toBeat - fromBeat) * spb * SR));
    for (let i = first; i < last; i++) {
      const a = l[i] as number;
      const b = r[i] as number;
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        nan = true;
        continue;
      }
      const time = t + (i - first) / SR;
      const m = (a + b) / 2;
      const absPeak = Math.max(Math.abs(a), Math.abs(b));
      peak = Math.max(peak, absPeak);
      sum += m;
      sumSq += m * m;
      n++;
      const ka = kl.process(a);
      const kb = kr.process(b);
      subAcc += ka * ka + kb * kb;
      if (++subN === SR / 10) {
        subMs.push(subAcc / subN);
        subAcc = 0;
        subN = 0;
      }
      const si = sectionAt(time);
      const acc = si >= 0 ? secAcc[si] : undefined;
      if (acc) {
        acc.sumSq += m * m;
        acc.n++;
        acc.peak = Math.max(acc.peak, absPeak);
      }
      hop[hopFill++] = m;
      if (hopFill === HOP) {
        hopFill = 0;
        const ht = time + 1 / SR;
        analyzer.process(hop, frame);
        processor.process(frame, ht, f);
        frames++;
        for (let k = 0; k < BANDS.length; k++) bandPow[k] = (bandPow[k] as number) + Math.pow(10, (frame[FRAME.bands + k] as number) / 10);
        if (processor.onsetCount > lastOnsets) {
          lastOnsets = processor.onsetCount;
          onsetTimes.push(processor.lastOnsetTime);
        }
        const hs = sectionAt(ht);
        const hacc = hs >= 0 ? secAcc[hs] : undefined;
        if (hacc) {
          hacc.frames++;
          for (let k = 0; k < BANDS.length; k++) hacc.bandPow[k] = (hacc.bandPow[k] as number) + Math.pow(10, (frame[FRAME.bands + k] as number) / 10);
          for (const key of FEATURES) hacc.feat[key] = (hacc.feat[key] as number) + (f[key] as number);
        }
        if (ht >= nextPhaseCheck && processor.tempo.bpm > 0) {
          nextPhaseCheck += 0.5;
          const period = 60 / processor.tempo.bpm;
          const lastBeat = ht - processor.tempo.phase * period;
          const grid = period < spb ? spb / Math.max(1, Math.round(spb / period)) : spb;
          const off = ((lastBeat % grid) + grid) % grid;
          phaseErrs.push(Math.min(off, grid - off));
        }
      }
    }
    t += (last - first) / SR;
  }

  const db = (x: number): number => 10 * Math.log10(Math.max(1e-12, x));
  const bandMean = bandPow.map((p) => p / Math.max(1, frames));
  const bandTotal = bandMean.reduce((a, b) => a + b, 0);
  // Section loudness from the 100 ms K-weighted mean squares inside each section.
  const sections: TrackSectionStats[] = timeline.map((s, i) => {
    const acc = secAcc[i] as Acc;
    const from = Math.ceil(s.startS * 10);
    const to = Math.min(subMs.length, Math.floor(s.endS * 10));
    const onsets = onsetTimes.filter((o) => o >= s.startS && o < s.endS).length;
    return {
      ...s,
      rmsDb: db(acc.sumSq / Math.max(1, acc.n)),
      lufs: integratedLufs(subMs.slice(from, to)),
      peakDb: 20 * Math.log10(Math.max(1e-9, acc.peak)),
      onsetsPerSec: onsets / Math.max(0.001, s.endS - s.startS),
      bandsDb: acc.bandPow.map((p) => db(p / Math.max(1, acc.frames))),
      features: Object.fromEntries(FEATURES.map((k) => [k, Math.round(((acc.feat[k] as number) / Math.max(1, acc.frames)) * 1000) / 1000])),
    };
  });
  const shortTerm: number[] = [];
  for (let i = 0; i + 30 <= subMs.length; i += 5) shortTerm.push(-0.691 + db(subMs.slice(i, i + 30).reduce((a, b) => a + b, 0) / 30));
  const est = processor.tempo.bpm;
  const ratio = est / c.bpm;
  const ratios = [1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3];
  const nearest = ratios.reduce((a, b) => (Math.abs(ratio - b) < Math.abs(ratio - a) ? b : a), 1);
  const sortedErr = [...phaseErrs].sort((a, b) => a - b);
  const lufsBySection = sections.map((s) => s.lufs).filter((x) => x > -69);
  const centroids = sections.map((s) => s.features.spectralCentroid ?? 0);
  return {
    id: c.id,
    title: c.title,
    bpm: c.bpm,
    beatsPerBar: c.beatsPerBar,
    key: c.key,
    scale: c.scale,
    seconds: t,
    passSeconds: passS,
    loopSeconds: loopS,
    peakDb: 20 * Math.log10(Math.max(1e-9, peak)),
    dc: sum / Math.max(1, n),
    nan,
    rmsDb: db(sumSq / Math.max(1, n)),
    lufs: integratedLufs(subMs),
    maxShortTerm: shortTerm.length ? Math.max(...shortTerm) : -70,
    minShortTerm: shortTerm.length ? Math.min(...shortTerm) : -70,
    bandsDb: bandMean.map(db),
    bandShare: bandMean.map((p) => Math.round((p / Math.max(1e-12, bandTotal)) * 1000) / 1000),
    estimatedBpm: est,
    tempoConfidence: processor.tempo.confidence,
    tempoRatio: Math.abs(ratio - nearest) < 0.03 ? nearest : ratio,
    phaseErrorMs: sortedErr.length ? (sortedErr[Math.floor(sortedErr.length / 2)] as number) * 1000 : null,
    onsetsPerSec: onsetTimes.length / Math.max(0.001, t),
    sections,
    sectionLoudnessRange: lufsBySection.length ? Math.max(...lufsBySection) - Math.min(...lufsBySection) : 0,
    sectionCentroidRange: Math.max(...centroids) - Math.min(...centroids),
    renderMs: performance.now() - started,
  };
}
