/**
 * Storm sound synthesis, sample by sample (pure TypeScript, no Web Audio): thunder, the crack of a
 * nearby strike and the droplet textures of rain. Everything is original and procedural; nothing is
 * sampled. Used in a worker (stormRender.worker.ts) and by the unit tests.
 *
 * Thunder follows the physics that make it roll. A lightning channel is a tortuous path kilometres
 * long; every short, straight piece of it sends out its own pressure pulse (an N-wave) at the moment
 * of the stroke, and the listener hears them one after another as their distances differ: the
 * nearest part of the channel first (the sharp clap of a nearby strike), the far upper reaches and
 * the branches seconds later (the roll). Air absorbs the highs with distance, so each pulse is
 * filtered by how far it travelled: near thunder cracks and tears, distant thunder only rumbles. A
 * low rumble body follows the density of arriving pulses, the land throws back late, dull echoes,
 * and a long dark reverberation lets it decay. Return strokes re-excite the nearest part of the
 * channel; sometimes a second channel gives a double peal. Every render has its own seed and its
 * own channel, so no two thunders are the same.
 */

export interface StereoBuffer {
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly sampleRate: number;
}

export interface ThunderSpec {
  readonly seed: number;
  /** Apparent distance of the strike (m): drives the clap, the filtering, the roll and the echoes. */
  readonly distance: number;
  /** 0..1 strike energy. */
  readonly energy: number;
  /** Return stroke offsets (s) after the first. */
  readonly strokes?: readonly number[];
  /** A channel to the ground (vertical) or one crawling between clouds (horizontal, longer roll). */
  readonly channel?: 'ground' | 'cloud';
  readonly sampleRate: number;
}

export interface CrackSpec {
  readonly seed: number;
  readonly energy: number;
  readonly sampleRate: number;
}

export type RainSurface = 'water' | 'rock' | 'wood' | 'foliage';

const SPEED = 343;

/** Deterministic mulberry32 in 0..1. */
export function rng(seed: number): () => number {
  let st = seed >>> 0 || 1;
  return () => {
    st = (st + 0x6d2b79f5) >>> 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One-pole low-pass in place (6 dB/octave); `passes` cascades it. */
function lowpass(x: Float32Array, hz: number, sr: number, passes = 1, from = 0, to = x.length): void {
  const a = 1 - Math.exp((-2 * Math.PI * Math.min(hz, sr * 0.45)) / sr);
  for (let p = 0; p < passes; p++) {
    let y = 0;
    for (let i = from; i < to; i++) {
      y += a * (x[i]! - y);
      x[i] = y;
    }
  }
}

/** One-pole high-pass in place. */
function highpass(x: Float32Array, hz: number, sr: number, passes = 1): void {
  const a = Math.exp((-2 * Math.PI * hz) / sr);
  for (let p = 0; p < passes; p++) {
    let prevX = 0;
    let y = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i]!;
      y = a * (y + v - prevX);
      prevX = v;
      x[i] = y;
    }
  }
}

/** RBJ band-pass (constant peak) in place. */
function bandpass(x: Float32Array, hz: number, q: number, sr: number): void {
  const w = (2 * Math.PI * hz) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w)) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    const y = b0 * v + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

/** A small damped comb and all-pass reverberator (Schroeder/Freeverb style), mixed in place. */
function reverb(x: Float32Array, sr: number, seconds: number, damping: number, wet: number, seed: number): void {
  const rand = rng(seed);
  const n = x.length;
  const out = new Float32Array(n);
  const combs = [0.0297, 0.0371, 0.0411, 0.0437, 0.0503, 0.0571].map((d) => Math.round(d * sr * (0.92 + rand() * 0.16)));
  for (const d of combs) {
    // Feedback for the decay time: g^(seconds / delay) = 0.001.
    const g = Math.pow(0.001, d / sr / seconds);
    const buf = new Float32Array(d);
    let k = 0;
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const y = buf[k]!;
      lp = y * (1 - damping) + lp * damping;
      buf[k] = x[i]! + lp * g;
      out[i]! += y;
      if (++k >= d) k = 0;
    }
  }
  for (const [ms, g] of [
    [0.0051, 0.6],
    [0.0127, 0.55],
  ] as const) {
    const d = Math.round(ms * sr * (0.9 + rand() * 0.2));
    const buf = new Float32Array(d);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const b = buf[k]!;
      const v = out[i]!;
      const y = -v * g + b;
      buf[k] = v + b * g;
      out[i] = y;
      if (++k >= d) k = 0;
    }
  }
  const scale = wet / combs.length;
  for (let i = 0; i < n; i++) x[i]! += out[i]! * scale;
}

