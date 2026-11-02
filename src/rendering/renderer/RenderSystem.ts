import { ACESFilmicToneMapping, AgXToneMapping, Group, NeutralToneMapping, PMREMGenerator, Scene, SRGBColorSpace, Vector3, WebGPURenderer } from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Settings } from '../../settings/schema';
import { reducedMotion } from '../../settings/store';
import { paletteFor } from '../../config/palette';
import { BoardView } from '../board/BoardView';
import { CameraRig } from '../camera/CameraRig';
import { DefaultBackdrop } from '../environments/DefaultBackdrop';
import { LightRig } from '../lighting/LightRig';
import { resolveBlockPreset } from '../materials/blockPresets';
import { PostPipeline } from '../postprocessing/PostPipeline';
import { frameUniforms } from '../shaders/uniforms';
import type { BoardRect, GameView, ViewFrame } from '../view';
import { PerfMonitor } from './PerfMonitor';
import { BurstSystem } from '../particles/BurstSystem';
import { FeedbackDirector } from '../fx/FeedbackDirector';
import { EnvironmentHost } from '../environments/EnvironmentHost';
import { createAudioFeatures, type AudioFeatures } from '../../audio/analysis/features';
import type { GameSignals, QualityInfo } from '../../sdk/types';
import { loadBlockGeometry } from '../board/blockLibrary';
import { createRoundedBlock } from '../board/blockGeometry';
import { perfStore } from './perfStore';

const perfStoreSnapshot = () => perfStore.getState();

export type BackendPreference = 'auto' | 'webgpu' | 'webgl2';

export interface AdapterInfo {
  readonly backend: 'webgpu' | 'webgl2';
  readonly vendor: string;
  readonly architecture: string;
  readonly description: string;
  readonly isFallbackAdapter: boolean;
}

export type ToneMap = 'agx' | 'aces' | 'neutral';

/** Hooks other render subsystems (effects, environments) attach to the frame. */
export interface RenderHook {
  update(frame: ViewFrame): void;
}

async function queryAdapter(): Promise<{ vendor: string; architecture: string; description: string; fallback: boolean } | null> {
  try {
    if (!navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const info = adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean };
    return { vendor: info.vendor, architecture: info.architecture, description: info.description, fallback: info.isFallbackAdapter ?? false };
  } catch {
    return null;
  }
}

function webglRendererName(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'WebGL 2';
  } catch {
    return 'WebGL 2';
  }
}

/**
 * Owns the three.js renderer, scene graph and per-frame rendering. Gameplay state is read
 * through ViewFrame; nothing here mutates the engine.
 */
export class RenderSystem implements GameView {
  readonly kind: 'webgpu' | 'webgl2';
  readonly renderer: WebGPURenderer;
  readonly scene = new Scene();
  readonly worldRoot = new Group();
  readonly boardRoot = new Group();
  readonly fxRoot = new Group();
  readonly cameraRig: CameraRig;
  readonly lights = new LightRig();
  readonly board: BoardView;
  readonly post: PostPipeline;
  readonly perf: PerfMonitor;
  readonly backdrop = new DefaultBackdrop();
  readonly bursts = new BurstSystem(32768);
  readonly feedback: FeedbackDirector;
  readonly environments: EnvironmentHost;
  readonly adapter: AdapterInfo;
  private readonly idleAudio: AudioFeatures = createAudioFeatures();
  readonly signals: { danger: number; combo: number; backToBack: number; level: number; clearPulse: number; progress: number } = {
    danger: 0,
    combo: -1,
    backToBack: -1,
    level: 1,
    clearPulse: 0,
    progress: 0,
  };
  private readonly hooks = new Set<RenderHook>();
  private renderScale = 1;
  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;
  private rect: BoardRect | null = null;
  private readonly v = new Vector3();
  private settings: Settings | null = null;
  /** Set when the GPU device was lost; the shell rebuilds the renderer. */
  onLost: ((reason: string) => void) | null = null;

