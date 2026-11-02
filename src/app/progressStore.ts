import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { emptyProgress, type LifetimeStats, type Progress } from '../storage/repositories';
import { emptyStats } from '../game/core/types';

export interface ProgressState {
  readonly progress: Progress;
  readonly lifetime: LifetimeStats;
}

export const progressStore = createStore<ProgressState>(() => ({
  progress: emptyProgress(),
  lifetime: { ...emptyStats(), games: 0, playTimeMs: 0 },
}));

export function useProgress<T>(selector: (s: ProgressState) => T): T {
  return useStore(progressStore, selector);
}
