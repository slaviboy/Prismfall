import { noiseBuffers } from '../synth/resources';
import { renderCrawl, renderSilk, renderSkitter, renderWebHum } from './creatureSynth';
import type { StereoSamples } from './impactSynth';

/**
 * Voices for ambience events: water drips, small insects, a pebble shaken loose, a rustle in the
 * dark, and creature sounds a long way off, made from the same creature one-shots the world plays
 * up close (here darker, quieter and mostly heard through the echo). Every voice is panned, sends
 * part of itself to the bed's echo and frees its nodes when it ends.
 */
export interface AmbienceOut {
  readonly dry: AudioNode;
  /** The bed's echo send (the dry output again for a preset without one). */
  readonly wet: AudioNode;
}

export type CreatureSound = 'skitter' | 'crawl' | 'silk' | 'webHum';

/** What a bed's events may draw on besides their output. */
export interface AmbienceEnv {
  /** The echo send (the bed's output itself for a preset without a space). */
  readonly space: AudioNode;
  /** A rendered creature one-shot, light to heavy by `weight`, or null while none is ready. */
  sample(id: CreatureSound, weight?: number): AudioBuffer | null;
  /** Semitones that put a C-pitched tonal sound on the music's key root (0 without music). */
  keyShift(): number;
}

const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const side = (width = 1): number => (Math.random() * 2 - 1) * width;

/** A panner into the dry output plus a send into the echo; both freed with the voice. */
function outlet(ctx: BaseAudioContext, o: AmbienceOut, pan: number, send: number, nodes: AudioNode[]): StereoPannerNode {
  const p = ctx.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(o.dry);
  if (send > 0 && o.wet !== o.dry) {
    const s = ctx.createGain();
    s.gain.value = send;
    p.connect(s).connect(o.wet);
    nodes.push(s);
  }
  nodes.push(p);
  return p;
}

function freeAfter(src: AudioScheduledSourceNode, nodes: readonly AudioNode[]): void {
  src.onended = () => {
    for (const n of nodes) n.disconnect();
  };
}

function noise(ctx: BaseAudioContext, pink = false): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  const { white, pink: pinkBuffer } = noiseBuffers(ctx);
  src.buffer = pink ? pinkBuffer : white;
  src.loop = true;
  return src;
}

/** A drop falling into still water: a short "plink" rising in pitch, with a faint click of impact. */
export function drip(ctx: BaseAudioContext, o: AmbienceOut, t: number, hz: number, level: number, pan: number, send: number): void {
  const nodes: AudioNode[] = [];
  const out = outlet(ctx, o, pan, send, nodes);
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(hz, t);
  osc.frequency.exponentialRampToValueAtTime(hz * rand(1.6, 2.3), t + rand(0.014, 0.026));
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + 0.0015);
  g.gain.setTargetAtTime(0, t + 0.003, rand(0.01, 0.018));
  osc.connect(g).connect(out);
  const click = noise(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 3500;
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(level * 0.35, t);
  cg.gain.setTargetAtTime(0, t, 0.0008);
  click.connect(hp).connect(cg).connect(out);
  click.start(t, Math.random());
  click.stop(t + 0.02);
  osc.start(t);
  osc.stop(t + 0.16);
  nodes.push(osc, g, click, hp, cg);
  freeAfter(osc, nodes);
}

/** A small insect: a few dry, high ticks in a quick trill. */
export function trill(ctx: BaseAudioContext, o: AmbienceOut, t: number, level: number, pan: number): void {
  const nodes: AudioNode[] = [];
  const out = outlet(ctx, o, pan, 0.15, nodes);
  const osc = ctx.createOscillator();
  osc.frequency.value = rand(4800, 7600);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  const count = 3 + Math.floor(Math.random() * 6);
  const gap = rand(0.018, 0.04);
  let tt = t;
  for (let k = 0; k < count; k++) {
    const a = level * rand(0.5, 1) * (1 - (k / count) * 0.4);
    g.gain.setValueAtTime(0, tt);
    g.gain.linearRampToValueAtTime(a, tt + 0.0012);
    g.gain.setTargetAtTime(0, tt + 0.0015, 0.0016);
    tt += gap * rand(0.85, 1.2);
  }
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(tt + 0.03);
  nodes.push(osc, g);
  freeAfter(osc, nodes);
}

