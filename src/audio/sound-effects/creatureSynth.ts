/**
 * Creature one-shots for world sounds: a small spider's skitter, a large one's crawl, a silk thread
 * under tension and a web humming. Synthesised sample by sample like the material impacts (pure and
 * deterministic per seed, so they render in the SFX worker and in Node tests), but independent of
 * the world's block material: a claw on stone sounds the same whatever the blocks are made of.
 */
import { Biquad, Canvas, finalize, IMPACT_CEILING_DB, rng, type StereoSamples } from './impactSynth';

const TAU = Math.PI * 2;
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
/** Envelope decay constant so the level falls 60 dB over `t60` seconds. */
const k60 = (t60: number): number => 6.9078 / Math.max(0.002, t60);

/** Pitch the web hum is rendered at (C3); the world-sound player transposes it into the music's key. */
export const WEB_HUM_HZ = 130.81;

/**
 * Loudness of each sound at gain 1: energy above 150 Hz (roughly how loud it sounds; a heavy step's
 * sub adds weight on top), in dB re one second at full scale. A footstep measures about -43.
 */
const LOUDNESS_DB = { skitter: -44, crawl: -41, silk: -46, webHum: -43 } as const;

type Pan = readonly [number, number];

/** Equal-power gains for a pan of -1..1. */
function pan(p: number): Pan {
  const a = (Math.max(-1, Math.min(1, p)) + 1) * 0.25 * Math.PI;
  return [Math.cos(a), Math.sin(a)];
}

function mix(c: Canvas, i: number, v: number, g: Pan): void {
  if (i < 0 || i >= c.length) return;
  c.left[i]! += v * g[0];
  c.right[i]! += v * g[1];
}

/**
 * Removes DC and fades the end, scales to a target loudness (`LOUDNESS_DB`), optionally rounds off
 * the hottest transients (soft limit at `softPeakDb`), and keeps the peak under the ceiling.
 */
function finish(c: Canvas, loudnessDb: number, softPeakDb?: number): StereoSamples {
  const out = { left: c.left, right: c.right, sampleRate: c.sr };
  finalize(out, 1);
  let sum = 0;
  for (const d of [c.left, c.right]) {
    const hp = new Biquad('highpass', 150, 0.6, c.sr);
    for (let i = 0; i < d.length; i++) {
      const v = hp.process(d[i]!);
      sum += v * v;
    }
  }
  const energy = sum / 2 / c.sr;
  if (energy <= 1e-14) return out;
  const k = Math.pow(10, loudnessDb / 20) / Math.sqrt(energy);
  const soft = softPeakDb === undefined ? 0 : Math.pow(10, softPeakDb / 20);
  let peak = 0;
  for (const d of [c.left, c.right]) {
    for (let i = 0; i < d.length; i++) {
      const v = soft > 0 ? soft * Math.tanh((d[i]! * k) / soft) : d[i]! * k;
      d[i] = v;
      peak = Math.max(peak, Math.abs(v));
    }
  }
  const ceiling = Math.pow(10, IMPACT_CEILING_DB / 20);
  if (peak > ceiling) for (const d of [c.left, c.right]) for (let i = 0; i < d.length; i++) d[i]! *= ceiling / peak;
  return out;
}

/** Chamberlin state-variable band-pass whose centre can move while it runs (sweeps), unity at the peak. */
class SweepBand {
  private low = 0;
  private band = 0;
  private f = 0;
  constructor(
    private readonly sr: number,
    /** 1 / Q. */
    private readonly damp: number,
  ) {}

  /** Sets the centre frequency (sweeps retune every BLOCK samples). */
  tune(freq: number): void {
    this.f = 2 * Math.sin((Math.PI * Math.min(freq, this.sr / 6)) / this.sr);
  }

  process(x: number): number {
    this.low += this.f * this.band;
    const high = x - this.low - this.damp * this.band;
    this.band += this.f * high;
    return this.band * this.damp;
  }
}

/** Samples per step of a sweep or vibrato: fine enough, and far cheaper than every sample. */
const BLOCK = 32;

