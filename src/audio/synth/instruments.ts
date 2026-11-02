import type { InstrumentSpec } from '../sequencer/composition';
import { midiToFrequency } from '../sequencer/theory';
import { noiseBuffers } from './resources';

/**
 * Plays one note of an instrument at audio time `t` into `out`. Every voice is built from native
 * Web Audio nodes and disconnects itself when finished.
 * Returns the time the voice ends (for ducking/cleanup bookkeeping).
 */
export function playNote(ctx: BaseAudioContext, out: AudioNode, spec: InstrumentSpec, midi: number, t: number, dur: number, vel: number): number {
  const v = Math.max(0, Math.min(1, vel));
  const level = Math.pow(v, 1.4);
  switch (spec.kind) {
    case 'pad':
    case 'strings':
      return padVoice(ctx, out, spec, midi, t, dur, level);
    case 'choir':
      return choirVoice(ctx, out, spec, midi, t, dur, level);
    case 'pluck':
    case 'lead':
      return pluckVoice(ctx, out, spec, midi, t, dur, level);
    case 'bass':
      return bassVoice(ctx, out, spec, midi, t, dur, level);
    case 'sub':
      return simpleOsc(ctx, out, 'sine', midiToFrequency(midi), t, dur, level * 0.9, spec.attack ?? 0.01, spec.release ?? 0.15);
    case 'bell':
      return fmVoice(ctx, out, midi, t, level, spec.ratio ?? 3.5, spec.index ?? 2.6, spec.decay ?? 2.6, spec.attack ?? 0.002);
    case 'epiano':
      return fmVoice(ctx, out, midi, t, level, spec.ratio ?? 1, spec.index ?? 1.4, spec.decay ?? 1.6, spec.attack ?? 0.003, dur);
    case 'mallet':
      return fmVoice(ctx, out, midi, t, level, spec.ratio ?? 4, spec.index ?? 1.6, spec.decay ?? 0.55, 0.001);
    case 'kick':
      return kick(ctx, out, spec, t, level);
    case 'snare':
      return snare(ctx, out, spec, t, level);
    case 'clap':
      return clap(ctx, out, t, level);
    case 'hat':
      return noiseHit(ctx, out, t, level * 0.5, 'highpass', spec.tone ?? 8500, 0.7, spec.decay ?? 0.045);
    case 'openhat':
      return noiseHit(ctx, out, t, level * 0.45, 'highpass', spec.tone ?? 7500, 0.7, spec.decay ?? 0.32);
    case 'shaker':
      return noiseHit(ctx, out, t, level * 0.35, 'bandpass', spec.tone ?? 6500, 1.2, spec.decay ?? 0.07, 0.012);
    case 'ride':
      return ride(ctx, out, t, level);
    case 'tom':
      return tom(ctx, out, spec, midi, t, level);
    case 'perc':
      return perc(ctx, out, midi, t, level);
    case 'crash':
      return noiseHit(ctx, out, t, level * 0.4, 'highpass', spec.tone ?? 4200, 0.5, spec.decay ?? 1.8);
    case 'riser':
      return riser(ctx, out, t, Math.max(0.5, dur), level);
    case 'impact':
      return impact(ctx, out, t, level);
  }
}

function envGain(ctx: BaseAudioContext, t: number, peak: number, attack: number, hold: number, release: number, sustain = 1): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + Math.max(0.001, attack));
  if (sustain < 1) g.gain.setTargetAtTime(peak * sustain, t + attack, Math.max(0.01, hold / 3));
  const end = t + attack + Math.max(0, hold);
  g.gain.setValueAtTime(sustain < 1 ? peak * sustain : peak, end);
  g.gain.setTargetAtTime(0, end, Math.max(0.005, release / 4));
  return g;
}

function cleanup(source: AudioScheduledSourceNode, nodes: AudioNode[]): void {
  source.onended = () => {
    for (const n of nodes) n.disconnect();
  };
}

