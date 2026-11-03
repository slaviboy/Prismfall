import type { InstrumentSpec } from '../sequencer/composition';
import { playNote } from '../synth/instruments';
import { resolveMaterialAudio, type MaterialAudioProfile } from './materialAudio';
import { MATERIAL_JOBS, renderMaterialSet, type MaterialRenderResult } from './materialJobs';
import type { MaterialWorkerRequest, MaterialWorkerResponse } from './materialRender.worker';
import MaterialWorker from './materialRender.worker.ts?worker';

export const SFX_IDS = [
  'spawn',
  'move',
  'rotate',
  'rotateCcw',
  'rotateFail',
  'softDrop',
  'hardDrop',
  'hardDropHeavy',
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
  'comboMid',
  'comboHigh',
  'b2b',
  'perfect',
  'levelUp',
  'stageComplete',
  'unlock',
  'danger',
  'gameOver',
  'pause',
  'resume',
  'menuMove',
  'menuSelect',
  'menuConfirm',
  'menuBack',
  'countdown',
  'go',
  'transition',
  'signature',
  'impactResponse',
  'footstep',
] as const;
export type SfxId = (typeof SFX_IDS)[number];

/** Mixer bus each effect plays on (see AudioEngine). */
export type SfxBus = 'sfx' | 'impacts' | 'stage' | 'ui';

const BUS: Partial<Record<SfxId, SfxBus>> = {
  softDrop: 'impacts',
  hardDrop: 'impacts',
  hardDropHeavy: 'impacts',
  land: 'impacts',
  lock: 'impacts',
  signature: 'stage',
  impactResponse: 'stage',
  footstep: 'stage',
  menuMove: 'ui',
  menuSelect: 'ui',
  menuConfirm: 'ui',
  menuBack: 'ui',
  pause: 'ui',
  resume: 'ui',
  unlock: 'ui',
};

export function busOf(id: SfxId): SfxBus {
  return BUS[id] ?? 'sfx';
}

/** Timbre families for the tonal (musical) side of gameplay sounds; stages pick one. */
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
  /** Warm plucked strings and hand percussion (desert). */
  oasis: { tick: p({ kind: 'pluck', wave: 'triangle', cutoff: 2200, envAmount: 1.4, decay: 0.08 }), tone: p({ kind: 'pluck', wave: 'sawtooth', cutoff: 1600, envAmount: 2.2, decay: 0.45 }), chord: p({ kind: 'pluck', wave: 'triangle', cutoff: 2000, envAmount: 1.8, decay: 1.2 }), thud: p({ kind: 'tom', tone: 80, decay: 0.3 }), shimmer: p({ kind: 'bell', ratio: 3.5, index: 1.2, decay: 2 }), brightness: 0.9 },
  /** Koto-like plucks and wooden mallets (Japan). */
  koto: { tick: p({ kind: 'mallet', ratio: 2.01, index: 0.8, decay: 0.1 }), tone: p({ kind: 'pluck', wave: 'triangle', cutoff: 2600, envAmount: 2, decay: 0.6 }), chord: p({ kind: 'pluck', wave: 'triangle', cutoff: 2400, envAmount: 2, decay: 1.4 }), thud: p({ kind: 'tom', tone: 140, decay: 0.2 }), shimmer: p({ kind: 'bell', ratio: 2.76, index: 1, decay: 2.6 }), brightness: 0.85 },
  /** Deep synth tones (space, abyss). */
  void: { tick: p({ kind: 'bell', ratio: 1.5, index: 0.8, decay: 0.12 }), tone: p({ kind: 'epiano', ratio: 1, index: 0.8, decay: 0.9 }), chord: p({ kind: 'pad', wave: 'sawtooth', voices: 3, detune: 12, cutoff: 1200, attack: 0.02, release: 1.6 }), thud: p({ kind: 'kick', tone: 70, decay: 0.4 }), shimmer: p({ kind: 'bell', ratio: 4.5, index: 1, decay: 3 }), brightness: 0.85 },
};