/** A decaying sine (one mode of a thud or a knock), pitch sagging by `sag` just after the hit. */
function mode(c: Canvas, s0: number, hz: number, t60: number, amp: number, sag: number, g: Pan, r: () => number): void {
  const n = Math.round(t60 * 1.1 * c.sr);
  const decay = Math.exp(-k60(t60) / c.sr);
  let env = amp;
  let ph = r() * TAU;
  for (let i = 0; i < n; i++) {
    const t = i / c.sr;
    ph += (TAU * hz * (1 - sag * (1 - Math.exp(-t * 30)))) / c.sr;
    mix(c, s0 + i, Math.sin(ph) * env * Math.min(1, i / 20), g);
    env *= decay;
  }
}

/** One claw tip touching stone: a tick of a millisecond or so ringing in two small stone resonances. */
function claw(c: Canvas, t: number, amp: number, w: number, g: Pan, r: () => number): void {
  const s0 = Math.round(t * c.sr);
  const f1 = (3000 + r() * 4200) * (1 - w * 0.22);
  const b1 = new Biquad('bandpass', f1, 6 + r() * 7, c.sr);
  const b2 = new Biquad('bandpass', Math.min(c.sr * 0.42, f1 * (1.55 + r() * 0.6)), 4 + r() * 3, c.sr);
  const exc = Math.max(2, Math.round((0.0001 + r() * 0.0003) * c.sr));
  const n = Math.round(0.01 * c.sr);
  for (let i = 0; i < n; i++) {
    const x = i < exc ? r() * 2 - 1 : 0;
    mix(c, s0 + i, (b1.process(x) + b2.process(x) * 0.55) * amp * 5, g);
  }
  // The faint knock of the leg itself (only for the less tiny).
  if (w > 0.05) mode(c, s0, 520 + r() * 420, 0.012, amp * w * 0.22, 0, g, r);
}

/**
 * A small spider's dash: a quick, irregular patter of tiny claw ticks on stone (alternating sets of
 * four legs), with the faint brush of its legs under them. It speeds up, may stall for an instant
 * and eases off, so a run of them never becomes a click track. `weight` 0..1: 0 is a tiny spider
 * (fewer, higher, lighter ticks), 1 a small one with a touch of body in each step.
 */
export function renderSkitter(weight: number, seed: number, sampleRate: number): StereoSamples {
  const w = clamp01(weight);
  const r = rng(seed * 6151 + Math.round(w * 97));
  const dur = 0.14 + r() * 0.2 + w * 0.08;
  const c = new Canvas(Math.ceil((dur + 0.06) * sampleRate), sampleRate);
  // Half a gait cycle at full speed (s): one set of four legs, then the other.
  const half = 0.062 - w * 0.012;
  let t = 0.004 + r() * 0.008;
  while (t < dur) {
    const u = t / dur;
    const speed = 0.7 + 0.55 * Math.sin(Math.PI * Math.min(1, u * 1.15));
    const env = 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, u * 1.05 + 0.08));
    for (let leg = 0; leg < 4; leg++) {
      if (r() < 0.3) continue; // not every claw clicks audibly
      claw(c, t + leg * (0.003 + r() * 0.009), (0.4 + r() * 0.6) * env, w, pan((leg % 2 ? 0.16 : -0.16) + (r() - 0.5) * 0.25), r);
    }
    t += (half / speed) * (0.7 + r() * 0.6);
    if (r() < 0.12) t += 0.03 + r() * 0.05; // a brief stall
  }
  // The legs' faint brush on stone under the dash.
  const bpL = new Biquad('bandpass', 3800 + r() * 1800, 0.9, c.sr);
  const bpR = new Biquad('bandpass', 3800 + r() * 1800, 0.9, c.sr);
  const n = Math.min(c.length, Math.round((dur + 0.03) * c.sr));
  const a = 0.018 + r() * 0.012;
  for (let i = 0; i < n; i++) {
    const e = Math.sin((Math.PI * i) / n) ** 1.5 * a * 0.7;
    c.left[i]! += bpL.process(r() * 2 - 1) * e;
    c.right[i]! += bpR.process(r() * 2 - 1) * e;
  }
  return finish(c, LOUDNESS_DB.skitter + w * 1.5, -12);
}

