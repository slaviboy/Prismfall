import type { InstrumentSpec } from '../sequencer/composition';
import { playNote } from '../synth/instruments';

export const SFX_IDS = [
  'move',
  'rotate',
  'rotateFail',
  'softDrop',
  'hardDrop',
  'land',
  'lock',
  'hold',
  'holdDenied',
  'clear1',
  'clear2',
  'clear3',
  'clear4',
  'tspin',
  'combo',
  'b2b',
  'perfect',
  'levelUp',
  'danger',
  'gameOver',
  'menuMove',
  'menuConfirm',
  'menuBack',
  'countdown',
  'go',
  'transition',
] as const;
export type SfxId = (typeof SFX_IDS)[number];

/** Timbre families for gameplay sounds; stages pick one so feedback matches their world. */
export interface SfxPreset {
  readonly tick: InstrumentSpec;
  readonly tone: InstrumentSpec;
  readonly chord: InstrumentSpec;
  readonly thud: InstrumentSpec;
  readonly shimmer: InstrumentSpec;
  readonly brightness: number;
}

const p = (spec: InstrumentSpec): InstrumentSpec => spec;

export const SFX_PRESETS: Record<string, SfxPreset> = {
  glass: { tick: p({ kind: 'mallet', ratio: 3.98, index: 1.2, decay: 0.12 }), tone: p({ kind: 'bell', ratio: 3.5, index: 1.8, decay: 0.6 }), chord: p({ kind: 'bell', ratio: 2.76, index: 2.2, decay: 1.6 }), thud: p({ kind: 'kick', tone: 110, decay: 0.16 }), shimmer: p({ kind: 'bell', ratio: 5.1, index: 1.4, decay: 2.2 }), brightness: 1 },
  metal: { tick: p({ kind: 'mallet', ratio: 2.71, index: 3.2, decay: 0.08 }), tone: p({ kind: 'bell', ratio: 1.41, index: 3.6, decay: 0.5 }), chord: p({ kind: 'bell', ratio: 1.41, index: 4, decay: 1.3 }), thud: p({ kind: 'kick', tone: 90, decay: 0.24, drive: 0.6 }), shimmer: p({ kind: 'bell', ratio: 2.71, index: 2.8, decay: 1.8 }), brightness: 0.8 },
  crystal: { tick: p({ kind: 'mallet', ratio: 5.2, index: 1, decay: 0.1 }), tone: p({ kind: 'bell', ratio: 4.2, index: 1.5, decay: 0.8 }), chord: p({ kind: 'bell', ratio: 3.5, index: 1.9, decay: 2.2 }), thud: p({ kind: 'kick', tone: 130, decay: 0.14 }), shimmer: p({ kind: 'bell', ratio: 6.3, index: 1.1, decay: 2.8 }), brightness: 1.2 },
  organic: { tick: p({ kind: 'mallet', ratio: 4, index: 1.6, decay: 0.15 }), tone: p({ kind: 'mallet', ratio: 4, index: 2, decay: 0.45 }), chord: p({ kind: 'epiano', ratio: 1, index: 1.5, decay: 1.4 }), thud: p({ kind: 'tom', decay: 0.25, tone: 120 }), shimmer: p({ kind: 'mallet', ratio: 3, index: 1.2, decay: 0.9 }), brightness: 0.9 },
  neon: { tick: p({ kind: 'pluck', wave: 'square', cutoff: 2400, envAmount: 2, decay: 0.05 }), tone: p({ kind: 'pluck', wave: 'square', cutoff: 1800, envAmount: 2.5, decay: 0.2 }), chord: p({ kind: 'pluck', wave: 'sawtooth', cutoff: 1500, envAmount: 3, decay: 0.6, voices: 2, detune: 14 }), thud: p({ kind: 'kick', tone: 140, decay: 0.18, drive: 0.4 }), shimmer: p({ kind: 'bell', ratio: 2, index: 2.4, decay: 1.4 }), brightness: 1.1 },
  paper: { tick: p({ kind: 'perc' }), tone: p({ kind: 'mallet', ratio: 3, index: 0.9, decay: 0.3 }), chord: p({ kind: 'epiano', ratio: 1, index: 0.9, decay: 1.2 }), thud: p({ kind: 'tom', decay: 0.18, tone: 150 }), shimmer: p({ kind: 'bell', ratio: 4, index: 0.8, decay: 1.6 }), brightness: 0.7 },
  stone: { tick: p({ kind: 'perc' }), tone: p({ kind: 'mallet', ratio: 2.4, index: 1.8, decay: 0.35 }), chord: p({ kind: 'bell', ratio: 2.4, index: 2.6, decay: 1.5 }), thud: p({ kind: 'kick', tone: 80, decay: 0.3 }), shimmer: p({ kind: 'bell', ratio: 3.1, index: 1.6, decay: 2 }), brightness: 0.75 },
  ice: { tick: p({ kind: 'mallet', ratio: 6.1, index: 0.9, decay: 0.09 }), tone: p({ kind: 'bell', ratio: 5.4, index: 1.2, decay: 0.7 }), chord: p({ kind: 'bell', ratio: 4.1, index: 1.5, decay: 2.4 }), thud: p({ kind: 'kick', tone: 120, decay: 0.15 }), shimmer: p({ kind: 'bell', ratio: 7.2, index: 0.9, decay: 3 }), brightness: 1.25 },
};

