import { AnalyserFrameBuilder } from '../analysis/dsp/analyserFrame';
import { FeatureProcessor } from '../analysis/dsp/featureProcessor';
import { FRAME, FrameAnalyzer } from '../analysis/dsp/frameAnalyzer';
import { createAudioFeatures } from '../analysis/features';
import type { Composition } from '../sequencer/composition';
import { CORPUS, SHARP, mergeOnsets, renderStyle } from './AudioLab';

/**
 * Measures the two analysis paths (worklet vs. AnalyserNode) and the long FFT sizes against the
 * acceptance corpus, so the defaults are chosen by measurement (see AUDIO_ANALYSIS.md).
 */

const SR = 48000;
const HOP = 512;

export interface PathRun {
  style: string;
  /** e.g. "worklet 4096" or "analyser 2048 @60 Hz". */
  config: string;
  onsetF: number | null;
  tempoError: number;
  octaveError: boolean;
  phaseErrorMaxMs: number | null;
  /** Cost per analysis update: main thread for the analyser, audio thread for the worklet. */
  microsPerUpdate: number;
  updatesPerSecond: number;
}

export interface FftTradeoff {
  longSize: number;
  /** Sub-bass band level relative to the bass band for a pure 100 Hz tone (dB; lower = cleaner). */
  subLeakageDb: number;
  /** Time for the bass band to come within 3 dB of its steady level after an 80 Hz tone starts (ms). */
  bassRiseMs: number;
}

type Truth = { inst: string; time: number }[];

/** Ground-truth onsets of sharp-attack instruments (simultaneous hits merged). */
function sharpTruth(c: Composition, truth: Truth, duration: number): number[] {
  return mergeOnsets(truth.filter((e) => SHARP.has(c.instruments[e.inst]?.kind ?? '') && e.time < duration - 0.1).map((e) => e.time), 0.05);
}

function onsetF(detected: number[], gt: number[]): number {
  const tp = gt.filter((g) => detected.some((d) => Math.abs(d - g) <= 0.05)).length;
  const fp = detected.filter((d) => !gt.some((g) => Math.abs(d - g) <= 0.05)).length;
  const p = tp / Math.max(1, tp + fp);
  const r = tp / Math.max(1, gt.length);
  return (2 * p * r) / Math.max(1e-9, p + r);
}

/** Beat-phase error samples every 0.5 s from 10 s, judged on the true grid (or its subdivision). */
class PhaseProbe {
  private next = 10;
  private readonly errs: number[] = [];
  constructor(private readonly bpm: number) {}
  sample(t: number, tempo: { bpm: number; phase: number }): void {
    if (t < this.next || tempo.bpm <= 0) return;
    this.next += 0.5;
    const spb = 60 / this.bpm;
    const period = 60 / tempo.bpm;
    const grid = period < spb ? spb / Math.max(1, Math.round(spb / period)) : spb;
    const off = (((t - tempo.phase * period - 0.05) % grid) + grid) % grid;
    this.errs.push(Math.min(off, grid - off) * 1000);
  }
  get max(): number | null {
    return this.errs.length ? Math.max(...this.errs) : null;
  }
}

/** Collects detections and cost for one run. */
class RunRecorder {
  readonly detected: number[] = [];
  readonly probe: PhaseProbe;
  private last = 0;
  costMs = 0;
  updates = 0;
  constructor(readonly c: Composition) {
    this.probe = new PhaseProbe(c.bpm);
  }
  after(proc: FeatureProcessor, t: number, costMs: number): void {
    this.costMs += costMs;
    this.updates++;
    if (proc.onsetCount > this.last) {
      this.last = proc.onsetCount;
      this.detected.push(proc.lastOnsetTime);
    }
    this.probe.sample(t, proc.tempo);
  }
  finish(style: string, config: string, percussive: boolean, gt: number[], proc: FeatureProcessor, seconds: number): PathRun {
    const est = proc.tempo.bpm;
    const ratio = est / this.c.bpm;
    const octave = [0.5, 1, 2].reduce((a, b) => (Math.abs(ratio - b) < Math.abs(ratio - a) ? b : a), 1);
    return {
      style,
      config,
      onsetF: percussive ? onsetF(this.detected, gt) : null,
      tempoError: est > 0 ? Math.abs(est / octave - this.c.bpm) / this.c.bpm : 1,
      octaveError: octave !== 1,
      phaseErrorMaxMs: this.probe.max,
      microsPerUpdate: (this.costMs * 1000) / Math.max(1, this.updates),
      updatesPerSecond: this.updates / seconds,
    };
  }
}

