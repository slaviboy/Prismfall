import { playNote } from '../synth/instruments';
import { longPinkNoise, noiseBuffers } from '../synth/resources';
import { localCreatureSample, webEvent, type AmbienceEnv } from './ambienceVoices';

/**
 * Procedural ambience beds per world: filtered noise layers with slow LFO motion plus sparse
 * scheduled events (wave crashes, clanks, bubbles, chirps). Crossfades between presets.
 */
interface Layer {
  /** `longPink` is an 11 s loop for quiet narrow bands, where the shared 2 s loop would be heard repeating. */
  readonly noise: 'white' | 'pink' | 'longPink';
  /** Playback rate of the noise (layers sharing the long loop at different rates never line up). */
  readonly rate?: number;
  readonly filter: BiquadFilterType;
  readonly freq: number;
  readonly q: number;
  readonly gain: number;
  /** LFO rate (Hz) and depth (0..1) on the layer gain: swells, wind gusts. */
  readonly lfo?: readonly [number, number];
  /** Slow filter sweep depth in Hz, and its rate (Hz, default 0.031). */
  readonly sweep?: number;
  readonly sweepRate?: number;
}

/** An echo for a preset's events (a cave, a hall): parallel feedback delays, darker on each repeat. */
interface Space {
  /** Delay times (s); alternate taps are panned left and right. */
  readonly delays: readonly number[];
  readonly feedback: number;
  /** Low-pass on the way in and inside each loop (Hz). */
  readonly cutoff: number;
  readonly level: number;
}

interface AmbienceEvent {
  readonly every: readonly [number, number];
  /** Chance of a longer silence after an event, and its length range (s). */
  readonly rest?: readonly [number, number, number];
  /** Plays one event at `t` into `out`; `env` holds the echo send and the world's creature sounds. */
  readonly play: (ctx: BaseAudioContext, out: AudioNode, t: number, env: AmbienceEnv) => void;
}

interface Preset {
  readonly layers: readonly Layer[];
  readonly space?: Space;
  readonly event?: AmbienceEvent;
}

