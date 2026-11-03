/**
 * Material impact synthesis (sample level, offline). A hit is built from layers that real impacts
 * have: a transient, the material's modal body, a resonance, scattering particles, an environmental
 * tail and a sub thump. Pure functions over Float32Arrays, so they render identically in the
 * browser and in Node tests; the bank turns the result into AudioBuffers.
 */
import type { MaterialAudioProfile, ScatterKind } from './materialAudio';

export interface StereoSamples {
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly sampleRate: number;
}

/** xorshift32 in [0, 1). */
export function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** RBJ biquad (direct form I), mono state. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(type: 'lowpass' | 'highpass' | 'bandpass', freq: number, q: number, sampleRate: number) {
    const f = Math.min(freq, sampleRate * 0.45);
    const w = (2 * Math.PI * f) / sampleRate;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(0.05, q));
    let b0: number;
    let b1: number;
    let b2: number;
    if (type === 'lowpass') {
      b0 = (1 - cw) / 2;
      b1 = 1 - cw;
      b2 = (1 - cw) / 2;
    } else if (type === 'highpass') {
      b0 = (1 + cw) / 2;
      b1 = -(1 + cw);
      b2 = (1 + cw) / 2;
    } else {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }
    const a0 = 1 + alpha;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

class Canvas {
  readonly left: Float32Array;
  readonly right: Float32Array;
  constructor(
    readonly length: number,
    readonly sr: number,
  ) {
    this.left = new Float32Array(length);
    this.right = new Float32Array(length);
  }

  /** Adds a mono sample at index with equal-power pan (-1..1). */
  add(i: number, v: number, pan = 0): void {
    if (i < 0 || i >= this.length) return;
    const a = (pan + 1) * 0.25 * Math.PI;
    this.left[i]! += v * Math.cos(a);
    this.right[i]! += v * Math.sin(a);
  }
}

const TAU = Math.PI * 2;
/** Envelope decay constant so the level falls 60 dB over `t60` seconds. */
const k60 = (t60: number): number => 6.9078 / Math.max(0.002, t60);

function renderTransient(c: Canvas, p: MaterialAudioProfile['transient'], strength: number, r: () => number): void {
  if (!p || p.level <= 0) return;
  const n = Math.round((p.ms / 1000) * c.sr * (0.8 + strength * 0.4));
  const bp = new Biquad('bandpass', p.freq * (0.95 + r() * 0.1), p.q, c.sr);
  const hp = new Biquad('highpass', 120, 0.7, c.sr);
  const k = k60(p.ms / 1000);
  const level = p.level * (0.55 + strength * 0.45);
  for (let i = 0; i < n * 3; i++) {
    const t = i / c.sr;
    const v = hp.process(bp.process((r() * 2 - 1) * Math.exp(-t * k))) * level * 3;
    c.add(i, v, (r() - 0.5) * 0.2);
  }
  if (p.click > 0) c.add(0, p.click * level, 0);
}

function renderBody(c: Canvas, p: MaterialAudioProfile['body'], strength: number, variation: number, r: () => number): void {
  if (!p || p.level <= 0) return;
  const base = p.baseHz * (1 + (r() - 0.5) * 0.06 * variation) * (1.06 - strength * 0.08);
  p.modes.forEach((m, idx) => {
    const f0 = base * m.ratio * (1 + (r() - 0.5) * 0.02 * variation);
    if (f0 > c.sr * 0.45) return;
    // Harder hits excite upper modes more (brighter); soft ones stay dark.
    const bright = Math.pow(strength, idx * p.brightness * 0.35);
    const amp = m.gain * bright * p.level * (0.4 + strength * 0.6);
    const k = k60(m.decay * (0.8 + strength * 0.3));
    const n = Math.min(c.length, Math.round(m.decay * 1.1 * c.sr));
    let phase = r() * TAU;
    const pan = (r() - 0.5) * 0.35;
    for (let i = 0; i < n; i++) {
      const t = i / c.sr;
      // Slight pitch drop after the hit (heavier materials sag more).
      const f = f0 * (1 - p.drop * (1 - Math.exp(-t * 25)));
      phase += (TAU * f) / c.sr;
      const attack = Math.min(1, t * c.sr / 24);
      c.add(i, Math.sin(phase) * Math.exp(-t * k) * amp * attack, pan);
    }
  });
  if (p.noise > 0) {
    // Broadband crunch for granular, dense materials (stone, sandstone, obsidian).
    const lp = new Biquad('lowpass', p.noiseCutoff * (0.7 + strength * 0.5), 0.8, c.sr);
    const k = k60(p.noiseDecay);
    const n = Math.min(c.length, Math.round(p.noiseDecay * 1.2 * c.sr));
    const amp = p.noise * p.level * (0.4 + strength * 0.6);
    for (let i = 0; i < n; i++) {
      const t = i / c.sr;
      c.add(i, lp.process(r() * 2 - 1) * Math.exp(-t * k) * amp * 2.2, (r() - 0.5) * 0.5);
    }
  }
}

