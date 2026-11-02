import { createAudioFeatures } from '../analysis/features';
import { FeatureProcessor } from '../analysis/dsp/featureProcessor';
import { FRAME, FrameAnalyzer } from '../analysis/dsp/frameAnalyzer';
import { CompositionPlayer } from '../music-director/tracks';
import { arp, bassline, beat, composition, hold, melody, once, type Composition, type SectionSpec } from '../sequencer/composition';
import { SFX_IDS, SFX_PRESETS, renderSfx } from '../sound-effects/SfxBank';

/**
 * Audio acceptance lab (dev/test builds only): renders a corpus of styles offline with the real
 * synthesizer, then scores the Music Analysis Engine against the sequencer's exact note log.
 */

/** Instruments with a sharp attack: every note start is an acoustic onset (pads, strings, choir, sub and risers swell in). */
export const SHARP = new Set(['kick', 'snare', 'clap', 'hat', 'openhat', 'ride', 'shaker', 'tom', 'perc', 'crash', 'impact', 'pluck', 'bass', 'bell', 'epiano', 'mallet', 'lead']);

function section(name: string, kind: SectionSpec['kind'], bars: number, intensity: number, chords: string[], parts: SectionSpec['parts']): SectionSpec {
  return { name, kind, bars, intensity, chords, parts };
}

const BASE_INSTRUMENTS = {
  kick: { kind: 'kick', tone: 150, decay: 0.32, gain: 0.85 },
  snare: { kind: 'snare', gain: 0.5 },
  clap: { kind: 'clap', gain: 0.45 },
  hat: { kind: 'hat', gain: 0.3 },
  tom: { kind: 'tom', gain: 0.6, decay: 0.4 },
  perc: { kind: 'perc', gain: 0.5 },
  bass: { kind: 'bass', cutoff: 420, gain: 0.55 },
  sub: { kind: 'sub', gain: 0.7 },
  pad: { kind: 'pad', cutoff: 1200, gain: 0.45, reverb: 0.5 },
  strings: { kind: 'strings', cutoff: 1800, gain: 0.45, reverb: 0.5 },
  choir: { kind: 'choir', gain: 0.3, reverb: 0.6 },
  bell: { kind: 'bell', gain: 0.3, reverb: 0.5 },
  pluck: { kind: 'pluck', gain: 0.25, delay: 0.2 },
  impact: { kind: 'impact', gain: 0.6 },
  riser: { kind: 'riser', gain: 0.4 },
} as const;

function style(id: string, bpm: number, scale: Composition['scale'], sections: SectionSpec[]): Composition {
  return composition({ id, title: id, bpm, beatsPerBar: 4, key: 'D', scale, swing: 0, instruments: BASE_INSTRUMENTS, sections, loopFrom: 0 });
}

