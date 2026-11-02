import type { AudioFeatures, BeatEvent } from '../analysis/features';
import { emitCue, hasCueListeners } from '../cues';
import type { AudioEngine } from '../engine/AudioEngine';
import type { TrackPlayer } from './tracks';

const LOOKAHEAD_S = 0.15;
const SECTION_CAPTIONS: Partial<Record<string, string>> = {
  build: 'Music builds up',
  drop: 'Music drops',
  break: 'Music breaks down',
  bridge: 'Music changes key',
  outro: 'Music winds down',
};
const EXTENDED_S = 2.0;
const TICK_MS = 25;

/**
 * Plays music tracks on the audio clock: lookahead scheduling, bar-quantised transitions,
 * pause/resume, adaptive intensity and stingers. Publishes the musical timeline (heard time).
 */
export class MusicDirector {
  current: TrackPlayer | null = null;
  private readonly retiring = new Set<TrackPlayer>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private extendUntil = 0;
  private intensity = 0.5;
  private lastBeat = Number.NEGATIVE_INFINITY;
  private sectionIntensity = 0.5;
  private readonly beats: BeatEvent[] = [];
  pauseMode: 'duck' | 'stop' = 'duck';
  private pausedState = false;
  private lastSection = '';
  /** Where the last track change landed on the outgoing track's timeline (verification/debug). */
  lastTransition: { atTime: number; outgoingBeat: number; beatsPerBar: number } | null = null;

  constructor(private readonly engine: AudioEngine) {}

  startScheduler(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stopScheduler(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const ctx = this.engine.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const horizon = performance.now() < this.extendUntil ? EXTENDED_S : LOOKAHEAD_S;
    const until = ctx.currentTime + horizon;
    this.current?.schedule(until);
    for (const p of this.retiring) p.schedule(until);
  }

  /** Schedules far ahead now so heavy main-thread work (loading, shader compiles) can't starve audio. */
  extendHorizon(ms = 3000): void {
    this.extendUntil = performance.now() + ms;
    this.tick();
  }

  /** Starts a track; with a track already playing, the switch lands on its next bar line. */
  play(player: TrackPlayer, options: { fade?: number; quantize?: boolean } = {}): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const fade = options.fade ?? 2;
    const now = ctx.currentTime;
    let at = now + 0.12;
    const old = this.current;
    if (old && options.quantize !== false && !old.paused) {
      const beat = old.beatAt(at);
      const nextBar = Math.ceil(beat / old.beatsPerBar) * old.beatsPerBar;
      at = Math.max(at, old.audioTimeOfBeat(nextBar));
    }
    if (old && !old.paused) this.lastTransition = { atTime: at, outgoingBeat: old.beatAt(at), beatsPerBar: old.beatsPerBar };
    player.start(at);
    player.setIntensity(this.intensity);
    player.fadeTo(1, at, fade);
    if (old) this.retire(old, at, fade);
    this.current = player;
    this.lastBeat = Number.NEGATIVE_INFINITY;
    this.tick();
  }

  private retire(player: TrackPlayer, at: number, fade: number): void {
    player.fadeTo(0, at, fade);
    this.retiring.add(player);
    const delay = (at - (this.engine.ctx?.currentTime ?? 0) + fade + 0.5) * 1000;
    setTimeout(() => {
      player.stop(this.engine.ctx?.currentTime ?? 0);
      player.dispose();
      this.retiring.delete(player);
    }, Math.max(0, delay));
  }

  stop(fade = 1.2): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.current) return;
    this.retire(this.current, ctx.currentTime, fade);
    this.current = null;
  }

  setIntensity(x: number): void {
    this.intensity = Math.max(0, Math.min(1, x));
    this.current?.setIntensity(this.intensity);
  }

  /** Musical flourish for big moments, quantised to the groove. */
  stinger(strength: number): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.current || this.pausedState) return;
    this.current.stinger(ctx.currentTime + 0.03, Math.max(0, Math.min(1, strength)));
  }

  pause(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    this.pausedState = true;
    if (this.pauseMode === 'stop') this.current?.pause(ctx.currentTime);
    this.engine.setPaused(true, this.pauseMode);
  }

  resume(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    this.pausedState = false;
    this.current?.resume(ctx.currentTime);
    this.engine.setPaused(false, this.pauseMode);
  }

  get paused(): boolean {
    return this.pausedState;
  }

  /**
   * Updates the timeline part of AudioFeatures for the moment being heard at `perfNow`
   * and returns the beats crossed since the previous call.
   */
  updateTimeline(f: AudioFeatures, perfNow: number, dt: number): readonly BeatEvent[] {
    this.beats.length = 0;
    const player = this.current;
    if (!player || !this.engine.ready) return this.beats;
    const heard = this.engine.audioTimeAt(perfNow);
    const beat = player.beatAt(heard);
    if (beat < 0) return this.beats;
    const bpb = player.beatsPerBar;
    if (this.lastBeat === Number.NEGATIVE_INFINITY) this.lastBeat = Math.floor(beat) - 0.0001;
    const first = Math.floor(this.lastBeat) + 1;
    const last = Math.floor(beat);
    if (last - first < 16) {
      for (let b = first; b <= last; b++) {
        const inBar = ((b % bpb) + bpb) % bpb;
        this.beats.push({ beat: b, bar: Math.floor(b / bpb), beatInBar: inBar, downbeat: inBar === 0, time: this.engine.heardAt(player.audioTimeOfBeat(b)) });
        f.beatPulse = 1;
        f.beatDetected = true;
        if (inBar === 0) f.barPulse = 1;
      }
    }
    this.lastBeat = beat;
    f.bpm = player.bpm;
    f.beat = last;
    f.beatPhase = beat - last;
    f.bar = Math.floor(beat / bpb);
    f.beatInBar = ((last % bpb) + bpb) % bpb;
    f.barPhase = (f.beatInBar + f.beatPhase) / bpb;
    f.beatConfidence = 1;
    const section = player.section(beat);
    if (section.name !== this.lastSection) {
      // Section changes are audible structure; announce the meaningful ones for visual cues.
      const label = this.lastSection !== '' && hasCueListeners() ? SECTION_CAPTIONS[section.kind] : undefined;
      if (label) emitCue({ kind: 'caption', text: label, tone: 'music' });
      this.lastSection = section.name;
    }
    f.section = section.name;
    this.sectionIntensity += (section.intensity - this.sectionIntensity) * (1 - Math.exp(-dt / 1.5));
    f.sectionIntensity = this.sectionIntensity;
    const up = player.upcoming(beat);
    if (up) {
      const beatsTo = up.beat - beat;
      f.nextEvent = up.kind;
      f.timeToNextEvent = (beatsTo * 60) / player.bpm;
      // Wind-up over the last four bars before a drop or build.
      const window = bpb * 4;
      f.anticipation = up.kind === 'drop' || up.kind === 'build' ? Math.max(0, Math.min(1, 1 - beatsTo / window)) : 0;
    } else {
      f.nextEvent = '';
      f.timeToNextEvent = Infinity;
      f.anticipation = 0;
    }
    return this.beats;
  }

  dispose(): void {
    this.stopScheduler();
    this.current?.dispose();
    for (const p of this.retiring) p.dispose();
    this.retiring.clear();
    this.current = null;
  }
}
