/**
 * Web Audio engine: context lifecycle, bus graph and the audio↔performance clock mapping.
 *
 *   music sources → musicPre ─┬→ analysisTap (pre-fader, for the Music Analysis Engine)
 *                             └→ musicFader → pauseFilter → master
 *   sfx → sfxFader → master     ambience → ambFader → master     ui → uiFader → master
 *   master → masterFader (volume, mute) → limiter → destination
 */
export interface AudioVolumes {
  enabled: boolean;
  muted: boolean;
  master: number;
  music: number;
  sfx: number;
  ambience: number;
  latencyOffsetMs: number;
}

const RAMP = 0.04;

/** Perceptual volume curve (slider 0..1 → gain). */
export function sliderToGain(v: number): number {
  const x = Math.max(0, Math.min(1, v));
  return x * x;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  musicPre!: GainNode;
  analysisTap!: GainNode;
  private musicFader!: GainNode;
  private pauseFilter!: BiquadFilterNode;
  private pauseGain!: GainNode;
  sfx!: GainNode;
  ambience!: GainNode;
  ui!: GainNode;
  private master!: GainNode;
  private masterFader!: GainNode;
  private limiter!: DynamicsCompressorNode;
  /** Post-limiter meter: what the player actually hears (tests, dashboard). */
  outputMeter!: AnalyserNode;
  private volumes: AudioVolumes = { enabled: true, muted: false, master: 0.8, music: 0.8, sfx: 0.75, ambience: 0.6, latencyOffsetMs: 0 };
  /** Smoothed offset (ms) such that heardAt(audioTime) = audioTime*1000 + offset. */
  private clockOffset: number | null = null;
  private readonly listeners = new Set<(state: AudioContextState | 'none') => void>();
  ducked = false;
  /** Music and ambience pulled down while the latency calibration clicks play. */
  private calibrating = false;
  private meterBuf: Float32Array<ArrayBuffer> | null = null;

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get state(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none';
  }

  onStateChange(l: (state: AudioContextState | 'none') => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Creates (if needed) and resumes the context. Must be called from a user gesture the first time. */
  async unlock(): Promise<boolean> {
    if (!this.volumes.enabled) return false;
    if (!this.ctx) this.create();
    const ctx = this.ctx as AudioContext;
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch (err) {
        console.warn('[audio] resume failed', err);
      }
    }
    return ctx.state === 'running';
  }

  private create(): void {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const gain = (v = 1): GainNode => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    this.musicPre = gain();
    this.analysisTap = gain();
    this.musicFader = gain();
    this.pauseFilter = ctx.createBiquadFilter();
    this.pauseFilter.type = 'lowpass';
    this.pauseFilter.frequency.value = 20000;
    this.pauseFilter.Q.value = 0.5;
    this.pauseGain = gain();
    this.sfx = gain();
    this.ambience = gain();
    this.ui = gain();
    this.master = gain();
    this.masterFader = gain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.2;

    this.musicPre.connect(this.analysisTap);
    this.musicPre.connect(this.musicFader);
    this.musicFader.connect(this.pauseFilter);
    this.pauseFilter.connect(this.pauseGain);
    this.pauseGain.connect(this.master);
    this.sfx.connect(this.master);
    this.ambience.connect(this.master);
    this.ui.connect(this.master);
    this.master.connect(this.masterFader);
    this.masterFader.connect(this.limiter);
    this.limiter.connect(ctx.destination);
    this.outputMeter = ctx.createAnalyser();
    this.outputMeter.fftSize = 2048;
    this.limiter.connect(this.outputMeter);
    ctx.addEventListener('statechange', () => this.listeners.forEach((l) => l(ctx.state)));
    this.applyVolumes(true);
  }

  setVolumes(v: AudioVolumes): void {
    const enabledChanged = v.enabled !== this.volumes.enabled;
    this.volumes = { ...v };
    this.applyVolumes(false);
    if (enabledChanged && this.ctx) {
      if (!v.enabled) void this.ctx.suspend();
      else void this.ctx.resume();
    }
  }

  private applyVolumes(immediate: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const v = this.volumes;
    const set = (node: GainNode, value: number): void => {
      if (immediate) node.gain.value = value;
      else node.gain.setTargetAtTime(value, ctx.currentTime, RAMP);
    };
    set(this.masterFader, v.muted || !v.enabled ? 0 : sliderToGain(v.master));
    const bed = this.calibrating ? 0.15 : 1;
    set(this.musicFader, sliderToGain(v.music) * bed);
    set(this.sfx, sliderToGain(v.sfx));
    // UI sounds (and calibration clicks) stay audible even with effects turned right down.
    set(this.ui, Math.max(this.calibrating ? 0.5 : 0, sliderToGain(v.sfx) * 0.8));
    set(this.ambience, sliderToGain(v.ambience) * bed);
  }

  setCalibrating(on: boolean): void {
    this.calibrating = on;
    this.applyVolumes(false);
  }

  /** Pause treatment: muffle and lower the music (duck) or silence it. */
  setPaused(paused: boolean, mode: 'duck' | 'stop'): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.ducked = paused;
    this.pauseFilter.frequency.setTargetAtTime(paused && mode === 'duck' ? 700 : 20000, t, 0.12);
    this.pauseGain.gain.setTargetAtTime(paused ? (mode === 'duck' ? 0.45 : 0) : 1, t, 0.1);
  }

  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  get outputLatency(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    return (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
  }

  /** Updates the audio→performance clock mapping (call once per frame). */
  updateClock(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    let offset: number;
    const stamp = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    if (stamp && stamp.contextTime !== undefined && stamp.performanceTime !== undefined && stamp.performanceTime > 0) {
      offset = stamp.performanceTime - stamp.contextTime * 1000;
    } else {
      offset = performance.now() - ctx.currentTime * 1000 + this.outputLatency * 1000;
    }
    // currentTime advances in ~10 ms steps on some platforms: smooth the mapping.
    this.clockOffset = this.clockOffset === null || Math.abs(offset - this.clockOffset) > 80 ? offset : this.clockOffset + (offset - this.clockOffset) * 0.05;
  }

  /** performance.now() time at which an audio-clock time is heard (includes user calibration). */
  heardAt(audioTime: number): number {
    return audioTime * 1000 + (this.clockOffset ?? 0) + this.volumes.latencyOffsetMs;
  }

  /** Audio-clock time that is being heard at a performance time. */
  audioTimeAt(perfMs: number): number {
    return (perfMs - (this.clockOffset ?? 0) - this.volumes.latencyOffsetMs) / 1000;
  }

  /** RMS level (linear) of the audible output right now. */
  outputRms(): number {
    if (!this.ctx || !this.outputMeter) return 0;
    if (!this.meterBuf || this.meterBuf.length !== this.outputMeter.fftSize) this.meterBuf = new Float32Array(this.outputMeter.fftSize);
    const buf = this.meterBuf;
    this.outputMeter.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += (buf[i] as number) ** 2;
    return Math.sqrt(sum / buf.length);
  }

  async close(): Promise<void> {
    await this.ctx?.close();
    this.ctx = null;
  }
}