interface Recipe {
  /** Seconds of tonal render (0 = material only). */
  readonly length: number;
  render?(ctx: OfflineAudioContext, out: AudioNode, preset: SfxPreset, root: number): void;
  /** Max pitch variation (semitones) at full "sound variation"; 0 keeps musical accents in key. */
  readonly pitchVar: number;
}

/** Scale degrees (semitones from the root) used to keep effects in the stage's key. */
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

const tone = (length: number, pitchVar: number, render: Recipe['render']): Recipe => ({ length, pitchVar, render });
const materialOnly = (pitchVar: number): Recipe => ({ length: 0, pitchVar });

const RECIPES: Record<SfxId, Recipe> = {
  spawn: materialOnly(1),
  move: tone(0.25, 0.25, (c, o, s, r) => void playNote(c, o, s.tick, r + 36, 0, 0.04, 0.32)),
  rotate: tone(0.35, 0.2, (c, o, s, r) => {
    playNote(c, o, s.tick, r + 43, 0, 0.04, 0.34);
    playNote(c, o, s.tick, r + 48, 0.025, 0.04, 0.24);
  }),
  rotateCcw: tone(0.35, 0.2, (c, o, s, r) => {
    playNote(c, o, s.tick, r + 48, 0, 0.04, 0.3);
    playNote(c, o, s.tick, r + 43, 0.025, 0.04, 0.26);
  }),
  rotateFail: tone(0.25, 0.2, (c, o, s, r) => void playNote(c, o, s.tick, r + 24, 0, 0.03, 0.22)),
  softDrop: materialOnly(1.5),
  hardDrop: tone(0.6, 0.6, (c, o, s, r) => void playNote(c, o, s.tone, r + 12, 0.004, 0.1, 0.22)),
  hardDropHeavy: tone(0.8, 0.5, (c, o, s, r) => {
    playNote(c, o, s.tone, r + 12, 0.004, 0.12, 0.26);
    playNote(c, o, s.thud, r + 12, 0, 0.1, 0.35);
  }),
  land: materialOnly(0.8),
  lock: tone(0.3, 0.4, (c, o, s, r) => void playNote(c, o, s.tick, r + 31, 0.008, 0.03, 0.14)),
  hold: tone(0.5, 0, (c, o, s, r) => {
    playNote(c, o, s.tone, r + 38, 0, 0.06, 0.38);
    playNote(c, o, s.tone, r + 31, 0.06, 0.06, 0.32);
  }),
  holdDenied: tone(0.3, 0, (c, o, s, r) => void playNote(c, o, s.tick, r + 13, 0, 0.08, 0.3)),
  clear1: tone(1.6, 0, (c, o, s, r) => {
    playNote(c, o, s.chord, r + 24, 0.02, 0.3, 0.5);
    playNote(c, o, s.chord, r + 31, 0.05, 0.3, 0.42);
  }),
  clear2: tone(1.8, 0, (c, o, s, r) => [0, 4, 7].forEach((n, i) => playNote(c, o, s.chord, r + 24 + n, 0.02 + i * 0.035, 0.3, 0.52))),
  clear3: tone(2.2, 0, (c, o, s, r) => {
    [0, 4, 7, 12].forEach((n, i) => playNote(c, o, s.chord, r + 24 + n, 0.02 + i * 0.04, 0.35, 0.56));
    [16, 19, 24].forEach((n, i) => playNote(c, o, s.shimmer, r + 24 + n, 0.22 + i * 0.06, 0.4, 0.22));
  }),
  clear4: tone(2.8, 0, (c, o, s, r) => {
    playNote(c, o, { kind: 'impact' }, 36, 0, 1, 0.55);
    [0, 4, 7, 12, 16, 19].forEach((n, i) => playNote(c, o, s.chord, r + 24 + n, i * 0.045, 0.4, 0.6));
    [24, 28, 31].forEach((n, i) => playNote(c, o, s.shimmer, r + 24 + n, 0.25 + i * 0.07, 0.5, 0.3));
  }),
  tspin: tone(1.6, 0, (c, o, s, r) => {
    playNote(c, o, { kind: 'riser' }, 60, 0, 0.18, 0.5);
    [2, 9, 14].forEach((n, i) => playNote(c, o, s.chord, r + 24 + n, 0.12 + i * 0.03, 0.3, 0.55));
  }),
  combo: tone(0.9, 0, (c, o, s, r) => void playNote(c, o, s.tone, r + 36, 0, 0.12, 0.5)),
  // Combos escalate: hand percussion joins from the third link, then a shimmer on long chains.
  comboMid: tone(1, 0, (c, o, s, r) => {
    playNote(c, o, s.tone, r + 36, 0, 0.12, 0.5);
    playNote(c, o, { kind: 'tom', tone: 150, decay: 0.15 }, 60, 0, 0.1, 0.4);
    playNote(c, o, { kind: 'perc' }, r + 60, 0.09, 0.05, 0.35);
  }),
  comboHigh: tone(1.4, 0, (c, o, s, r) => {
    playNote(c, o, s.tone, r + 36, 0, 0.12, 0.5);
    playNote(c, o, s.tone, r + 43, 0.06, 0.12, 0.38);
    playNote(c, o, { kind: 'tom', tone: 130, decay: 0.18 }, 60, 0, 0.1, 0.45);
    playNote(c, o, { kind: 'tom', tone: 170, decay: 0.12 }, 60, 0.08, 0.1, 0.35);
    playNote(c, o, s.shimmer, r + 55, 0.12, 0.3, 0.22);
  }),
  b2b: tone(2, 0, (c, o, s, r) => {
    playNote(c, o, s.shimmer, r + 48, 0, 0.4, 0.4);
    playNote(c, o, s.shimmer, r + 55, 0.05, 0.4, 0.32);
  }),
  perfect: tone(3.6, 0, (c, o, s, r) => {
    playNote(c, o, { kind: 'impact' }, 36, 0, 1, 0.6);
    PENTA.forEach((n, i) => playNote(c, o, s.shimmer, r + 36 + n, i * 0.06, 0.6, 0.45));
    [0, 7, 12].forEach((n) => playNote(c, o, s.chord, r + 24 + n, 0, 1.2, 0.5));
  }),
  levelUp: tone(2.2, 0, (c, o, s, r) => [0, 4, 7, 12, 16].forEach((n, i) => playNote(c, o, s.tone, r + 36 + n, i * 0.08, 0.2, 0.5))),
  stageComplete: tone(3.4, 0, (c, o, s, r) => {
    playNote(c, o, { kind: 'impact' }, 36, 0, 1, 0.45);
    [0, 4, 7, 12, 16, 19, 24].forEach((n, i) => playNote(c, o, s.tone, r + 36 + n, i * 0.07, 0.25, 0.48));
    [0, 7, 12, 16].forEach((n) => playNote(c, o, s.chord, r + 24 + n, 0.5, 1.4, 0.45));
    playNote(c, o, s.shimmer, r + 48, 0.55, 1, 0.3);
  }),
  unlock: tone(2, 0, (c, o, s, r) => {
    [12, 16, 19, 24, 28].forEach((n, i) => playNote(c, o, s.shimmer, r + 24 + n, i * 0.05, 0.4, 0.32));
    [0, 7, 12].forEach((n) => playNote(c, o, s.chord, r + 24 + n, 0.2, 0.8, 0.32));
  }),
  danger: tone(0.9, 0, (c, o, _s, r) => {
    playNote(c, o, { kind: 'kick', tone: 70, decay: 0.22 }, r, 0, 0.1, 0.55);
    playNote(c, o, { kind: 'kick', tone: 70, decay: 0.22 }, r, 0.22, 0.1, 0.4);
  }),
  gameOver: tone(3.5, 0, (c, o, s, r) => [12, 7, 3, 0, -5].forEach((n, i) => playNote(c, o, s.chord, r + 24 + n, i * 0.18, 0.6, 0.5))),
  pause: tone(0.7, 0, (c, o, s, r) => {
    playNote(c, o, s.tone, r + 43, 0, 0.08, 0.3);
    playNote(c, o, s.tone, r + 36, 0.07, 0.12, 0.26);
    playNote(c, o, { kind: 'shaker', tone: 3200, decay: 0.25 }, 60, 0, 0.1, 0.25);
  }),
  resume: tone(0.7, 0, (c, o, s, r) => {
    playNote(c, o, s.tone, r + 36, 0, 0.08, 0.26);
    playNote(c, o, s.tone, r + 43, 0.07, 0.12, 0.3);
  }),
  menuMove: tone(0.2, 0.15, (c, o, s, r) => void playNote(c, o, s.tick, r + 40, 0, 0.03, 0.2)),
  menuSelect: tone(0.35, 0, (c, o, s, r) => {
    playNote(c, o, s.tick, r + 43, 0, 0.03, 0.22);
    playNote(c, o, s.tone, r + 50, 0.02, 0.05, 0.14);
  }),
  menuConfirm: tone(0.5, 0, (c, o, s, r) => {
    playNote(c, o, s.tone, r + 36, 0, 0.06, 0.3);
    playNote(c, o, s.tone, r + 43, 0.05, 0.06, 0.3);
  }),
  menuBack: tone(0.5, 0, (c, o, s, r) => {
    playNote(c, o, s.tone, r + 43, 0, 0.06, 0.26);
    playNote(c, o, s.tone, r + 36, 0.05, 0.06, 0.26);
  }),
  countdown: tone(0.8, 0, (c, o, s, r) => void playNote(c, o, s.tone, r + 31, 0, 0.1, 0.45)),
  go: tone(1.4, 0, (c, o, s, r) => [0, 7, 12].forEach((n) => playNote(c, o, s.chord, r + 36 + n, 0, 0.3, 0.45))),
  transition: tone(3, 0, (c, o, s, r) => {
    playNote(c, o, { kind: 'riser' }, 60, 0, 2.2, 0.55);
    playNote(c, o, s.shimmer, r + 48, 2.2, 0.5, 0.35);
  }),
  signature: materialOnly(0),
  impactResponse: materialOnly(0.5),
  footstep: materialOnly(1.2),
};