  private constructor(private readonly canvas: HTMLCanvasElement, renderer: WebGPURenderer, adapter: AdapterInfo) {
    this.renderer = renderer;
    this.adapter = adapter;
    this.kind = adapter.backend;
    this.cameraRig = new CameraRig(BoardView.FRAME_WIDTH, BoardView.FRAME_HEIGHT);
    this.board = new BoardView({ palette: paletteFor(false), preset: resolveBlockPreset('prism') });
    this.boardRoot.add(this.board.group);
    this.scene.add(this.backdrop.group, this.worldRoot, this.lights.group, this.boardRoot, this.fxRoot);
    this.post = new PostPipeline(renderer, this.scene, this.cameraRig.camera);
    this.feedback = new FeedbackDirector(this.bursts, this.cameraRig, createRoundedBlock());
    this.fxRoot.add(this.bursts.object, this.feedback.ghosts);
    this.environments = new EnvironmentHost(this);
    this.feedback.onStageEvent = (e) => this.environments.onGameEvent(e);
    this.perf = new PerfMonitor(renderer, adapter.backend === 'webgpu');
    renderer.onDeviceLost = (info) => {
      console.warn('[render] GPU device lost', info);
      this.onLost?.(info.message || info.reason || 'device lost');
    };
  }

  static async create(canvas: HTMLCanvasElement, preference: BackendPreference): Promise<RenderSystem> {
    const forceWebGL = preference === 'webgl2';
    const gpu = forceWebGL ? null : await queryAdapter();
    const renderer = new WebGPURenderer({
      canvas,
      antialias: false,
      alpha: false,
      forceWebGL,
      powerPreference: 'high-performance',
      trackTimestamp: !forceWebGL && gpu !== null,
    });
    await renderer.init();
    const isWebGPU = (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
    const adapter: AdapterInfo = isWebGPU
      ? { backend: 'webgpu', vendor: gpu?.vendor ?? '', architecture: gpu?.architecture ?? '', description: gpu?.description ?? '', isFallbackAdapter: gpu?.fallback ?? false }
      : { backend: 'webgl2', vendor: '', architecture: '', description: webglRendererName(), isFallbackAdapter: false };
    if (!isWebGPU && !forceWebGL) console.info('[render] WebGPU unavailable — using the WebGL 2 backend');
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    // Counters accumulate across the pipeline's passes; reset once per frame in render().
    renderer.info.autoReset = false;
    const system = new RenderSystem(canvas, renderer, adapter);
    system.setupEnvironmentLighting();
    return system;
  }

  get adapterLabel(): string {
    const a = this.adapter;
    if (a.backend === 'webgl2') return a.description;
    const parts = [a.vendor, a.architecture, a.description].filter((p) => p && p.length > 0);
    return parts.length > 0 ? parts.join(' ') : 'WebGPU adapter';
  }

  private setupEnvironmentLighting(): void {
    const pmrem = new PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    const target = pmrem.fromScene(room, 0.04);
    this.scene.environment = target.texture;
    this.scene.environmentIntensity = 0.3;
    room.dispose();
    pmrem.dispose();
  }

  /** Quality information environment components scale with. */
  quality(): QualityInfo {
    const s = this.settings;
    return {
      detail: s?.graphics.environmentDetail ?? 'high',
      particles: s?.graphics.particleDensity ?? 1,
      reflections: s?.graphics.reflections ?? 'low',
      reducedMotion: s ? reducedMotion(s) : false,
    };
  }

  private blockDesign = 'procedural';

  /** Switches the block geometry to a Blender-authored design (falls back to procedural). */
  async setBlockDesign(id: string): Promise<void> {
    if (id === this.blockDesign) return;
    this.blockDesign = id;
    const geometry = id === 'procedural' ? createRoundedBlock() : await loadBlockGeometry(id);
    if (this.blockDesign !== id) {
      geometry?.dispose();
      return;
    }
    const g = geometry ?? createRoundedBlock();
    this.board.setBlockGeometry(g);
    this.feedback.setGeometry(g);
  }

  addHook(hook: RenderHook): () => void {
    this.hooks.add(hook);
    return () => this.hooks.delete(hook);
  }

  setToneMapping(mode: ToneMap, exposure: number): void {
    this.renderer.toneMapping = mode === 'aces' ? ACESFilmicToneMapping : mode === 'neutral' ? NeutralToneMapping : AgXToneMapping;
    this.renderer.toneMappingExposure = exposure;
  }

  applySettings(s: Settings): void {
    this.settings = s;
    const g = s.graphics;
    this.renderScale = g.renderScale;
    this.post.configure({
      enabled: g.postProcessing,
      antialias: g.antialias,
      renderScale: g.renderScale,
      upscaler: g.upscaler,
      bloom: g.bloom * (s.accessibility.flashReduction ? 0.6 : 1),
      ambientOcclusion: g.ambientOcclusion,
      depthOfField: g.depthOfField,
      screenEffects: s.accessibility.screenEffects,
    });
    this.lights.setShadowQuality(g.shadows);
    this.board.setPalette(paletteFor(s.accessibility.highContrast));
    this.feedback.piecePalette = paletteFor(s.accessibility.highContrast);
    this.feedback.settings = { intensity: s.gameplay.effectsIntensity, reducedMotion: reducedMotion(s), screenEffects: s.accessibility.screenEffects * (s.graphics.screenSpaceEffects ? 1 : 0.4) };
    this.bursts.density = Math.max(0.05, g.particleDensity);
    this.environments.reactivity = { ...s.reactivity };
    this.board.setGlyphs(s.accessibility.pieceGlyphs);
    this.board.showGhost = s.gameplay.ghost;
    this.board.setGhostOpacity(s.gameplay.ghostOpacity);
    this.board.setGrid(s.gameplay.grid);
    this.board.showHold = s.gameplay.showHold;
    this.board.showNext = s.gameplay.showNext;
    this.board.nextCount = s.gameplay.nextCount;
    this.board.lockIndicator = s.gameplay.lockIndicator;
    this.board.setBackgroundDim(s.accessibility.backgroundDim);
    this.board.invalidate();
    this.cameraRig.settings = { ...s.camera, reducedMotion: reducedMotion(s) };
    frameUniforms.effectsIntensity.value = s.gameplay.effectsIntensity;
    frameUniforms.flashLimit.value = s.accessibility.flashReduction ? 0.45 : 1;
    frameUniforms.reactivity.value = s.reactivity.enabled ? s.reactivity.strength : 0;
  }

  resize(): void {
    this.cssWidth = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    this.cssHeight = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    const maxDim = 8192;
    const scale = Math.min(this.dpr, maxDim / this.cssWidth, maxDim / this.cssHeight);
    this.renderer.setPixelRatio(scale);
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
    this.cameraRig.setAspect(this.cssWidth / this.cssHeight);
    this.updateBoardRect();
  }

  private updateBoardRect(): void {
    const cam = this.cameraRig.camera;
    cam.updateMatrixWorld();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of [[-5, -10], [5, -10], [-5, 10], [5, 10]] as const) {
      this.v.set(x, y, 0.5).applyMatrix4(this.boardRoot.matrixWorld).project(cam);
      const sx = ((this.v.x + 1) / 2) * this.cssWidth;
      const sy = ((1 - this.v.y) / 2) * this.cssHeight;
      minX = Math.min(minX, sx);
      maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy);
      maxY = Math.max(maxY, sy);
    }
    this.rect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  boardRect(): BoardRect | null {
    return this.rect;
  }

