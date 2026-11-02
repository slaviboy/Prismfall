import type { Engine } from '../game/core/engine';
import type { GameEvent } from '../game/core/types';
import type { Settings } from '../settings/schema';
import { AnalysisEngine, type AnalysisPath } from './analysis/AnalysisEngine';
import { emitCue, hasCueListeners } from './cues';
import { DEFAULT_TUNING } from './analysis/dsp/featureProcessor';
import { createAudioFeatures, MetronomeFeatureSource, type AudioFeatureSource, type AudioFeatures, type BeatEvent } from './analysis/features';
import { AudioEngine } from './engine/AudioEngine';
import { MusicDirector } from './music-director/MusicDirector';
import { CompositionPlayer, FileTrackPlayer, type FileTrackMeta } from './music-director/tracks';
import type { Composition } from './sequencer/composition';
import { keyRoot } from './sequencer/theory';
import { Ambience } from './sound-effects/Ambience';
import { SfxBank, type SfxId } from './sound-effects/SfxBank';

/** Publishes AudioFeatures: real analysis + music timeline while music plays, metronome otherwise. */
class FeaturesHub implements AudioFeatureSource {
  private readonly live = createAudioFeatures();
  readonly metronome = new MetronomeFeatureSource(100);
  private usingLive = false;

  constructor(private readonly system: AudioSystem) {}

  get features(): AudioFeatures {
    return this.usingLive ? this.live : this.metronome.features;
  }

  /** True while features come from music that is actually playing (not the metronome stand-in). */
  get playing(): boolean {
    return this.usingLive;
  }

  update(now: number, dt: number): readonly BeatEvent[] {
    const s = this.system;
    this.usingLive = s.engine.ready && s.director.current !== null && !s.director.current.paused;
    if (!this.usingLive) return this.metronome.update(now, dt);
    const f = this.live;
    f.beatDetected = false;
    f.beatPulse *= Math.exp(-dt * 6);
    f.barPulse *= Math.exp(-dt * 2.5);
    s.engine.updateClock();
    const beats = s.director.updateTimeline(f, now, dt);
    s.analysis.update(f, now, dt);
    return beats;
  }
}

export interface StageAudio {
  readonly id: string;
  readonly bpm: number;
  readonly beatsPerBar: number;
  readonly composition: Composition | null;
  readonly file: { readonly url: string; readonly meta: FileTrackMeta } | null;
  readonly ambience: string | null;
  readonly ambienceLevel: number;
  readonly sfxPreset: string;
}

/**
 * The game's audio: engine, music director, analysis, SFX and ambience behind one facade.
 * Gameplay never waits on audio; everything here reacts to the simulation, never drives it.
 */
export class AudioSystem {
  readonly engine = new AudioEngine();
  readonly director = new MusicDirector(this.engine);
  readonly analysis = new AnalysisEngine(this.engine);
  readonly sfx = new SfxBank(
    () => this.engine.ctx,
    () => (this.engine.ctx ? this.engine.sfx : null),
    () => (this.engine.ctx ? this.engine.ui : null),
  );
  readonly ambience = new Ambience(
    () => this.engine.ctx,
    () => (this.engine.ctx ? this.engine.ambience : null),
  );
  readonly hub = new FeaturesHub(this);
  private settings: Settings | null = null;
  private stage: StageAudio | null = null;
  private analysisKey = '';
  private dangerTimer = 0;
  private danger = false;
  private clearEnergy = 0;
  private readonly fileCache = new Map<string, AudioBuffer>();
  /** Track chosen explicitly (Music Room / mode setup); null = the stage's own music. */
  overrideTrack: StageAudio | null = null;

  get features(): AudioFeatureSource {
    return this.hub;
  }

  get unlocked(): boolean {
    return this.engine.ready;
  }

  get analysisPath(): AnalysisPath {
    return this.analysis.path;
  }

  /** Must run inside a user gesture the first time. */
  async unlock(): Promise<boolean> {
    const ok = await this.engine.unlock();
    if (!ok) return false;
    this.director.startScheduler();
    await this.configureAnalysis(true);
    if (!this.sfx.ready) await this.sfx.build(this.stage?.sfxPreset ?? 'glass', this.stage?.composition ? keyRoot(this.stage.composition.key) : 0);
    if (this.stage) await this.startStageAudio(this.overrideTrack ?? this.stage, 0.5);
    return true;
  }

