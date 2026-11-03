import type { AudioEngine } from '../engine/AudioEngine';
import type { StormSound, WeatherSound } from '../worldSounds';
import { renderStormJob, type StormRenderJob, type StormWorkerRequest, type StormWorkerResponse } from './stormJobs';
import StormWorker from './stormRender.worker.ts?worker';
import type { RainSurface, StereoBuffer } from './stormSynth';

/** One scheduled storm sound, kept for the debug log (strike-to-thunder timing). */
export interface StormLogEntry {
  readonly kind: 'thunder' | 'crack';
  /** The world's id for the strike (pairs a strike with its thunder). */
  readonly tag: number | null;
  /** Audio-clock time the world asked for it: its strike's flash. */
  readonly requested: number;
  /** performance.now() at the request. */
  readonly requestedPerf: number;
  readonly delay: number;
  /** Audio time it was due to start: requested + delay. */
  readonly scheduled: number;
  /** Audio time it actually starts (only later than scheduled if its render came back late). */
  started: number | null;
  /** Milliseconds its synthesis took. */
  renderMs: number | null;
  readonly distance: number;
  readonly energy: number;
  /** Share sent to the near thunder bus (the rest goes to the distant one). */
  readonly near: number;
  readonly gain: number;
  readonly pan: number;
}

interface Layer {
  readonly gain: GainNode;
  readonly filter: BiquadFilterNode | null;
  readonly source: AudioBufferSourceNode;
  /** Slow random variation of this layer's level (a smoothed walk). */
  drift: number;
}

interface Bed {
  readonly out: GainNode;
  readonly rain: GainNode;
  readonly wind: GainNode;
  readonly layers: Map<string, Layer>;
  readonly nodes: AudioNode[];
  last: number;
  timer: ReturnType<typeof setTimeout> | null;
}

type BedLayer = 'roar' | 'hiss' | 'ground' | 'far' | 'water' | 'rock' | 'wood' | 'foliage' | 'windBody' | 'windLow' | 'whistle' | 'gustAir';

/**
 * The storm sound engine: the continuous rain and wind beds of weather worlds, and the thunder and
 * lightning cracks they schedule on the audio clock. Thunder, cracks and the rain's droplet loops are
 * synthesised in a worker (stormSynth.ts) for each event, so no two thunders are alike; the beds are
 * long noise loops through slowly moving filters with droplet textures for puddles, rock, wood and
 * grass. Each kind has its own bus (rain, wind, near thunder, distant thunder, crack), so each has its
 * own volume; big thunder ducks the music a little as it arrives.
 */
export class StormAudio {
  private worker: Worker | null = null;
  private workerFailed = false;
  private nextJob = 1;
  private readonly pending = new Map<number, { resolve: (b: StereoBuffer & { ms: number }) => void; reject: (e: Error) => void }>();
  private bed: Bed | null = null;
  private bedBuilding = false;
  private readonly cracks: AudioBuffer[] = [];
  private crackRefill = 0;
  private seed = (Math.random() * 4294967296) >>> 0;
  private readonly listener = { x: 0, y: 0, z: 30, fx: 0, fz: -1 };
  /** Recent storm sounds and their timing (inspected by tests and the developer tools). */
  readonly log: StormLogEntry[] = [];
  private lastWeather = 0;

  constructor(private readonly engine: AudioEngine) {}

  setListener(px: number, py: number, pz: number, fx: number, fz: number): void {
    const l = this.listener;
    l.x = px;
    l.y = py;
    l.z = pz;
    const len = Math.hypot(fx, fz) || 1;
    l.fx = fx / len;
    l.fz = fz / len;
  }