  render(frame: ViewFrame): void {
    const t0 = performance.now();
    const time = frame.now / 1000;
    frameUniforms.time.value = time;
    const engine = frame.engine;
    const audio = frame.audio ?? this.idleAudio;
    const sig = this.signals;
    const dangerTarget = engine ? Math.min(1, Math.max(0, (engine.board.stackHeight() - 12) / 6)) : 0;
    sig.danger += (dangerTarget - sig.danger) * Math.min(1, frame.dt * 4);
    sig.combo = engine?.combo ?? -1;
    sig.backToBack = engine && engine.backToBackActive ? engine.backToBackCount : -1;
    sig.level = engine?.level ?? 1;
    sig.progress = frame.progress ?? 0;
    frameUniforms.danger.value = sig.danger;
    frameUniforms.clearPulse.value = Math.max(0, frameUniforms.clearPulse.value - frame.dt * 2.2);
    sig.clearPulse = frameUniforms.clearPulse.value;
    frameUniforms.comboLevel.value = Math.min(1, Math.max(0, sig.combo) / 8);
    // Music features → shared shader uniforms (zero when audio reactivity is off).
    const react = this.settings?.reactivity.enabled ?? true;
    frameUniforms.bass.value = react ? audio.bass : 0;
    frameUniforms.mid.value = react ? audio.mid : 0;
    frameUniforms.treble.value = react ? audio.treble : 0;
    frameUniforms.energy.value = react ? audio.overallEnergy : 0;
    frameUniforms.flux.value = react ? audio.spectralFlux : 0;
    frameUniforms.beatPulse.value = react ? audio.beatPulse : 0;
    frameUniforms.barPulse.value = react ? audio.barPulse : 0;
    frameUniforms.beatPhase.value = audio.beatPhase;
    frameUniforms.sectionIntensity.value = audio.sectionIntensity;

    this.feedback.handle(frame.events, engine, time);
    this.board.sync(engine, frame.events, time);
    this.environments.update(frame.dt, time, audio, frame.beats ?? [], sig as GameSignals);
    for (const hook of this.hooks) hook.update(frame);
    this.lights.setLevel(sig.level);
    this.lights.update(frame.dt, frameUniforms.beatPulse.value, frameUniforms.clearPulse.value, frameUniforms.reactivity.value);
    this.cameraRig.update(frame.dt, time, frameUniforms.beatPulse.value);
    this.post.setFocusDistance(this.cameraRig.camera.position.length());
    const t1 = performance.now();
    this.post.updateFrame();
    this.renderer.info.reset();
    this.post.render();
    const t2 = performance.now();
    this.perf.addCpu('scene update', t1 - t0);
    this.perf.addCpu('render encode', t2 - t1);
    this.perf.afterRender();
    this.updateBoardRect();
  }

