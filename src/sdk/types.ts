import type { Object3D, Scene, Vector3 } from 'three/webgpu';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { ZodType } from 'zod';
import type { AudioFeatures } from '../audio/analysis/features';
import type { WorldSoundId } from '../audio/worldSounds';
import type { FrameUniforms } from '../rendering/shaders/uniforms';
import type { BurstSystem } from '../rendering/particles/BurstSystem';
import type { StormSound, WeatherSound } from '../audio/worldSounds';
import type { MusicCue, MusicDrive } from '../rendering/environments/living/musicDirector';
import type { BackgroundLevels } from '../rendering/environments/living/intensity';
import type { CallAction as StageCallAction } from '../stages/triggers';

export type { StormSound, WeatherSound, MusicCue, MusicDrive, BackgroundLevels };

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

/** Quality information components use to scale their cost (never gameplay). */
export interface QualityInfo {
  readonly detail: QualityLevel;
  /** Particle density multiplier (0..2). */
  readonly particles: number;
  readonly reflections: 'off' | 'low' | 'high' | 'ultra';
  readonly reducedMotion: boolean;
}

/** Gameplay signals environments may react to (read-only, smoothed). */
export interface GameSignals {
  /** 0..1 how close the stack is to the top. */
  readonly danger: number;
  /** Current combo (-1 = none). */
  readonly combo: number;
  readonly backToBack: number;
  readonly level: number;
  /** Decaying 0..1+ pulse after line clears (bigger clears = larger). */
  readonly clearPulse: number;
  /** 0..1 progress toward the current goal (Voyage leg, Sprint lines), if any. */
  readonly progress: number;
  /**
   * 0..1 heat of the run (since SDK 1.5): rises with consecutive clears, combos, back-to-back and
   * spins, holds for a few seconds after each clear and then cools over about 10 to 20 seconds.
   */
  readonly heat: number;
  /** 0..1 long-release clear signal (since SDK 1.5): set by each clear's size, falls over ~3 s. */
  readonly clearWave: number;
  /** 0 (empty) .. 1 (top of the visible field): the stack's height, smoothed (since SDK 1.5). */
  readonly stackHeight: number;
  /** The active piece across the board, -1 (left wall) .. 1 (right wall), smoothed (since SDK 1.5). */
  readonly pieceX: number;
}

/**
 * Stage-level game moments forwarded to environment components. `column` is the piece's centre
 * across the board, 0 (left wall) .. 10 (right wall); in board space its x is `column - 5`.
 * `move`, `rotate`, `spawn` and `hold`, and the columns, were added in SDK 1.5; a component must
 * ignore kinds it does not know.
 */
export type StageGameEvent =
  | { readonly kind: 'clear'; readonly lines: number; readonly intensity: number; readonly spin: boolean; readonly perfectClear: boolean; readonly combo: number; readonly backToBack: boolean }
  | { readonly kind: 'levelUp'; readonly level: number }
  | { readonly kind: 'hardDrop'; readonly rows: number; readonly column?: number }
  | { readonly kind: 'lock'; readonly column?: number }
  | { readonly kind: 'move'; readonly dx: number; readonly column: number }
  | { readonly kind: 'rotate'; readonly kick: boolean; readonly column: number }
  | { readonly kind: 'spawn'; readonly piece: string; readonly column: number }
  | { readonly kind: 'hold'; readonly piece: string; readonly column: number }
  | { readonly kind: 'danger'; readonly active: boolean }
  | { readonly kind: 'gameOver' };

/** The music entered a new section (EnvironmentComponent.onSection, since SDK 1.5). */
export interface SectionInfo {
  /** intro, verse, build, drop, break, bridge or outro ('' when the music has no sections). */
  readonly kind: string;
  /** The composition's own section name. */
  readonly name: string;
  /** The section's composed intensity (smoothed), 0..1. */
  readonly intensity: number;
  /** The previous section's kind, or null for the first section heard. */
  readonly previous: string | null;
  readonly time: number;
}

/**
 * What an event call-in asks a layer to do (EnvironmentComponent.onCall, since SDK 1.5). Components
 * receive the first six; `pulse` and `wave` (SDK 1.7) are carried out by the environment itself.
 */
export type CallAction = StageCallAction;

export interface CallInfo {
  readonly action: CallAction;
  /** The manifest entry's `params`, unvalidated: components check what they read. */
  readonly params: Readonly<Record<string, unknown>>;
  /** The trigger that fired (`clear>=4`, `section:drop`...). */
  readonly trigger: string;
  /** Size of the moment, 0..1.5 (a clear's strength; 1 for other triggers). */
  readonly strength: number;
  readonly time: number;
}