/** One leg of a large spider landing: a claw on stone over a thud of weight, grit under the foot. */
function contact(c: Canvas, t: number, amp: number, w: number, baseHz: number, p: number, r: () => number): void {
  const s0 = Math.round(t * c.sr);
  const g = pan(p);
  // The claw: lower and longer than a skitter's tick, and less of the sound the heavier the leg.
  const fc = (1800 + r() * 1700) * (1 - w * 0.18);
  const b1 = new Biquad('bandpass', fc, 4 + r() * 3, c.sr);
  const b2 = new Biquad('bandpass', Math.min(c.sr * 0.42, fc * (2.1 + r() * 0.8)), 9, c.sr);
  const exc = Math.max(2, Math.round((0.0004 + r() * 0.0008) * c.sr));
  const clawAmp = amp * (1.1 - w * 0.5) * 3.2;
  const nt = Math.round(0.016 * c.sr);
  for (let i = 0; i < nt; i++) {
    const x = i < exc ? (r() * 2 - 1) * (1 - i / exc) : 0;
    mix(c, s0 + i, (b1.process(x) + b2.process(x) * 0.5) * clawAmp, g);
  }
  // The thud: leg and body weight meeting stone. Low modes for the weight, a short knock in the
  // low mids so it reads on small speakers too.
  const body = pan(p * 0.5);
  const thud = amp * (0.15 + w * 0.6);
  mode(c, s0, baseHz, 0.1 + w * 0.07, thud, 0.05, body, r);
  mode(c, s0, baseHz * 1.62, 0.065, thud * 0.42, 0.05, body, r);
  mode(c, s0, baseHz * 2.43, 0.04, thud * 0.22, 0.04, body, r);
  mode(c, s0, (380 - w * 140) * (0.9 + r() * 0.2), 0.03, thud * 0.5, 0.03, body, r);
  // Crunch: grit pressed under the foot.
  const lp = new Biquad('lowpass', 900 + r() * 500 + (1 - w) * 500, 0.8, c.sr);
  const decay = Math.exp(-k60(0.04) / c.sr);
  const nc = Math.round(0.05 * c.sr);
  let e = amp * (0.2 + w * 0.25);
  for (let i = 0; i < nc; i++) {
    mix(c, s0 + i, lp.process(r() * 2 - 1) * e, g);
    e *= decay;
  }
  // A few grains of grit skittering away.
  const grains = Math.floor(r() * (2 + w * 3));
  for (let k = 0; k < grains; k++) {
    const gt = s0 + Math.round((0.008 + r() * 0.08) * c.sr);
    const bp = new Biquad('bandpass', 1400 + r() * 3000, 3, c.sr);
    const gl = Math.max(2, Math.round((0.002 + r() * 0.004) * c.sr));
    const ga = amp * (0.15 + r() * 0.2) * 2;
    const gp = pan(p + (r() - 0.5) * 0.5);
    for (let i = 0; i < gl * 3; i++) mix(c, gt + i, bp.process(i < gl ? r() * 2 - 1 : 0) * ga, gp);
  }
}

/** A leg dragged over stone: rough stick-slip friction, rising in pitch as it slides. */
function drag(c: Canvas, t: number, dur: number, amp: number, p: number, r: () => number): void {
  const s0 = Math.round(t * c.sr);
  const n = Math.round(dur * c.sr);
  const g = pan(p);
  const band = new SweepBand(c.sr, 0.35);
  const f0 = 900 + r() * 600;
  const f1 = f0 * (1.5 + r() * 0.8);
  let next = 0;
  let slip = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    if (i >= next) {
      slip = 0.6 + r() * 0.8;
      next = i + Math.round(c.sr / (45 + r() * 50));
    }
    slip *= 0.995;
    if (i % BLOCK === 0) band.tune(f0 + (f1 - f0) * u);
    mix(c, s0 + i, band.process(r() * 2 - 1) * Math.sin(Math.PI * u) ** 0.8 * (0.35 + slip * 0.65) * amp, g);
  }
}