  private dynamicTimer = 0;
  private dynamicScale = 1;

  /** Adjusts render scale toward the target frame rate (GPU time when available, else frame time). */
  private updateDynamicResolution(now: number): void {
    const g = this.settings?.graphics;
    if (!g || !g.dynamicResolution) {
      if (this.post.effectiveScale !== this.renderScale) this.post.setDynamicScale(null);
      this.dynamicScale = this.renderScale;
      return;
    }
    if (now - this.dynamicTimer < 1000) return;
    this.dynamicTimer = now;
    const budget = 1000 / Math.min(g.dynamicTargetFps, this.perf.refreshHz);
    const snapshot = perfStoreSnapshot();
    const cost = snapshot.gpuMs ?? snapshot.frameMs;
    const max = this.renderScale;
    if (cost > budget * 0.92) this.dynamicScale = Math.max(0.5, this.dynamicScale - 0.08);
    else if (cost < budget * 0.7) this.dynamicScale = Math.min(max, this.dynamicScale + 0.05);
    this.post.setDynamicScale(Math.abs(this.dynamicScale - max) < 0.01 ? null : this.dynamicScale);
  }

  /** Called by the shell every rAF (even when the frame limiter skips rendering). */
  tickPerf(now: number): void {
    this.perf.frame(now);
    this.updateDynamicResolution(now);
    this.perf.publish(now, {
      renderWidth: Math.round(this.cssWidth * this.renderer.getPixelRatio() * this.post.effectiveScale),
      renderHeight: Math.round(this.cssHeight * this.renderer.getPixelRatio() * this.post.effectiveScale),
      displayWidth: Math.round(window.screen.width * (window.devicePixelRatio || 1)),
      displayHeight: Math.round(window.screen.height * (window.devicePixelRatio || 1)),
      dpr: this.dpr,
      renderScale: this.post.effectiveScale,
      backend: this.kind === 'webgpu' ? 'WebGPU' : 'WebGL 2',
      adapter: this.adapterLabel,
    });
  }

  /**
   * Renders one frame through the post pipeline to compile every material with the same MRT
   * layout used in play (compileAsync would compile against a non-MRT target).
   */
  warmUpFrame(): void {
    this.post.render();
  }

  get currentSettings(): Settings | null {
    return this.settings;
  }

  dispose(): void {
    this.environments.dispose();
    this.feedback.dispose();
    this.bursts.dispose();
    this.post.dispose();
    this.board.dispose();
    this.backdrop.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
  }
}
