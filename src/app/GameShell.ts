import { emitCue, hasCueListeners } from '../audio/cues';
import type { GameAction, GameEvent } from '../game/core/types';
import type { Engine } from '../game/core/engine';
import { GAME_ACTIONS } from '../game/core/types';
import { getMode, highScoreKey, type ModeId } from '../game/modes/modes';
import { InputManager } from '../input/inputManager';
import type { ActionEvent } from '../input/types';
import type { InputAction } from '../settings/schema';
import { getSettings, handlingFromSettings, replaceSettings, settingsStore, subscribeSettings, updateSection } from '../settings/store';
import { openSaveBackend, requestPersistentStorage, type SaveBackend } from '../storage/backend';
import {
  HighScoreRepository,
  ProgressRepository,
  ReplayRepository,
  SettingsRepository,
  StatsRepository,
  type HighScoreEntry,
  type Progress,
} from '../storage/repositories';
import { paletteFor } from '../config/palette';
import { DebugView } from '../rendering/debug/DebugView';
import { RenderSystem } from '../rendering/renderer/RenderSystem';
import type { GameView } from '../rendering/view';
import { GameSession, ReplaySession, type SessionConfig } from './GameSession';
import { appStore, goBack, hudStore, navigate, pushCallout, toast, type GameResults } from './stores';
import { progressStore } from './progressStore';
import { describeEvents } from './feedback';
import { choosePlacement } from '../game/ai/bot';
import { registerBuiltinComponents } from '../rendering/environments/builtins';
import { registerBuiltinEffects } from '../rendering/fx/lineClearEffects';
import { StageManager } from '../stages/StageManager';
import { availableStages, getStage } from '../stages/registry';
import { isStageUnlocked } from '../stages/progression';
import { getCampaign } from '../stages/registry';
import { planVoyage, VoyageRun, type VoyageDifficulty, type VoyageLeg } from '../stages/campaign';
import type { AudioFeatureSource, BeatEvent } from '../audio/analysis/features';
import { AudioSystem, type StageAudio } from '../audio/AudioSystem';
import type { Composition } from '../audio/sequencer/composition';
import { loadMusicModule, readTrackMeta, resolveAsset, type StageInfo } from '../stages/registry';
import { UserMusicLibrary } from '../audio/library/UserMusic';
import type { FileTrackMeta } from '../audio/music-director/tracks';

/** A playable track: a world's own music or one of the player's files. */
export interface CatalogTrack {
  /** "stage:<stageId>:<trackId>" or "user:<id>". */
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly bpm: number;
  readonly source: 'world' | 'user';
}

export interface StartOptions {
  readonly modeId: ModeId;
  readonly variantId: string;
  readonly stageId: string;
  readonly seed?: number;
  /** Voyage: where the run starts and how hard it is. */
  readonly voyage?: { readonly areaId: string; readonly difficulty: VoyageDifficulty };
}

type FrameListener = (now: number, dt: number) => void;

/**
 * Orchestrates every subsystem and owns the single requestAnimationFrame loop.
 * React reads state from stores and calls the command methods below.
 */
export class GameShell {
  readonly input = new InputManager();
  backend!: SaveBackend;
  settingsRepo!: SettingsRepository;
  progressRepo!: ProgressRepository;
  highScores!: HighScoreRepository;
  replays!: ReplayRepository;
  statsRepo!: StatsRepository;

  view: GameView | null = null;
  renderSystem: RenderSystem | null = null;
  stageManager: StageManager | null = null;
  readonly audio = new AudioSystem();
  /** Music features: real analysis while music plays, metronome stand-in otherwise. */
  get features(): AudioFeatureSource {
    return this.audio.features;
  }
  private readonly pendingBeats: BeatEvent[] = [];
  private lastRender = 0;
  session: GameSession | null = null;
  replaySession: ReplaySession | null = null;
  private lastOptions: StartOptions | null = null;
  /** The player's own music files. */
  readonly userMusic = new UserMusicLibrary(() => this.backend ?? null);
  /** Track playing instead of the world's music (Music Room, free-play choice); null = world music. */
  currentTrackId: string | null = null;
  /** Voyage run in progress (null in other modes). */
  voyage: VoyageRun | null = null;
  private readonly voyagePreloaded = new Set<string>();
  private voyageTimer: ReturnType<typeof setTimeout> | null = null;
  private finishing = false;
  private rafId = 0;
  private lastFrame = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly frameListeners = new Set<FrameListener>();
  private readonly pendingEvents: GameEvent[] = [];
  private readonly eventListeners = new Set<(events: readonly GameEvent[]) => void>();

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.backend = await openSaveBackend();
    this.settingsRepo = new SettingsRepository(this.backend);
    this.progressRepo = new ProgressRepository(this.backend);
    this.highScores = new HighScoreRepository(this.backend);
    this.replays = new ReplayRepository(this.backend);
    this.statsRepo = new StatsRepository(this.backend);
    appStore.setState({ storageKind: this.backend.kind });
    if (this.backend.kind !== 'indexeddb') toast('Saving to temporary storage — progress may not persist in this browser mode.', 'warning', 6000);
    void requestPersistentStorage();

