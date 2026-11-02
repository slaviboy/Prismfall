import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { defaultSettings, type Settings, type SettingsSection } from './schema';
import { applyPreset, detectPreset, type QualityPreset } from './presets';
import type { HandlingConfig } from '../game/core/types';

export interface SettingsState {
  readonly settings: Settings;
  /** True once persisted settings were loaded (or defaults confirmed). */
  readonly loaded: boolean;
}

export const settingsStore = createStore<SettingsState>(() => ({ settings: defaultSettings(), loaded: false }));

export function getSettings(): Settings {
  return settingsStore.getState().settings;
}

export function replaceSettings(settings: Settings, loaded = true): void {
  settingsStore.setState({ settings, loaded });
}

/** Shallow-merges a patch into one section. */
export function updateSection<K extends SettingsSection>(section: K, patch: Partial<Settings[K]>): void {
  const current = getSettings();
  let nextSection = { ...current[section], ...patch } as Settings[K];
  if (section === 'graphics') {
    const g = nextSection as Settings['graphics'];
    const patchKeys = Object.keys(patch);
    if (patchKeys.includes('preset') && g.preset !== 'custom') {
      nextSection = applyPreset(g, g.preset as QualityPreset) as Settings[K];
    } else if (!patchKeys.includes('preset')) {
      nextSection = { ...g, preset: detectPreset(g) } as Settings[K];
    }
  }
  settingsStore.setState({ settings: { ...current, [section]: nextSection } });
}

export function resetSection<K extends SettingsSection>(section: K): void {
  const defaults = defaultSettings();
  settingsStore.setState({ settings: { ...getSettings(), [section]: defaults[section] } });
}

export function useSettings<T>(selector: (s: Settings) => T): T {
  return useStore(settingsStore, (state) => selector(state.settings));
}

/** Subscribes to a derived slice; the listener fires only when the slice changes (Object.is). */
export function subscribeSettings<T>(selector: (s: Settings) => T, listener: (value: T, prev: T) => void): () => void {
  let prev = selector(getSettings());
  return settingsStore.subscribe((state) => {
    const next = selector(state.settings);
    if (!Object.is(next, prev)) {
      const old = prev;
      prev = next;
      listener(next, old);
    }
  });
}

export function handlingFromSettings(s: Settings): HandlingConfig {
  const g = s.gameplay;
  return {
    dasMs: g.dasMs,
    arrMs: g.arrMs,
    softDropFactor: g.softDropFactor >= 41 ? Infinity : g.softDropFactor,
    dasCutMs: g.dasCutMs,
    bufferInitialActions: g.bufferInitialActions,
    bufferHardDrop: g.bufferHardDrop,
  };
}

/** Effective reduced-motion flag (setting overrides the OS preference). */
export function reducedMotion(s: Settings): boolean {
  if (s.accessibility.reducedMotion === 'on') return true;
  if (s.accessibility.reducedMotion === 'off') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