interface Recipe {
  readonly length: number;
  render(ctx: OfflineAudioContext, out: AudioNode, preset: SfxPreset, root: number): void;
}

/** Scale degrees (semitones from the root) used to keep effects in the stage's key. */
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

const RECIPES: Record<SfxId, Recipe> = {
  move: { length: 0.25, render: (c, o, s, r) => void playNote(c, o, s.tick, r + 36, 0, 0.04, 0.32) },
  rotate: {
    length: 0.35,
    render: (c, o, s, r) => {
      playNote(c, o, s.tick, r + 43, 0, 0.04, 0.34);
      playNote(c, o, s.tick, r + 48, 0.025, 0.04, 0.24);
    },
  },
  rotateFail: { length: 0.25, render: (c, o, s, r) => void playNote(c, o, s.tick, r + 24, 0, 0.03, 0.22) },
  softDrop: { length: 0.2, render: (c, o, s, r) => void playNote(c, o, s.tick, r + 31, 0, 0.02, 0.12) },
  hardDrop: {
    length: 0.7,
    render: (c, o, s, r) => {
      playNote(c, o, s.thud, r + 24, 0, 0.1, 0.9);
      playNote(c, o, { kind: 'hat', decay: 0.09 }, 60, 0, 0.05, 0.6);
      playNote(c, o, s.tone, r + 12, 0.005, 0.1, 0.45);
    },
  },
  land: { length: 0.35, render: (c, o, s, r) => void playNote(c, o, s.thud, r + 24, 0, 0.06, 0.32) },
  lock: {
    length: 0.4,
    render: (c, o, s, r) => {
      playNote(c, o, s.thud, r + 24, 0, 0.05, 0.42);
      playNote(c, o, s.tick, r + 31, 0.01, 0.03, 0.22);
    },
  },
  hold: {
    length: 0.5,
    render: (c, o, s, r) => {
      playNote(c, o, s.tone, r + 38, 0, 0.06, 0.38);
      playNote(c, o, s.tone, r + 31, 0.06, 0.06, 0.32);
    },
  },
  holdDenied: { length: 0.3, render: (c, o, s, r) => void playNote(c, o, s.tick, r + 13, 0, 0.08, 0.3) },
  clear1: {
    length: 1.6,
    render: (c, o, s, r) => {
      playNote(c, o, s.chord, r + 24, 0, 0.3, 0.55);
      playNote(c, o, s.chord, r + 31, 0.03, 0.3, 0.45);
    },
  },
  clear2: { length: 1.8, render: (c, o, s, r) => [0, 4, 7].forEach((n, i) => playNote(c, o, s.chord, r + 24 + n, i * 0.035, 0.3, 0.55)) },
  clear3: { length: 2, render: (c, o, s, r) => [0, 4, 7, 12].forEach((n, i) => playNote(c, o, s.chord, r + 24 + n, i * 0.04, 0.35, 0.6)) },
  clear4: {
    length: 2.8,
    render: (c, o, s, r) => {
      playNote(c, o, { kind: 'impact' }, 36, 0, 1, 0.7);
      [0, 4, 7, 12, 16, 19].forEach((n, i) => playNote(c, o, s.chord, r + 24 + n, i * 0.045, 0.4, 0.62));
      [24, 28, 31].forEach((n, i) => playNote(c, o, s.shimmer, r + 24 + n, 0.25 + i * 0.07, 0.5, 0.3));
    },
  },
  tspin: {
    length: 1.6,
    render: (c, o, s, r) => {
      playNote(c, o, { kind: 'riser' }, 60, 0, 0.18, 0.5);
      [2, 9, 14].forEach((n, i) => playNote(c, o, s.chord, r + 24 + n, 0.12 + i * 0.03, 0.3, 0.55));
    },
  },
  combo: { length: 0.9, render: (c, o, s, r) => void playNote(c, o, s.tone, r + 36, 0, 0.12, 0.5) },
  b2b: {
    length: 2,
    render: (c, o, s, r) => {
      playNote(c, o, s.shimmer, r + 48, 0, 0.4, 0.4);
      playNote(c, o, s.shimmer, r + 55, 0.05, 0.4, 0.32);
    },
  },
  perfect: {
    length: 3.6,
    render: (c, o, s, r) => {
      playNote(c, o, { kind: 'impact' }, 36, 0, 1, 0.6);
      PENTA.forEach((n, i) => playNote(c, o, s.shimmer, r + 36 + n, i * 0.06, 0.6, 0.45));
      [0, 7, 12].forEach((n) => playNote(c, o, s.chord, r + 24 + n, 0, 1.2, 0.5));
    },
  },
  levelUp: { length: 2.2, render: (c, o, s, r) => [0, 4, 7, 12, 16].forEach((n, i) => playNote(c, o, s.tone, r + 36 + n, i * 0.08, 0.2, 0.5)) },
  danger: {
    length: 0.9,
    render: (c, o, _s, r) => {
      playNote(c, o, { kind: 'kick', tone: 70, decay: 0.22 }, r, 0, 0.1, 0.55);
      playNote(c, o, { kind: 'kick', tone: 70, decay: 0.22 }, r, 0.22, 0.1, 0.4);
    },
  },
  gameOver: { length: 3.5, render: (c, o, s, r) => [12, 7, 3, 0, -5].forEach((n, i) => playNote(c, o, s.chord, r + 24 + n, i * 0.18, 0.6, 0.5)) },
  menuMove: { length: 0.2, render: (c, o, s, r) => void playNote(c, o, s.tick, r + 40, 0, 0.03, 0.2) },
  menuConfirm: {
    length: 0.5,
    render: (c, o, s, r) => {
      playNote(c, o, s.tone, r + 36, 0, 0.06, 0.3);
      playNote(c, o, s.tone, r + 43, 0.05, 0.06, 0.3);
    },
  },
  menuBack: {
    length: 0.5,
    render: (c, o, s, r) => {
      playNote(c, o, s.tone, r + 43, 0, 0.06, 0.26);
      playNote(c, o, s.tone, r + 36, 0.05, 0.06, 0.26);
    },
  },
  countdown: { length: 0.8, render: (c, o, s, r) => void playNote(c, o, s.tone, r + 31, 0, 0.1, 0.45) },
  go: { length: 1.4, render: (c, o, s, r) => [0, 7, 12].forEach((n) => playNote(c, o, s.chord, r + 36 + n, 0, 0.3, 0.45)) },
  transition: {
    length: 3,
    render: (c, o, s, r) => {
      playNote(c, o, { kind: 'riser' }, 60, 0, 2.2, 0.55);
      playNote(c, o, s.shimmer, r + 48, 2.2, 0.5, 0.35);
    },
  },
};