const PRESETS: Record<string, Preset> = {
  ocean: {
    layers: [
      { noise: 'pink', filter: 'lowpass', freq: 520, q: 0.6, gain: 0.55, lfo: [0.09, 0.7], sweep: 260 },
      { noise: 'white', filter: 'bandpass', freq: 2600, q: 0.5, gain: 0.07, lfo: [0.09, 0.9] },
    ],
    event: { every: [5, 11], play: (c, o, t) => void playNote(c, o, { kind: 'crash', tone: 900, decay: 2.6 }, 60, t, 1, 0.35) },
  },
  foundry: {
    layers: [
      { noise: 'pink', filter: 'lowpass', freq: 160, q: 0.9, gain: 0.7, lfo: [0.05, 0.3] },
      { noise: 'white', filter: 'bandpass', freq: 3800, q: 1.4, gain: 0.04, lfo: [0.3, 0.6] },
    ],
    event: {
      every: [2, 6],
      play: (c, o, t) => void playNote(c, o, { kind: 'bell', ratio: 1.41, index: 5, decay: 0.8 }, 40 + Math.floor(Math.random() * 12), t, 0.1, 0.18),
    },
  },
  space: {
    layers: [
      { noise: 'pink', filter: 'lowpass', freq: 110, q: 1.5, gain: 0.5, lfo: [0.03, 0.4], sweep: 40 },
      { noise: 'white', filter: 'bandpass', freq: 5200, q: 6, gain: 0.03, lfo: [0.11, 0.8], sweep: 1500 },
    ],
    event: { every: [6, 14], play: (c, o, t) => void playNote(c, o, { kind: 'bell', ratio: 5.1, index: 1, decay: 4 }, 84 + Math.floor(Math.random() * 10), t, 0.1, 0.08) },
  },
  forest: {
    layers: [{ noise: 'pink', filter: 'bandpass', freq: 900, q: 0.4, gain: 0.18, lfo: [0.07, 0.5] }],
    event: {
      every: [0.6, 2.2],
      play: (c, o, t) => {
        const n = 96 + Math.floor(Math.random() * 6);
        for (let i = 0; i < 3; i++) playNote(c, o, { kind: 'mallet', ratio: 1.01, index: 0.4, decay: 0.05 }, n, t + i * 0.06, 0.03, 0.06);
      },
    },
  },
  wind: { layers: [{ noise: 'pink', filter: 'bandpass', freq: 600, q: 0.8, gain: 0.45, lfo: [0.12, 0.8], sweep: 400 }] },
  rain: {
    layers: [
      { noise: 'white', filter: 'highpass', freq: 2500, q: 0.3, gain: 0.16 },
      { noise: 'pink', filter: 'lowpass', freq: 300, q: 0.5, gain: 0.3, lfo: [0.05, 0.3] },
    ],
  },
  underwater: {
    layers: [{ noise: 'pink', filter: 'lowpass', freq: 220, q: 1.2, gain: 0.7, lfo: [0.06, 0.5], sweep: 80 }],
    event: { every: [1, 4], play: (c, o, t) => void playNote(c, o, { kind: 'mallet', ratio: 1, index: 0.3, decay: 0.12 }, 70 + Math.floor(Math.random() * 18), t, 0.05, 0.12) },
  },
  city: {
    layers: [
      { noise: 'pink', filter: 'lowpass', freq: 240, q: 0.6, gain: 0.45, lfo: [0.04, 0.3] },
      { noise: 'white', filter: 'highpass', freq: 3000, q: 0.3, gain: 0.08 },
    ],
  },
  cathedral: {
    layers: [{ noise: 'pink', filter: 'bandpass', freq: 400, q: 0.6, gain: 0.35, lfo: [0.08, 0.6], sweep: 200 }],
    event: { every: [7, 15], play: (c, o, t) => void playNote(c, o, { kind: 'bell', ratio: 2.4, index: 1.4, decay: 5 }, 64 + Math.floor(Math.random() * 7), t, 0.1, 0.1) },
  },
  arctic: { layers: [{ noise: 'pink', filter: 'bandpass', freq: 800, q: 1.2, gain: 0.4, lfo: [0.1, 0.85], sweep: 600 }] },
  horizon: { layers: [{ noise: 'pink', filter: 'lowpass', freq: 380, q: 0.5, gain: 0.25, lfo: [0.05, 0.5] }] },
  // World beds (brief §27): each world recognisable with eyes closed.
  desert: {
    layers: [
      { noise: 'pink', filter: 'bandpass', freq: 520, q: 0.7, gain: 0.38, lfo: [0.07, 0.85], sweep: 380 },
      { noise: 'white', filter: 'highpass', freq: 4800, q: 0.5, gain: 0.045, lfo: [0.07, 0.95] },
      { noise: 'pink', filter: 'lowpass', freq: 140, q: 0.7, gain: 0.25, lfo: [0.03, 0.4] },
    ],
    // A far-off caravan bell now and then.
    event: { every: [10, 20], play: (c, o, t) => void playNote(c, o, { kind: 'bell', ratio: 2.4, index: 1.1, decay: 3.2 }, 62 + [0, 1, 4, 7][Math.floor(Math.random() * 4)]!, t, 0.1, 0.07) },
  },
  ice: {
    layers: [
      { noise: 'pink', filter: 'bandpass', freq: 950, q: 1.4, gain: 0.32, lfo: [0.09, 0.85], sweep: 700 },
      { noise: 'white', filter: 'highpass', freq: 6000, q: 0.4, gain: 0.03, lfo: [0.12, 0.8] },
    ],
    // Ice creaks deep below and crystalline tinkles.
    event: {
      every: [5, 12],
      play: (c, o, t) =>
        Math.random() < 0.5
          ? void playNote(c, o, { kind: 'mallet', ratio: 1.41, index: 4.5, decay: 0.7 }, 33 + Math.floor(Math.random() * 8), t, 0.1, 0.1)
          : [0, 0.09, 0.2].forEach((d, i) => playNote(c, o, { kind: 'bell', ratio: 5.4, index: 0.9, decay: 1.6 }, 90 + i * 3 + Math.floor(Math.random() * 3), t + d, 0.05, 0.035)),
    },
  },
  garden: {
    layers: [
      { noise: 'pink', filter: 'bandpass', freq: 700, q: 0.5, gain: 0.16, lfo: [0.06, 0.6] },
      { noise: 'white', filter: 'bandpass', freq: 2600, q: 2.2, gain: 0.05, lfo: [1.7, 0.55] },
    ],
    // A bamboo water knocker and the odd bird.
    event: {
      every: [7, 15],
      play: (c, o, t) => {
        if (Math.random() < 0.6) {
          playNote(c, o, { kind: 'mallet', ratio: 1.01, index: 0.6, decay: 0.28 }, 57, t, 0.05, 0.16);
          playNote(c, o, { kind: 'mallet', ratio: 1.01, index: 0.6, decay: 0.2 }, 57, t + 0.18, 0.05, 0.07);
        } else for (let i = 0; i < 2; i++) playNote(c, o, { kind: 'bell', ratio: 1, index: 0.25, decay: 0.18 }, 91 - i * 3, t + i * 0.14, 0.05, 0.05);
      },
    },
  },
  cosmos: {
    layers: [
      { noise: 'pink', filter: 'lowpass', freq: 90, q: 1.8, gain: 0.55, lfo: [0.025, 0.45], sweep: 35 },
      { noise: 'white', filter: 'bandpass', freq: 4800, q: 7, gain: 0.025, lfo: [0.09, 0.85], sweep: 1800 },
    ],
    event: { every: [8, 16], play: (c, o, t) => void playNote(c, o, { kind: 'bell', ratio: 4.5, index: 0.9, decay: 5 }, 80 + Math.floor(Math.random() * 12), t, 0.1, 0.05) },
  },
  alpine: {
    layers: [
      { noise: 'pink', filter: 'bandpass', freq: 430, q: 0.6, gain: 0.4, lfo: [0.05, 0.85], sweep: 300 },
      { noise: 'white', filter: 'bandpass', freq: 3200, q: 0.8, gain: 0.03, lfo: [0.05, 0.9] },
    ],
    // A distant raptor call echoing off the peaks.
    event: {
      every: [12, 24],
      play: (c, o, t) => {
        playNote(c, o, { kind: 'bell', ratio: 1, index: 0.3, decay: 0.6 }, 86, t, 0.2, 0.05);
        playNote(c, o, { kind: 'bell', ratio: 1, index: 0.3, decay: 0.8 }, 82, t + 0.25, 0.3, 0.04);
        playNote(c, o, { kind: 'bell', ratio: 1, index: 0.3, decay: 0.8 }, 82, t + 0.95, 0.3, 0.015);
      },
    },
  },
  abyss: {
    layers: [
      { noise: 'pink', filter: 'lowpass', freq: 200, q: 1.3, gain: 0.7, lfo: [0.05, 0.5], sweep: 70 },
      { noise: 'pink', filter: 'bandpass', freq: 800, q: 3, gain: 0.05, lfo: [0.11, 0.8], sweep: 300 },
    ],
    // Bubbles and, rarely, a deep song from something large.
    event: {
      every: [2, 7],
      play: (c, o, t) =>
        Math.random() < 0.15
          ? void playNote(c, o, { kind: 'pad', wave: 'sine', voices: 1, attack: 0.8, release: 2.5, cutoff: 900 }, 41 + Math.floor(Math.random() * 5), t, 1.6, 0.18)
          : void playNote(c, o, { kind: 'mallet', ratio: 1, index: 0.3, decay: 0.1 }, 72 + Math.floor(Math.random() * 16), t, 0.05, 0.1),
    },
  },
  wilderness: {
    layers: [
      { noise: 'pink', filter: 'bandpass', freq: 900, q: 0.4, gain: 0.17, lfo: [0.07, 0.5] },
      { noise: 'white', filter: 'bandpass', freq: 5200, q: 1.2, gain: 0.025, lfo: [0.15, 0.9] },
    ],
    event: {
      every: [0.8, 2.6],
      play: (c, o, t) => {
        const n = 94 + Math.floor(Math.random() * 8);
        const k = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < k; i++) playNote(c, o, { kind: 'mallet', ratio: 1.01, index: 0.4, decay: 0.05 }, n + (i % 2) * 2, t + i * 0.07, 0.03, 0.05);
      },
    },
  },
  volcanic: {
    layers: [
      { noise: 'pink', filter: 'lowpass', freq: 120, q: 1, gain: 0.7, lfo: [0.04, 0.45] },
      { noise: 'white', filter: 'bandpass', freq: 3000, q: 3, gain: 0.03, lfo: [2.6, 0.95] },
    ],
    event: { every: [9, 18], play: (c, o, t) => void playNote(c, o, { kind: 'impact' }, 36, t, 1, 0.12) },
  },
  aurora: {
    layers: [
      { noise: 'pink', filter: 'bandpass', freq: 1100, q: 2, gain: 0.2, lfo: [0.06, 0.9], sweep: 900 },
      { noise: 'pink', filter: 'lowpass', freq: 160, q: 0.8, gain: 0.18, lfo: [0.03, 0.4] },
    ],
    event: { every: [6, 13], play: (c, o, t) => [0, 0.3, 0.7].forEach((d, i) => playNote(c, o, { kind: 'bell', ratio: 3.02, index: 0.7, decay: 3 }, 84 + [0, 4, 7][i]!, t + d, 0.1, 0.03)) },
  },
  neon: {
    layers: [
      { noise: 'pink', filter: 'lowpass', freq: 220, q: 0.6, gain: 0.4, lfo: [0.04, 0.3] },
      { noise: 'white', filter: 'highpass', freq: 2600, q: 0.3, gain: 0.12 },
    ],
    event: { every: [6, 14], play: (c, o, t) => void playNote(c, o, { kind: 'riser' }, 60, t, 1.4, 0.08) },
  },
  // The Veil: wind in dead branches over a low rumble, a fine hiss of twigs; now and then (quietly,
  // never close) a drip into still water, a creak of old timber, a branch giving way, a far call,
  // or slow heavy footfalls a long way off.
  veil: {
    layers: [
      { noise: 'pink', filter: 'bandpass', freq: 520, q: 0.6, gain: 0.3, lfo: [0.07, 0.75], sweep: 280 },
      { noise: 'pink', filter: 'lowpass', freq: 95, q: 0.8, gain: 0.34, lfo: [0.025, 0.4] },
      { noise: 'white', filter: 'bandpass', freq: 4200, q: 0.9, gain: 0.016, lfo: [0.11, 0.85] },
    ],
    event: {
      every: [3.5, 9],
      play: (c, o, t) => {
        const r = Math.random();
        if (r < 0.3) {
          playNote(c, o, { kind: 'mallet', ratio: 1, index: 0.25, decay: 0.12 }, 86 + Math.floor(Math.random() * 10), t, 0.05, 0.05);
        } else if (r < 0.5) {
          const n = 50 + Math.floor(Math.random() * 6);
          for (let i = 0; i < 2; i++) playNote(c, o, { kind: 'pluck', wave: 'sawtooth', cutoff: 650, envAmount: 0.6, decay: 0.35 }, n + i, t + i * 0.42, 0.3, 0.06);
        } else if (r < 0.64) {
          for (let i = 0; i < 3; i++) playNote(c, o, { kind: 'tom', tone: 38, decay: 1.3 }, 30, t + i * 1.55 + Math.random() * 0.2, 1, 0.1 - i * 0.02);
        } else if (r < 0.8) {
          const n = 55 + Math.floor(Math.random() * 5);
          playNote(c, o, { kind: 'pad', wave: 'sine', voices: 1, attack: 0.9, release: 2.2, cutoff: 1200 }, n, t, 1.8, 0.14);
          playNote(c, o, { kind: 'pad', wave: 'sine', voices: 1, attack: 0.8, release: 2.6, cutoff: 1100 }, n - 3, t + 1.5, 2.1, 0.11);
        } else if (r < 0.9) {
          playNote(c, o, { kind: 'perc', tone: 2600, decay: 0.05 }, 70, t, 0.05, 0.05);
          playNote(c, o, { kind: 'perc', tone: 1800, decay: 0.08 }, 66, t + 0.07, 0.05, 0.03);
        } else {
          playNote(c, o, { kind: 'impact' }, 30, t, 2, 0.05);
        }
      },
    },
  },
  // The Web: still cave air and a low room tone under a ruin, wind moaning faintly through two
  // stone arches, a fine hiss of moving air. Events (ambienceVoices.webEvent) are sparse and varied
  // and often nothing at all: far drips in the cave's echo, a small insect, a silk creak, a rustle,
  // a pebble; rarely a far skitter, something large crawling far off, a web humming.
  web: {
    layers: [
      { noise: 'longPink', filter: 'lowpass', freq: 120, q: 0.7, gain: 0.3, lfo: [0.021, 0.35] },
      { noise: 'longPink', rate: 0.96, filter: 'bandpass', freq: 420, q: 0.5, gain: 0.06, lfo: [0.037, 0.5] },
      { noise: 'longPink', rate: 1.05, filter: 'bandpass', freq: 310, q: 5, gain: 0.2, lfo: [0.047, 0.92], sweep: 70, sweepRate: 0.023 },
      { noise: 'longPink', rate: 0.93, filter: 'bandpass', freq: 540, q: 7, gain: 0.16, lfo: [0.029, 0.95], sweep: 110, sweepRate: 0.041 },
      { noise: 'white', filter: 'bandpass', freq: 5200, q: 0.8, gain: 0.006, lfo: [0.07, 0.8] },
    ],
    space: { delays: [0.137, 0.191, 0.263, 0.347], feedback: 0.52, cutoff: 2600, level: 0.55 },
    event: { every: [2.2, 6.5], rest: [0.2, 7, 15], play: webEvent },
  },
};

