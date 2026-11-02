import { playNote } from '../synth/instruments';
import { noiseBuffers } from '../synth/resources';

/**
 * Procedural ambience beds per world: filtered noise layers with slow LFO motion plus sparse
 * scheduled events (wave crashes, clanks, bubbles, chirps). Crossfades between presets.
 */
interface Layer {
  readonly noise: 'white' | 'pink';
  readonly filter: BiquadFilterType;
  readonly freq: number;
  readonly q: number;
  readonly gain: number;
  /** LFO rate (Hz) and depth (0..1) on the layer gain: swells, wind gusts. */
  readonly lfo?: readonly [number, number];
  /** Slow filter sweep depth in Hz. */
  readonly sweep?: number;
}

interface Preset {
  readonly layers: readonly Layer[];
  readonly event?: { readonly every: readonly [number, number]; readonly play: (ctx: AudioContext, out: AudioNode, t: number) => void };
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
};

export const AMBIENCE_PRESETS = Object.keys(PRESETS);

interface Bed {
  readonly output: GainNode;
  readonly nodes: AudioNode[];
  readonly sources: AudioScheduledSourceNode[];
  timer: ReturnType<typeof setTimeout> | null;
}

export class Ambience {
  private bed: Bed | null = null;
  current = '';

  constructor(
    private readonly getContext: () => AudioContext | null,
    private readonly bus: () => AudioNode | null,
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
    const output = ctx.createGain();
    output.gain.value = 0;
    output.gain.setTargetAtTime(level, ctx.currentTime, fade / 3);
    output.connect(bus);
    const nodes: AudioNode[] = [output];
    const sources: AudioScheduledSourceNode[] = [];
    const { white, pink } = noiseBuffers(ctx);
    for (const layer of def.layers) {
      const src = ctx.createBufferSource();
      src.buffer = layer.noise === 'pink' ? pink : white;
      src.loop = true;
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
        lfo2.frequency.value = 0.031;
        const depth2 = ctx.createGain();
        depth2.gain.value = layer.sweep;
        lfo2.connect(depth2).connect(filter.frequency);
        lfo2.start();
        nodes.push(lfo2, depth2);
        sources.push(lfo2);
      }
      src.start(0, Math.random() * 1.5);
    }
    const bed: Bed = { output, nodes, sources, timer: null };
    if (def.event) {
      const event = def.event;
      const loop = (): void => {
        const wait = event.every[0] + Math.random() * (event.every[1] - event.every[0]);
        bed.timer = setTimeout(() => {
          if (ctx.state === 'running') event.play(ctx, output, ctx.currentTime + 0.05);
          loop();
        }, wait * 1000);
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