/** Wings: a soft buzz of wingbeats passing from one side to the other. */
export function flutter(ctx: BaseAudioContext, o: AmbienceOut, t: number, level: number): void {
  const nodes: AudioNode[] = [];
  const out = outlet(ctx, o, 0, 0.2, nodes);
  const dur = rand(0.25, 0.6);
  const from = side(0.8);
  out.pan.setValueAtTime(from, t);
  out.pan.linearRampToValueAtTime(Math.max(-1, Math.min(1, -from * rand(0.3, 1))), t + dur);
  const src = noise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = rand(380, 900);
  bp.Q.value = 1.4;
  // Wingbeats: the noise pulsed at the beat rate.
  const am = ctx.createGain();
  am.gain.value = 0.5;
  const beat = ctx.createOscillator();
  beat.frequency.value = rand(60, 130);
  const depth = ctx.createGain();
  depth.gain.value = 0.5;
  beat.connect(depth).connect(am.gain);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(level, t + dur * 0.4);
  env.gain.linearRampToValueAtTime(0, t + dur);
  src.connect(bp).connect(am).connect(env).connect(out);
  src.start(t, Math.random());
  beat.start(t);
  src.stop(t + dur + 0.02);
  beat.stop(t + dur + 0.02);
  nodes.push(src, bp, am, beat, depth, env);
  freeAfter(src, nodes);
}