/**
 * One step of a large spider: two to four legs of one set landing a beat apart, each a claw on
 * stone over a low thud, with grit under the foot, now and then a leg dragging and, for the
 * heaviest, the body settling. `weight` 0..1: heavier is deeper, slower and more thud than click.
 */
export function renderCrawl(weight: number, seed: number, sampleRate: number): StereoSamples {
  const w = clamp01(weight);
  const r = rng(seed * 7393 + Math.round(w * 89));
  const c = new Canvas(Math.ceil((0.62 + w * 0.2) * sampleRate), sampleRate);
  const legs = 2 + Math.floor(r() * 3);
  const gap = 0.045 + w * 0.06;
  const baseHz = 100 - w * 30 + (r() - 0.5) * 10;
  let t = 0.003;
  for (let k = 0; k < legs; k++) {
    const main = k === 0 || r() < 0.3;
    contact(c, t, main ? 1 : 0.4 + r() * 0.4, w, baseHz * (1 + (r() - 0.5) * 0.14), (r() - 0.5) * 0.5, r);
    t += gap * (0.55 + r() * 0.9);
  }
  if (r() < 0.25 + w * 0.25) drag(c, 0.03 + r() * 0.14, 0.07 + r() * 0.1 + w * 0.06, 0.3 + w * 0.2, (r() - 0.5) * 0.6, r);
  if (w > 0.35) {
    // The body's weight settling: a soft sub swell under the step.
    const a = (w - 0.35) * 0.55;
    const s0 = Math.round(0.004 * c.sr);
    const n = Math.round(0.3 * c.sr);
    const decay = Math.exp(-k60(0.26) / c.sr);
    const centre = pan(0);
    let env = a;
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const tt = i / c.sr;
      ph += (TAU * (32 + 22 * Math.exp(-tt * 14))) / c.sr;
      mix(c, s0 + i, Math.sin(ph) * env * Math.min(1, tt / 0.012), centre);
      env *= decay;
    }
  }
  return finish(c, LOUDNESS_DB.crawl + w * 2.5);
}

/**
 * A silk thread under tension: an airy stretch, a soft stick-slip creak at its anchor whose rate
 * climbs as the strand tightens (or falls as it slackens), and a faint singing of the strand.
 */
export function renderSilk(seed: number, sampleRate: number): StereoSamples {
  const r = rng(seed * 4241 + 3);
  const dur = 0.55 + r() * 0.5;
  const c = new Canvas(Math.ceil((dur + 0.2) * sampleRate), sampleRate);
  const n = Math.round(dur * c.sr);
  const rising = r() < 0.7;
  const env = (u: number): number => Math.sin(Math.PI * Math.min(1, u)) ** 1.4 * (rising ? 0.6 + 0.4 * u : 1 - 0.4 * u);
  // The airy stretch.
  const airL = new SweepBand(c.sr, 0.7);
  const airR = new SweepBand(c.sr, 0.7);
  const a0 = 2300 + r() * 1200;
  const a1 = a0 * (rising ? 1.35 : 0.75);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    if (i % BLOCK === 0) {
      const f = a0 + (a1 - a0) * u;
      airL.tune(f);
      airR.tune(f * 1.06);
    }
    const e = env(u) * 0.22;
    c.left[i]! += airL.process(r() * 2 - 1) * e;
    c.right[i]! += airR.process(r() * 2 - 1) * e;
  }
  // The creak: slips of the strand at an anchor, each ringing a small resonance.
  const fr = 1250 + r() * 900;
  const res1 = new Biquad('bandpass', fr, 14, c.sr);
  const res2 = new Biquad('bandpass', Math.min(c.sr * 0.42, fr * 2.7), 10, c.sr);
  const rate0 = 16 + r() * 10;
  const rate1 = rate0 * (rising ? 2.4 + r() * 0.8 : 0.5);
  const from = Math.round(n * (0.1 + r() * 0.15));
  const to = Math.round(n * (0.75 + r() * 0.2));
  const g = pan((r() - 0.5) * 0.4);
  let next = from;
  for (let i = from; i < c.length; i++) {
    let x = 0;
    if (i >= next && i < to) {
      const u = (i - from) / (to - from);
      x = (0.5 + r() * 0.5) * Math.sin(Math.PI * u) ** 0.7;
      next = i + Math.round((c.sr / (rate0 + (rate1 - rate0) * u)) * (0.8 + r() * 0.4));
    }
    mix(c, i, (res1.process(x) + res2.process(x) * 0.35) * 22, g);
  }
  // The strand singing faintly as it tightens.
  const s0 = 820 + r() * 600;
  const s1 = s0 * (rising ? 1.07 : 0.95);
  const trem = 7 + r() * 5;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    ph += (TAU * (s0 + (s1 - s0) * u)) / c.sr;
    mix(c, i, Math.sin(ph) * env(u) * (0.75 + 0.25 * Math.sin((TAU * trem * i) / c.sr)) * 0.025, g);
  }
  return finish(c, LOUDNESS_DB.silk);
}