export const CORPUS: readonly { id: string; rhythmic: boolean; percussive: boolean; composition: Composition }[] = [
  { id: 'electronic', rhythmic: true, percussive: true, composition: style('electronic', 128, 'minor', [section('a', 'drop', 8, 0.9, ['i', 'VI', 'VII', 'i'], { kick: beat('x...x...x...x...'), clap: beat('....x.......x...'), hat: beat('..x...x...x...x.'), bass: bassline('x.x.x.x.x.x.x.x.', { octave: 2 }), pad: hold() })]) },
  { id: 'ambient', rhythmic: false, percussive: false, composition: style('ambient', 70, 'lydian', [section('a', 'verse', 5, 0.4, ['I', 'II'], { pad: hold({ octave: 3 }), bell: melody('5:12 3:4 2:16', { octave: 5 }) })]) },
  { id: 'orchestral', rhythmic: true, percussive: false, composition: style('orchestral', 96, 'harmonicMinor', [section('a', 'verse', 6, 0.7, ['i', 'iv', 'V', 'i'], { strings: hold({ octave: 3, voicing: 'spread' }), choir: hold({ octave: 4 }), pluck: arp({ rate: 2, octave: 4 }), tom: beat('x.......x.......') })]) },
  { id: 'cinematic', rhythmic: false, percussive: false, composition: style('cinematic', 80, 'minor', [section('a', 'build', 4, 0.8, ['i', 'VI'], { strings: hold({ octave: 3 }), riser: once({ dur: 64 }) }), section('b', 'drop', 2, 1, ['i'], { impact: once({ dur: 8 }), strings: hold({ octave: 2, voicing: 'spread' }) })]) },
  { id: 'percussion', rhythmic: true, percussive: true, composition: style('percussion', 110, 'dorian', [section('a', 'drop', 8, 0.9, ['i'], { kick: beat('x.....x...x.....'), snare: beat('....x.......x...'), tom: beat('......x......x.x'), perc: beat('x..x..x...x..x..'), hat: beat('x.x.x.x.x.x.x.x.') })]) },
  { id: 'bassHeavy', rhythmic: true, percussive: true, composition: style('bassHeavy', 140, 'phrygian', [section('a', 'drop', 9, 0.9, ['i', 'II'], { kick: beat('x...x...x...x...'), sub: bassline('x...x...x...x...', { octave: 1 }), bass: bassline('x..x..x...x..x..', { octave: 1 }) })]) },
  { id: 'slow', rhythmic: true, percussive: true, composition: style('slow', 60, 'major', [section('a', 'verse', 4, 0.6, ['I', 'vi', 'IV', 'V'], { kick: beat('x.......x.......'), snare: beat('....x.......x...'), hat: beat('x.x.x.x.x.x.x.x.'), pad: hold() })]) },
  { id: 'fast', rhythmic: true, percussive: true, composition: style('fast', 174, 'minor', [section('a', 'drop', 12, 0.95, ['i', 'VI'], { kick: beat('x.........x.....'), snare: beat('....x.......x...'), hat: beat('x.x.x.x.x.x.x.x.'), bass: bassline('x.....x...x.....', { octave: 1 }), pluck: arp({ rate: 2 }) })]) },
  {
    id: 'quietPassages',
    rhythmic: true,
    percussive: true,
    composition: style('quietPassages', 100, 'minor', [
      section('loud', 'drop', 4, 0.9, ['i'], { kick: beat('x...x...x...x...'), snare: beat('....x.......x...'), bass: bassline('x.x.x.x.x.x.x.x.') }),
      section('silent', 'break', 4, 0.1, ['i'], {}),
      section('soft', 'verse', 4, 0.3, ['i'], { pad: hold({ vel: 0.25 }) }),
      section('loud2', 'drop', 4, 0.9, ['i'], { kick: beat('x...x...x...x...'), snare: beat('....x.......x...') }),
    ]),
  },
];

export interface StyleReport {
  id: string;
  seconds: number;
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
  /** Beat-phase error after lock (s): mean and max of |predicted beat − true grid| from 10 s on. */
  phaseErrorMean: number | null;
  phaseErrorMax: number | null;
  /** Signed mean phase error (s): positive = predicted beats late. */
  phaseErrorBias: number | null;
  /** Signed phase error samples (ms), every 0.5 s from 10 s. */
  phaseSamples: number[];
  meanBands: Record<string, number>;
  maxEnergyStep: number;
  minFeature: number;
  maxFeature: number;
  silentEnergy: number | null;
  /** Raw spectral flux percentiles (calibration). */
  rawFlux: { p50: number; p95: number; max: number };
  /** Ground-truth and detected onset times (s), for diagnostics. */
  truthOnsets: number[];
  detectedOnsets: number[];
  /** Downsampled feature curves (10 Hz) for plotting. */
  curves: Record<string, number[]>;
}

const SR = 48000;
const HOP = 512;

/** Merges ground-truth onsets closer than the tolerance (simultaneous hits count once). */
export function mergeOnsets(times: number[], tol: number): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of sorted) if (out.length === 0 || t - (out[out.length - 1] as number) > tol) out.push(t);
  return out;
}

export async function renderStyle(c: Composition, seconds: number): Promise<{ buffer: AudioBuffer; truth: { inst: string; time: number }[] }> {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SR), SR);
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
  const truth: { inst: string; time: number }[] = [];
  player.onNote = (inst, time) => truth.push({ inst, time });
  player.start(0.05);
  player.fadeTo(1, 0, 0.01);
  player.schedule(seconds);
  const buffer = await ctx.startRendering();
  return { buffer, truth };
}