  private async configureAnalysis(force = false): Promise<void> {
    const r = this.settings?.reactivity;
    const key = `${r?.analysisPath ?? 'auto'}:${r?.fftSize ?? 4096}`;
    if (!this.engine.ctx || (!force && key === this.analysisKey)) return;
    this.analysisKey = key;
    await this.analysis.setup(r?.analysisPath ?? 'auto', r?.fftSize ?? 4096);
  }

  applySettings(s: Settings): void {
    this.settings = s;
    const a = s.audio;
    this.engine.setVolumes({ enabled: a.enabled, muted: a.muted, master: a.master, music: a.music, sfx: a.sfx, ambience: a.ambience, latencyOffsetMs: a.latencyOffsetMs });
    this.director.pauseMode = a.pauseBehavior;
    this.analysis.setTuning({ ...DEFAULT_TUNING, sensitivity: 0.85 + 0.15 * s.reactivity.strength });
    void this.configureAnalysis();
  }

  /** Switches to a stage's music, ambience and sound palette. */
  async setStage(stage: StageAudio): Promise<void> {
    const changed = this.stage?.id !== stage.id;
    this.stage = stage;
    this.hub.metronome.setBpm(stage.bpm);
    this.hub.metronome.beatsPerBar = stage.beatsPerBar;
    if (!changed || !this.engine.ready) return;
    this.director.extendHorizon(2500);
    await this.sfx.build(stage.sfxPreset, stage.composition ? keyRoot(stage.composition.key) : 0);
    if (!this.overrideTrack) await this.startStageAudio(stage, 2.5);
    this.ambience.set(stage.ambience ?? '', stage.ambienceLevel);
  }

  /** Plays a specific track (Music Room, user file) or returns to the stage music with null. */
  async setOverride(track: StageAudio | null): Promise<void> {
    this.overrideTrack = track;
    const target = track ?? this.stage;
    if (target && this.engine.ready) await this.startStageAudio(target, 1.5);
  }

  private async startStageAudio(stage: StageAudio, fade: number): Promise<void> {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    if (stage.composition) {
      this.director.play(new CompositionPlayer(ctx, stage.composition, this.engine.musicPre), { fade });
    } else if (stage.file) {
      let buffer = this.fileCache.get(stage.file.url);
      if (!buffer) {
        const res = await fetch(stage.file.url);
        buffer = await ctx.decodeAudioData(await res.arrayBuffer());
        this.fileCache.set(stage.file.url, buffer);
      }
      this.director.play(new FileTrackPlayer(ctx, buffer, stage.file.meta, this.engine.musicPre, stage.id), { fade });
    } else {
      this.director.stop(fade);
    }
    if (stage.ambience) this.ambience.set(stage.ambience, stage.ambienceLevel);
  }

  pause(): void {
    this.director.pause();
  }

  resume(): void {
    this.director.resume();
  }

  play(id: SfxId, options?: Parameters<SfxBank['play']>[1]): void {
    this.sfx.play(id, options);
  }

  /** Gameplay events → sound effects, stingers and intensity. Called once per frame. */
  private readonly lastCaption = new Map<string, number>();

  /** Announces a sound for the visual cue display (rate-limited per sound). */
  private caption(text: string, tone: 'info' | 'warn' | 'music', key: string, minGapMs = 700): void {
    if (!hasCueListeners()) return;
    const now = performance.now();
    if (now - (this.lastCaption.get(key) ?? -Infinity) < minGapMs) return;
    this.lastCaption.set(key, now);
    emitCue({ kind: 'caption', text, tone });
  }