function simpleOsc(ctx: BaseAudioContext, out: AudioNode, type: OscillatorType, freq: number, t: number, dur: number, level: number, attack: number, release: number): number {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = envGain(ctx, t, level, attack, dur, release);
  osc.connect(g).connect(out);
  const end = t + attack + dur + release + 0.05;
  osc.start(t);
  osc.stop(end);
  cleanup(osc, [osc, g]);
  return end;
}

function padVoice(ctx: BaseAudioContext, out: AudioNode, s: InstrumentSpec, midi: number, t: number, dur: number, level: number): number {
  const voices = s.voices ?? 3;
  const detune = s.detune ?? 12;
  const attack = s.attack ?? (s.kind === 'strings' ? 0.6 : 1.2);
  const release = s.release ?? 2;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = s.cutoff ?? 1600;
  filter.Q.value = s.resonance ?? 0.7;
  // Slow filter breathing keeps sustained chords alive.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.15 + (midi % 7) * 0.02;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = (s.cutoff ?? 1600) * 0.25;
  lfo.connect(lfoGain).connect(filter.frequency);
  const g = envGain(ctx, t, (level * 0.32) / Math.sqrt(voices), attack, dur, release);
  filter.connect(g).connect(out);
  const end = t + attack + dur + release + 0.1;
  const nodes: AudioNode[] = [filter, g, lfo, lfoGain];
  for (let i = 0; i < voices; i++) {
    const osc = ctx.createOscillator();
    osc.type = s.wave ?? 'sawtooth';
    osc.frequency.value = midiToFrequency(midi);
    osc.detune.value = voices > 1 ? (i / (voices - 1) - 0.5) * 2 * detune : 0;
    osc.connect(filter);
    osc.start(t);
    osc.stop(end);
    nodes.push(osc);
    if (i === 0) cleanup(osc, nodes);
  }
  lfo.start(t);
  lfo.stop(end);
  return end;
}

function choirVoice(ctx: BaseAudioContext, out: AudioNode, s: InstrumentSpec, midi: number, t: number, dur: number, level: number): number {
  const attack = s.attack ?? 0.9;
  const release = s.release ?? 1.8;
  const end = t + attack + dur + release + 0.1;
  const g = envGain(ctx, t, level * 0.3, attack, dur, release);
  g.connect(out);
  const nodes: AudioNode[] = [g];
  // Two formant bands ("ah") over a pair of detuned saws.
  for (const [freq, q, amp] of [[800, 6, 1], [1150, 8, 0.6], [2900, 10, 0.25]] as const) {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const a = ctx.createGain();
    a.gain.value = amp;
    bp.connect(a).connect(g);
    nodes.push(bp, a);
    for (const d of [-7, 7]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = midiToFrequency(midi);
      osc.detune.value = d;
      osc.connect(bp);
      osc.start(t);
      osc.stop(end);
      nodes.push(osc);
    }
  }
  cleanup(nodes[nodes.length - 1] as OscillatorNode, nodes);
  return end;
}

function pluckVoice(ctx: BaseAudioContext, out: AudioNode, s: InstrumentSpec, midi: number, t: number, dur: number, level: number): number {
  const lead = s.kind === 'lead';
  const decay = s.decay ?? (lead ? 0.6 : 0.28);
  const release = s.release ?? (lead ? 0.25 : 0.2);
  const cutoff = s.cutoff ?? (lead ? 2200 : 1200);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = s.resonance ?? (lead ? 1.2 : 2.5);
  const peak = Math.min(18000, cutoff * Math.pow(2, s.envAmount ?? 3));
  filter.frequency.setValueAtTime(peak, t);
  filter.frequency.setTargetAtTime(cutoff, t + 0.002, decay / 3);
  const g = lead ? envGain(ctx, t, level * 0.22, s.attack ?? 0.01, dur, release) : envGain(ctx, t, level * 0.3, 0.002, Math.min(dur, decay * 2), release, s.sustain ?? 0.25);
  filter.connect(g).connect(out);
  const end = t + dur + release + decay + 0.1;
  const voices = s.voices ?? (lead ? 2 : 1);
  const nodes: AudioNode[] = [filter, g];
  for (let i = 0; i < voices; i++) {
    const osc = ctx.createOscillator();
    osc.type = s.wave ?? (lead ? 'sawtooth' : 'square');
    osc.frequency.value = midiToFrequency(midi);
    osc.detune.value = voices > 1 ? (i - 0.5) * (s.detune ?? 10) : 0;
    if (lead) {
      const vib = ctx.createOscillator();
      vib.frequency.value = 5.2;
      const vg = ctx.createGain();
      vg.gain.setValueAtTime(0, t);
      vg.gain.linearRampToValueAtTime(9, t + 0.35);
      vib.connect(vg).connect(osc.detune);
      vib.start(t);
      vib.stop(end);
      nodes.push(vib, vg);
    }
    osc.connect(filter);
    osc.start(t);
    osc.stop(end);
    nodes.push(osc);
  }
  cleanup(nodes[nodes.length - 1] as OscillatorNode, nodes);
  return end;
}