export function scoreStyle(id: string, c: Composition, buffer: AudioBuffer, truth: { inst: string; time: number }[], percussive: boolean): StyleReport {
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);
  let peak = 0;
  let sum = 0;
  let nan = false;
  const mono = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) {
    const a = l[i] as number;
    const b = r[i] as number;
    if (!Number.isFinite(a) || !Number.isFinite(b)) nan = true;
    peak = Math.max(peak, Math.abs(a), Math.abs(b));
    sum += (a + b) / 2;
    mono[i] = (a + b) / 2;
  }
  const analyzer = new FrameAnalyzer(SR, 4096, 2048, HOP);
  const processor = new FeatureProcessor(HOP / SR);
  processor.onsetLatencyS = (2048 + HOP) / 2 / SR;
  const f = createAudioFeatures();
  const frame = new Float32Array(FRAME.size);
  const detected: number[] = [];
  let lastCount = 0;
  const keys = ['subBass', 'bass', 'lowMid', 'mid', 'highMid', 'treble', 'overallEnergy', 'spectralFlux', 'transientIntensity'] as const;
  const sums: Record<string, number> = {};
  const curves: Record<string, number[]> = {};
  for (const k of keys) {
    sums[k] = 0;
    curves[k] = [];
  }
  const fluxes: number[] = [];
  let frames = 0;
  let maxStep = 0;
  let prevEnergy = 0;
  let minF = Infinity;
  let maxF = -Infinity;
  let silentSum = 0;
  let silentFrames = 0;
  const phaseErrs: number[] = [];
  const phaseSigned: number[] = [];
  const spbTrue = 60 / c.bpm;
  let nextPhaseCheck = 10;
  for (let i = 0; i + HOP <= mono.length; i += HOP) {
    const t = (i + HOP) / SR;
    analyzer.process(mono.subarray(i, i + HOP), frame);
    processor.process(frame, t, f);
    if (processor.onsetCount > lastCount) {
      lastCount = processor.onsetCount;
      detected.push(processor.lastOnsetTime);
    }
    frames++;
    fluxes.push(processor.rawFlux);
    for (const k of keys) {
      const v = f[k];
      sums[k] = (sums[k] as number) + v;
      minF = Math.min(minF, v);
      maxF = Math.max(maxF, v);
    }
    if (t >= nextPhaseCheck && processor.tempo.bpm > 0) {
      nextPhaseCheck += 0.5;
      const period = 60 / processor.tempo.bpm;
      const lastBeat = t - processor.tempo.phase * period;
      // Judge alignment on the true grid (or its subdivision for a double-tempo estimate), so
      // octave errors count only as alignment; never modulo the estimated period, which drifts.
      const grid = period < spbTrue ? spbTrue / Math.max(1, Math.round(spbTrue / period)) : spbTrue;
      const off = (((lastBeat - 0.05) % grid) + grid) % grid;
      phaseErrs.push(Math.min(off, grid - off));
      phaseSigned.push(off < grid / 2 ? off : off - grid);
    }
    maxStep = Math.max(maxStep, Math.abs(f.overallEnergy - prevEnergy));
    prevEnergy = f.overallEnergy;
    if (frames % 9 === 0) for (const k of keys) curves[k]?.push(Math.round(f[k] * 1000) / 1000);
    // The quiet-passages style is silent between bars 4 and 8 (allow 1.2 s of release).
    if (id === 'quietPassages') {
      const bar = (t - 0.05) / ((60 / c.bpm) * 4);
      if (bar > 5.2 && bar < 8) {
        silentSum += f.overallEnergy;
        silentFrames++;
      }
    }
  }
  const meanBands: Record<string, number> = {};
  for (const k of keys) meanBands[k] = (sums[k] as number) / Math.max(1, frames);
  fluxes.sort((a, b) => a - b);
  const pct = (q: number): number => fluxes[Math.min(fluxes.length - 1, Math.floor(q * fluxes.length))] ?? 0;
  let gt: number[] = [];
  let onsetF: number | null = null;
  let precision: number | null = null;
  let recall: number | null = null;
  if (percussive) {
    gt = mergeOnsets(truth.filter((e) => SHARP.has(c.instruments[e.inst]?.kind ?? '') && e.time < buffer.duration - 0.1).map((e) => e.time), 0.05);
    const tp = gt.filter((g) => detected.some((d) => Math.abs(d - g) <= 0.05)).length;
    const fp = detected.filter((d) => !gt.some((g) => Math.abs(d - g) <= 0.05)).length;
    precision = tp / Math.max(1, tp + fp);
    recall = tp / Math.max(1, gt.length);
    onsetF = (2 * precision * recall) / Math.max(1e-9, precision + recall);
  }
  const est = processor.tempo.bpm;
  const ratio = est / c.bpm;
  const octave = [0.5, 1, 2].reduce((a, b) => (Math.abs(ratio - b) < Math.abs(ratio - a) ? b : a), 1);
  return {
    id,
    seconds: buffer.duration,
    peakDb: 20 * Math.log10(Math.max(1e-9, peak)),
    dc: sum / l.length,
    nan,
    onsetF,
    onsetPrecision: precision,
    onsetRecall: recall,
    bpm: c.bpm,
    estimatedBpm: est,
    octaveNormalizedError: est > 0 ? Math.abs(est / octave - c.bpm) / c.bpm : 1,
    octaveError: octave !== 1,
    tempoConfidence: processor.tempo.confidence,
    phaseErrorMean: phaseErrs.length ? phaseErrs.reduce((a, b) => a + b, 0) / phaseErrs.length : null,
    phaseErrorMax: phaseErrs.length ? Math.max(...phaseErrs) : null,
    phaseErrorBias: phaseSigned.length ? phaseSigned.reduce((a, b) => a + b, 0) / phaseSigned.length : null,
    phaseSamples: phaseSigned.map((x) => Math.round(x * 1000)),
    meanBands,
    maxEnergyStep: maxStep,
    minFeature: minF,
    maxFeature: maxF,
    silentEnergy: silentFrames > 0 ? silentSum / silentFrames : null,
    rawFlux: { p50: pct(0.5), p95: pct(0.95), max: pct(1) },
    truthOnsets: gt.map((t) => Math.round(t * 1000) / 1000),
    detectedOnsets: detected.map((t) => Math.round(t * 1000) / 1000),
    curves,
  };
}