    const { settings, recovered } = await this.settingsRepo.load();
    replaceSettings(settings, true);
    if (recovered) toast('Saved settings were unreadable and have been reset. A backup was kept.', 'warning', 6000);
    progressStore.setState({ progress: await this.progressRepo.load(), lifetime: await this.statsRepo.load() });

    this.setupPersistence();
    this.setupInput();
    this.audio.applySettings(getSettings());
    settingsStore.subscribe((state, prev) => {
      if (state.settings.audio !== prev.settings.audio || state.settings.reactivity !== prev.settings.reactivity) this.audio.applySettings(state.settings);
    });
    registerBuiltinComponents();
    registerBuiltinEffects();
    this.view = await this.createView(canvas);
    this.setupStages();
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('wheel', this.handleWheel, { passive: true });
    this.handleResize();
    this.rafId = requestAnimationFrame(this.frame);
  }

  /** URL overrides: ?view=debug2d (Canvas2D dev view), ?backend=webgl2|webgpu. */
  private static urlParam(name: string): string | null {
    return new URLSearchParams(location.search).get(name);
  }

  protected async createView(canvas: HTMLCanvasElement): Promise<GameView> {
    if (GameShell.urlParam('view') === 'debug2d') return this.createDebugView(canvas);
    const pref = (GameShell.urlParam('backend') as 'webgpu' | 'webgl2' | null) ?? getSettings().graphics.backend;
    try {
      const system = await RenderSystem.create(canvas, pref);
      this.renderSystem = system;
      system.applySettings(getSettings());
      settingsStore.subscribe((state, prev) => {
        const a = state.settings;
        const b = prev.settings;
        if (a.graphics !== b.graphics || a.gameplay !== b.gameplay || a.accessibility !== b.accessibility || a.camera !== b.camera || a.reactivity !== b.reactivity) {
          system.applySettings(a);
        }
      });
      system.onLost = (reason) => void this.recoverRenderer(canvas, reason);
      await system.setBlockDesign(GameShell.urlParam('block') ?? 'framed');
      appStore.setState({ renderer: { backend: system.kind, adapter: system.adapterLabel, fallback: system.adapter.isFallbackAdapter } });
      return system;
    } catch (err) {
      console.error('[shell] 3D renderer failed to start; using the debug view', err);
      toast('3D rendering is unavailable in this browser. Showing the simple playfield view.', 'warning', 8000);
      return this.createDebugView(canvas);
    }
  }

  private setupStages(): void {
    const system = this.renderSystem;
    if (!system) return;
    const manager = new StageManager(system);
    this.stageManager = manager;
    manager.onActivate = (info) => {
      hudStore.setState({ stageName: info.manifest?.name ?? '' });
      // While browsing worlds, the music follows only if music previews are on.
      const browsing = ['stages', 'setup'].includes(appStore.getState().screen);
      if (!browsing || getSettings().audio.musicPreview) void this.loadStageAudio(info);
    };
    // Rebuild environments when their quality inputs change.
    let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
    subscribeSettings(
      (s) => `${s.graphics.environmentDetail}|${s.graphics.particleDensity}|${s.graphics.reflections}`,
      () => {
        if (rebuildTimer) clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => void manager.rebuild(), 400);
      },
    );
    // Show the attract world behind the menus as soon as possible.
    void manager.show(this.menuStageId(), { transition: 0 });
  }

  /** Builds the stage's audio description (composition module, ambience, SFX palette). */
  private async loadStageAudio(info: StageInfo): Promise<void> {
    const m = info.manifest;
    if (!m) return;
    const trackSpec = m.music.tracks.find((t) => t.id === m.music.defaultTrack) ?? m.music.tracks[0];
    let composition: Composition | null = null;
    if (trackSpec?.kind === 'composition') {
      try {
        composition = (await loadMusicModule(info, trackSpec.src)) as Composition;
      } catch (err) {
        console.warn('[audio] could not load stage music', err);
      }
    }
    const file = trackSpec?.kind === 'file' ? this.fileTrack(info, trackSpec.src, trackSpec.meta, trackSpec.title) : null;
    const stageAudio: StageAudio = {
      id: m.id,
      bpm: composition?.bpm ?? file?.meta.bpm ?? m.music.bpm,
      beatsPerBar: composition?.beatsPerBar ?? file?.meta.beatsPerBar ?? m.music.beatsPerBar,
      composition,
      file,
      ambience: m.ambience?.preset ?? null,
      ambienceLevel: m.ambience?.level ?? 1,
      sfxPreset: m.sfx.preset,
    };
    await this.audio.setStage(stageAudio);
  }

  /** A stage's audio-file track with its beat metadata (track.json). */
  private fileTrack(info: StageInfo, src: string, metaPath: string | undefined, title: string): { url: string; meta: FileTrackMeta } | null {
    const url = resolveAsset(info.dir, src);
    const raw = metaPath ? (readTrackMeta(info, metaPath) as Partial<FileTrackMeta> | undefined) : undefined;
    if (!url) return null;
    return { url, meta: { title, bpm: raw?.bpm ?? info.manifest?.music.bpm ?? 120, beatsPerBar: raw?.beatsPerBar ?? 4, offset: raw?.offset ?? 0, loop: raw?.loop, sections: raw?.sections } };
  }

  /** Every playable track: music of unlocked worlds, then the player's own files. */
  async catalog(): Promise<CatalogTrack[]> {
    const progress = progressStore.getState().progress;
    const unlockAll = getSettings().setup.unlockAll;
    const out: CatalogTrack[] = [];
    for (const st of availableStages()) {
      const m = st.manifest;
      if (!m || !isStageUnlocked(m, progress, unlockAll)) continue;
      for (const t of m.music.tracks) out.push({ id: `stage:${m.id}:${t.id}`, title: t.title, subtitle: m.name, bpm: m.music.bpm, source: 'world' });
    }
    for (const u of await this.userMusic.list()) out.push({ id: `user:${u.id}`, title: u.name, subtitle: 'Your music', bpm: Math.round(u.analysis.bpm), source: 'user' });
    return out;
  }

  /** Resolves a catalog id to audio the music director can play. */
  async trackAudio(id: string): Promise<StageAudio | null> {
    if (id.startsWith('user:')) {
      const uid = id.slice(5);
      const track = (await this.userMusic.list()).find((t) => t.id === uid);
      const url = track ? await this.userMusic.url(uid) : null;
      if (!track || !url) return null;
      const a = track.analysis;
      return { id, bpm: a.bpm, beatsPerBar: 4, composition: null, file: { url, meta: { title: track.name, bpm: a.bpm, beatsPerBar: 4, offset: a.offset, sections: a.sections } }, ambience: null, ambienceLevel: 0, sfxPreset: this.audio.stage?.sfxPreset ?? 'glass' };
    }
    const [, stageId, trackId] = id.split(':');
    const info = getStage(stageId ?? '');
    const m = info?.manifest;
    const spec = m?.music.tracks.find((t) => t.id === trackId);
    if (!info || !m || !spec) return null;
    if (spec.kind === 'file') {
      const file = this.fileTrack(info, spec.src, spec.meta, spec.title);
      return file ? { id, bpm: file.meta.bpm, beatsPerBar: file.meta.beatsPerBar ?? 4, composition: null, file, ambience: null, ambienceLevel: 0, sfxPreset: m.sfx.preset } : null;
    }
    const composition = (await loadMusicModule(info, spec.src)) as Composition;
    return { id, bpm: composition.bpm, beatsPerBar: composition.beatsPerBar, composition, file: null, ambience: null, ambienceLevel: 0, sfxPreset: m.sfx.preset };
  }

  /** Plays a catalog track instead of the world's music; null returns to the world's music. */
  async playTrack(id: string | null): Promise<boolean> {
    if (id === this.currentTrackId) return true;
    const audio = id ? await this.trackAudio(id) : null;
    if (id && !audio) return false;
    this.currentTrackId = id;
    await this.audio.setOverride(audio);
    return true;
  }

  /** Free play: the world's music, a shuffled track or the chosen track (Music Room). */
  private async applyFreePlayMusic(): Promise<void> {
    const choice = getSettings().setup.music;
    if (choice === 'stage') {
      await this.playTrack(null);
      return;
    }
    if (choice === 'shuffle') {
      const tracks = await this.catalog();
      const pick = tracks[Math.floor(Math.random() * tracks.length)];
      await this.playTrack(pick?.id ?? null);
      return;
    }
    if (!(await this.playTrack(choice))) await this.playTrack(null);
  }

  /** Starts audio from a user gesture (boot screen, first input). */
  unlockAudio(): void {
    if (this.audio.unlocked) return;
    void this.audio.unlock().then((ok) => appStore.setState({ audioUnlocked: ok }));
  }

  /** Gamepad rumble scaled by the controller settings. */
  rumble(strong: number, weak: number, ms: number): void {
    const c = getSettings().controller;
    if (!c.rumble || this.input.lastDevice !== 'gamepad') return;
    this.input.gamepad.rumble(strong * c.rumbleStrength, weak * c.rumbleStrength, ms);
  }

  private hapticsFor(events: readonly GameEvent[]): void {
    for (const e of events) {
      if (e.type === 'hardDrop') this.rumble(0.25, 0.45, 70);
      else if (e.type === 'lineClear') {
        const k = Math.min(1, e.lines / 4 + (e.spin !== 'none' ? 0.3 : 0) + (e.perfectClear ? 0.5 : 0));
        this.rumble(0.3 + k * 0.6, 0.4 + k * 0.4, 90 + k * 260);
      } else if (e.type === 'gameOver') this.rumble(0.8, 0.6, 600);
      else if (e.type === 'levelUp') this.rumble(0.2, 0.5, 160);
    }
  }

  /** The stage shown behind menus: the last selection if unlocked, else the first available. */
  menuStageId(): string {
    const s = getSettings();
    const progress = progressStore.getState().progress;
    const chosen = getStage(s.setup.stageId);
    if (chosen?.available && chosen.manifest && isStageUnlocked(chosen.manifest, progress, s.setup.unlockAll)) return chosen.id;
    return availableStages()[0]?.id ?? s.setup.stageId;
  }

  /** Ensures a stage is on screen before play, showing the loading screen while it builds. */
  private async ensureStage(stageId: string): Promise<void> {
    const manager = this.stageManager;
    if (!manager || manager.activeId === stageId) return;
    const info = getStage(stageId);
    if (!info?.available) return;
    appStore.setState({ loading: { label: info.manifest?.name ?? stageId, progress: 0 } });
    navigate('loading', true);
    const ok = await manager.show(stageId, {
      transition: 1.2,
      onProgress: (f) => appStore.setState({ loading: { label: info.manifest?.name ?? stageId, progress: f } }),
    });
    appStore.setState({ loading: null });
    if (!ok) toast(`${info.manifest?.name ?? stageId} could not be loaded; playing in the neutral space instead.`, 'warning', 6000);
  }

  private createDebugView(canvas: HTMLCanvasElement): GameView {
    const view = new DebugView(canvas, paletteFor(getSettings().accessibility.highContrast));
    const apply = (): void => {
      const s = getSettings();
      view.palette = paletteFor(s.accessibility.highContrast);
      view.showGhost = s.gameplay.ghost;
      view.ghostOpacity = s.gameplay.ghostOpacity;
      view.showGrid = s.gameplay.grid;
      view.nextCount = s.gameplay.nextCount;
      view.showNext = s.gameplay.showNext;
      view.showHold = s.gameplay.showHold;
    };
    apply();
    settingsStore.subscribe(apply);
    appStore.setState({ renderer: { backend: 'canvas2d', adapter: 'Canvas 2D (debug view)', fallback: false } });
    return view;
  }

  /** GPU device lost (driver reset, sleep): pause and rebuild the renderer on a fresh canvas. */
  private async recoverRenderer(canvas: HTMLCanvasElement, reason: string): Promise<void> {
    this.pause();
    toast(`The graphics device was reset (${reason}). Restoring…`, 'warning', 6000);
    const old = this.view;
    this.view = null;
    this.renderSystem = null;
    try {
      old?.dispose();
    } catch {
      /* already lost */
    }
    const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
    canvas.replaceWith(fresh);
    this.view = await this.createView(fresh);
    this.handleResize();
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.handleResize);
    this.input.detach();
    this.view?.dispose();
  }

  // ------------------------------------------------------------------ persistence

  private setupPersistence(): void {
    settingsStore.subscribe(() => {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.flushSettings(), 400);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushSettings();
    });
  }

  flushSettings(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    void this.settingsRepo.save(getSettings()).catch((err: unknown) => console.error('[storage] settings save failed', err));
  }

  async saveProgress(progress: Progress): Promise<void> {
    progressStore.setState({ progress });
    await this.progressRepo.save(progress);
  }

  // ------------------------------------------------------------------ input

  private setupInput(): void {
    const im = this.input;
    im.attach();
    const applyBindings = (): void => {
      const s = getSettings();
      im.setBindings(s.keyboard, s.gamepad, s.controller.swapConfirmBack);
      const c = s.controller;
      im.setTuning({
        deadzoneInner: c.deadzoneInner,
        deadzoneOuter: c.deadzoneOuter,
        stickThreshold: c.stickThreshold,
        triggerThreshold: c.triggerThreshold,
        activePadId: c.activePadId,
        ignoredPadIds: c.ignoredPadIds,
        profiles: c.profiles,
      });
    };
    applyBindings();
    subscribeSettings((s) => s.keyboard, applyBindings);
    subscribeSettings((s) => s.gamepad, applyBindings);
    subscribeSettings((s) => s.controller, applyBindings);
    subscribeSettings(
      (s) => s.gameplay,
      () => this.session?.setHandling(handlingFromSettings(getSettings())),
    );
    im.setContext('menu');
    im.onAnyInput((e) => {
      const state = appStore.getState();
      if (e.device === 'gamepad') {
        const family = im.gamepad.connectedPads().find((p) => p.index === e.pad)?.family ?? 'generic';
        if (state.device !== 'gamepad' || state.padFamily !== family) appStore.setState({ device: 'gamepad', padFamily: family });
      } else if (state.device !== 'keyboard') appStore.setState({ device: 'keyboard' });
    });
    im.onGameplay((e) => this.handleGameplayAction(e));
    im.onFocusLost(() => {
      if (this.session && (this.session.status === 'running' || this.session.status === 'countdown')) this.pause();
    });
    im.onConnection((pad, connected) => {
      appStore.setState({ pads: im.gamepad.connectedPads() });
      toast(`${pad.name} ${connected ? 'connected' : 'disconnected'}`, connected ? 'success' : 'warning');
      if (!connected && this.session?.status === 'running') this.pause();
    });
  }

  private handleGameplayAction(e: ActionEvent<InputAction>): void {
    if (e.action === 'pause') {
      if (e.down) this.togglePause();
      return;
    }
    if (e.action === 'confirm' || e.action === 'back') return;
    if (e.action === 'practiceUndo' || e.action === 'practiceReset') {
      if (e.down && this.session?.mode.id === 'practice') {
        if (e.action === 'practiceUndo') this.practiceUndo();
        else this.practiceReset();
      }
      return;
    }
    this.session?.handleAction(e.action as GameAction, e.down, e.time);
  }

  /** Gameplay actions currently held (DAS pre-charge on start/resume). */
  private heldGameActions(): GameAction[] {
    return GAME_ACTIONS.filter((a) => this.input.isActionHeld(a));
  }

  // ------------------------------------------------------------------ session lifecycle

  startGame(options: StartOptions): void {
    void this.startGameAsync(options);
  }

  private async startGameAsync(input: StartOptions): Promise<void> {
    this.stopReplay();
    this.lastOptions = input;
    this.clearVoyage();
    let options = input;
    let voyageRules: SessionConfig['rules'] = {};
    if (input.modeId === 'voyage') {
      const { campaign } = getCampaign('voyage');
      const area = input.voyage?.areaId ?? campaign?.areas[0]?.id ?? '';
      const difficulty = input.voyage?.difficulty ?? 'standard';
      if (campaign) {
        const plan = planVoyage(campaign, area, difficulty);
        const first = plan.legs[0] as VoyageLeg;
        this.voyage = new VoyageRun(plan);
        options = { ...input, stageId: first.stage, variantId: `${difficulty}@${plan.startAreaId}`, voyage: { areaId: plan.startAreaId, difficulty } };
        voyageRules = { goal: { kind: 'lines', lines: plan.totalLines }, startLevel: first.level };
      }
    }
    await this.ensureStage(options.stageId);
    // The world may have been previewed without its music (music previews off).
    const stageInfo = getStage(options.stageId);
    if (stageInfo?.available && this.audio.stageId !== options.stageId) await this.loadStageAudio(stageInfo);
    if (options.modeId === 'voyage') await this.playTrack(null);
    else await this.applyFreePlayMusic();
    const s = getSettings();
    const mode = getMode(options.modeId);
    const config: SessionConfig = {
      ...options,
      handling: handlingFromSettings(s),
      rules: { ...this.rulesForMode(options.modeId), ...voyageRules },
    };
    const session = new GameSession(config);
    session.heldAtStart = () => this.heldGameActions();
    this.session = session;
    this.finishing = false;
    const linesGoal = session.engine.rules.goal.kind === 'lines' ? session.engine.rules.goal.lines : null;
    const timeLimit = session.engine.rules.goal.kind === 'time' ? session.engine.rules.goal.ms : null;
    hudStore.setState({
      visible: true,
      modeId: mode.id,
      score: 0,
      level: session.engine.level,
      lines: 0,
      linesGoal,
      timeLimitMs: timeLimit,
      combo: -1,
      backToBack: -1,
      hold: null,
      holdUsed: false,
      next: session.engine.preview(6),
      pieces: 0,
      inputs: 0,
      callouts: [],
      intro: 'ready',
      countdown: null,
      danger: false,
      best: null,
      voyage: this.voyage ? { leg: 1, legs: this.voyage.plan.legs.length, stage: getStage(this.voyage.current.stage)?.manifest?.name ?? this.voyage.current.stage } : null,
    });
    if (this.voyage) hudStore.setState({ linesGoal: this.voyage.current.endLines });
    void this.highScores.top(highScoreKey(mode.id, options.variantId), mode.lowerIsBetter, 1).then((top) => {
      const best = top[0];
      hudStore.setState({ best: best ? (mode.metric === 'time' ? best.timeMs : best.score) : null });
    });
    appStore.setState({ paused: false, pauseView: 'menu', results: null });
    navigate('game');
    this.input.setContext('gameplay');
    session.begin(performance.now());
  }

  /** Practice settings -> rule overrides. Other modes use their definitions unchanged. */
  private rulesForMode(modeId: ModeId): SessionConfig['rules'] {
    const s = getSettings();
    const base = { rotation180: s.gameplay.rotation180 };
    if (modeId !== 'practice') return base;
    const p = s.practice;
    return {
      ...base,
      gravity: p.gravityMode === 'none' ? { kind: 'fixed', gravity: 0 } : p.gravityMode === 'custom' ? { kind: 'fixed', gravity: Math.round((1 << 24) / p.msPerRow) } : { kind: 'guideline' },
      startLevel: p.level,
      lockResetMode: p.lockMode,
      lockDelayMs: p.lockDelayMs,
      areMs: p.areMs,
      lineClearDelayMs: p.lineClearDelayMs,
      previewCount: p.previewCount,
      holdEnabled: p.holdMode !== 'off',
      infiniteHold: p.holdMode === 'infinite',
      randomizer: p.randomizer === 'drill' ? { kind: 'drill', pieces: p.drillPieces } : { kind: p.randomizer },
      allSpin: p.allSpin,
    };
  }

  togglePause(): void {
    if (!this.session) return;
    if (appStore.getState().paused) this.resume();
    else this.pause();
  }

  pause(): void {
    const s = this.session;
    if (!s || s.status === 'finished' || appStore.getState().paused) return;
    s.pause(performance.now());
    this.audio.pause();
    appStore.setState({ paused: true, pauseView: 'menu' });
    this.input.setContext('menu');
  }

  resume(): void {
    const s = this.session;
    if (!s || !appStore.getState().paused) return;
    appStore.setState({ paused: false });
    this.input.setContext('gameplay');
    this.audio.resume();
    s.resume(performance.now(), getSettings().gameplay.resumeCountdown);
  }

  restart(): void {
    if (!this.lastOptions) return;
    void this.finishSession('quit', false);
    this.startGame(this.lastOptions);
  }

  private clearVoyage(): void {
    if (this.voyageTimer) clearTimeout(this.voyageTimer);
    this.voyageTimer = null;
    this.voyage = null;
    this.voyagePreloaded.clear();
  }

  /** Voyage: enter new legs as their line goals are reached; preload the next world halfway. */
  private updateVoyage(engine: Engine): void {
    const run = this.voyage;
    if (!run) return;
    const name = (id: string): string => getStage(id)?.manifest?.name ?? id;
    const { completed, entered } = run.advance(engine.lines);
    if (entered) {
      for (const leg of completed) pushCallout({ title: `${name(leg.stage)} cleared`, detail: '', intensity: 0.7, tone: 'level' }, 1800);
      // The speed band only ever rises within a run.
      if (entered.level > engine.level) engine.setLevel(entered.level);
      this.voyageTransition(entered.stage);
      hudStore.setState({ linesGoal: entered.endLines, voyage: { leg: run.index + 1, legs: run.plan.legs.length, stage: name(entered.stage) } });
    }
    const next = run.plan.legs[run.index + 1];
    if (next && run.progress(engine.lines) >= 0.5 && !this.voyagePreloaded.has(next.stage)) {
      this.voyagePreloaded.add(next.stage);
      this.stageManager?.preload(next.stage);
    }
  }

  /** Mid-game world change, started on the next musical bar (its music crossfades on a bar too). */
  private voyageTransition(stageId: string): void {
    const f = this.features.features;
    const barS = f.bpm > 0 ? (60 / f.bpm) * (this.audio.director.current?.beatsPerBar ?? 4) : 0;
    const wait = barS > 0 ? Math.max(0, (1 - f.barPhase) * barS) : 0;
    if (this.voyageTimer) clearTimeout(this.voyageTimer);
    this.voyageTimer = setTimeout(() => {
      this.voyageTimer = null;
      if (this.session && this.voyage) void this.stageManager?.show(stageId, { transition: 2.4 });
    }, wait * 1000);
  }

  quitToMenu(): void {
    if (this.session && this.session.status !== 'finished') void this.finishSession('quit', false);
    this.endSessionView();
    navigate('main', true);
  }

  practiceUndo(): void {
    if (this.session?.undo()) toast('Undid the last placement');
  }

  practiceReset(): void {
    if (this.session?.resetBoard()) toast('Board reset');
  }

  private endSessionView(): void {
    if (this.audio.director.paused) this.audio.resume();
    this.clearVoyage();
    // Menus play the world's own music again.
    void this.playTrack(null);
    this.session = null;
    this.stopReplay();
    hudStore.setState({ visible: false, callouts: [] });
    appStore.setState({ paused: false });
    this.input.setContext('menu');
  }

  /**
   * Voyage progress for a finished run: completed legs unlock their worlds, completed areas unlock
   * the next area, and the best score per start area and difficulty is kept. Returns the names
   * of everything newly unlocked.
   */
  private recordVoyage(run: VoyageRun, progress: Progress, engine: Engine, outcome: 'complete' | 'gameOver' | 'quit', key: string): string[] {
    if (outcome === 'complete') run.advance(engine.lines);
    const unlockAll = getSettings().setup.unlockAll;
    const before = new Set(availableStages().filter((st) => st.manifest && isStageUnlocked(st.manifest, progress, unlockAll)).map((st) => st.id));
    const campaign = getCampaign('voyage').campaign;
    const areasBefore = new Set(progress.voyage.completedAreas);
    for (const leg of run.completed) {
      if (!progress.voyage.completedLegs.includes(leg.stage)) progress.voyage.completedLegs.push(leg.stage);
      const rec = progress.stages[leg.stage] ?? { unlocked: true, completed: false, plays: 0, bestScore: 0, bestLines: 0, lastPlayed: null };
      progress.stages[leg.stage] = { ...rec, unlocked: true, completed: true };
    }
    for (const area of run.completedAreas()) if (!progress.voyage.completedAreas.includes(area)) progress.voyage.completedAreas.push(area);
    progress.voyage.bestScores[key] = Math.max(progress.voyage.bestScores[key] ?? 0, engine.score);
    const names: string[] = [];
    for (const st of availableStages()) {
      if (st.manifest && !before.has(st.id) && isStageUnlocked(st.manifest, progress, unlockAll)) names.push(st.manifest.name);
    }
    // Completing an area opens the next one as a starting point.
    campaign?.areas.forEach((area, i) => {
      const prev = campaign.areas[i - 1];
      if (prev && progress.voyage.completedAreas.includes(prev.id) && !areasBefore.has(prev.id)) names.push(`${area.name} (Voyage area)`);
    });
    return names;
  }

  private async finishSession(outcome: 'complete' | 'gameOver' | 'quit', showResults: boolean): Promise<void> {
    const session = this.session;
    if (!session || this.finishing) return;
    this.finishing = true;
    const engine = session.engine;
    const mode = session.mode;
    const replay = session.runner.started ? session.runner.exportReplay() : null;
    const timeMs = engine.tick;
    const ranked = outcome !== 'quit' && mode.metric !== 'none' && (mode.metric !== 'time' || outcome === 'complete');
    let rank: number | null = null;
    let replayId: string | null = null;
    const unlocked: string[] = [];
    const voyageRun = mode.id === 'voyage' ? this.voyage : null;
    const key = highScoreKey(mode.id, session.config.variantId);
    try {
      if (replay && engine.stats.pieces > 0 && mode.id !== 'practice') {
        replayId = `r-${Date.now().toString(36)}-${session.seed.toString(36)}`;
        await this.replays.save(replayId, replay, false);
      }
      const previousBest = (await this.highScores.top(key, mode.lowerIsBetter, 1))[0] ?? null;
      if (ranked) {
        const entry: HighScoreEntry = {
          id: `h-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
          key,
          score: engine.score,
          timeMs,
          lines: engine.lines,
          level: engine.level,
          stageId: session.config.stageId,
          date: new Date().toISOString(),
          seed: session.seed,
          stats: { ...engine.stats },
          replayId,
        };
        rank = await this.highScores.add(entry, mode.lowerIsBetter);
        if (rank !== null && replayId) await this.replays.pin(replayId);
      }
      if (engine.stats.pieces > 0) {
        const lifetime = await this.statsRepo.add(engine.stats, timeMs);
        const progress = structuredClone(progressStore.getState().progress);
        const stage = progress.stages[session.config.stageId] ?? { unlocked: true, completed: false, plays: 0, bestScore: 0, bestLines: 0, lastPlayed: null };
        progress.stages[session.config.stageId] = {
          ...stage,
          plays: stage.plays + 1,
          bestScore: Math.max(stage.bestScore, engine.score),
          bestLines: Math.max(stage.bestLines, engine.lines),
          lastPlayed: new Date().toISOString(),
        };
        if (voyageRun) unlocked.push(...this.recordVoyage(voyageRun, progress, engine, outcome, key));
        progress.modesPlayed[mode.id] = (progress.modesPlayed[mode.id] ?? 0) + 1;
        progress.bestByMode[mode.id] = Math.max(progress.bestByMode[mode.id] ?? 0, engine.score);
        progressStore.setState({ lifetime });
        await this.saveProgress(progress);
      }
      if (showResults) {
        const best = (await this.highScores.top(key, mode.lowerIsBetter, 1))[0] ?? null;
        const results: GameResults = {
          modeId: mode.id,
          variantId: session.config.variantId,
          stageId: session.config.stageId,
          outcome,
          score: engine.score,
          timeMs,
          lines: engine.lines,
          level: engine.level,
          stats: { ...engine.stats },
          rank,
          best,
          isPersonalBest: rank === 1 && (previousBest === null || previousBest.id !== best?.id),
          replayId,
          unlocked,
          voyage: voyageRun
            ? {
                legsCleared: voyageRun.completed.length,
                legs: voyageRun.plan.legs.length,
                lastStage: getStage(voyageRun.current.stage)?.manifest?.name ?? voyageRun.current.stage,
                areaName: getCampaign('voyage').campaign?.areas.find((a) => a.id === voyageRun.plan.startAreaId)?.name ?? voyageRun.plan.startAreaId,
              }
            : null,
        };
        appStore.setState({ results });
      }
    } catch (err) {
      console.error('[shell] failed to save results', err);
      toast('Could not save this result.', 'warning');
    }
  }

  // ------------------------------------------------------------------ replays

  async watchReplay(replayId: string, stageId: string): Promise<void> {
    const replay = await this.replays.load(replayId);
    if (!replay) {
      toast('That replay is no longer stored.', 'warning');
      return;
    }
    this.session = null;
    this.replaySession = new ReplaySession(replay, stageId);
    hudStore.setState({ visible: true, modeId: this.replaySession.mode.id, intro: null, callouts: [], best: null, linesGoal: null, timeLimitMs: null });
    navigate('replay');
    this.input.setContext('menu');
  }

  stopReplay(): void {
    if (!this.replaySession) return;
    this.replaySession = null;
    hudStore.setState({ visible: false });
  }

  // ------------------------------------------------------------------ frame loop

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onGameEvents(listener: (events: readonly GameEvent[]) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  get elapsedMs(): number {
    return this.session?.elapsedMs ?? this.replaySession?.engine.tick ?? 0;
  }

  private goalProgress(engine: Engine | null): number {
    if (!engine) return 0;
    const goal = engine.rules.goal;
    if (goal.kind === 'lines') return Math.min(1, engine.lines / goal.lines);
    if (goal.kind === 'time') return Math.min(1, engine.tick / goal.ms);
    return 0;
  }

  /** Frame limiter: simulation and input run every rAF; only rendering is capped. */
  private shouldRender(now: number): boolean {
    const cap = getSettings().graphics.fpsCap;
    if (cap === 'display') return true;
    const refresh = this.renderSystem?.perf.refreshHz ?? 60;
    const target = cap === 'half' ? refresh / 2 : cap === 'third' ? refresh / 3 : Number(cap);
    if (!(target > 0) || target >= refresh - 0.5) return true;
    return now - this.lastRender >= 1000 / target - 1.5;
  }

  /** Mouse-wheel camera zoom during play (Camera → zoom sensitivity). */
  private readonly handleWheel = (e: WheelEvent): void => {
    if (!this.session || appStore.getState().paused) return;
    const cam = getSettings().camera;
    const zoom = Math.min(1.25, Math.max(0.8, cam.zoom - e.deltaY * 0.0004 * cam.zoomSensitivity));
    if (Math.abs(zoom - cam.zoom) > 1e-4) updateSection('camera', { zoom: Math.round(zoom * 100) / 100 });
  };

  private readonly handleResize = (): void => {
    this.view?.resize();
    hudStore.setState({ boardRect: this.view?.boardRect() ?? null });
  };

  private readonly frame = (now: number): void => {
    this.rafId = requestAnimationFrame(this.frame);
    const t = performance.now();
    const dt = Math.min(0.1, Math.max(0, (t - (this.lastFrame || t)) / 1000));
    this.lastFrame = t;
    this.input.poll(t);
    const beats = this.features.update(t, dt);
    if (beats.length > 0) {
      this.pendingBeats.push(...beats);
      // Only real music produces visual beat cues (not the silent metronome stand-in).
      if (this.audio.hub.playing && hasCueListeners()) for (const b of beats) emitCue({ kind: 'beat', downbeat: b.downbeat });
    }
    let events: GameEvent[] = [];
    const session = this.session;
    if (session) events = session.update(t);
    else if (this.replaySession) events = this.replaySession.update(t);
    const engine = session?.engine ?? this.replaySession?.engine ?? null;
    if (events.length > 0) {
      for (const c of describeEvents(events)) pushCallout(c);
      this.eventListeners.forEach((l) => l(events));
      this.hapticsFor(events);
    }
    if (session && this.voyage && session.status === 'running') this.updateVoyage(session.engine);
    if (engine) this.audio.onGameEvents(events, engine, dt);
    if (engine) this.syncHud(t);
    this.renderSystem?.tickPerf(t);
    if (this.shouldRender(t)) {
      this.view?.render({
        now: t,
        dt: Math.min(0.1, (t - (this.lastRender || t)) / 1000),
        engine,
        events: this.pendingEvents.length > 0 ? [...this.pendingEvents, ...events] : events,
        paused: appStore.getState().paused,
        audio: this.features.features,
        beats: this.pendingBeats.length > 0 ? this.pendingBeats.splice(0) : [],
        progress: this.goalProgress(engine),
      });
      this.pendingEvents.length = 0;
      this.lastRender = t;
      hudStore.setState({ boardRect: this.view?.boardRect() ?? null });
    } else if (events.length > 0) {
      // Keep events for the next rendered frame so effects are never lost.
      this.pendingEvents.push(...events);
    }
    this.frameListeners.forEach((l) => l(now, dt));
    if (session && session.status === 'finished' && !this.finishing) {
      const outcome = session.engine.phase === 'complete' ? 'complete' : 'gameOver';
      void this.finishSession(outcome, true).then(() => {
        this.input.setContext('menu');
        navigate('results', true);
      });
    }
  };

  private syncHud(now: number): void {
    const e = (this.session?.engine ?? this.replaySession?.engine)!;
    const h = hudStore.getState();
    const next = e.preview(6);
    const intro = this.session?.introPhase(now) ?? null;
    const countdown = this.session?.countdownValue(now) ?? null;
    const danger = e.board.stackHeight() >= e.board.visibleRows - 3;
    if (intro !== h.intro && intro !== null) this.audio.play(intro === 'go' ? 'go' : 'countdown');
    if (countdown !== h.countdown && countdown !== null) this.audio.play('countdown');
    if (
      h.score !== e.score ||
      h.level !== e.level ||
      h.lines !== e.lines ||
      h.combo !== e.combo ||
      h.backToBack !== (e.backToBackActive ? e.backToBackCount : -1) ||
      h.hold !== e.hold ||
      h.holdUsed !== e.holdUsed ||
      h.pieces !== e.stats.pieces ||
      h.next.join('') !== next.join('') ||
      h.intro !== intro ||
      h.countdown !== countdown ||
      h.danger !== danger
    ) {
      hudStore.setState({
        score: e.score,
        level: e.level,
        lines: e.lines,
        combo: e.combo,
        backToBack: e.backToBackActive ? e.backToBackCount : -1,
        hold: e.hold,
        holdUsed: e.holdUsed,
        pieces: e.stats.pieces,
        inputs: e.stats.inputs,
        next,
        intro,
        countdown,
        danger,
      });
    }
  }

  /**
   * The AI performs one placement through the normal input path (tests, perf runs, attract demo).
   * Returns false once the session can no longer accept placements.
   */
  aiStep(): boolean {
    const s = this.session;
    if (!s || s.status === 'finished') return false;
    if (s.status !== 'running' || !s.engine.active) return true;
    const placement = choosePlacement(s.engine);
    if (!placement) return false;
    const t = performance.now();
    const actions: GameAction[] = placement.useHold ? ['hold', ...placement.actions] : [...placement.actions];
    actions.forEach((a, i) => {
      s.handleAction(a, true, t + i * 0.01);
      s.handleAction(a, false, t + i * 0.01 + 0.005);
    });
    return true;
  }

  // ------------------------------------------------------------------ navigation helpers for UI

  back(): void {
    goBack();
  }
}

export const shell = new GameShell();
