import { assetCache } from '../rendering/assets/AssetCache';
import type { StageEnvironment } from '../rendering/environments/StageEnvironment';
import type { RenderSystem } from '../rendering/renderer/RenderSystem';
import { perfStore } from '../rendering/renderer/perfStore';
import type { StageAssets } from '../sdk/types';
import { availableStages, getStage, loadStageModule, resolveAsset, type StageInfo } from './registry';

export interface ShowOptions {
  /** Crossfade length in seconds (0 = cut). */
  readonly transition?: number;
  readonly onProgress?: (fraction: number) => void;
}

/**
 * Loads stages on demand (module, assets, environment build, shader warm-up), switches between
 * them, preloads upcoming ones and unloads the rest. Rendering details live in EnvironmentHost.
 */
export class StageManager {
  private readonly inflight = new Map<string, Promise<StageEnvironment>>();
  activeId: string | null = null;
  /** Called when a stage becomes active (music BPM, palette, effects). */
  onActivate: ((info: StageInfo) => void) | null = null;
  lastError: string | null = null;

  constructor(private readonly render: RenderSystem) {}

  stages(): StageInfo[] {
    return availableStages();
  }

  private assetsFor(info: StageInfo): StageAssets {
    const resolve = (rel: string): string | null => (rel.startsWith('/content/') ? resolveAsset('', rel) : resolveAsset(info.dir, rel));
    return {
      url: resolve,
      loadGLTF: (rel) => {
        const url = resolve(rel);
        if (!url) return Promise.reject(new Error(`asset ${rel} not found in ${info.id}`));
        return assetCache.load(url);
      },
      release: (rel) => {
        const url = resolve(rel);
        if (url) assetCache.release(url);
      },
    };
  }

  /** Builds (or returns the cached) environment for a stage without showing it. */
  prepare(id: string, onProgress?: (fraction: number) => void): Promise<StageEnvironment> {
    const existing = this.inflight.get(id);
    if (existing) return existing;
    const info = getStage(id);
    if (!info || !info.manifest || !info.available) return Promise.reject(new Error(info ? info.errors.join('; ') : `unknown stage ${id}`));
    const manifest = info.manifest;
    const started = performance.now();
    const task = (async () => {
      await loadStageModule(info);
      onProgress?.(0.08);
      const buildStart = performance.now();
      const env = await this.render.environments.prepare(manifest, this.assetsFor(info), this.render.quality(), (f) => onProgress?.(0.08 + f * 0.92));
      const total = performance.now() - started;
      perfStore.setState({ stageLoadMs: total, stageCompileMs: performance.now() - buildStart });
      return env;
    })();
    this.inflight.set(id, task);
    task.catch(() => this.inflight.delete(id));
    return task;
  }

  /** Shows a stage (loading it first if needed). Falls back to the neutral backdrop on failure. */
  async show(id: string, options: ShowOptions = {}): Promise<boolean> {
    const info = getStage(id);
    if (!info?.manifest) return false;
    try {
      const env = await this.prepare(id, options.onProgress);
      // A newer request may have superseded this one while loading.
      if (this.pendingShow !== null && this.pendingShow !== id) return false;
      this.render.environments.activate(env, options.transition ?? 2.5, (geometry) => void this.render.setBlockDesign(geometry));
      this.render.feedback.palette = info.manifest.palette;
      this.render.feedback.lineClearEffect = { effect: info.manifest.effects.lineClear.effect, params: info.manifest.effects.lineClear.params };
      this.activeId = id;
      this.lastError = null;
      this.onActivate?.(info);
      // Keep cache bounded to what is on screen plus one preloaded stage.
      for (const key of [...this.inflight.keys()]) if (!this.render.environments.preparedIds.includes(key)) this.inflight.delete(key);
      return true;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error(`[stages] failed to load "${id}"`, err);
      return false;
    }
  }

  private pendingShow: string | null = null;

  /** Debounced preview (stage select): only the last requested stage is shown. */
  preview(id: string, delayMs = 250, transition = 1.2): void {
    this.pendingShow = id;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      if (this.pendingShow === id) void this.show(id, { transition }).finally(() => {
        if (this.pendingShow === id) this.pendingShow = null;
      });
    }, delayMs);
  }

  private previewTimer: ReturnType<typeof setTimeout> | null = null;

  /** Starts loading a stage in the background (e.g. the next Voyage leg). */
  preload(id: string): void {
    void this.prepare(id).catch(() => undefined);
  }

  /** Quality settings changed: rebuild environments with the new detail level. */
  async rebuild(): Promise<void> {
    const id = this.activeId;
    this.render.environments.clearCache();
    this.inflight.clear();
    if (id) {
      this.activeId = null;
      this.render.environments.deactivate(0.001);
      this.render.environments.clearCache();
      await this.show(id, { transition: 0.6 });
    }
  }
}
