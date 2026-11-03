import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { PieceType } from '../game/pieces/pieces';
import type { ModeId } from '../game/modes/modes';
import type { SessionStats } from '../game/core/types';
import type { HighScoreEntry } from '../storage/repositories';
import type { PadInfo } from '../input/types';

export type Screen =
  | 'boot'
  | 'title'
  | 'main'
  | 'modes'
  | 'setup'
  | 'stages'
  | 'voyage'
  | 'loading'
  | 'game'
  | 'results'
  | 'highscores'
  | 'settings'
  | 'musicRoom'
  | 'credits'
  | 'creator'
  | 'replay';

export interface Toast {
  readonly id: number;
  readonly text: string;
  readonly tone: 'info' | 'success' | 'warning';
}

export interface GameResults {
  readonly modeId: ModeId;
  readonly variantId: string;
  readonly stageId: string;
  readonly outcome: 'complete' | 'gameOver' | 'quit';
  readonly score: number;
  readonly timeMs: number;
  readonly lines: number;
  readonly level: number;
  readonly stats: SessionStats;
  readonly rank: number | null;
  readonly best: HighScoreEntry | null;
  readonly isPersonalBest: boolean;
  readonly replayId: string | null;
  /** Names of worlds and areas unlocked by this run. */
  readonly unlocked: readonly string[];
  readonly voyage: { readonly legsCleared: number; readonly legs: number; readonly lastStage: string; readonly areaName: string } | null;
}

export interface RendererInfo {
  readonly backend: 'webgpu' | 'webgl2' | 'canvas2d';
  readonly adapter: string;
  readonly fallback: boolean;
}

export interface AppState {
  readonly screen: Screen;
  readonly history: readonly Screen[];
  readonly paused: boolean;
  readonly pauseView: 'menu' | 'settings';
  readonly results: GameResults | null;
  readonly toasts: readonly Toast[];
  readonly audioUnlocked: boolean;
  readonly renderer: RendererInfo | null;
  readonly pads: readonly PadInfo[];
  readonly loading: { readonly label: string; readonly progress: number } | null;
  readonly storageKind: string;
  readonly fatalError: string | null;
  /** Device used most recently (for button hints). */
  readonly device: 'keyboard' | 'gamepad';
  readonly padFamily: 'playstation' | 'xbox' | 'generic';
}

export const appStore = createStore<AppState>(() => ({
  screen: 'boot',
  history: [],
  paused: false,
  pauseView: 'menu',
  results: null,
  toasts: [],
  audioUnlocked: false,
  renderer: null,
  pads: [],
  loading: null,
  storageKind: 'unknown',
  fatalError: null,
  device: 'keyboard',
  padFamily: 'generic',
}));

export function useApp<T>(selector: (s: AppState) => T): T {
  return useStore(appStore, selector);
}

export function navigate(screen: Screen, replace = false): void {
  const s = appStore.getState();
  if (s.screen === screen) return;
  appStore.setState({ screen, history: replace ? s.history : [...s.history, s.screen].slice(-20) });
}

export function goBack(fallback: Screen = 'main'): void {
  const s = appStore.getState();
  const history = [...s.history];
  let prev = history.pop();
  // Never go "back" into transient screens.
  while (prev && (prev === 'loading' || prev === 'game' || prev === 'boot' || prev === 'results' || prev === 'replay')) prev = history.pop();
  appStore.setState({ screen: prev ?? fallback, history });
}

let toastId = 0;
export function toast(text: string, tone: Toast['tone'] = 'info', ms = 3200): void {
  const t: Toast = { id: ++toastId, text, tone };
  appStore.setState({ toasts: [...appStore.getState().toasts, t].slice(-4) });
  setTimeout(() => appStore.setState({ toasts: appStore.getState().toasts.filter((x) => x.id !== t.id) }), ms);
}

// ----------------------------------------------------------------------------- HUD

export interface Callout {
  readonly id: number;
  readonly title: string;
  readonly detail: string;
  /** 0..1+ — drives size/emphasis. */
  readonly intensity: number;
  readonly tone: 'clear' | 'spin' | 'combo' | 'b2b' | 'pc' | 'level' | 'info';
}

export interface HudState {
  readonly visible: boolean;
  readonly modeId: ModeId | null;
  readonly score: number;
  readonly best: number | null;
  readonly level: number;
  readonly lines: number;
  readonly linesGoal: number | null;
  readonly timeLimitMs: number | null;
  readonly combo: number;
  readonly backToBack: number;
  readonly hold: PieceType | null;
  readonly holdUsed: boolean;
  readonly next: readonly PieceType[];
  readonly pieces: number;
  readonly inputs: number;
  readonly callouts: readonly Callout[];
  readonly intro: 'ready' | 'go' | null;
  readonly countdown: number | null;
  readonly danger: boolean;
  /** Board rectangle in CSS pixels for anchoring the HUD (from the view). */
  readonly boardRect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null;
  readonly stageName: string;
  /** Voyage: current leg (null outside Voyage). */
  readonly voyage: { readonly leg: number; readonly legs: number; readonly stage: string } | null;
}

export const hudStore = createStore<HudState>(() => ({
  visible: false,
  modeId: null,
  score: 0,
  best: null,
  level: 1,
  lines: 0,
  linesGoal: null,
  timeLimitMs: null,
  combo: -1,
  backToBack: -1,
  hold: null,
  holdUsed: false,
  next: [],
  pieces: 0,
  inputs: 0,
  callouts: [],
  intro: null,
  countdown: null,
  danger: false,
  boardRect: null,
  stageName: '',
  voyage: null,
}));

export function useHud<T>(selector: (s: HudState) => T): T {
  return useStore(hudStore, selector);
}

let calloutId = 0;
export function pushCallout(c: Omit<Callout, 'id'>, ms = 1600): void {
  const callout: Callout = { ...c, id: ++calloutId };
  hudStore.setState({ callouts: [...hudStore.getState().callouts, callout].slice(-3) });
  setTimeout(() => hudStore.setState({ callouts: hudStore.getState().callouts.filter((x) => x.id !== callout.id) }), ms);
}