function peak(...chs: Float32Array[]): number {
  let p = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]!));
  return p;
}

/** Scales a stereo pair to a peak ceiling and fades its last `fade` seconds out. */
function finish(left: Float32Array, right: Float32Array, sr: number, ceiling: number, fade: number): void {
  const n = left.length;
  const f = Math.min(n, Math.round(fade * sr));
  for (let i = 0; i < f; i++) {
    const k = i / f;
    const g = k * k;
    left[n - 1 - i]! *= g;
    right[n - 1 - i]! *= g;
  }
  const p = peak(left, right);
  if (p > 0) {
    const s = ceiling / p;
    for (let i = 0; i < n; i++) {
      left[i]! *= s;
      right[i]! *= s;
    }
  }
}

/** Point of the virtual channel: distance from the listener, lateral position (for pan) and weight. */
interface Emitter {
  r: number;
  side: number;
  w: number;
  /** Extra delay (s): a return stroke or a second channel. */
  lag: number;
}

/**
 * Lays out a virtual channel around the listener at an apparent distance as emitters of N-waves: for
 * a ground strike a tortuous walk from the ground up into the cloud that then spreads for kilometres
 * through the cloud (most of a flash's channel is inside the cloud, and it keeps the roll going), for
 * a cloud discharge a long crawl along the cloud; both with branches.
 */
function channelEmitters(rand: () => number, distance: number, cloud: boolean, lag: number, weight: number, out: Emitter[]): void {
  // The source direction is +x; y up; z across (left/right).
  const D = Math.max(60, distance);
  const step = 6 + rand() * 4;
  const branches: [number, number, number][] = [];
  const emit = (x: number, y: number, zz: number, hx: number, hy: number, hz: number, w: number): void => {
    const r = Math.hypot(x, y, zz);
    // Directivity: a piece of channel broadside to the listener is much louder than one end-on.
    const broad = 1 - Math.abs((hx * x + hy * y + hz * zz) / r);
    out.push({ r, side: zz / r, w: w * (0.25 + broad * broad * 1.6) * (0.3 + rand() ** 3 * 2.2), lag });
  };
  /** A tortuous walk; `rise` keeps it climbing (a leader) or level (an in-cloud channel). */
  const walk = (p: [number, number, number], h: [number, number, number], steps: number, rise: boolean, top: number, w: number, branchChance: number): [number, number, number] => {
    let [x, y, zz] = p;
    let [hx, hy, hz] = h;
    for (let i = 0; i < steps; i++) {
      // Kinks of tens of degrees every few steps.
      if (rand() < 0.3) {
        hx += (rand() - 0.5) * 0.9;
        hy += (rand() - 0.5) * (rise ? 0.9 : 0.25);
        hz += (rand() - 0.5) * 0.9;
        if (rise) hy = Math.max(0.35, hy);
        else hy *= 0.6;
        const l = Math.hypot(hx, hy, hz) || 1;
        hx /= l;
        hy /= l;
        hz /= l;
      }
      x += hx * step;
      y += hy * step;
      zz += hz * step;
      if (rise && y > top) break;
      emit(x, y, zz, hx, hy, hz, w);
      if (rand() < branchChance) branches.push([x, y, zz]);
    }
    return [x, y, zz];
  };
  const start: [number, number, number] = [D * (0.95 + rand() * 0.1), cloud ? 1500 + rand() * 1500 : 0, (rand() - 0.5) * D * 0.15];
  let top: [number, number, number];
  if (cloud) {
    top = start;
  } else {
    const height = 1700 + rand() * 1600;
    top = walk(start, [(rand() - 0.5) * 0.5, 1, (rand() - 0.5) * 0.5], Math.round((height * 1.6) / step), true, height, weight, 0.006);
  }
  // The channel in the cloud: kilometres of it, quieter per metre, spreading away.
  const flat = (cloud ? 2500 + rand() * 5000 : 1500 + rand() * 3500) / step;
  const away = rand() < 0.6 ? 1 : -0.4;
  walk(top, [away * (0.4 + rand() * 0.6), 0, rand() < 0.5 ? -1 : 1], Math.min(1200, Math.round(flat)), false, Infinity, weight * (cloud ? 1 : 0.7), 0.01);
  // Branches: shorter and quieter, spreading out from the channel in all directions.
  for (const b of branches) {
    const d: [number, number, number] = [rand() - 0.5, rand() - 0.5, rand() - 0.5];
    walk(b, d, 20 + Math.floor(rand() * 80), false, Infinity, weight * 0.35, 0);
  }
}

