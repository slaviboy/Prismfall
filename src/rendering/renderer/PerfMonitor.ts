import type { WebGPURenderer } from 'three/webgpu';
import { perfStore } from './perfStore';

const WINDOW = 240;

/**
 * Collects frame timing (rAF intervals), CPU time per subsystem, GPU time (WebGPU timestamp
 * queries when available) and renderer counters. Publishes a snapshot twice a second.
 */
export class PerfMonitor {
  private readonly intervals = new Float64Array(WINDOW);
  private count = 0;
  private cursor = 0;
  private lastFrame = 0;
  private readonly cpuSums = new Map<string, number>();
  private cpuFrames = 0;
  private gpuMs: number | null = null;
  private resolving = false;
  private frameIndex = 0;
  private lastPublish = 0;
  refreshHz = 60;
  private refreshSamples: number[] = [];

  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly timestamps: boolean,
  ) {}

  /** Call once per rAF with the frame timestamp. */
  frame(now: number): void {
    if (this.lastFrame > 0) {
      const dt = now - this.lastFrame;
      if (dt > 0 && dt < 250) {
        this.intervals[this.cursor] = dt;
        this.cursor = (this.cursor + 1) % WINDOW;
        this.count = Math.min(WINDOW, this.count + 1);
        if (this.refreshSamples.length < 120) {
          this.refreshSamples.push(dt);
          if (this.refreshSamples.length === 120) this.refreshHz = this.estimateRefresh();
        }
      }
    }
    this.lastFrame = now;
    this.frameIndex++;
    this.cpuFrames++;
  }

  /** Measured display refresh rate from the median rAF interval (rounded to common rates). */
  private estimateRefresh(): number {
    const sorted = [...this.refreshSamples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 16.67;
    const hz = 1000 / median;
    const common = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 170, 175, 180, 200, 240, 280, 360];
    return common.reduce((best, c) => (Math.abs(c - hz) < Math.abs(best - hz) ? c : best), 60);
  }

  addCpu(label: string, ms: number): void {
    this.cpuSums.set(label, (this.cpuSums.get(label) ?? 0) + ms);
  }

  /** Resolves GPU timestamps periodically (async, never blocks the frame). */
  afterRender(): void {
    if (!this.timestamps || this.resolving || this.frameIndex % 15 !== 0) return;
    this.resolving = true;
    this.renderer
      .resolveTimestampsAsync('render')
      .then((ms) => {
        if (typeof ms === 'number' && Number.isFinite(ms)) this.gpuMs = ms;
      })
      .catch(() => undefined)
      .finally(() => (this.resolving = false));
  }

  publish(now: number, extra: { renderWidth: number; renderHeight: number; displayWidth: number; displayHeight: number; dpr: number; renderScale: number; backend: string; adapter: string }): void {
    if (now - this.lastPublish < 500) return;
    this.lastPublish = now;
    const n = this.count;
    const values = Array.from(this.intervals.subarray(0, n)).sort((a, b) => a - b);
    const avg = n > 0 ? values.reduce((a, b) => a + b, 0) / n : 0;
    const pct = (p: number): number => (n > 0 ? (values[Math.min(n - 1, Math.floor(n * p))] ?? 0) : 0);
    const cpu: Record<string, number> = {};
    for (const [k, v] of this.cpuSums) cpu[k] = v / Math.max(1, this.cpuFrames);
    this.cpuSums.clear();
    this.cpuFrames = 0;
    const info = this.renderer.info;
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    perfStore.setState({
      fps: avg > 0 ? 1000 / avg : 0,
      frameMs: avg,
      p95Ms: pct(0.95),
      p99Ms: pct(0.99),
      gpuMs: this.gpuMs,
      cpu,
      drawCalls: info.render.drawCalls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      heapMb: memory ? memory.usedJSHeapSize / 1048576 : null,
      refreshHz: this.refreshHz,
      ...extra,
    });
  }
}