function renderResonance(c: Canvas, p: MaterialAudioProfile['resonance'], strength: number, r: () => number): void {
  if (!p || p.level <= 0) return;
  const amp = p.level * (0.5 + strength * 0.5);
  if (p.kind === 'comb') {
    // Feedback comb on a short noise burst: a metallic/electronic ring at freq.
    const delay = Math.max(2, Math.round(c.sr / p.freq));
    const buf = new Float32Array(delay);
    const fb = Math.exp(-delay / c.sr * k60(p.decay));
    const n = Math.min(c.length, Math.round(p.decay * 1.1 * c.sr));
    const lp = new Biquad('lowpass', p.freq * 6, 0.7, c.sr);
    for (let i = 0; i < n; i++) {
      const exc = i < c.sr * 0.004 ? (r() * 2 - 1) : 0;
      const y = exc + buf[i % delay]! * fb;
      buf[i % delay] = lp.process(y);
      c.add(i, y * amp * 0.5, Math.sin(i / c.sr * 3) * 0.3);
    }
    return;
  }
  const bands = p.kind === 'cavity' ? [1, 2.03, 3.1] : [1];
  bands.forEach((ratio, b) => {
    const bp = new Biquad('bandpass', p.freq * ratio * (0.97 + r() * 0.06), p.q, c.sr);
    const n = Math.min(c.length, Math.round(p.decay * 1.1 * c.sr));
    const g = amp / (b + 1);
    for (let i = 0; i < n; i++) {
      const exc = i < c.sr * 0.006 ? (r() * 2 - 1) * (1 - i / (c.sr * 0.006)) : 0;
      c.add(i, bp.process(exc) * g * p.q * 0.35, b === 0 ? 0 : (b % 2 ? -0.3 : 0.3));
    }
  });
}

function grain(c: Canvas, kind: ScatterKind, start: number, lo: number, hi: number, amp: number, pan: number, r: () => number): void {
  const f = lo * Math.pow(hi / lo, r());
  const s0 = Math.round(start * c.sr);
  switch (kind) {
    case 'sand':
    case 'dust': {
      const len = (kind === 'sand' ? 0.0015 + r() * 0.003 : 0.008 + r() * 0.02) * c.sr;
      const bp = new Biquad('bandpass', f, kind === 'sand' ? 1.6 : 0.8, c.sr);
      for (let i = 0; i < len * 2; i++) c.add(s0 + i, bp.process(r() * 2 - 1) * Math.exp((-i / len) * 3) * amp * 2.5, pan);
      break;
    }
    case 'pebbles': {
      const len = (0.004 + r() * 0.006) * c.sr;
      const bp = new Biquad('bandpass', f, 2.5, c.sr);
      let ph = 0;
      for (let i = 0; i < len * 3; i++) {
        ph += (TAU * f * 0.5) / c.sr;
        const e = Math.exp((-i / len) * 2.5);
        c.add(s0 + i, (bp.process(r() * 2 - 1) * 2 + Math.sin(ph) * 0.4) * e * amp, pan);
      }
      break;
    }
    case 'shards':
    case 'chimes': {
      const decay = kind === 'shards' ? 0.02 + r() * 0.05 : 0.25 + r() * 0.5;
      const n = Math.round(decay * 1.2 * c.sr);
      const k = k60(decay);
      let p1 = r() * TAU;
      let p2 = r() * TAU;
      for (let i = 0; i < n; i++) {
        p1 += (TAU * f) / c.sr;
        p2 += (TAU * f * 2.76) / c.sr;
        const t = i / c.sr;
        c.add(s0 + i, (Math.sin(p1) + Math.sin(p2) * 0.3) * Math.exp(-t * k) * amp * Math.min(1, i / 8), pan);
      }
      break;
    }
    case 'bubbles': {
      const dur = 0.03 + r() * 0.05;
      const n = Math.round(dur * c.sr);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        ph += (TAU * f * (1 + t * 0.7)) / c.sr;
        c.add(s0 + i, Math.sin(ph) * Math.sin(Math.PI * t) * Math.exp(-t * 2) * amp * 0.9, pan);
      }
      break;
    }
    case 'crackle': {
      const len = (0.0003 + r() * 0.001) * c.sr;
      const bp = new Biquad('bandpass', f, 1.2, c.sr);
      const a = amp * (0.4 + r() * r() * 2.4);
      for (let i = 0; i < len * 4; i++) c.add(s0 + i, bp.process(i < len ? r() * 2 - 1 : 0) * a * 3, pan);
      break;
    }
    case 'leaves': {
      const len = (0.02 + r() * 0.05) * c.sr;
      const bp = new Biquad('bandpass', f, 0.7, c.sr);
      for (let i = 0; i < len; i++) c.add(s0 + i, bp.process(r() * 2 - 1) * Math.sin((Math.PI * i) / len) * amp * 1.2, pan);
      break;
    }
    case 'sparks': {
      const decay = 0.005 + r() * 0.012;
      const n = Math.round(decay * 1.5 * c.sr);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        ph += (TAU * f) / c.sr;
        c.add(s0 + i, Math.sign(Math.sin(ph)) * Math.exp(-(i / c.sr) * k60(decay)) * amp * 0.35, pan);
      }
      break;
    }
  }
}