/** Renders one thunder (stereo, starting at the first arrival). */
export function renderThunder(spec: ThunderSpec): StereoBuffer {
  const sr = spec.sampleRate;
  const rand = rng(spec.seed * 2654435761 + 11);
  const D = Math.max(60, spec.distance);
  const energy = Math.max(0.05, Math.min(1, spec.energy));
  const cloud = spec.channel === 'cloud';
  /** 1 for a strike a few hundred metres away, 0 beyond about 3 km. */
  const near = Math.max(0, Math.min(1, 1 - (D - 300) / 2700));
  const emitters: Emitter[] = [];
  channelEmitters(rand, D, cloud, 0, 1, emitters);
  // Return strokes re-light the lower main channel: the nearest emitters again, a little quieter.
  const strokes = spec.strokes ?? [0];
  const firstMain = emitters.length;
  for (let s = 1; s < strokes.length; s++) {
    for (let i = 0; i < firstMain; i += 3) {
      const e = emitters[i]!;
      if (e.r < D * 1.6) emitters.push({ r: e.r, side: e.side, w: e.w * 0.55, lag: strokes[s]! });
    }
  }
  // Now and then a second channel nearby: a double peal.
  if (rand() < 0.28) channelEmitters(rand, D * (1.05 + rand() * 0.5), cloud || rand() < 0.4, 0.4 + rand() * 1.6, 0.55, emitters);
  let rMin = Infinity;
  let rMax = 0;
  for (const e of emitters) {
    rMin = Math.min(rMin, e.r);
    rMax = Math.max(rMax, e.r + e.lag * SPEED);
  }
  const roll = Math.min(9, (rMax - rMin) / SPEED);
  const tail = 2.5 + (1 - near) * 2 + energy * 1.5;
  const seconds = Math.min(14, 0.3 + roll + tail);
  const n = Math.round(seconds * sr);
  // Four distance bands, filtered separately: the nearest bright, the farthest dull.
  const BANDS = 4;
  const bandsL = Array.from({ length: BANDS }, () => new Float32Array(n));
  const bandsR = Array.from({ length: BANDS }, () => new Float32Array(n));
  const bandOf = (r: number): number => Math.min(BANDS - 1, Math.floor((Math.log(r / rMin) / Math.log(Math.max(1.0001, rMax / rMin))) * BANDS));
  const env = new Float32Array(Math.ceil(n / 64) + 1);
  for (const e of emitters) {
    const t = (e.r - rMin) / SPEED + e.lag;
    const start = Math.round(t * sr);
    if (start >= n) continue;
    // N-waves lengthen as they travel (nonlinear steepening, then dispersion).
    const T = Math.max(4, Math.round(sr * (0.0015 + rand() * 0.0065) * Math.pow(e.r / 1000, 0.35) * (0.8 + energy * 0.5)));
    // Spreading loss, softened: the far reaches of the channel keep the roll going for seconds.
    // The nearest stretch of channel arrives all at once: the clap.
    const clap = e.r < rMin * 1.18 ? 1 + 1.6 * near : 1;
    const amp = e.w * Math.pow(1000 / e.r, 0.8) * clap;
    const panR = Math.sqrt(0.5 + 0.5 * Math.max(-1, Math.min(1, e.side * 2.5)));
    const panL = Math.sqrt(1 - panR * panR);
    const b = bandOf(e.r);
    const L = bandsL[b]!;
    const R = bandsR[b]!;
    const end = Math.min(n, start + T);
    for (let i = start; i < end; i++) {
      const v = amp * (1 - (2 * (i - start)) / T);
      L[i]! += v * panL;
      R[i]! += v * panR;
    }
    env[start >> 6]! += amp;
  }
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let b = 0; b < BANDS; b++) {
    const r = rMin * Math.pow(rMax / rMin, (b + 0.5) / BANDS);
    // Air absorption: highs fade fast with distance (bright crackle only from the nearest band).
    const cutoff = 90 + 7000 * Math.exp(-r / 1100);
    lowpass(bandsL[b]!, cutoff, sr, 2);
    lowpass(bandsR[b]!, cutoff, sr, 2);
    const g = [1.7, 1.25, 1, 0.9][b]!;
    const sl = bandsL[b]!;
    const srr = bandsR[b]!;
    for (let i = 0; i < n; i++) {
      left[i]! += sl[i]! * g;
      right[i]! += srr[i]! * g;
    }
  }
  // The rumble body: deep noise following the density of arriving pulses, rolling as it goes.
  let sm = 0;
  const envS = new Float32Array(env.length);
  const k = 1 - Math.exp(-64 / (0.12 * sr));
  let envMax = 0;
  for (let i = 0; i < env.length; i++) {
    sm += (env[i]! - sm) * k;
    envS[i] = sm;
    envMax = Math.max(envMax, sm);
  }
  const nl = new Float32Array(n);
  const nr = new Float32Array(n);
  const nrand = rng(spec.seed + 99);
  for (let i = 0; i < n; i++) {
    nl[i] = nrand() * 2 - 1;
    nr[i] = nrand() * 2 - 1;
  }
  const bodyHz = 70 + 60 * near;
  lowpass(nl, bodyHz, sr, 3);
  lowpass(nr, bodyHz, sr, 3);
  let roller = 0.7;
  let rollTarget = 0.7;
  const rumble = (0.5 + (1 - near) * 0.6) * 2.6;
  // Levels follow the pulses' RMS over the first second (their peak is a single nearby N-wave).
  let sq = 0;
  const span = Math.min(n, sr);
  for (let i = 0; i < span; i++) sq += left[i]! * left[i]! + right[i]! * right[i]!;
  const sig = Math.sqrt(sq / (2 * span)) * 3 || 1;
  for (let i = 0; i < n; i++) {
    if (i % 2048 === 0) rollTarget = 0.35 + nrand() * 0.9;
    roller += (rollTarget - roller) * 0.00012;
    const e = envMax > 0 ? (envS[i >> 6]! / envMax) * sig : 0;
    left[i]! += nl[i]! * e * rumble * roller;
    right[i]! += nr[i]! * e * rumble * (1.4 - roller * 0.6);
  }
  // A nearby clap's deep body: a low, falling boom from the first arrival.
  if (near > 0.05) {
    const boom = sig * 0.22 * near * energy;
    const f0 = 52 + rand() * 12;
    let ph = 0;
    for (let i = 0; i < Math.min(n, sr * 2.5); i++) {
      const t = i / sr;
      const f = f0 * (0.55 + 0.45 * Math.exp(-t / 0.35));
      ph += (2 * Math.PI * f) / sr;
      const v = Math.sin(ph) * boom * (1 - Math.exp(-t / 0.006)) * Math.exp(-t / 0.75);
      left[i]! += v;
      right[i]! += v;
    }
  }
  // Echoes off the mountains and the glen: late, dull copies.
  const echoSrcL = left.slice();
  const echoSrcR = right.slice();
  lowpass(echoSrcL, 420, sr, 2);
  lowpass(echoSrcR, 420, sr, 2);
  const echoes = 3 + Math.floor(rand() * 3);
  for (let e = 0; e < echoes; e++) {
    const delay = Math.round((0.45 + rand() * 2.8) * (1 + D / 5000) * sr);
    const g = (0.14 + rand() * 0.22) * (1 - e * 0.12);
    const cross = rand() < 0.5;
    for (let i = delay; i < n; i++) {
      left[i]! += (cross ? echoSrcR : echoSrcL)[i - delay]! * g;
      right[i]! += (cross ? echoSrcL : echoSrcR)[i - delay]! * g;
    }
  }
  // Distant thunder arrives softly: no sharp onset.
  if (near < 0.6) {
    const a = Math.round((0.08 + (0.6 - near) * 0.45) * sr);
    for (let i = 0; i < Math.min(n, a); i++) {
      const g = (i / a) ** 1.5;
      left[i]! *= g;
      right[i]! *= g;
    }
  }
  reverb(left, sr, 3.2 + (1 - near) * 2.5, 0.55, 0.55 + (1 - near) * 0.4, spec.seed + 1);
  reverb(right, sr, 3.4 + (1 - near) * 2.5, 0.55, 0.55 + (1 - near) * 0.4, spec.seed + 2);
  highpass(left, 24, sr, 2);
  highpass(right, 24, sr, 2);
  if (near < 0.5) {
    lowpass(left, 280 + near * 2400, sr, 2);
    lowpass(right, 280 + near * 2400, sr, 2);
  }
  finish(left, right, sr, 0.89, Math.min(1.5, seconds * 0.25));
  return { left, right, sampleRate: sr };
}