/**
 * A web set vibrating: three strands of silk (the root, a detuned twin and a fifth or octave)
 * touched softly, ringing as plucked strings that waver as the web sways. The twin beats against
 * the root and the upper partials glint and fade first. Rendered at WEB_HUM_HZ.
 */
export function renderWebHum(seed: number, sampleRate: number): StereoSamples {
  const r = rng(seed * 9187 + 11);
  const dur = 1.6 + r() * 0.6;
  const c = new Canvas(Math.ceil((dur + 0.1) * sampleRate), sampleRate);
  const cents = (x: number): number => Math.pow(2, x / 1200);
  const strands = [
    { ratio: 1, gain: 1, pan: (r() - 0.5) * 0.3 },
    { ratio: cents(4 + r() * 6), gain: 0.6 + r() * 0.25, pan: 0.35 },
    { ratio: (r() < 0.5 ? 1.5 : 2) * cents((r() - 0.5) * 6), gain: 0.35 + r() * 0.2, pan: -0.35 },
  ];
  // A soft touch rather than a sharp pluck.
  const attack = Math.round((0.008 + r() * 0.02) * c.sr);
  const mono = new Float32Array(c.length);
  for (const s of strands) {
    mono.fill(0);
    const pos = 0.12 + r() * 0.2;
    const vibRate = 1.2 + r() * 1.4;
    const vibPhase = r() * TAU;
    for (let k = 1; k <= 9; k++) {
      const f = WEB_HUM_HZ * s.ratio * k * (1 + 0.0004 * k * k);
      if (f > c.sr * 0.2) break;
      const amp = (Math.abs(Math.sin(Math.PI * k * pos)) / Math.pow(k, 1.15)) * s.gain * 0.3;
      const t60 = dur / (1 + 0.45 * (k - 1));
      const decay = Math.exp(-k60(t60) / c.sr);
      const m = Math.min(c.length, Math.round(t60 * 1.1 * c.sr));
      // A rotating phasor whose step follows the sway every BLOCK samples.
      const ph0 = r() * TAU;
      let cs = Math.cos(ph0);
      let sn = Math.sin(ph0);
      let env = amp;
      for (let b = 0; b < m; b += BLOCK) {
        const step = (TAU * f * (1 + 0.0022 * Math.sin((TAU * vibRate * b) / c.sr + vibPhase))) / c.sr;
        const cw = Math.cos(step);
        const sw = Math.sin(step);
        const end = Math.min(m, b + BLOCK);
        for (let i = b; i < end; i++) {
          const ns = sn * cw + cs * sw;
          cs = cs * cw - sn * sw;
          sn = ns;
          let a = env;
          if (i < attack) {
            const u = i / attack;
            a *= u * u * (3 - 2 * u);
          }
          mono[i]! += sn * a;
          env *= decay;
        }
        const norm = 1 / Math.hypot(cs, sn);
        cs *= norm;
        sn *= norm;
      }
    }
    const g = pan(s.pan);
    for (let i = 0; i < c.length; i++) {
      c.left[i]! += mono[i]! * g[0];
      c.right[i]! += mono[i]! * g[1];
    }
  }
  return finish(c, LOUDNESS_DB.webHum);
}
