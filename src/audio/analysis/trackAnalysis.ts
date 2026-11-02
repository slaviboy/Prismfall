import type { SectionKind } from '../sequencer/composition';
import { FRAME, FrameAnalyzer } from './dsp/frameAnalyzer';

/** Beat metadata derived from a whole audio file (the player's own music). */
export interface TrackAnalysis {
  readonly bpm: number;
  /** Confidence of the tempo (0..1); low for music without a steady pulse. */
  readonly confidence: number;
  /** Seconds from the file start to the first beat of the grid. */
  readonly offset: number;
  readonly duration: number;
  readonly sections: readonly { readonly name: string; readonly kind: SectionKind; readonly startBar: number; readonly intensity: number }[];
}

const HOP = 512;
const BEATS_PER_BAR = 4;

/** Downmixes channels to mono (average). */
export function downmix(channels: readonly Float32Array[]): Float32Array {
  const n = channels[0]?.length ?? 0;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] = (out[i] as number) + (ch[i] as number) / channels.length;
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/**
 * Analyses a whole track offline with the same DSP core as the live engine: spectral-flux onset
 * envelope → tempo by autocorrelation (log-Gaussian prior around 120 BPM, refined on a four-beat
 * lag) → beat offset by an accent comb → sections by novelty between four-bar blocks of band
 * energy, labelled by energy and its trend.
 */