/** A pebble shaken loose somewhere: a few bounces on stone, each shorter and softer. */
export function pebble(ctx: BaseAudioContext, o: AmbienceOut, t: number, level: number, pan: number): void {
  const nodes: AudioNode[] = [];
  const out = outlet(ctx, o, pan, 0.7, nodes);
  const bounces = 2 + Math.floor(Math.random() * 3);
  let tt = t;
  let gap = rand(0.12, 0.24);
  let a = level;
  let last: AudioScheduledSourceNode | null = null;
  for (let k = 0; k < bounces; k++) {
    const src = noise(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = rand(2000, 4500);
    bp.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(a, tt);
    g.gain.setTargetAtTime(0, tt, 0.004);
    src.connect(bp).connect(g).connect(out);
    src.start(tt, Math.random());
    src.stop(tt + 0.03);
    nodes.push(src, bp, g);
    last = src;
    tt += gap;
    gap *= rand(0.5, 0.7);
    a *= rand(0.45, 0.7);
  }
  if (last) freeAfter(last, nodes);
}

/** Something shifting in the dark: a brief, soft rustle of dry matter. */
export function rustle(ctx: BaseAudioContext, o: AmbienceOut, t: number, level: number, pan: number): void {
  const nodes: AudioNode[] = [];
  const out = outlet(ctx, o, pan, 0.3, nodes);
  const dur = rand(0.3, 0.7);
  const src = noise(ctx, true);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = rand(900, 1700);
  bp.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  // Two small movements, the second softer.
  g.gain.linearRampToValueAtTime(level, t + dur * 0.18);
  g.gain.linearRampToValueAtTime(level * 0.25, t + dur * 0.45);
  g.gain.linearRampToValueAtTime(level * 0.6, t + dur * 0.62);
  g.gain.linearRampToValueAtTime(0, t + dur);
  src.connect(bp).connect(g).connect(out);
  src.start(t, Math.random());
  src.stop(t + dur + 0.02);
  nodes.push(src, bp, g);
  freeAfter(src, nodes);
}

/** Creature one-shots rendered here, once per context and variant: the fallback without a sound bank (offline renders). */
const local = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();

export function localCreatureSample(ctx: BaseAudioContext, id: CreatureSound, weight = 0.5): AudioBuffer {
  let cache = local.get(ctx);
  if (!cache) local.set(ctx, (cache = new Map()));
  const variant = Math.floor(Math.random() * 3);
  const w = Math.round(Math.max(0, Math.min(1, weight)) * 4) / 4;
  const key = `${id}:${variant}:${id === 'skitter' || id === 'crawl' ? w : ''}`;
  let b = cache.get(key);
  if (!b) {
    const seed = 101 + variant;
    const sr = ctx.sampleRate;
    const s: StereoSamples = id === 'skitter' ? renderSkitter(w, seed, sr) : id === 'crawl' ? renderCrawl(w, seed, sr) : id === 'silk' ? renderSilk(seed, sr) : renderWebHum(seed, sr);
    b = ctx.createBuffer(2, s.left.length, sr);
    b.getChannelData(0).set(s.left);
    b.getChannelData(1).set(s.right);
    cache.set(key, b);
  }
  return b;
}

/** A creature sound far off: darker (low-passed), quieter and mostly heard through the echo. */
export function distant(ctx: BaseAudioContext, o: AmbienceOut, t: number, buffer: AudioBuffer | null, level: number, pan: number, cutoff: number, rate: number, send: number): void {
  if (!buffer) return;
  const nodes: AudioNode[] = [];
  const out = outlet(ctx, o, pan, send, nodes);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = cutoff;
  lp.Q.value = 0.6;
  const g = ctx.createGain();
  g.gain.value = level;
  src.connect(lp).connect(g).connect(out);
  src.start(t);
  nodes.push(src, lp, g);
  freeAfter(src, nodes);
}

/**
 * The Web's events: a cave under a ruin with webs across the arches. Mostly drips a long way off
 * (now and then the same drip a few times), sometimes a small insect, a silk creak, a rustle, a
 * pebble; rarely a far skitter, something large crawling far off, or a web humming. About a third
 * of the calls play nothing: the quiet between sounds belongs to the place.
 */
export function webEvent(ctx: BaseAudioContext, dry: AudioNode, t: number, env: AmbienceEnv): void {
  const o: AmbienceOut = { dry, wet: env.space };
  const r = Math.random();
  if (r < 0.28) {
    const hz = rand(900, 2600);
    const pan = side(0.85);
    const level = rand(0.025, 0.05);
    const drops = Math.random() < 0.4 ? 2 + Math.floor(Math.random() * 3) : 1;
    const period = rand(1.1, 2.7);
    for (let k = 0; k < drops; k++) drip(ctx, o, t + k * period * rand(0.92, 1.08), hz * rand(0.96, 1.04), level * (1 - k * 0.12), pan, 0.9);
  } else if (r < 0.37) {
    if (Math.random() < 0.6) trill(ctx, o, t, rand(0.02, 0.045), side(0.9));
    else flutter(ctx, o, t, rand(0.08, 0.17));
  } else if (r < 0.46) {
    distant(ctx, o, t, env.sample('silk'), rand(0.25, 0.45), side(0.7), 5200, rand(0.9, 1.1), 0.35);
  } else if (r < 0.52) {
    rustle(ctx, o, t, rand(0.05, 0.1), side(0.9));
  } else if (r < 0.57) {
    distant(ctx, o, t, env.sample('skitter', rand(0.2, 0.6)), rand(0.25, 0.4), side(0.9), 4200, rand(0.9, 1.05), 0.6);
  } else if (r < 0.61) {
    // Something large crawling a long way off: a few slow steps.
    const steps = 2 + Math.floor(Math.random() * 3);
    const pan = side(0.8);
    const gap = rand(0.5, 0.85);
    for (let k = 0; k < steps; k++) distant(ctx, o, t + k * gap * rand(0.9, 1.15), env.sample('crawl', rand(0.7, 0.95)), rand(0.1, 0.16), pan + k * 0.05, 650, rand(0.82, 0.92), 0.75);
  } else if (r < 0.65) {
    pebble(ctx, o, t, rand(0.3, 0.6), side(0.8));
  } else if (r < 0.67) {
    // On the key's root, a fourth below it or an octave below, like the web hums up close.
    const semis = env.keyShift() + ([0, -5, -12] as const)[Math.floor(Math.random() * 3)]!;
    distant(ctx, o, t, env.sample('webHum'), rand(0.12, 0.2), side(0.7), 1800, Math.pow(2, semis / 12), 0.5);
  }
}