/** Renders and scores every corpus style. */
export async function runCorpus(seconds = 16): Promise<StyleReport[]> {
  const out: StyleReport[] = [];
  for (const s of CORPUS) {
    const { buffer, truth } = await renderStyle(s.composition, seconds);
    out.push(scoreStyle(s.id, s.composition, buffer, truth, s.percussive));
  }
  return out;
}

/** Peak/NaN/DC checks of every SFX in every preset. */
export async function checkSfx(presets: readonly string[]): Promise<{ id: string; preset: string; peakDb: number; nan: boolean }[]> {
  const out: { id: string; preset: string; peakDb: number; nan: boolean }[] = [];
  for (const preset of presets) {
    for (const id of SFX_IDS) {
      const buf = await renderSfx(id, preset, 2, SR);
      let peak = 0;
      let nan = false;
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < d.length; i++) {
          const v = d[i] as number;
          if (!Number.isFinite(v)) nan = true;
          peak = Math.max(peak, Math.abs(v));
        }
      }
      out.push({ id, preset, peakDb: 20 * Math.log10(Math.max(1e-9, peak)), nan });
    }
  }
  return out;
}

/** Peak/DC/NaN checks of shipped stage compositions (first 24 s through the limiter). */
export async function checkCompositions(list: readonly Composition[], seconds = 24): Promise<{ id: string; peakDb: number; dc: number; nan: boolean }[]> {
  const out: { id: string; peakDb: number; dc: number; nan: boolean }[] = [];
  for (const c of list) {
    const { buffer } = await renderStyle(c, seconds);
    const l = buffer.getChannelData(0);
    let peak = 0;
    let sum = 0;
    let nan = false;
    for (let i = 0; i < l.length; i++) {
      const v = l[i] as number;
      if (!Number.isFinite(v)) nan = true;
      peak = Math.max(peak, Math.abs(v));
      sum += v;
    }
    out.push({ id: c.id, peakDb: 20 * Math.log10(Math.max(1e-9, peak)), dc: sum / l.length, nan });
  }
  return out;
}

/** Every composition track shipped with a valid stage (for mix checks). */
export async function shippedCompositions(): Promise<Composition[]> {
  const { availableStages, loadMusicModule } = await import('../../stages/registry');
  const out: Composition[] = [];
  for (const info of availableStages()) {
    for (const t of info.manifest?.music.tracks ?? []) {
      if (t.kind === 'composition') out.push((await loadMusicModule(info, t.src)) as Composition);
    }
  }
  return out;
}

export function sfxPresetNames(): string[] {
  return Object.keys(SFX_PRESETS);
}