export function analyzeTrack(mono: Float32Array, sampleRate: number, onProgress?: (fraction: number) => void): TrackAnalysis {
  const hopS = HOP / sampleRate;
  const analyzer = new FrameAnalyzer(sampleRate, 4096, 2048, HOP);
  const frame = new Float32Array(FRAME.size);
  const frames = Math.floor(mono.length / HOP);
  const flux = new Float32Array(frames);
  const energy = new Float32Array(frames);
  const low = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    analyzer.process(mono.subarray(f * HOP, (f + 1) * HOP), frame);
    flux[f] = frame[FRAME.flux] as number;
    energy[f] = Math.pow(10, (frame[FRAME.rms] as number) / 20);
    low[f] = Math.pow(10, Math.max(frame[FRAME.bands] as number, frame[FRAME.bands + 1] as number) / 20);
    if (onProgress && f % 2000 === 0) onProgress((f / frames) * 0.8);
  }
  const duration = mono.length / sampleRate;

  // Onset-strength envelope: flux above a local median (removes the steady texture).
  const env = new Float32Array(frames);
  const win = Math.round(0.4 / hopS);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, f - win); k <= Math.min(frames - 1, f + win); k += 4) {
      sum += flux[k] as number;
      n++;
    }
    env[f] = Math.max(0, (flux[f] as number) - (sum / Math.max(1, n)) * 1.2);
  }

  // Tempo: autocorrelation over 60..200 BPM with the same prior as the live tracker.
  let mean = 0;
  for (let f = 0; f < frames; f++) mean += env[f] as number;
  mean /= Math.max(1, frames);
  const acf = (lag: number): number => {
    let acc = 0;
    for (let f = 0; f + lag < frames; f++) acc += ((env[f] as number) - mean) * ((env[f + lag] as number) - mean);
    return acc / Math.max(1, frames - lag);
  };
  const minLag = Math.floor(60 / 200 / hopS);
  const maxLag = Math.ceil(60 / 60 / hopS);
  let best = 0;
  let bestLag = 0;
  let total = 0;
  let count = 0;
  for (let lag = minLag; lag <= maxLag && lag < frames - 2; lag++) {
    const bpm = 60 / (lag * hopS);
    const score = Math.max(0, acf(lag)) * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    total += score;
    count++;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  onProgress?.(0.9);
  if (bestLag === 0 || best <= 0) return { bpm: 120, confidence: 0, offset: 0, duration, sections: [{ name: 'main', kind: 'verse', startBar: 0, intensity: 0.6 }] };
  // Refine on the four-beat lag: interpolating there divides the lag error by four.
  const centre = bestLag * 4;
  let lagRefined = bestLag;
  if (centre < frames / 2) {
    let bl = centre;
    let bv = -Infinity;
    for (let l = centre - 4; l <= centre + 4; l++) {
      const v = acf(l);
      if (v > bv) {
        bv = v;
        bl = l;
      }
    }
    const a = acf(bl - 1);
    const c = acf(bl + 1);
    const denom = a - 2 * bv + c;
    const off = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
    const refined = (bl + off) / 4;
    if (Math.abs(refined / bestLag - 1) < 0.03) lagRefined = refined;
  }
  const period = lagRefined * hopS;
  const bpm = 60 / period;
  const confidence = Math.max(0, Math.min(1, (best - total / Math.max(1, count)) / best));

  // Beat offset: the grid phase whose beats collect the most onset strength. Kicks and bass
  // define the beat but make little short-window flux, so the low band's own attack (its
  // amplitude rise per frame from the long window) is added, shifted to line up with the short
  // window. Linear, not dB: from silence even a hat's faint low end is a huge rise in dB.
  let maxRise = 1e-9;
  for (let f = 1; f < frames; f++) maxRise = Math.max(maxRise, (low[f] as number) - (low[f - 1] as number));
  let maxEnv = 1e-9;
  for (let f = 0; f < frames; f++) maxEnv = Math.max(maxEnv, env[f] as number);
  const shift = Math.round((4096 - 2048) / 2 / HOP);
  const strength = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    const lowOnset = Math.max(0, ((low[f] as number) - (low[f - 1] as number)) / maxRise);
    const target = f - shift;
    if (target >= 0) strength[target] = (strength[target] as number) + 2 * lowOnset;
    strength[f] = (strength[f] as number) + (env[f] as number) / maxEnv;
  }
  const steps = 160;
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * period;
    let score = 0;
    for (let t = phase; t < duration; t += period) {
      const f = Math.round(t / hopS);
      for (let d = -2; d <= 2; d++) {
        const k = f + d;
        if (k >= 0 && k < frames) score += (strength[k] as number) * (d === 0 ? 1 : 0.5);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  // Measured on synthetic grooves at 90-140 BPM: frame stamps (window end) and the aligned
  // low-band attacks balance out, so the best phase already sits on the attacks.
  const offset = bestPhase;

  // Sections: four-bar blocks of RMS energy and low-band share; boundaries at large changes.
  const barS = period * BEATS_PER_BAR;
  const bars = Math.max(1, Math.floor((duration - offset) / barS));
  const barEnergy: number[] = [];
  for (let b = 0; b < bars; b++) {
    const f0 = Math.floor((offset + b * barS) / hopS);
    const f1 = Math.min(frames, Math.floor((offset + (b + 1) * barS) / hopS));
    let e = 0;
    for (let f = f0; f < f1; f++) e += energy[f] as number;
    barEnergy.push(e / Math.max(1, f1 - f0));
  }
  const maxE = Math.max(...barEnergy, 1e-9);
  const norm = barEnergy.map((e) => e / maxE);
  const block = 4;
  const starts = [0];
  for (let b = block; b < bars - block; b += block) {
    const prev = norm.slice(b - block, b).reduce((x, y) => x + y, 0) / block;
    const next = norm.slice(b, b + block).reduce((x, y) => x + y, 0) / block;
    if (Math.abs(next - prev) > 0.18 && b - (starts[starts.length - 1] as number) >= 8) starts.push(b);
  }
  const med = median(norm);
  const sections = starts.map((start, i) => {
    const end = starts[i + 1] ?? bars;
    const e = norm.slice(start, end).reduce((x, y) => x + y, 0) / Math.max(1, end - start);
    const prevE = i > 0 ? norm.slice(starts[i - 1] as number, start).reduce((x, y) => x + y, 0) / Math.max(1, start - (starts[i - 1] as number)) : e;
    let kind: SectionKind = 'verse';
    if (i === 0 && starts.length > 1 && e < med) kind = 'intro';
    else if (i === starts.length - 1 && starts.length > 2 && e < med) kind = 'outro';
    else if (e > med * 1.15 && e > prevE) kind = 'drop';
    else if (e < med * 0.75) kind = 'break';
    else if (e > prevE * 1.1) kind = 'build';
    return { name: `${kind}-${i + 1}`, kind, startBar: start, intensity: Math.max(0.2, Math.min(1, e)) };
  });
  onProgress?.(1);
  return { bpm, confidence, offset, duration, sections };
}