export const AMBIENCE_PRESETS = Object.keys(PRESETS);

/** Where a bed's events find the world's creature sounds and the music's key (the audio system). */
export type AmbienceSource = Pick<AmbienceEnv, 'sample' | 'keyShift'>;

/** Without a sound bank (offline renders), creature sounds are rendered here and the key is C. */
const LOCAL_SOURCE = (ctx: BaseAudioContext): AmbienceSource => ({ sample: (id, weight) => localCreatureSample(ctx, id, weight), keyShift: () => 0 });

interface Bed {
  readonly output: GainNode;
  /** Where events send their echo (the output itself for a preset without a space). */
  readonly space: AudioNode;
  readonly nodes: AudioNode[];
  readonly sources: AudioScheduledSourceNode[];
  timer: ReturnType<typeof setTimeout> | null;
}

/** Seconds until a bed's next event: its interval, sometimes followed by a longer rest. */
function nextWait(event: AmbienceEvent): number {
  const wait = event.every[0] + Math.random() * (event.every[1] - event.every[0]);
  const rest = event.rest;
  return rest && Math.random() < rest[0] ? wait + rest[1] + Math.random() * (rest[2] - rest[1]) : wait;
}

/** The echo network: a send into parallel feedback delays with a low-pass in each loop. */
function buildSpace(ctx: BaseAudioContext, output: AudioNode, def: Space, nodes: AudioNode[]): AudioNode {
  const send = ctx.createGain();
  const pre = ctx.createBiquadFilter();
  pre.type = 'lowpass';
  pre.frequency.value = def.cutoff;
  send.connect(pre);
  const wet = ctx.createGain();
  wet.gain.value = def.level / Math.sqrt(def.delays.length);
  wet.connect(output);
  nodes.push(send, pre, wet);
  def.delays.forEach((seconds, i) => {
    const delay = ctx.createDelay(Math.max(1, seconds + 0.1));
    delay.delayTime.value = seconds;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = def.cutoff * 0.8;
    const fb = ctx.createGain();
    fb.gain.value = def.feedback;
    const pan = ctx.createStereoPanner();
    pan.pan.value = i % 2 ? 0.7 : -0.7;
    pre.connect(delay);
    delay.connect(damp).connect(fb).connect(delay);
    delay.connect(pan).connect(wet);
    nodes.push(delay, damp, fb, pan);
  });
  return send;
}

