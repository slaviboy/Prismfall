import type { Object3D, Scene } from 'three/webgpu';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { ZodType } from 'zod';
import type { AudioFeatures } from '../audio/analysis/features';
import type { FrameUniforms } from '../rendering/shaders/uniforms';
import type { BurstSystem } from '../rendering/particles/BurstSystem';

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
}

/** Stage-level game moments forwarded to environment components. */
export type StageGameEvent =
  | { readonly kind: 'clear'; readonly lines: number; readonly intensity: number; readonly spin: boolean; readonly perfectClear: boolean; readonly combo: number; readonly backToBack: boolean }
  | { readonly kind: 'levelUp'; readonly level: number }
  | { readonly kind: 'hardDrop'; readonly rows: number }
  | { readonly kind: 'lock' }
  | { readonly kind: 'danger'; readonly active: boolean }
  | { readonly kind: 'gameOver' };

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
}

export interface WorldSounds {
  emit(sound: 'footstep', x: number, y: number, z: number, gain?: number): void;
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

/** A custom stage module (content/stages/<id>/stage.ts) registers its own pieces through the SDK. */
export interface StageModule {
  readonly sdkVersion: string;
  register(sdk: SdkRegistries): void;
}

export interface SdkRegistries {
  readonly components: Registry<ComponentFactory>;
  readonly lineClearEffects: Registry<LineClearEffect>;
}

export interface Registry<T extends { readonly id?: string; readonly type?: string }> {
  register(item: T): void;
  get(key: string): T | undefined;
  has(key: string): boolean;
  keys(): string[];
}