/** Peak ceiling of every rendered effect (dBFS): layered transients never clip before the mix. */
const SFX_CEILING_DB = -1.5;

function limitPeak(channels: Float32Array[]): void {
  let peak = 0;
  for (const d of channels) for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i] as number));
  const ceiling = Math.pow(10, SFX_CEILING_DB / 20);
  if (peak > ceiling) {
    const k = ceiling / peak;
    for (const d of channels) for (let i = 0; i < d.length; i++) d[i] = (d[i] as number) * k;
  }
}

async function renderTonal(id: SfxId, preset: SfxPreset, keyRoot: number, sampleRate: number): Promise<AudioBuffer | null> {
  const recipe = RECIPES[id];
  if (!recipe.render || recipe.length <= 0) return null;
  const offline = new OfflineAudioContext(2, Math.ceil(recipe.length * sampleRate), sampleRate);
  const gain = offline.createGain();
  gain.gain.value = 0.9;
  gain.connect(offline.destination);
  recipe.render(offline, gain, preset, 48 + keyRoot);
  return offline.startRendering();
}

/** Tonal accent + material layer, mixed and peak-limited into one buffer. */
function combine(tonal: AudioBuffer | null, material: MaterialRenderResult | undefined, sampleRate: number): AudioBuffer | null {
  if (!tonal && !material) return null;
  const length = Math.max(tonal?.length ?? 0, material?.left.length ?? 0);
  const buffer = new AudioBuffer({ length, numberOfChannels: 2, sampleRate });
  const l = new Float32Array(length);
  const r = new Float32Array(length);
  if (tonal) {
    l.set(tonal.getChannelData(0));
    r.set(tonal.getChannelData(tonal.numberOfChannels > 1 ? 1 : 0));
  }
  if (material) {
    for (let i = 0; i < material.left.length; i++) {
      l[i]! += material.left[i]!;
      r[i]! += material.right[i]!;
    }
  }
  limitPeak([l, r]);
  buffer.copyToChannel(l, 0);
  buffer.copyToChannel(r, 1);
  return buffer;
}