function renderScatter(c: Canvas, p: MaterialAudioProfile['scatter'], strength: number, r: () => number): void {
  if (!p || p.level <= 0 || p.count <= 0) return;
  const count = Math.round(p.count * (0.3 + strength * 0.9));
  for (let g = 0; g < count; g++) {
    // Front-loaded: most particles scatter right after the hit, stragglers trail off.
    const u = r();
    const t = p.delay + p.spread * Math.pow(u, 1.8);
    const fade = Math.pow(1 - u, 1.2);
    grain(c, p.kind, t, p.lo, p.hi, p.level * (0.35 + r() * 0.65) * (0.4 + fade * 0.6) * (0.5 + strength * 0.5), (r() - 0.5) * 2 * p.width, r);
  }
}

function renderTail(c: Canvas, p: MaterialAudioProfile['tail'], strength: number, r: () => number): void {
  if (!p || p.level <= 0) return;
  const type = p.kind === 'rumble' ? 'lowpass' : p.kind === 'hiss' ? 'bandpass' : 'bandpass';
  const filtL = new Biquad(type, p.freq, p.kind === 'shimmer' ? 4 : 0.8, c.sr);
  const filtR = new Biquad(type, p.freq * 1.07, p.kind === 'shimmer' ? 4 : 0.8, c.sr);
  const n = Math.min(c.length, Math.round(p.decay * 1.3 * c.sr));
  const k = k60(p.decay);
  const amp = p.level * (0.4 + strength * 0.6) * 1.8;
  for (let i = 0; i < n; i++) {
    const t = i / c.sr;
    const env = Math.min(1, t / 0.015) * Math.exp(-t * k);
    const wob = p.kind === 'shimmer' ? 0.6 + 0.4 * Math.sin(t * 23) : 1;
    c.left[i]! += filtL.process(r() * 2 - 1) * env * amp * wob;
    c.right[i]! += filtR.process(r() * 2 - 1) * env * amp * wob;
  }
}

function renderSub(c: Canvas, p: MaterialAudioProfile['sub'], strength: number): void {
  if (!p || p.level <= 0) return;
  const n = Math.min(c.length, Math.round(p.decay * 1.2 * c.sr));
  const k = k60(p.decay);
  const amp = p.level * Math.pow(strength, 1.3);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / c.sr;
    const f = p.to + (p.from - p.to) * Math.exp(-t * 30);
    ph += (TAU * f) / c.sr;
    c.add(i, Math.sin(ph) * Math.exp(-t * k) * amp * Math.min(1, i / 32), 0);
  }
}

/** Small Schroeder reverb (combs + allpasses) for the spatial tail. */
function reverb(c: Canvas, wet: number, size: number): void {
  if (wet <= 0) return;
  const combs = [1557, 1617, 1491, 1422].map((d) => Math.round(d * size * (c.sr / 44100)));
  const aps = [225, 556].map((d) => Math.round(d * (c.sr / 44100)));
  for (const [ch, data] of [c.left, c.right].entries()) {
    const out = new Float32Array(c.length);
    combs.forEach((d0) => {
      const d = d0 + ch * 23;
      const buf = new Float32Array(d);
      let lp = 0;
      for (let i = 0; i < c.length; i++) {
        const y = buf[i % d]!;
        lp = y * 0.7 + lp * 0.3;
        buf[i % d] = data[i]! + lp * 0.8;
        out[i]! += y * 0.25;
      }
    });
    aps.forEach((d) => {
      const buf = new Float32Array(d);
      for (let i = 0; i < c.length; i++) {
        const b = buf[i % d]!;
        const x = out[i]!;
        buf[i % d] = x + b * 0.5;
        out[i] = b - x * 0.5;
      }
    });
    for (let i = 0; i < c.length; i++) data[i]! += out[i]! * wet;
  }
}