/** A preset's looping layers (and echo) into `bus`, fading in over `fade` seconds (0 = at once). */
function buildBed(ctx: BaseAudioContext, bus: AudioNode, def: Preset, level: number, fade: number): Bed {
  const output = ctx.createGain();
  if (fade > 0) {
    output.gain.value = 0;
    output.gain.setTargetAtTime(level, ctx.currentTime, fade / 3);
  } else output.gain.value = level;
  output.connect(bus);
  const nodes: AudioNode[] = [output];
  const sources: AudioScheduledSourceNode[] = [];
  const { white, pink } = noiseBuffers(ctx);
  for (const layer of def.layers) {
    const src = ctx.createBufferSource();
    const long = layer.noise === 'longPink' ? longPinkNoise(ctx) : null;
    src.buffer = long ?? (layer.noise === 'pink' ? pink : white);
    src.loop = true;
    if (layer.rate) src.playbackRate.value = layer.rate;
    const filter = ctx.createBiquadFilter();
    filter.type = layer.filter;
    filter.frequency.value = layer.freq;
    filter.Q.value = layer.q;
    const g = ctx.createGain();
    g.gain.value = layer.gain;
    src.connect(filter).connect(g).connect(output);
    nodes.push(src, filter, g);
    sources.push(src);
    if (layer.lfo) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = layer.lfo[0];
      const depth = ctx.createGain();
      depth.gain.value = layer.gain * layer.lfo[1] * 0.5;
      lfo.connect(depth).connect(g.gain);
      g.gain.value = layer.gain * (1 - layer.lfo[1] * 0.5);
      lfo.start();
      nodes.push(lfo, depth);
      sources.push(lfo);
    }
    if (layer.sweep) {
      const lfo2 = ctx.createOscillator();
      lfo2.frequency.value = layer.sweepRate ?? 0.031;
      const depth2 = ctx.createGain();
      depth2.gain.value = layer.sweep;
      lfo2.connect(depth2).connect(filter.frequency);
      lfo2.start();
      nodes.push(lfo2, depth2);
      sources.push(lfo2);
    }
    src.start(0, Math.random() * (long ? long.duration - 0.5 : 1.5));
  }
  const space = def.space ? buildSpace(ctx, output, def.space, nodes) : output;
  return { output, space, nodes, sources, timer: null };
}