  onGameEvents(events: readonly GameEvent[], engine: Engine | null, dt: number): void {
    let hardDropped = false;
    for (const e of events) {
      switch (e.type) {
        case 'move':
          this.sfx.play('move', { gain: e.auto ? 0.55 : 0.9, pan: engine?.active ? (engine.active.x - 4) / 8 : 0 });
          break;
        case 'rotate':
          this.sfx.play('rotate');
          break;
        case 'rotateFailed':
          this.sfx.play('rotateFail', { gain: 0.6 });
          this.caption('Rotation blocked (click)', 'info', 'rotateFail');
          break;
        case 'softDrop':
          this.sfx.play('softDrop', { gain: 0.5, minGapMs: 45 });
          break;
        case 'hardDrop':
          hardDropped = true;
          this.sfx.play('hardDrop', { gain: Math.min(1, 0.65 + e.rows * 0.02) });
          break;
        case 'land':
          this.sfx.play('land', { gain: 0.7 });
          break;
        case 'lock':
          if (!hardDropped) this.sfx.play('lock');
          break;
        case 'hold':
          this.sfx.play('hold');
          break;
        case 'holdDenied':
          this.sfx.play('holdDenied');
          this.caption('Hold already used (buzz)', 'info', 'holdDenied');
          break;
        case 'lineClear': {
          const id = (['clear1', 'clear2', 'clear3', 'clear4'] as const)[Math.min(4, e.lines) - 1] ?? 'clear1';
          this.sfx.play(id);
          if (e.spin !== 'none') this.sfx.play('tspin');
          if (e.combo >= 1) {
            this.sfx.play('combo', { semitones: SfxBank.comboSemitones(e.combo), gain: 0.8 });
            this.caption(`Combo chime, rising (${e.combo})`, 'info', 'combo');
          }
          if (e.backToBack) this.sfx.play('b2b', { gain: 0.8 });
          if (e.perfectClear) {
            this.sfx.play('perfect');
            this.caption('Perfect clear fanfare', 'music', 'perfect');
          }
          const strength = Math.min(1, e.lines / 4 + (e.spin !== 'none' ? 0.3 : 0) + (e.perfectClear ? 0.5 : 0));
          // Beat-quantised musical accent layer: a short phrase in the track's key on every clear,
          // a full stinger on big ones. The SFX above always play instantly.
          if (this.settings?.audio.sfxAccentLayer ?? true) this.director.stinger(strength >= 0.75 ? strength : Math.max(0.1, strength * 0.5));
          this.clearEnergy = Math.min(1, this.clearEnergy + strength * 0.6);
          break;
        }
        case 'spinNoLines':
          this.sfx.play('tspin', { gain: 0.6 });
          if (this.settings?.audio.sfxAccentLayer ?? true) this.director.stinger(0.1);
          break;
        case 'levelUp':
          this.sfx.play('levelUp');
          this.caption('Level-up fanfare', 'music', 'levelUp');
          break;
        case 'goal':
          this.sfx.play('levelUp');
          break;
        case 'boardReset':
          this.sfx.play('clear4', { gain: 0.7 });
          break;
        case 'gameOver':
          this.sfx.play('gameOver');
          this.caption('Game over sting', 'warn', 'gameOver');
          break;
        default:
          break;
      }
    }
    if (!engine) return;
    // Music follows the game: level, combos, recent clears and danger raise intensity.
    this.clearEnergy = Math.max(0, this.clearEnergy - dt * 0.12);
    const height = engine.board.stackHeight();
    this.danger = height >= 16;
    const intensity = 0.3 + Math.min(0.35, (engine.level - 1) * 0.025) + Math.min(0.2, Math.max(0, engine.combo) * 0.04) + this.clearEnergy * 0.25 + (this.danger ? 0.15 : 0);
    this.director.setIntensity(intensity);
    if (this.danger && !engine.isOver) {
      this.dangerTimer -= dt;
      if (this.dangerTimer <= 0) {
        this.sfx.play('danger', { gain: 0.55 });
        emitCue({ kind: 'heartbeat' });
        this.dangerTimer = 1.1;
      }
    } else this.dangerTimer = 0;
  }

  get stageId(): string | null {
    return this.stage?.id ?? null;
  }

  get dangerActive(): boolean {
    return this.danger;
  }

  dispose(): void {
    this.director.dispose();
    this.analysis.teardown();
    this.ambience.stop();
    void this.engine.close();
  }
}