/** Peak ceiling for rendered effects (dBFS). */
export const IMPACT_CEILING_DB = -1.5;

/** Removes DC, fades the end and keeps the peak under the ceiling. */
export function finalize(c: { left: Float32Array; right: Float32Array; sampleRate: number }, gain = 1): void {
  const ceiling = Math.pow(10, IMPACT_CEILING_DB / 20);
  let peak = 0;
  for (const data of [c.left, c.right]) {
    const hp = new Biquad('highpass', 22, 0.7, c.sampleRate);
    for (let i = 0; i < data.length; i++) {
      data[i] = hp.process(data[i]!) * gain;
      peak = Math.max(peak, Math.abs(data[i]!));
    }
    const fade = Math.min(data.length, Math.round(0.03 * c.sampleRate));
    for (let i = 0; i < fade; i++) data[data.length - 1 - i]! *= i / fade;
  }
  if (peak > ceiling) {
    const k = ceiling / peak;
    for (const data of [c.left, c.right]) for (let i = 0; i < data.length; i++) data[i]! *= k;
  }
}

export type ImpactLayer = 'transient' | 'body' | 'resonance' | 'scatter' | 'tail' | 'sub';

/**
 * Renders a material hit. `strength` 0..1 scales loudness, brightness and particle count;
 * `seed` picks the variation; `layers` limits which layers sound (lock = no tail, etc).
 */
export function renderImpact(
  profile: MaterialAudioProfile,
  strength: number,
  seed: number,
  sampleRate: number,
  opts: { layers?: readonly ImpactLayer[]; gain?: number; variation?: number; maxSeconds?: number } = {},
): StereoSamples {
  const layers = new Set(opts.layers ?? ['transient', 'body', 'resonance', 'scatter', 'tail', 'sub']);
  const s = Math.max(0.02, Math.min(1, strength));
  const longest = Math.max(
    0.1,
    layers.has('body') ? Math.max(...profile.body.modes.map((m) => m.decay), profile.body.noiseDecay) : 0,
    layers.has('resonance') ? profile.resonance.decay : 0,
    layers.has('scatter') ? profile.scatter.delay + profile.scatter.spread + 0.1 : 0,
    layers.has('tail') ? profile.tail.decay * 1.2 + profile.reverb.wet * profile.reverb.size * 0.8 : 0,
    layers.has('sub') ? profile.sub.decay : 0,
  );
  const seconds = Math.min(opts.maxSeconds ?? 2.6, longest + 0.08);
  const c = new Canvas(Math.ceil(seconds * sampleRate), sampleRate);
  const r = rng(seed * 7919 + Math.round(s * 1000));
  const variation = opts.variation ?? 1;
  if (layers.has('transient')) renderTransient(c, profile.transient, s, r);
  if (layers.has('body')) renderBody(c, profile.body, s, variation, r);
  if (layers.has('resonance')) renderResonance(c, profile.resonance, s, r);
  if (layers.has('scatter')) renderScatter(c, profile.scatter, s, r);
  if (layers.has('sub')) renderSub(c, profile.sub, s);
  if (layers.has('tail')) {
    reverb(c, profile.reverb.wet * (0.6 + s * 0.4), profile.reverb.size);
    renderTail(c, profile.tail, s, r);
  }
  const out = { left: c.left, right: c.right, sampleRate };
  finalize(out, (opts.gain ?? 1) * profile.gain);
  return out;
}

/** Short counterparts of long-ringing particle kinds, so light ticks stay light. */
const SHORT_KIND: Partial<Record<ScatterKind, ScatterKind>> = { chimes: 'shards', leaves: 'sand', dust: 'sand' };

/** Light particle ticks only (soft drop, spawn shimmer): a few short grains of the material's scatter. */
export function renderGrains(profile: MaterialAudioProfile, count: number, spread: number, seed: number, sampleRate: number, level = 0.5, rising = false): StereoSamples {
  const seconds = spread + 0.25;
  const c = new Canvas(Math.ceil(seconds * sampleRate), sampleRate);
  const r = rng(seed * 104729 + count);
  const p = profile.scatter;
  const kind = SHORT_KIND[p.kind] ?? p.kind;
  for (let g = 0; g < count; g++) {
    const u = r();
    const t = rising ? spread * Math.sqrt(u) : spread * Math.pow(u, 1.6);
    grain(c, kind, t, p.lo, p.hi, level * (0.5 + r() * 0.5), (r() - 0.5) * 2 * p.width, r);
  }
  const out = { left: c.left, right: c.right, sampleRate };
  finalize(out, profile.gain);
  return out;
}