/** Worklet path: the DSP core at a fixed 512-sample hop with a given long FFT size. */
function workletRun(id: string, c: Composition, buffer: AudioBuffer, truth: Truth, percussive: boolean, longSize: number): PathRun {
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);
  const mono = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) mono[i] = ((l[i] as number) + (r[i] as number)) / 2;
  const analyzer = new FrameAnalyzer(SR, longSize, 2048, HOP);
  const proc = new FeatureProcessor(HOP / SR);
  proc.onsetLatencyS = (2048 + HOP) / 2 / SR;
  const f = createAudioFeatures();
  const frame = new Float32Array(FRAME.size);
  const rec = new RunRecorder(c);
  for (let i = 0; i + HOP <= mono.length; i += HOP) {
    const t = (i + HOP) / SR;
    const a = performance.now();
    analyzer.process(mono.subarray(i, i + HOP), frame);
    proc.process(frame, t, f);
    rec.after(proc, t, performance.now() - a);
  }
  return rec.finish(id, `worklet ${longSize}`, percussive, sharpTruth(c, truth, buffer.duration), proc, buffer.duration);
}

/** Analyser path: a real AnalyserNode read once per render frame (offline, via suspend/resume). */
async function analyserRun(id: string, c: Composition, buffer: AudioBuffer, truth: Truth, percussive: boolean, fftSize: number, fps: number): Promise<PathRun> {
  const ctx = new OfflineAudioContext(1, buffer.length, SR);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const an = ctx.createAnalyser();
  an.fftSize = fftSize;
  an.smoothingTimeConstant = 0;
  an.minDecibels = -110;
  an.maxDecibels = -10;
  const sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(an).connect(sink).connect(ctx.destination);
  src.start(0);
  const builder = new AnalyserFrameBuilder(SR, fftSize);
  const proc = new FeatureProcessor(HOP / SR);
  proc.onsetLatencyS = fftSize / 2 / SR;
  const f = createAudioFeatures();
  const frame = new Float32Array(FRAME.size);
  const freq = new Float32Array(an.frequencyBinCount);
  const time = new Float32Array(fftSize);
  const rec = new RunRecorder(c);
  const quantum = 128 / SR;
  let prevT = 0;
  for (let k = 1; k / fps < buffer.duration - 2 * quantum; k++) {
    const t = Math.round(k / fps / quantum) * quantum;
    void ctx.suspend(t).then(() => {
      const a = performance.now();
      an.getFloatFrequencyData(freq);
      an.getFloatTimeDomainData(time);
      builder.build(freq, time, frame);
      proc.process(frame, t, f, Math.max(1 / 480, t - prevT));
      prevT = t;
      rec.after(proc, t, performance.now() - a);
      void ctx.resume();
    });
  }
  await ctx.startRendering();
  return rec.finish(id, `analyser ${fftSize} @${fps} Hz`, percussive, sharpTruth(c, truth, buffer.duration), proc, buffer.duration);
}

/** What the long FFT size trades: low-band separation against response time. */
export function fftTradeoff(longSize: number): FftTradeoff {
  const tone = (hz: number, seconds: number, start: number): Float32Array => {
    const out = new Float32Array(Math.round(seconds * SR));
    for (let i = Math.round(start * SR); i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
    return out;
  };
  const run = (signal: Float32Array, cb: (frame: Float32Array, t: number) => void): void => {
    const a = new FrameAnalyzer(SR, longSize, 2048, HOP);
    const frame = new Float32Array(FRAME.size);
    for (let i = 0; i + HOP <= signal.length; i += HOP) {
      a.process(signal.subarray(i, i + HOP), frame);
      cb(frame, (i + HOP) / SR);
    }
  };
  let sub = 0;
  let bass = 0;
  run(tone(100, 1, 0), (fr) => {
    sub = fr[FRAME.bands] as number;
    bass = fr[FRAME.bands + 1] as number;
  });
  const levels: { t: number; db: number }[] = [];
  run(tone(80, 1.5, 0.5), (fr, t) => levels.push({ t, db: fr[FRAME.bands + 1] as number }));
  const steady = levels[levels.length - 1]?.db ?? 0;
  const reached = levels.find((x) => x.t > 0.5 && x.db >= steady - 3);
  return { longSize, subLeakageDb: sub - bass, bassRiseMs: reached ? (reached.t - 0.5) * 1000 : Number.NaN };
}

/** Profiles worklet vs. analyser paths and long FFT sizes over the rhythmic corpus styles. */
export async function profilePaths(seconds = 16): Promise<{ runs: PathRun[]; fft: FftTradeoff[] }> {
  const runs: PathRun[] = [];
  for (const s of CORPUS.filter((x) => x.rhythmic)) {
    const { buffer, truth } = await renderStyle(s.composition, seconds);
    for (const longSize of [4096, 2048]) runs.push(workletRun(s.id, s.composition, buffer, truth, s.percussive, longSize));
    for (const fftSize of [4096, 2048]) for (const fps of [60, 144]) runs.push(await analyserRun(s.id, s.composition, buffer, truth, s.percussive, fftSize, fps));
  }
  return { runs, fft: [fftTradeoff(4096), fftTradeoff(2048)] };
}