/**
 * The crack of a nearby strike: a sharp click, a fast tearing crackle of bright sparks, then a short
 * atmospheric tail. Electrical and high, unlike the thunder that follows it.
 */
export function renderCrack(spec: CrackSpec): StereoBuffer {
  const sr = spec.sampleRate;
  const rand = rng(spec.seed * 747796405 + 3);
  const energy = Math.max(0.1, Math.min(1, spec.energy));
  const seconds = 1.4;
  const n = Math.round(seconds * sr);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  // The initial snap.
  left[0] = 1;
  right[1] = 1;
  for (let i = 0; i < Math.round(0.0015 * sr); i++) {
    left[i]! += (rand() * 2 - 1) * 0.8;
    right[i]! += (rand() * 2 - 1) * 0.8;
  }
  // The tear: hundreds of tiny sparks, dense at first, thinning out within a fraction of a second.
  const tear = 0.07 + rand() * 0.11;
  const sparks = Math.round(260 + energy * 380);
  for (let s = 0; s < sparks; s++) {
    const t = tear * Math.pow(rand(), 1.7);
    const start = Math.round(t * sr);
    const len = 6 + Math.floor(rand() * 34);
    const amp = (0.15 + rand() ** 2 * 0.85) * Math.exp(-t / (tear * 0.6));
    const sign = rand() < 0.5 ? -1 : 1;
    const toLeft = 0.3 + rand() * 0.7;
    for (let i = 0; i < len && start + i < n; i++) {
      const v = sign * amp * (rand() * 2 - 1) * Math.exp(-i / (len * 0.35));
      left[start + i]! += v * toLeft;
      right[start + i]! += v * (1.3 - toLeft);
    }
  }
  highpass(left, 1600, sr, 2);
  highpass(right, 1600, sr, 2);
  // The atmospheric tail: a bright hiss that dies quickly into the air.
  const tl = new Float32Array(n);
  const tr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const e = (1 - Math.exp(-t / 0.004)) * Math.exp(-t / (0.16 + energy * 0.1));
    tl[i] = (rand() * 2 - 1) * e;
    tr[i] = (rand() * 2 - 1) * e;
  }
  bandpass(tl, 2600 + rand() * 1600, 0.7, sr);
  bandpass(tr, 2400 + rand() * 1600, 0.7, sr);
  for (let i = 0; i < n; i++) {
    left[i]! += tl[i]! * 0.5;
    right[i]! += tr[i]! * 0.5;
  }
  reverb(left, sr, 0.9, 0.3, 0.35, spec.seed + 5);
  reverb(right, sr, 1.0, 0.3, 0.35, spec.seed + 6);
  finish(left, right, sr, 0.85, 0.4);
  return { left, right, sampleRate: sr };
}

