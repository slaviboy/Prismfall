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

  /** Defaults tuned on the acceptance corpus (see AUDIO_ANALYSIS.md). */
  constructor(
    private readonly k = 3.5,
    private readonly minIntervalS = 0.07,
    historyFrames = 48,
    private readonly floor = 0.006,
    /** A peak must exceed this fraction of the decaying recent maximum (rejects decay tails). */
    private readonly peakRatio = 0.3,
    private readonly peakDecayS = 0.6,
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
    this.recentPeak = Math.max(this.recentPeak * Math.exp(-dt / this.peakDecayS), this.prev);
    const threshold = Math.max(this.floor, median + this.k * mad * 1.4826, this.recentPeak * this.peakRatio);
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
 * Tempo and beat phase from the onset envelope (one impulse per detected onset).
 *
 * Tempo: autocorrelation over 60–200 BPM with a log-Gaussian prior around 120 BPM (resolves
 * octave ambiguity). Impulses beat continuous flux on the acceptance corpus: flux keeps the
 * texture of sustained parts, which pulls arpeggiated and ambient material off the beat.
 *
 * Phase: a comb over accent-weighted impulses (recent beats weigh most, so a small tempo error
 * doesn't skew the newest beat), plus a bonus where low-band (kick) and mid-band (snare) accents
 * alternate on adjacent beats, gives a coarse lock. The alternation cue is what resolves
 * syncopated grooves whose off-beat kicks outweigh the backbeat; a phase-locked loop then nudges the phase
 * on every accented onset near a predicted beat. A comb result far from the PLL phase must be
 * confirmed twice before it is accepted, so syncopation can't flip the grid by half a beat.
 */
export class TempoTracker {
  private readonly envelope: Ring;
  /** Onset impulses weighted by their accent: drives the phase comb (on-beat kicks and snares, not off-beat hats). */
  private readonly accents: Ring;
  private readonly lowAccents: Ring;
  private readonly midAccents: Ring;
  private readonly hopSeconds: number;
  private readonly scores: Float32Array;
  bpm = 0;
  confidence = 0;
  /** Phase of the beat grid (0..1) at the newest frame. */
  phase = 0;
  /** Delay between a beat and its impulse in the envelope (detection latency). */
  latencyS = 0;
  private sinceEstimate = 0;
  private period = 0;
  private locked = false;
  private pendingJump = 0;
  private pendingTempo = 0;
  /** Consecutive provisional comb estimates that agreed (the lock forms after LOCK_AGREEMENTS). */
  private agreements = 0;
  private meanAccent = 1;

  constructor(hopSeconds: number, windowSeconds = 8) {
    this.hopSeconds = hopSeconds;
    this.envelope = new Ring(Math.round(windowSeconds / hopSeconds));
    this.accents = new Ring(this.envelope.size);
    this.lowAccents = new Ring(this.envelope.size);
    this.midAccents = new Ring(this.envelope.size);
    this.scores = new Float32Array(Math.ceil(60 / 60 / hopSeconds) + 2);
  }

  /**
   * `onset` is 1 on a detected onset (else 0); `accent` its perceptual weight, `low` and `mid`
   * the kick-band and snare-band parts of that weight.
   */
  push(onset: number, time: number, accent = onset, low = 0, mid = 0): void {
    void time;
    this.envelope.push(onset);
    this.accents.push(onset * accent);
    this.lowAccents.push(onset * low);
    this.midAccents.push(onset * mid);
    this.sinceEstimate += this.hopSeconds;
    if (this.period > 0) this.phase = (this.phase + this.hopSeconds / this.period) % 1;
    if (onset > 0 && this.locked) this.correct(accent);
    if (this.sinceEstimate >= 0.5 && this.envelope.filled >= this.envelope.size * 0.5) {
      this.sinceEstimate = 0;
      this.estimate();
    }
  }

  /** PLL step: pull the phase toward an accented onset that lands near a predicted beat. */
  private correct(accent: number): void {
    this.meanAccent += (accent - this.meanAccent) * 0.05;
    const at = this.phase - this.latencyS / this.period;
    const e = at - Math.round(at);
    if (Math.abs(e) > 0.2) return;
    const w = accent / (accent + this.meanAccent);
    this.phase = (((this.phase - PLL_GAIN * w * e) % 1) + 1) % 1;
  }

  private estimate(): void {
    const n = this.envelope.filled;
    // Coast through rests: without recent onsets there is nothing new to estimate from.
    let recent = 0;
    const restFrames = Math.min(n, Math.round(REST_S / this.hopSeconds));
    for (let i = 0; i < restFrames; i++) recent += this.envelope.get(i);
    if (recent === 0) {
      this.confidence *= 0.9;
      return;
    }
    const minLag = Math.max(2, Math.floor(60 / 200 / this.hopSeconds));
    const maxLag = Math.min(n - 2, Math.ceil(60 / 60 / this.hopSeconds));
    let mean = 0;
    for (let i = 0; i < n; i++) mean += this.envelope.get(i);
    mean /= n;
    let best = 0;
    let bestLag = 0;
    let total = 0;
    let count = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acc = 0;
      for (let i = 0; i + lag < n; i++) acc += (this.envelope.get(i) - mean) * (this.envelope.get(i + lag) - mean);
      acc /= n - lag;
      const bpm = 60 / (lag * this.hopSeconds);
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
      const score = Math.max(0, acc) * prior;
      this.scores[lag - minLag] = score;
      total += score;
      count++;
      if (score > best) {
        best = score;
        bestLag = lag;
      }
    }
    if (bestLag === 0 || best <= 0) {
      this.confidence *= 0.8;
      if (this.confidence < 0.1) this.locked = false;
      return;
    }
    // Tempo hysteresis: near an octave boundary the prior is nearly flat, so a competing tempo
    // must clearly beat the current one in consecutive estimates before the lock follows it.
    if (this.locked && this.period > 0) {
      const curLag = Math.round(this.period / this.hopSeconds);
      if (curLag - 2 >= minLag && curLag + 2 <= maxLag && Math.abs(bestLag / curLag - 1) > 0.03) {
        let localLag = curLag;
        let local = this.scores[curLag - minLag] as number;
        for (let l = curLag - 2; l <= curLag + 2; l++) {
          const v = this.scores[l - minLag] as number;
          if (v > local) {
            local = v;
            localLag = l;
          }
        }
        if (local > 0 && (best < TEMPO_MARGIN * local || ++this.pendingTempo < 2)) {
          if (best < TEMPO_MARGIN * local) this.pendingTempo = 0;
          bestLag = localLag;
          best = local;
        } else {
          this.pendingTempo = 0;
        }
      } else {
        this.pendingTempo = 0;
      }
    }
    // Parabolic interpolation around the peak for sub-hop precision.
    const i = bestLag - minLag;
    const a = i > 0 ? (this.scores[i - 1] as number) : best;
    const c = bestLag < maxLag ? (this.scores[i + 1] as number) : best;
    const denom = a - 2 * best + c;
    const offset = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
    const lag = this.refineLag(bestLag + offset, n, mean);
    const period = lag * this.hopSeconds;
    if (this.period > 0) {
      // A real tempo change drops the lock; refinements and octave switches keep it (the beats
      // of one octave are a subset of the other's).
      const ratio = period / this.period;
      const octave = Math.abs(ratio - 2) < 0.06 || Math.abs(ratio - 0.5) < 0.015;
      if (Math.abs(ratio - 1) > 0.03 && !octave) {
        this.locked = false;
        this.agreements = 0;
      }
      // Keep the time since the last beat, not the phase fraction.
      this.phase = ((this.phase * this.period) / period) % 1;
    }
    this.period = period;
    this.bpm = 60 / period;
    const avg = total / Math.max(1, count);
    this.confidence = Math.max(0, Math.min(1, (best - avg) / (best + 1e-9)));
    this.estimatePhase(lag);
  }

  /**
   * Refines a beat lag on its largest multiple (up to four beats) that fits twice in the window:
   * interpolating the autocorrelation peak there divides the lag error by the multiple.
   */
  private refineLag(lag: number, n: number, mean: number): number {
    let m = 4;
    while (m > 1 && m * lag > n * 0.5) m--;
    if (m === 1) return lag;
    const centre = Math.round(m * lag);
    const acfAt = (l: number): number => {
      let acc = 0;
      for (let i = 0; i + l < n; i++) acc += (this.envelope.get(i) - mean) * (this.envelope.get(i + l) - mean);
      return acc / (n - l);
    };
    let bestL = centre;
    let best = -Infinity;
    for (let l = centre - 2; l <= centre + 2; l++) {
      const v = acfAt(l);
      if (v > best) {
        best = v;
        bestL = l;
      }
    }
    if (best <= 0) return lag;
    const a = acfAt(bestL - 1);
    const c = acfAt(bestL + 1);
    const denom = a - 2 * best + c;
    const offset = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
    const refined = (bestL + offset) / m;
    // Keep the refinement only if it stays close to the beat-level estimate.
    return Math.abs(refined / lag - 1) < 0.02 ? refined : lag;
  }

  /** Ring value at `i` through a triangular ±1 frame kernel (impulses jitter by a hop; symmetric, so no tie bias). */
  private static tri(r: Ring, i: number, n: number): number {
    return r.get(i) + 0.5 * ((i > 0 ? r.get(i - 1) : 0) + (i + 1 < n ? r.get(i + 1) : 0));
  }

  /** Recency-weighted comb score of the beat grid whose newest beat is `o` frames ago. */
  private combScore(o: number, lag: number, n: number): number {
    let s = 0;
    let w = 1;
    let prevLow = 0;
    let prevMid = 0;
    for (let k = 0; o + k * lag < n; k++, w *= COMB_DECAY) {
      const i = Math.round(o + k * lag);
      const lowRaw = TempoTracker.tri(this.lowAccents, i, n);
      const midRaw = TempoTracker.tri(this.midAccents, i, n);
      // Kick-like (low-dominant) on one beat and snare-like (mid-dominant) on the next, in either
      // order, marks the grid. Dominance, not presence: a bass note with both doesn't alternate.
      const low = Math.max(0, lowRaw - midRaw);
      const mid = Math.max(0, midRaw - lowRaw);
      const alt = k > 0 ? Math.sqrt(low * prevMid) + Math.sqrt(mid * prevLow) : 0;
      s += w * (TempoTracker.tri(this.accents, i, n) + ALTERNATION_WEIGHT * alt);
      prevLow = low;
      prevMid = mid;
    }
    return s;
  }

  private estimatePhase(lag: number): void {
    const n = this.envelope.filled;
    const steps = Math.max(1, Math.round(lag));
    let bestOffset = 0;
    let best = -Infinity;
    for (let o = 0; o < steps; o++) {
      const s = this.combScore(o, lag, n);
      if (s > best) {
        best = s;
        bestOffset = o;
      }
    }
    if (best <= 0) return;
    // The newest beat was detected `bestOffset` frames ago, `latencyS` after it sounded.
    const comb = ((bestOffset * this.hopSeconds + this.latencyS) / this.period) % 1;
    let d = comb - this.phase;
    d -= Math.round(d);
    if (!this.locked) {
      // Provisional: follow the comb until consecutive estimates agree, so an early, noisy
      // preference (only a few seconds of onsets) can't decide the lock on its own.
      this.agreements = Math.abs(d) < 0.08 ? this.agreements + 1 : 0;
      this.phase = comb;
      if (this.agreements >= LOCK_AGREEMENTS) {
        this.locked = true;
        this.pendingJump = 0;
        this.agreements = 0;
      }
      return;
    }
    if (Math.abs(d) <= 0.25) {
      this.pendingJump = 0;
      this.phase = (((this.phase + d * 0.2) % 1) + 1) % 1;
      return;
    }
    // A different grid must clearly beat the current one, in consecutive estimates, before the
    // lock moves: syncopated accents can briefly favour the off-beat.
    const current = Math.round(((this.phase * this.period - this.latencyS) / this.hopSeconds + steps * 4) % steps);
    if (best > JUMP_MARGIN * this.combScore(current, lag, n) && ++this.pendingJump >= JUMP_CONFIRMATIONS) {
      this.phase = comb;
      this.pendingJump = 0;
    } else if (best <= JUMP_MARGIN * this.combScore(current, lag, n)) {
      this.pendingJump = 0;
    }
  }
}

/** Fraction of a beat-phase error corrected per accented onset. */
const PLL_GAIN = 0.25;
/** Per-beat weight decay of older beats in the phase comb. */
const COMB_DECAY = 0.85;
/** Consecutive agreeing comb estimates (0.5 s apart) before the phase locks. */
const LOCK_AGREEMENTS = 3;
/** Weight of the kick/snare alternation cue relative to plain accents in the phase comb. */
const ALTERNATION_WEIGHT = 1;
/** A competing beat grid must score this much higher than the locked one... */
const JUMP_MARGIN = 1.15;
/** ...in this many consecutive estimates (0.5 s apart) before the lock moves. */
const JUMP_CONFIRMATIONS = 3;
/** A competing tempo must score this much higher than the locked one (twice in a row). */
const TEMPO_MARGIN = 1.15;
/** Without onsets for this long, tempo and phase coast instead of re-estimating. */
const REST_S = 2;