function renderMaterialAsync(profile: MaterialAudioProfile, sampleRate: number): Promise<MaterialRenderResult[]> {
  if (typeof Worker === 'undefined') return Promise.resolve(renderMaterialSet(profile, sampleRate));
  return new Promise((resolve) => {
    const worker = new MaterialWorker();
    worker.onmessage = (e: MessageEvent<MaterialWorkerResponse>) => {
      worker.terminate();
      if ('results' in e.data) resolve(e.data.results);
      else {
        console.warn('[sfx] material worker failed, rendering on the main thread', e.data.error);
        resolve(renderMaterialSet(profile, sampleRate));
      }
    };
    worker.onerror = () => {
      worker.terminate();
      resolve(renderMaterialSet(profile, sampleRate));
    };
    worker.postMessage({ profile, sampleRate } satisfies MaterialWorkerRequest);
  });
}

export interface PlayOptions {
  semitones?: number;
  gain?: number;
  pan?: number;
  minGapMs?: number;
  /** Force a variant (tests, audio test screen). */
  variant?: number;
}

/** Renders and plays gameplay/UI sounds. Buffers (with variants) are cached per preset, key and material. */
export class SfxBank {
  buffers = new Map<SfxId, AudioBuffer[]>();
  private currentKey = '';
  private building: Promise<void> | null = null;
  private readonly lastPlayed = new Map<SfxId, number>();
  private readonly lastVariant = new Map<SfxId, number>();
  /** Sound variation 0..1 (settings): pitch and level spread between repeats. */
  variation = 0.5;
  /** HRTF panning for spatial sounds when true, equal-power stereo otherwise. */
  spatial = true;