  private nextSeed(): number {
    this.seed = (Math.imul(this.seed ^ (this.seed >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
    return this.seed;
  }

  /** Renders a job in the worker (or on the main thread when workers are unavailable). */
  private render(job: StormRenderJob): Promise<StereoBuffer & { ms: number }> {
    if (!this.worker && !this.workerFailed && typeof Worker !== 'undefined') {
      try {
        this.worker = new StormWorker();
        this.worker.onmessage = (e: MessageEvent<StormWorkerResponse>) => {
          const p = this.pending.get(e.data.id);
          if (!p) return;
          this.pending.delete(e.data.id);
          if ('error' in e.data) p.reject(new Error(e.data.error));
          else p.resolve({ left: e.data.left, right: e.data.right, sampleRate: e.data.sampleRate, ms: e.data.ms });
        };
        this.worker.onerror = () => {
          this.workerFailed = true;
          this.worker?.terminate();
          this.worker = null;
          for (const p of this.pending.values()) p.reject(new Error('storm worker failed'));
          this.pending.clear();
        };
      } catch {
        this.workerFailed = true;
        this.worker = null;
      }
    }
    if (!this.worker) {
      const t0 = performance.now();
      try {
        const b = renderStormJob(job);
        return Promise.resolve({ ...b, ms: performance.now() - t0 });
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    const id = this.nextJob++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, job } satisfies StormWorkerRequest);
    });
  }

  private toBuffer(ctx: AudioContext, b: StereoBuffer): AudioBuffer {
    const buf = ctx.createBuffer(2, b.left.length, b.sampleRate);
    buf.copyToChannel(b.left as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(b.right as Float32Array<ArrayBuffer>, 1);
    return buf;
  }

  /** Left/right placement (-1..1) of a world position for the current listener. */
  private panOf(x: number, z: number): number {
    const l = this.listener;
    const dx = x - l.x;
    const dz = z - l.z;
    const d = Math.hypot(dx, dz) || 1;
    // Right of the listener = forward × up.
    return Math.max(-1, Math.min(1, ((dx * -l.fz + dz * l.fx) / d) * 0.75));
  }

  // ------------------------------------------------------------------ weather beds

  /** Keeps the rain and wind beds sounding at these levels; they fade out soon after the calls stop. */
  weather(state: WeatherSound): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.engine.ready) return;
    const now = ctx.currentTime;
    if (now - this.lastWeather < 0.06) return;
    this.lastWeather = now;
    this.refillCracks(ctx);
    if (!this.bed) {
      if (!this.bedBuilding) void this.buildBed(ctx);
      return;
    }
    const bed = this.bed;
    bed.last = now;
    if (bed.timer) clearTimeout(bed.timer);
    // Nobody keeps the weather alive any more (world hidden): release the bed after it has faded.
    bed.timer = setTimeout(() => this.disposeBed(), 6000);
    const r = Math.max(0, Math.min(1.6, state.rain));
    const w = Math.max(0, Math.min(1.3, state.wind));
    const g = Math.max(0, Math.min(1, state.gust ?? 0));
    const s = state.surfaces ?? {};
    const levels: Record<BedLayer, number> = {
      roar: 0.5 * r ** 0.9 * (1 + 0.25 * g),
      hiss: 0.2 * r * (1 + 0.7 * g),
      ground: 0.42 * r ** 0.8,
      far: 0.22 * r ** 0.7,
      water: 0.5 * r ** 1.1 * (s.water ?? 0.5),
      rock: 0.32 * r * (s.rock ?? 0.4),
      wood: 0.22 * r * (s.wood ?? 0.1),
      foliage: 0.3 * r * (s.foliage ?? 0.4),
      windBody: 0.48 * Math.pow(w * 0.8 + g * 0.7, 1.2),
      windLow: 0.42 * (w + g * 0.5),
      whistle: 0.07 * Math.max(0, g - 0.35) * 2 * (0.5 + w),
      gustAir: 0.17 * g * (0.5 + r * 0.5),
    };
    for (const [name, layer] of bed.layers) {
      // Slow natural variation: no layer holds perfectly still.
      layer.drift += (Math.random() - 0.5) * 0.08 - layer.drift * 0.02;
      const target = Math.max(0, (levels[name as BedLayer] ?? 0) * (1 + layer.drift));
      const p = layer.gain.gain as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now);
      else p.cancelScheduledValues(now);
      p.setTargetAtTime(target, now, 0.5);
      p.setTargetAtTime(0, now + 0.9, 0.9);
      if (name === 'windBody' && layer.filter) layer.filter.frequency.setTargetAtTime(260 + 520 * (w * 0.4 + g) * (1 + layer.drift), now, 0.6);
      if (name === 'whistle' && layer.filter) layer.filter.frequency.setTargetAtTime(950 + 500 * g + 200 * layer.drift, now, 0.8);
      if (name === 'roar' && layer.filter) layer.filter.frequency.setTargetAtTime(1300 + 300 * layer.drift + 400 * g, now, 1.2);
      if ((name === 'water' || name === 'rock' || name === 'wood' || name === 'foliage') && Math.random() < 0.05) {
        layer.source.playbackRate.setTargetAtTime(0.95 + Math.random() * 0.1, now, 2);
      }
    }
  }

  private async buildBed(ctx: AudioContext): Promise<void> {
    this.bedBuilding = true;
    try {
      const sr = ctx.sampleRate;
      const [white, pink, brown, ...tex] = await Promise.all([
        this.render({ kind: 'noise', color: 'white', seconds: 9.3, seed: 11, sampleRate: sr }),
        this.render({ kind: 'noise', color: 'pink', seconds: 11.7, seed: 12, sampleRate: sr }),
        this.render({ kind: 'noise', color: 'brown', seconds: 13.1, seed: 13, sampleRate: sr }),
        ...(['water', 'rock', 'wood', 'foliage'] as RainSurface[]).map((surface, i) => this.render({ kind: 'rain', surface, seconds: 6 + i * 0.7, seed: 21 + i, sampleRate: sr })),
      ]);
      if (this.engine.ctx !== ctx) return;
      const out = ctx.createGain();
      out.gain.value = 0;
      out.gain.setTargetAtTime(1, ctx.currentTime, 0.8);
      const rain = ctx.createGain();
      const wind = ctx.createGain();
      rain.connect(this.engine.rain);
      wind.connect(this.engine.wind);
      out.connect(rain);
      const nodes: AudioNode[] = [out, rain, wind];
      const layers = new Map<string, Layer>();
      const buffers = { white: this.toBuffer(ctx, white!), pink: this.toBuffer(ctx, pink!), brown: this.toBuffer(ctx, brown!) };
      const texBuffers = tex.map((t) => this.toBuffer(ctx, t));
      const add = (name: BedLayer, buffer: AudioBuffer, bus: AudioNode, filter?: { type: BiquadFilterType; freq: number; q: number }): void => {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        let f: BiquadFilterNode | null = null;
        if (filter) {
          f = ctx.createBiquadFilter();
          f.type = filter.type;
          f.frequency.value = filter.freq;
          f.Q.value = filter.q;
          source.connect(f).connect(gain);
        } else source.connect(gain);
        gain.connect(bus);
        source.start(ctx.currentTime, Math.random() * buffer.duration);
        nodes.push(source, gain);
        if (f) nodes.push(f);
        layers.set(name, { gain, filter: f, source, drift: 0 });
      };
      // Rain: the roar of heavy rain, its fine hiss, the low wash of rain on wet ground, the far rain
      // across the glen, and droplets on puddles, rock, wood and heather.
      add('roar', buffers.pink, out, { type: 'bandpass', freq: 1400, q: 0.45 });
      add('hiss', buffers.white, out, { type: 'highpass', freq: 5200, q: 0.5 });
      add('ground', buffers.brown, out, { type: 'lowpass', freq: 420, q: 0.6 });
      add('far', buffers.pink, out, { type: 'lowpass', freq: 950, q: 0.5 });
      add('water', texBuffers[0]!, out);
      add('rock', texBuffers[1]!, out);
      add('wood', texBuffers[2]!, out, { type: 'lowpass', freq: 2600, q: 0.6 });
      add('foliage', texBuffers[3]!, out);
      // Wind: its body (a band that rises with the gusts), the low distant roar, a thin whistle in
      // strong gusts and the hiss of rain blown sideways.
      add('windBody', buffers.pink, wind, { type: 'bandpass', freq: 420, q: 0.8 });
      add('windLow', buffers.brown, wind, { type: 'lowpass', freq: 150, q: 0.7 });
      add('whistle', buffers.white, wind, { type: 'bandpass', freq: 1100, q: 12 });
      add('gustAir', buffers.white, wind, { type: 'bandpass', freq: 2500, q: 0.6 });
      this.bed = { out, rain, wind, layers, nodes, last: ctx.currentTime, timer: setTimeout(() => this.disposeBed(), 6000) };
    } catch (err) {
      console.warn('[audio] storm bed unavailable', err);
    } finally {
      this.bedBuilding = false;
    }
  }

  private disposeBed(): void {
    const bed = this.bed;
    if (!bed) return;
    this.bed = null;
    if (bed.timer) clearTimeout(bed.timer);
    for (const l of bed.layers.values()) {
      try {
        l.source.stop();
      } catch {
        /* already stopped */
      }
    }
    for (const n of bed.nodes) n.disconnect();
  }

  // ------------------------------------------------------------------ thunder and cracks

  /** Pre-renders a few cracks so a nearby strike's crack sounds with its flash, not after a render. */
  private refillCracks(ctx: AudioContext): void {
    while (this.cracks.length + this.crackRefill < 3) {
      this.crackRefill++;
      void this.render({ kind: 'crack', spec: { seed: this.nextSeed(), energy: 0.9, sampleRate: ctx.sampleRate } })
        .then((b) => {
          if (this.engine.ctx === ctx) this.cracks.push(this.toBuffer(ctx, b));
        })
        .catch(() => undefined)
        .finally(() => this.crackRefill--);
    }
  }

  /** Schedules a world's storm sound (see WorldSounds.storm). */
  schedule(sound: StormSound): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.engine.ready) return;
    this.refillCracks(ctx);
    const requested = ctx.currentTime;
    const delay = Math.max(0, Math.min(20, sound.delay ?? 0));
    const energy = Math.max(0, Math.min(1, sound.energy));
    const pan = this.panOf(sound.x, sound.z);
    const distance = Math.max(30, sound.distance);
    if (sound.kind === 'crack') {
      const buffer = this.cracks.shift();
      const entry: StormLogEntry = { kind: 'crack', tag: sound.tag ?? null, requested, requestedPerf: performance.now(), delay, scheduled: requested + delay, started: null, renderMs: 0, distance, energy, near: 1, gain: 0, pan };
      this.pushLog(entry);
      if (!buffer) return;
      const gain = 0.85 * energy ** 0.7 * Math.min(1, 900 / distance);
      (entry as { gain: number }).gain = gain;
      entry.started = this.play(ctx, buffer, requested + delay, gain, pan, [[this.engine.crack, 1]]);
      return;
    }
    // Thunder: louder and nearer-sounding close by, softer and on the distant bus far away.
    const near = Math.max(0, Math.min(1, 1 - (distance - 700) / 2600));
    const gain = 0.8 * Math.pow(energy, 0.8) * (0.32 + 0.68 / (1 + Math.pow(distance / 2600, 1.3)));
    const entry: StormLogEntry = { kind: 'thunder', tag: sound.tag ?? null, requested, requestedPerf: performance.now(), delay, scheduled: requested + delay, started: null, renderMs: null, distance, energy, near, gain, pan };
    this.pushLog(entry);
    void this.render({ kind: 'thunder', spec: { seed: sound.seed ?? this.nextSeed(), distance, energy, strokes: sound.strokes, channel: sound.channel, sampleRate: ctx.sampleRate } })
      .then((b) => {
        if (this.engine.ctx !== ctx) return;
        entry.renderMs = b.ms;
        const buffer = this.toBuffer(ctx, b);
        entry.started = this.play(ctx, buffer, entry.scheduled, gain, pan, [
          [this.engine.thunderNear, near],
          [this.engine.thunderFar, 1 - near],
        ]);
        // Big, close thunder rises over the music: the music dips a few dB as it arrives.
        const weight = energy * (0.35 + 0.65 * near);
        if (weight > 0.45) this.engine.duckMusic(entry.started, 0.2 + 0.25 * (weight - 0.45) / 0.55, 1.2 + near, 3.5);
      })
      .catch((err) => console.warn('[audio] thunder render failed', err));
  }

  /** Starts a buffer at audio time `when` (or as soon as possible), through a gain and panner to buses. */
  private play(ctx: AudioContext, buffer: AudioBuffer, when: number, gain: number, pan: number, buses: [AudioNode, number][]): number {
    const at = Math.max(when, ctx.currentTime + 0.005);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(g).connect(p);
    const sends: GainNode[] = [];
    for (const [bus, share] of buses) {
      if (share <= 0.001) continue;
      const s = ctx.createGain();
      s.gain.value = share;
      p.connect(s).connect(bus);
      sends.push(s);
    }
    src.onended = () => {
      src.disconnect();
      g.disconnect();
      p.disconnect();
      for (const s of sends) s.disconnect();
    };
    src.start(at);
    return at;
  }

  private pushLog(entry: StormLogEntry): void {
    this.log.push(entry);
    if (this.log.length > 120) this.log.shift();
  }

  dispose(): void {
    this.disposeBed();
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    this.cracks.length = 0;
  }
}