function bassVoice(ctx: BaseAudioContext, out: AudioNode, s: InstrumentSpec, midi: number, t: number, dur: number, level: number): number {
  const release = s.release ?? 0.12;
  const cutoff = s.cutoff ?? 500;
  const f = midiToFrequency(midi);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = s.resonance ?? 3;
  filter.frequency.setValueAtTime(cutoff * Math.pow(2, s.envAmount ?? 2), t);
  filter.frequency.setTargetAtTime(cutoff, t + 0.002, (s.decay ?? 0.18) / 3);
  const g = envGain(ctx, t, level * 0.42, s.attack ?? 0.004, dur, release);
  filter.connect(g).connect(out);
  const osc = ctx.createOscillator();
  osc.type = s.wave ?? 'sawtooth';
  osc.frequency.value = f;
  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = f / 2;
  const subGain = ctx.createGain();
  subGain.gain.value = 0.7;
  osc.connect(filter);
  sub.connect(subGain).connect(g);
  const end = t + dur + release + 0.1;
  osc.start(t);
  sub.start(t);
  osc.stop(end);
  sub.stop(end);
  cleanup(osc, [osc, sub, subGain, filter, g]);
  return end;
}

/** Two-operator FM: bells (inharmonic ratio), e-piano (ratio 1), mallets (ratio 4, short). */
function fmVoice(ctx: BaseAudioContext, out: AudioNode, midi: number, t: number, level: number, ratio: number, index: number, decay: number, attack: number, hold = 0): number {
  const f = midiToFrequency(midi);
  const carrier = ctx.createOscillator();
  carrier.frequency.value = f;
  const mod = ctx.createOscillator();
  mod.frequency.value = f * ratio;
  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(f * index, t);
  modGain.gain.setTargetAtTime(f * index * 0.15, t + attack, decay / 5);
  mod.connect(modGain).connect(carrier.frequency);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level * 0.35, t + attack);
  g.gain.setTargetAtTime(0, t + attack + hold * 0.2, decay / 4);
  carrier.connect(g).connect(out);
  const end = t + attack + hold * 0.2 + decay * 1.6 + 0.05;
  carrier.start(t);
  mod.start(t);
  carrier.stop(end);
  mod.stop(end);
  cleanup(carrier, [carrier, mod, modGain, g]);
  return end;
}

function noiseSource(ctx: BaseAudioContext, pink = false): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  const { white, pink: pinkBuf } = noiseBuffers(ctx);
  src.buffer = pink ? pinkBuf : white;
  src.loop = true;
  src.loopStart = Math.random() * 1.5;
  return src;
}

function noiseHit(ctx: BaseAudioContext, out: AudioNode, t: number, level: number, type: BiquadFilterType, freq: number, q: number, decay: number, attack = 0.001): number {
  const src = noiseSource(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + attack);
  g.gain.setTargetAtTime(0, t + attack, decay / 3);
  src.connect(filter).connect(g).connect(out);
  const end = t + attack + decay * 2.5 + 0.02;
  src.start(t, Math.random());
  src.stop(end);
  cleanup(src, [src, filter, g]);
  return end;
}