  constructor(
    private readonly getContext: () => AudioContext | null,
    private readonly bus: (bus: SfxBus) => AudioNode | null,
  ) {}

  get ready(): boolean {
    return this.buffers.size > 0;
  }

  /** Material name/profile the bank is built for. */
  material: MaterialAudioProfile = resolveMaterialAudio('glass');

  /** Renders every effect for a preset, key root (0..11) and material profile. */
  async build(presetName: string, keyRoot: number, material: MaterialAudioProfile = resolveMaterialAudio('glass'), materialKey = 'glass', overrides: Partial<Record<SfxId, AudioBuffer>> = {}): Promise<void> {
    const ctx = this.getContext();
    if (!ctx) return;
    const key = `${presetName}:${keyRoot}:${materialKey}`;
    if (key === this.currentKey) return this.building ?? undefined;
    this.currentKey = key;
    const task = (async () => {
      const preset = SFX_PRESETS[presetName] ?? (SFX_PRESETS.glass as SfxPreset);
      const [materials, tonal] = await Promise.all([
        renderMaterialAsync(material, ctx.sampleRate),
        Promise.all(SFX_IDS.map(async (id) => [id, await renderTonal(id, preset, keyRoot, ctx.sampleRate)] as const)),
      ]);
      if (this.currentKey !== key) return;
      const next = new Map<SfxId, AudioBuffer[]>();
      for (const [id, tonalBuf] of tonal) {
        const override = overrides[id];
        if (override) {
          next.set(id, [override]);
          continue;
        }
        const variants = materials.filter((m) => m.id === id);
        const list: AudioBuffer[] = [];
        if (variants.length === 0) {
          const b = combine(tonalBuf, undefined, ctx.sampleRate);
          if (b) list.push(b);
        } else for (const v of variants) {
          const b = combine(tonalBuf, v, ctx.sampleRate);
          if (b) list.push(b);
        }
        if (list.length > 0) next.set(id, list);
      }
      this.buffers = next;
      this.material = material;
    })();
    this.building = task;
    await task;
  }

  has(id: SfxId): boolean {
    return (this.buffers.get(id)?.length ?? 0) > 0;
  }