/**
 * A seamless loop of raindrops hitting one kind of surface: plinks and bubbles on water, sharp ticks
 * on rock, hollow knocks on wood, a soft patter on grass and heather. Every drop is synthesised
 * (an impact click, and on water often a small bubble ringing up in pitch); drops near the loop's end
 * wrap around to its start, so the loop has no seam. Left and right are independent showers.
 */
export function renderRainTexture(surface: RainSurface, seconds: number, seed: number, sampleRate: number): StereoBuffer {
  const sr = sampleRate;
  const n = Math.round(seconds * sr);
  const make = (ch: number): Float32Array => {
    const rand = rng(seed * 1103515245 + ch * 12345 + surface.length);
    const x = new Float32Array(n);
    const write = (i: number, v: number): void => {
      x[i % n]! += v;
    };
    const density = surface === 'water' ? 260 : surface === 'rock' ? 620 : surface === 'wood' ? 130 : 900;
    const count = Math.round(density * seconds);
    for (let d = 0; d < count; d++) {
      const at = Math.floor(rand() * n);
      const amp = 0.12 + rand() ** 2.2 * 0.88;
      if (surface === 'water') {
        // Impact click, and in about half the drops a bubble whose pitch rises as it rings.
        write(at, amp * 0.5);
        write(at + 1, -amp * 0.35);
        if (rand() < 0.55) {
          const f0 = 1100 + Math.pow(rand(), 1.5) * 3600;
          const tau = (0.004 + rand() * 0.011) * sr;
          const len = Math.round(tau * 5);
          let ph = 0;
          for (let i = 0; i < len; i++) {
            const f = f0 * (1 + (0.18 * i) / len);
            ph += (2 * Math.PI * f) / sr;
            write(at + 2 + i, Math.sin(ph) * amp * 0.55 * Math.exp(-i / tau));
          }
        }
      } else if (surface === 'rock') {
        const len = 4 + Math.floor(rand() * 18);
        for (let i = 0; i < len; i++) write(at + i, (rand() * 2 - 1) * amp * Math.exp(-i / (len * 0.3)));
      } else if (surface === 'wood') {
        const f = 260 + rand() * 650;
        const tau = (0.006 + rand() * 0.02) * sr;
        const len = Math.round(tau * 5);
        for (let i = 0; i < len; i++) {
          const t = i / sr;
          const v = Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * f * 2.31 * t);
          write(at + i, v * amp * 0.5 * Math.exp(-i / tau));
        }
        write(at, amp * 0.4);
      } else {
        const len = 18 + Math.floor(rand() * 70);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          lp += ((rand() * 2 - 1) - lp) * 0.3;
          write(at + i, lp * amp * Math.sin((Math.PI * i) / len));
        }
      }
    }
    // Filter as a loop: the filters first run over the loop's last 50 ms, so their state at the
    // start matches the end and the seam stays clean.
    const warm = Math.min(n, Math.round(0.05 * sr));
    const y = new Float32Array(n + warm);
    y.set(x.subarray(n - warm), 0);
    y.set(x, warm);
    if (surface === 'rock') {
      highpass(y, 900, sr, 1);
      lowpass(y, 8000, sr, 1);
    } else if (surface === 'foliage') {
      lowpass(y, 3800, sr, 1);
      highpass(y, 250, sr, 1);
    } else {
      highpass(y, 120, sr, 1);
    }
    x.set(y.subarray(warm));
    // Normalise loudness (RMS) so the mix stays predictable.
    let sum = 0;
    for (let i = 0; i < n; i++) sum += x[i]! * x[i]!;
    const rms = Math.sqrt(sum / n) || 1;
    const k = 0.2 / rms;
    for (let i = 0; i < n; i++) x[i] = Math.max(-1, Math.min(1, x[i]! * k));
    return x;
  };
  return { left: make(0), right: make(1), sampleRate: sr };
}
