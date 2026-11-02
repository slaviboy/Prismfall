import type { AudioEngine } from '../engine/AudioEngine';

export interface CalibrationResult {
  /** Suggested latency offset (ms): how much later than reported the clicks were heard. */
  offsetMs: number;
  /** Median absolute deviation of the taps (ms): a measure of how steady they were. */
  spreadMs: number;
  /** Taps that matched a click. */
  count: number;
}

/** Taps for the first clicks are ignored while the player finds the pulse. */
export const WARMUP_CLICKS = 4;
const MIN_TAPS = 8;

/** Robust offset estimate from tap-minus-click deltas (ms): median and median absolute deviation. */
export function estimateOffset(deltas: readonly number[]): CalibrationResult | null {
  if (deltas.length < MIN_TAPS) return null;
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  const dev = sorted.map((d) => Math.abs(d - median)).sort((a, b) => a - b);
  return { offsetMs: Math.round(median), spreadMs: Math.round(dev[Math.floor(dev.length / 2)] as number), count: deltas.length };
}

/**
 * Tap-along latency calibration: schedules clicks on the audio clock and compares the player's
 * taps (input timestamps) with the moments the clicks are heard according to the audio clock
 * mapping, excluding the current user offset. The median difference is the offset to apply.
 */
export class LatencyCalibrator {
  readonly clicks: number;
  readonly intervalS: number;
  private times: number[] = [];
  private readonly deltas: number[] = [];
  private nodes: AudioNode[] = [];
  private startedAt = 0;

  constructor(
    private readonly engine: AudioEngine,
    /** The user offset currently applied inside `engine.heardAt` (ms). */
    private readonly currentOffsetMs: number,
    bpm = 100,
    clicks = 20,
  ) {
    this.clicks = clicks;
    this.intervalS = 60 / bpm;
  }

  /** Schedules the click track; returns false when audio isn't running. */
  start(): boolean {
    const ctx = this.engine.ctx;
    if (!ctx || ctx.state !== 'running') return false;
    const first = ctx.currentTime + 0.8;
    this.times = Array.from({ length: this.clicks }, (_, i) => first + i * this.intervalS);
    this.startedAt = performance.now();
    for (const [i, t] of this.times.entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = i % 4 === 0 ? 1760 : 1320;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.5, t + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      osc.connect(gain).connect(this.engine.ui);
      osc.start(t);
      osc.stop(t + 0.08);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
      this.nodes.push(osc);
    }
    return true;
  }

  /** Moment (performance.now ms, without the user offset) at which click `i` is heard. */
  private heard(i: number): number {
    return this.engine.heardAt(this.times[i] as number) - this.currentOffsetMs;
  }

  /** Index of the click currently sounding (or most recently sounded), -1 before the first. */
  currentClick(now = performance.now()): number {
    let idx = -1;
    for (let i = 0; i < this.times.length; i++) if (this.heard(i) <= now + 1) idx = i;
    return idx;
  }

  get finished(): boolean {
    return this.times.length > 0 && performance.now() > this.heard(this.times.length - 1) + this.intervalS * 1000 * 0.6;
  }

  /** Registers a tap (performance.now-compatible timestamp). Returns true if it matched a click. */
  tap(time: number): boolean {
    if (time < this.startedAt) return false;
    let best = -1;
    let bestDelta = Infinity;
    for (let i = WARMUP_CLICKS; i < this.times.length; i++) {
      const d = time - this.heard(i);
      if (Math.abs(d) < Math.abs(bestDelta)) {
        bestDelta = d;
        best = i;
      }
    }
    if (best < 0 || Math.abs(bestDelta) > (this.intervalS * 1000) / 2) return false;
    this.deltas.push(bestDelta);
    return true;
  }

  get taps(): number {
    return this.deltas.length;
  }

  result(): CalibrationResult | null {
    return estimateOffset(this.deltas);
  }

  stop(): void {
    const now = this.engine.ctx?.currentTime ?? 0;
    for (const n of this.nodes) {
      try {
        (n as OscillatorNode).stop(now);
      } catch {
        // already stopped
      }
    }
    this.nodes = [];
  }
}