  private pick(id: SfxId, forced?: number): AudioBuffer | null {
    const list = this.buffers.get(id);
    if (!list || list.length === 0) return null;
    if (forced !== undefined) return list[forced % list.length] ?? null;
    if (list.length === 1) return list[0]!;
    // Round-robin with a random step, never the same variant twice in a row.
    const last = this.lastVariant.get(id) ?? -1;
    let v = Math.floor(Math.random() * (list.length - 1));
    if (v >= last) v++;
    this.lastVariant.set(id, v);
    return list[v] ?? list[0]!;
  }

  private source(ctx: AudioContext, id: SfxId, buffer: AudioBuffer, options: PlayOptions): { src: AudioBufferSourceNode; gain: GainNode } {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const spread = RECIPES[id].pitchVar * this.variation;
    const jitter = spread > 0 ? (Math.random() * 2 - 1) * spread : 0;
    const semis = (options.semitones ?? 0) + jitter;
    if (semis !== 0) src.playbackRate.value = Math.pow(2, semis / 12);
    const g = ctx.createGain();
    const levelJitter = 1 + (Math.random() * 2 - 1) * 0.12 * this.variation;
    g.gain.value = (options.gain ?? 1) * levelJitter;
    src.connect(g);
    return { src, gain: g };
  }

  /** Plays an effect. `semitones` transposes (combo ladder); `minGapMs` limits rapid repeats. */
  play(id: SfxId, options: PlayOptions = {}): void {
    const ctx = this.getContext();
    const buffer = this.pick(id, options.variant);
    const bus = this.bus(busOf(id));
    if (!ctx || !buffer || !bus || ctx.state !== 'running') return;
    const now = performance.now();
    const gap = options.minGapMs ?? (id === 'move' || id === 'softDrop' ? 18 : 0);
    if (gap > 0 && now - (this.lastPlayed.get(id) ?? 0) < gap) return;
    this.lastPlayed.set(id, now);
    const { src, gain: g } = this.source(ctx, id, buffer, options);
    let out: AudioNode = g;
    if (options.pan) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, options.pan));
      g.connect(pan);
      out = pan;
    }
    out.connect(bus);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
      if (out !== g) out.disconnect();
    };
    src.start();
  }

  /** Plays an effect from a world position (creatures, environment), relative to the audio listener. */
  playAt(id: SfxId, x: number, y: number, z: number, options: PlayOptions = {}): void {
    const ctx = this.getContext();
    const buffer = this.pick(id, options.variant);
    const bus = this.bus(busOf(id));
    if (!ctx || !buffer || !bus || ctx.state !== 'running') return;
    const { src, gain: g } = this.source(ctx, id, buffer, options);
    const panner = new PannerNode(ctx, {
      panningModel: this.spatial ? 'HRTF' : 'equalpower',
      distanceModel: 'inverse',
      refDistance: 30,
      maxDistance: 600,
      rolloffFactor: 1.1,
      positionX: x,
      positionY: y,
      positionZ: z,
    });
    g.connect(panner).connect(bus);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
      panner.disconnect();
    };
    src.start();
  }

  /** Pentatonic transposition for the n-th combo step. */
  static comboSemitones(combo: number): number {
    return PENTA[Math.min(PENTA.length - 1, Math.max(0, combo - 1))] as number;
  }
}

/**
 * Renders one effect (first variant) for a preset, key root (0..11) and material. Used by the audio
 * acceptance tests; the bank renders the same layers (material ones in a worker).
 */
export async function renderSfx(id: SfxId, presetName: string, keyRoot: number, sampleRate: number, material: string = 'glass'): Promise<AudioBuffer | null> {
  const preset = SFX_PRESETS[presetName] ?? (SFX_PRESETS.glass as SfxPreset);
  const tonal = await renderTonal(id, preset, keyRoot, sampleRate);
  const job = MATERIAL_JOBS[id];
  const r = job?.render(resolveMaterialAudio(material), 1, sampleRate) ?? null;
  return combine(tonal, r ? { id, variant: 0, left: r.left, right: r.right } : undefined, sampleRate);
}