/** The viewer's camera and the board on screen (EnvironmentContext.view, since SDK 1.5). */
export interface ViewInfo {
  /** The board's rectangle in normalised device coordinates (-1..1), widened by `margin`. */
  boardRect(margin?: number): { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  /** The world point seen at NDC (x, y), `distance` units from the camera, written to `out`. */
  toWorld(ndcX: number, ndcY: number, distance: number, out: Vector3): Vector3;
  /** The camera's world position, written to `out`. */
  cameraPosition(out: Vector3): Vector3;
}

export interface BeatInfo {
  readonly beat: number;
  readonly bar: number;
  readonly beatInBar: number;
  readonly downbeat: boolean;
  readonly time: number;
}

/** Everything a component sees each frame. */
export interface EnvFrame {
  readonly time: number;
  readonly dt: number;
  readonly audio: Readonly<AudioFeatures>;
  readonly game: GameSignals;
  /** Fade weight while this environment is transitioning in/out (0..1). */
  readonly presence: number;
  /**
   * The Environment Music Director's interpretation of the music (since SDK 1.7): drives at
   * distinct time scales (`body`, `motion`, `detail`, `intensity`, `tension`...) and the section.
   * Use these instead of raw audio features; they are not yet scaled by the Background intensity
   * music level, which is `levels.music`.
   */
  readonly music: Readonly<MusicDrive>;
  /** Background intensity levels (since SDK 1.7): 1 = as authored. */
  readonly levels: BackgroundLevels;
}

/** Resolves and loads files that live inside the stage folder. */
export interface StageAssets {
  url(relativePath: string): string | null;
  loadGLTF(relativePath: string): Promise<GLTF>;
  /** Releases a GLTF obtained with loadGLTF (ref-counted; disposed when unused). */
  release(relativePath: string): void;
  /** Parsed data file (e.g. a creature rig, *.rig.json) or null if missing. */
  json(relativePath: string): unknown;
}

/** Terrain height shared between components (dunes provide it; creatures and props stand on it). */
export interface GroundField {
  /** World-space ground height at (x, z). Falls back to the stage's base ground level. */
  height(x: number, z: number): number;
  /** Installs (or clears) the height function; the terrain component calls this. */
  provide(fn: ((x: number, z: number) => number) | null): void;
  /** Where a viewer stands (VR): the ground, or a water surface above it. Since SDK 1.2. */
  surface(x: number, z: number): number;
  /** Declares (or clears) a water surface at world height `y`; the water component calls this. Since SDK 1.2. */
  setWaterLevel(y: number | null): void;
}

/** Context passed to component factories and custom effects. */
export interface EnvironmentContext {
  readonly stageId: string;
  readonly scene: Scene;
  readonly quality: QualityInfo;
  readonly uniforms: FrameUniforms;
  readonly assets: StageAssets;
  readonly bursts: BurstSystem;
  readonly palette: StagePalette;
  readonly ground: GroundField;
  /** Positional world sounds (footfalls...); the audio system plays them if enabled. */
  readonly sounds: WorldSounds;
  /**
   * Shakes the world (the environment only: never the board, HUD or camera) with a tremor that
   * starts strong and decays: `strength` 0..1 (1 = a few tenths of a degree), over `seconds`.
   * Off under reduced motion and in VR, scaled by the screen-effects setting, and ignored for a
   * stage that is not on screen. Since SDK 1.3.
   */
  readonly shakeWorld?: (strength: number, seconds: number) => void;
  /**
   * The desktop view (camera and the board's screen rectangle), for paths that must stay clear of
   * the playfield, such as a creature passing close by. Since SDK 1.5; in VR it still describes the
   * desktop view.
   */
  readonly view?: ViewInfo;
}

/**
 * Positional one-shots a component may emit (`WorldSounds.emit`):
 * - `footstep` (SDK 1.1): a creature's footfall, made from the world's block material.
 * - `skitter` (SDK 1.4): a small spider's dash, a quick irregular patter of tiny claw ticks on stone
 *   (one call per dash, not per leg).
 * - `crawl` (SDK 1.4): one step of a large spider, two to four legs landing with a low thud (one call
 *   per half gait cycle, when a set of legs lands).
 * - `silk` (SDK 1.4): a silk thread stretching or creaking, soft and airy.
 * - `webHum` (SDK 1.4): a web vibrating, a soft plucked-string shimmer, played in the music's key.
 */
export type WorldSoundName = WorldSoundId;

export interface WorldSounds {
  /**
   * Plays a world sound at a world position, if sound is on and the rate limits allow (each sound
   * has its own and all share one; extra calls are dropped, so emit only what should be heard).
   * `gain` is the loudness (default 1, distance comes on top). For `skitter` and `crawl` it is also
   * the weight: 0.2 a light, quiet contact from a smaller animal, 1 the heaviest and loudest.
   */
  emit(sound: WorldSoundName, x: number, y: number, z: number, gain?: number): void;
  /**
   * Keeps a sustained world voice (a hum or drone) sounding: call it every frame or so with its
   * loudness (0..1), pitch (Hz), brightness (0..1) and stereo pan; it fades out by itself soon
   * after the calls stop. Optional: a host without it simply stays silent.
   */
  drone?(id: string, level: number, hz: number, brightness?: number, pan?: number): void;
  /**
   * Keeps a world's weather sounding (rain and wind on their own buses, each with its own volume
   * setting): call it every frame or so; the beds fade out soon after the calls stop. Optional,
   * since SDK 1.5.
   */
  weather?(state: WeatherSound): void;
  /**
   * Schedules a storm sound on the audio clock: a strike's thunder `delay` seconds from now (time
   * it from the strike's apparent distance), or the crack of a nearby strike. The audio system
   * synthesises a unique sound for the event, places it towards (x, y, z) and mixes it on the near
   * or distant thunder bus (or the crack bus), ducking the music a little under big ones. Optional,
   * since SDK 1.5.
   */
  storm?(sound: StormSound): void;
}

export interface StagePalette {
  readonly accent: string;
  readonly secondary: string;
  readonly highlight: string;
  readonly fog: string;
}

/** A piece of a stage environment (sky, particles, water, a Blender scene, ...). */
export interface EnvironmentComponent {
  readonly object: Object3D;
  /** Named float uniforms that reactivity bindings may drive (base values are captured on build). */
  readonly reactive?: Readonly<Record<string, { value: number }>>;
  update?(frame: EnvFrame): void;
  onBeat?(beat: BeatInfo): void;
  onGameEvent?(event: StageGameEvent): void;
  /** The music entered a new section (since SDK 1.5). */
  onSection?(info: SectionInfo): void;
  /** A manifest event call-in addressed to this layer (since SDK 1.5). */
  onCall?(call: CallInfo): void;
  /**
   * A cue of the Environment Music Director (since SDK 1.7): accent, downbeat, phrase, build, drop,
   * break, peak, calm or section. Most worlds react to cues through `events` instead.
   */
  onMusicCue?(cue: MusicCue): void;
  /** Called when the environment fades (0..1) during transitions. */
  setPresence?(presence: number): void;
  dispose(): void;
}

export interface ComponentFactory<P = unknown> {
  readonly type: string;
  readonly version: number;
  readonly description: string;
  readonly schema: ZodType<P>;
  create(ctx: EnvironmentContext, params: P): EnvironmentComponent | Promise<EnvironmentComponent>;
}

/** Information about a line clear given to line-clear effects. */
export interface ClearInfo {
  readonly rows: readonly number[];
  readonly cells: readonly { readonly x: number; readonly y: number; readonly color: readonly [number, number, number] }[];
  readonly lines: number;
  readonly intensity: number;
  readonly spin: boolean;
  readonly perfectClear: boolean;
  readonly combo: number;
  readonly backToBack: boolean;
  readonly time: number;
}

export interface LineClearEffect {
  readonly id: string;
  readonly description: string;
  trigger(ctx: EffectContext, clear: ClearInfo, params: Readonly<Record<string, unknown>>): void;
}

export interface EffectContext {
  readonly bursts: BurstSystem;
  readonly uniforms: FrameUniforms;
  readonly palette: StagePalette;
  /** Converts a board cell to board-space world coordinates. */
  cellToWorld(x: number, y: number): { x: number; y: number; z: number };
  readonly intensityScale: number;
  readonly reducedMotion: boolean;
}

/** What a themed stage transition can use while the worlds crossfade. */
export interface TransitionContext {
  readonly bursts: BurstSystem;
  readonly palette: StagePalette;
  /** Crossfade length in seconds. */
  readonly duration: number;
  /** Audio-clock-independent effect time (frame uniforms). */
  readonly time: number;
  readonly intensityScale: number;
  readonly reducedMotion: boolean;
}

/** The incoming world's entrance (sand sweep, frost, stars...). */
export interface TransitionEffect {
  readonly id: string;
  readonly description: string;
  play(ctx: TransitionContext, params: Readonly<Record<string, unknown>>): void;
}

/** A custom stage module (content/stages/<id>/stage.ts) registers its own pieces through the SDK. */
export interface StageModule {
  readonly sdkVersion: string;
  register(sdk: SdkRegistries): void;
}

export interface SdkRegistries {
  readonly components: Registry<ComponentFactory>;
  readonly lineClearEffects: Registry<LineClearEffect>;
  readonly transitions: Registry<TransitionEffect>;
}

export interface Registry<T extends { readonly id?: string; readonly type?: string }> {
  register(item: T): void;
  get(key: string): T | undefined;
  has(key: string): boolean;
  keys(): string[];
}