/**
 * Renders `seconds` of a preset offline: its layers, echo and events at times drawn the way a live
 * bed draws them (audio lab level checks). Null for an unknown preset or without Web Audio.
 */
export async function renderAmbience(preset: string, seconds: number, sampleRate = 48000, level = 1): Promise<AudioBuffer | null> {
  const def = PRESETS[preset];
  if (!def || typeof OfflineAudioContext === 'undefined') return null;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const bed = buildBed(ctx, ctx.destination, def, level, 0);
  const event = def.event;
  const env: AmbienceEnv = { space: bed.space, ...LOCAL_SOURCE(ctx) };
  if (event) for (let t = nextWait(event); t < seconds - 0.1; t += nextWait(event)) event.play(ctx, bed.output, t, env);
  return ctx.startRendering();
}

export class Ambience {
  private bed: Bed | null = null;
  current = '';

  constructor(
    private readonly getContext: () => AudioContext | null,
    private readonly bus: () => AudioNode | null,
    /** The world's rendered creature sounds and key (so no event synthesises on the main thread). */
    private readonly source?: AmbienceSource,
  ) {}

  /** Crossfades to a preset (empty string = silence). */
  set(preset: string, level = 1, fade = 2): void {
    const ctx = this.getContext();
    const bus = this.bus();
    if (!ctx || !bus || preset === this.current) return;
    this.current = preset;
    const old = this.bed;
    if (old) {
      old.output.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
      if (old.timer) clearTimeout(old.timer);
      setTimeout(() => this.disposeBed(old), (fade + 0.5) * 1000);
    }
    const def = PRESETS[preset];
    this.bed = def ? this.createBed(ctx, bus, def, level, fade) : null;
  }

  private createBed(ctx: AudioContext, bus: AudioNode, def: Preset, level: number, fade: number): Bed {
    const bed = buildBed(ctx, bus, def, level, fade);
    if (def.event) {
      const event = def.event;
      const env: AmbienceEnv = { space: bed.space, ...(this.source ?? LOCAL_SOURCE(ctx)) };
      const loop = (): void => {
        bed.timer = setTimeout(() => {
          if (ctx.state === 'running') event.play(ctx, bed.output, ctx.currentTime + 0.05, env);
          loop();
        }, nextWait(event) * 1000);
      };
      loop();
    }
    return bed;
  }

  private disposeBed(bed: Bed): void {
    if (bed.timer) clearTimeout(bed.timer);
    for (const s of bed.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    for (const n of bed.nodes) n.disconnect();
  }

  stop(): void {
    this.set('', 0, 1);
  }
}
