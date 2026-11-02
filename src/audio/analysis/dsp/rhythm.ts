import { Ring } from './smoothing';

/**
 * Onset picking on the spectral-flux signal: a local maximum above an adaptive threshold
 * (median + k·MAD of recent flux), at least `minIntervalS` after the previous onset.
 * Uses one frame of look-ahead (reports the onset one hop late, with its true time).
 */
export class OnsetDetector {
  private readonly history: Ring;
  private readonly scratch: Float32Array;
  private lastOnset = -Infinity;
  private prev = 0;
  private prevPrev = 0;
  private prevTime = 0;
  /** Decaying maximum of recent flux: decay tails of a hit can't exceed a fraction of the hit. */
  private recentPeak = 0;
  private lastPushTime = 0;

  constructor(
    private readonly k = 1.6,
    private readonly minIntervalS = 0.07,
    historyFrames = 48,
    private readonly floor = 0.004,
  ) {
    this.history = new Ring(historyFrames);
    this.scratch = new Float32Array(historyFrames);
  }

  private medianMad(): { median: number; mad: number } {
    const n = this.history.filled;
    if (n === 0) return { median: 0, mad: 0 };
    for (let i = 0; i < n; i++) this.scratch[i] = this.history.get(i);
    const view = this.scratch.subarray(0, n).sort();
    const median = view[Math.floor(n / 2)] as number;
    for (let i = 0; i < n; i++) this.scratch[i] = Math.abs((view[i] as number) - median);
    const dev = this.scratch.subarray(0, n).sort();
    return { median, mad: dev[Math.floor(n / 2)] as number };
  }

  /** Feeds one flux value; returns the onset strength (>0) for the previous frame if it was an onset. */
  push(flux: number, time: number): { onset: boolean; strength: number; time: number } {
    const { median, mad } = this.medianMad();
    const dt = Math.max(0, time - this.lastPushTime);
    this.lastPushTime = time;
    this.recentPeak = Math.max(this.recentPeak * Math.exp(-dt / 0.6), this.prev);
    const threshold = Math.max(this.floor, median + this.k * mad * 1.4826, this.recentPeak * 0.35);
    const candidate = this.prev;
    const isPeak = candidate > threshold && candidate >= this.prevPrev && candidate > flux;
    const result = { onset: false, strength: 0, time: this.prevTime };
    if (isPeak && this.prevTime - this.lastOnset >= this.minIntervalS) {
      this.lastOnset = this.prevTime;
      result.onset = true;
      result.strength = Math.min(1, (candidate - threshold) / (threshold + 1e-9));
    }
    this.history.push(flux);
    this.prevPrev = this.prev;
    this.prev = flux;
    this.prevTime = time;
    return result;
  }
}

/**
 * Tempo and beat phase from the onset-strength envelope: autocorrelation over 60–200 BPM with a
 * log-Gaussian prior around 120 BPM (resolves octave ambiguity), then a comb filter for phase.
 */
export class TempoTracker {
  private readonly envelope: Ring;
  private readonly hopSeconds: number;
  bpm = 0;
  confidence = 0;
  /** Phase of the beat grid (0..1) at the newest frame. */
  phase = 0;
  private sinceEstimate = 0;
  private period = 0;
  private lastTime = 0;

  constructor(hopSeconds: number, windowSeconds = 8) {
    this.hopSeconds = hopSeconds;
    this.envelope = new Ring(Math.round(windowSeconds / hopSeconds));
  }

  push(onsetStrength: number, time: number): void {
    this.envelope.push(onsetStrength);
    this.lastTime = time;
    this.sinceEstimate += this.hopSeconds;
    if (this.period > 0) this.phase = (this.phase + this.hopSeconds / this.period) % 1;
    if (this.sinceEstimate >= 0.5 && this.envelope.filled >= this.envelope.size * 0.5) {
      this.sinceEstimate = 0;
      this.estimate();
    }
  }

  private estimate(): void {
    const n = this.envelope.filled;
    const minLag = Math.max(2, Math.floor(60 / 200 / this.hopSeconds));
    const maxLag = Math.min(n - 2, Math.ceil(60 / 60 / this.hopSeconds));
    let mean = 0;
    for (let i = 0; i < n; i++) mean += this.envelope.get(i);
    mean /= n;
    let best = 0;
    let bestLag = 0;
    let total = 0;
    let count = 0;
    const scores: number[] = [];
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acc = 0;
      for (let i = 0; i + lag < n; i++) acc += (this.envelope.get(i) - mean) * (this.envelope.get(i + lag) - mean);
      acc /= n - lag;
      const bpm = 60 / (lag * this.hopSeconds);
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
      const score = Math.max(0, acc) * prior;
      scores.push(score);
      total += score;
      count++;
      if (score > best) {
        best = score;
        bestLag = lag;
      }
    }
    if (bestLag === 0 || best <= 0) {
      this.confidence *= 0.8;
      return;
    }
    // Parabolic interpolation around the peak for sub-hop precision.
    const i = bestLag - minLag;
    const a = scores[i - 1] ?? best;
    const c = scores[i + 1] ?? best;
    const denom = a - 2 * best + c;
    const offset = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
    const lag = bestLag + offset;
    this.period = lag * this.hopSeconds;
    this.bpm = 60 / this.period;
    const avg = total / Math.max(1, count);
    this.confidence = Math.max(0, Math.min(1, (best - avg) / (best + 1e-9)));
    this.estimatePhase(lag);
  }

  private estimatePhase(lag: number): void {
    const n = this.envelope.filled;
    const steps = Math.max(1, Math.round(lag));
    let bestOffset = 0;
    let best = -Infinity;
    for (let o = 0; o < steps; o++) {
      let s = 0;
      for (let k = 0; o + k * lag < n; k++) s += this.envelope.get(Math.round(o + k * lag));
      if (s > best) {
        best = s;
        bestOffset = o;
      }
    }
    // The newest beat happened `bestOffset` frames ago.
    this.phase = ((bestOffset * this.hopSeconds) / this.period) % 1;
    void this.lastTime;
  }
}
