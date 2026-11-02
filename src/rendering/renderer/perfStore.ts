import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

export interface PerfSnapshot {
  readonly fps: number;
  readonly frameMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly gpuMs: number | null;
  /** CPU milliseconds per subsystem (averaged). */
  readonly cpu: Readonly<Record<string, number>>;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly heapMb: number | null;
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly dpr: number;
  readonly refreshHz: number;
  readonly renderScale: number;
  readonly backend: string;
  readonly adapter: string;
  readonly stageLoadMs: number | null;
  readonly stageCompileMs: number | null;
}

export const perfStore = createStore<PerfSnapshot>(() => ({
  fps: 0,
  frameMs: 0,
  p95Ms: 0,
  p99Ms: 0,
  gpuMs: null,
  cpu: {},
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  heapMb: null,
  renderWidth: 0,
  renderHeight: 0,
  displayWidth: 0,
  displayHeight: 0,
  dpr: 1,
  refreshHz: 60,
  renderScale: 1,
  backend: '',
  adapter: '',
  stageLoadMs: null,
  stageCompileMs: null,
}));

export function usePerf<T>(selector: (s: PerfSnapshot) => T): T {
  return useStore(perfStore, selector);
}