function kick(ctx: BaseAudioContext, out: AudioNode, s: InstrumentSpec, t: number, level: number): number {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  const start = s.tone ?? 150;
  osc.frequency.setValueAtTime(start, t);
  osc.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  const g = ctx.createGain();
  g.gain.setValueAtTime(level * 1.1, t);
  g.gain.setTargetAtTime(0, t + 0.02, (s.decay ?? 0.32) / 3);
  let node: AudioNode = g;
  if (s.drive) {
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * 2 - 1;
      curve[i] = Math.tanh(x * (1 + s.drive * 4));
    }
    shaper.curve = curve;
    g.connect(shaper);
    node = shaper;
  }
  osc.connect(g);
  node.connect(out);
  const end = t + (s.decay ?? 0.32) * 2.5;
  osc.start(t);
  osc.stop(end);
  cleanup(osc, [osc, g, node]);
  noiseHit(ctx, out, t, level * 0.12, 'highpass', 3000, 0.7, 0.006);
  return end;
}

function snare(ctx: BaseAudioContext, out: AudioNode, s: InstrumentSpec, t: number, level: number): number {
  simpleOsc(ctx, out, 'triangle', s.tone ?? 190, t, 0.02, level * 0.5, 0.001, 0.09);
  return noiseHit(ctx, out, t, level * 0.6, 'bandpass', 1900, 0.8, s.decay ?? 0.17);
}

function clap(ctx: BaseAudioContext, out: AudioNode, t: number, level: number): number {
  for (const o of [0, 0.011, 0.023]) noiseHit(ctx, out, t + o, level * 0.45, 'bandpass', 1250, 1.4, 0.012);
  return noiseHit(ctx, out, t + 0.03, level * 0.5, 'bandpass', 1250, 1.1, 0.16);
}

function ride(ctx: BaseAudioContext, out: AudioNode, t: number, level: number): number {
  fmVoice(ctx, out, 96, t, level * 0.25, 2.71, 3.5, 1.1, 0.001);
  return noiseHit(ctx, out, t, level * 0.12, 'highpass', 6500, 0.6, 0.7);
}

function tom(ctx: BaseAudioContext, out: AudioNode, s: InstrumentSpec, midi: number, t: number, level: number): number {
  const osc = ctx.createOscillator();
  const f = s.tone ?? midiToFrequency(midi - 12);
  osc.frequency.setValueAtTime(f * 1.6, t);
  osc.frequency.exponentialRampToValueAtTime(f, t + 0.08);
  const g = envGain(ctx, t, level * 0.7, 0.002, 0, s.decay ?? 0.35);
  osc.connect(g).connect(out);
  const end = t + (s.decay ?? 0.35) * 2;
  osc.start(t);
  osc.stop(end);
  cleanup(osc, [osc, g]);
  return end;
}

function perc(ctx: BaseAudioContext, out: AudioNode, midi: number, t: number, level: number): number {
  noiseHit(ctx, out, t, level * 0.15, 'bandpass', 3000, 2, 0.008);
  return simpleOsc(ctx, out, 'sine', midiToFrequency(midi), t, 0.005, level * 0.5, 0.001, 0.07);
}

function riser(ctx: BaseAudioContext, out: AudioNode, t: number, dur: number, level: number): number {
  const src = noiseSource(ctx, true);
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 3;
  filter.frequency.setValueAtTime(250, t);
  filter.frequency.exponentialRampToValueAtTime(7000, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level * 0.35, t + dur * 0.95);
  g.gain.linearRampToValueAtTime(0, t + dur + 0.05);
  src.connect(filter).connect(g).connect(out);
  src.start(t);
  src.stop(t + dur + 0.1);
  cleanup(src, [src, filter, g]);
  return t + dur + 0.1;
}

function impact(ctx: BaseAudioContext, out: AudioNode, t: number, level: number): number {
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(90, t);
  osc.frequency.exponentialRampToValueAtTime(28, t + 1.2);
  const g = envGain(ctx, t, level * 0.9, 0.002, 0.05, 1.6);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 2.2);
  cleanup(osc, [osc, g]);
  noiseHit(ctx, out, t, level * 0.3, 'lowpass', 900, 0.7, 0.8);
  return t + 2.2;
}