/** Renders and plays gameplay/UI sounds. Buffers are cached per (preset, key). */
export class SfxBank {
  private buffers = new Map<SfxId, AudioBuffer>();
  private currentKey = '';
  private readonly lastPlayed = new Map<SfxId, number>();

  constructor(
    private readonly getContext: () => AudioContext | null,
    private readonly gameBus: () => AudioNode | null,
    private readonly uiBus: () => AudioNode | null,
  ) {}

  get ready(): boolean {
    return this.buffers.size > 0;
  }

  /** Renders every effect for a preset and key root (0..11). */
  async build(presetName: string, keyRoot: number, overrides: Partial<Record<SfxId, AudioBuffer>> = {}): Promise<void> {
    const ctx = this.getContext();
    if (!ctx) return;
    const key = `${presetName}:${keyRoot}`;
    if (key === this.currentKey) return;
    const preset = SFX_PRESETS[presetName] ?? (SFX_PRESETS.glass as SfxPreset);
    const root = 48 + keyRoot;
    const entries = await Promise.all(
      SFX_IDS.map(async (id) => {
        if (overrides[id]) return [id, overrides[id] as AudioBuffer] as const;
        const recipe = RECIPES[id];
        const offline = new OfflineAudioContext(2, Math.ceil(recipe.length * ctx.sampleRate), ctx.sampleRate);
        const gain = offline.createGain();
        gain.gain.value = 0.9;
        gain.connect(offline.destination);
        recipe.render(offline, gain, preset, root);
        return [id, await offline.startRendering()] as const;
      }),
    );
    this.buffers = new Map(entries);
    this.currentKey = key;
  }

  /** Plays an effect. `semitones` transposes (combo ladder); `minGapMs` limits rapid repeats. */
  play(id: SfxId, options: { semitones?: number; gain?: number; pan?: number; minGapMs?: number } = {}): void {
    const ctx = this.getContext();
    const buffer = this.buffers.get(id);
    const ui = id.startsWith('menu');
    const bus = ui ? this.uiBus() : this.gameBus();
    if (!ctx || !buffer || !bus || ctx.state !== 'running') return;
    const now = performance.now();
    const gap = options.minGapMs ?? (id === 'move' || id === 'softDrop' ? 18 : 0);
    if (gap > 0 && now - (this.lastPlayed.get(id) ?? 0) < gap) return;
    this.lastPlayed.set(id, now);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (options.semitones) src.playbackRate.value = Math.pow(2, options.semitones / 12);
    const g = ctx.createGain();
    g.gain.value = options.gain ?? 1;
    let out: AudioNode = g;
    if (options.pan) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, options.pan));
      g.connect(pan);
      out = pan;
    }
    src.connect(g);
    out.connect(bus);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
      if (out !== g) out.disconnect();
    };
    src.start();
  }

  /** Pentatonic transposition for the n-th combo step. */
  static comboSemitones(combo: number): number {
    return PENTA[Math.min(PENTA.length - 1, Math.max(0, combo - 1))] as number;
  }
}

/** Exposed for offline loudness checks (audio acceptance tests). */
export function renderRecipe(ctx: OfflineAudioContext, id: SfxId, presetName: string, keyRoot: number): void {
  const gain = ctx.createGain();
  gain.gain.value = 0.9;
  gain.connect(ctx.destination);
  RECIPES[id].render(ctx, gain, SFX_PRESETS[presetName] ?? (SFX_PRESETS.glass as SfxPreset), 48 + keyRoot);
}

export function recipeLength(id: SfxId): number {
  return RECIPES[id].length;
}
