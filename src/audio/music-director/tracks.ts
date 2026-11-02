import { expandComposition, STEPS_PER_BEAT, type Composition, type ExpandedSection, type SectionKind } from '../sequencer/composition';
import { degreeToMidi, parseChord, voiceChord } from '../sequencer/theory';
import { playNote } from '../synth/instruments';
import { impulseResponse } from '../synth/resources';

export interface SectionInfo {
  readonly index: number;
  readonly name: string;
  readonly kind: SectionKind;
  readonly intensity: number;
  readonly startBeat: number;
  readonly endBeat: number;
}

/** Common interface for generative and file-based music. */
export interface TrackPlayer {
  readonly id: string;
  readonly title: string;
  readonly bpm: number;
  readonly beatsPerBar: number;
  readonly output: GainNode;
  start(atTime: number): void;
  /** Schedules everything up to audio time `until`. */
  schedule(until: number): void;
  fadeTo(level: number, at: number, seconds: number): void;
  stop(at: number): void;
  pause(now: number): void;
  resume(now: number): void;
  readonly paused: boolean;
  /** Continuous beat position at an audio time (negative before the start). */
  beatAt(audioTime: number): number;
  audioTimeOfBeat(beat: number): number;
  section(beat: number): SectionInfo;
  /** Next marked section (build/drop/break) after `beat`. */
  upcoming(beat: number): { kind: SectionKind; beat: number } | null;
  setIntensity(x: number): void;
  stinger(at: number, strength: number): void;
  dispose(): void;
  /** Test/debug hook: called for every scheduled note. */
  onNote: ((inst: string, time: number, note: number) => void) | null;
}

interface Channel {
  input: GainNode;
  pan: StereoPannerNode;
  layer: number;
  open: boolean;
  lastGateBar: number;
}

/** Plays a generative Composition with the built-in synthesizer. */
export class CompositionPlayer implements TrackPlayer {
  readonly output: GainNode;
  readonly id: string;
  readonly title: string;
  readonly bpm: number;
  readonly beatsPerBar: number;
  onNote: ((inst: string, time: number, note: number) => void) | null = null;
  private readonly sections: ExpandedSection[];
  private readonly introBeats: number;
  private readonly loopBeats: number;
  private readonly channels = new Map<string, Channel>();
  private readonly duckBus: GainNode;
  private readonly reverb: ConvolverNode;
  private readonly delay: { input: GainNode; nodes: AudioNode[] };
  private readonly nodes: AudioNode[] = [];
  private origin = 0;
  private started = false;
  private scheduledUntilBeat = 0;
  private intensity = 0.5;
  paused = false;
  private pausedBeat = 0;
  private readonly spb: number;

  constructor(
    private readonly ctx: BaseAudioContext,
    readonly composition: Composition,
    destination: AudioNode,
  ) {
    this.id = composition.id;
    this.title = composition.title;
    this.bpm = composition.bpm;
    this.beatsPerBar = composition.beatsPerBar;
    this.spb = 60 / composition.bpm;
    this.sections = expandComposition(composition);
    this.introBeats = this.sections.slice(0, composition.loopFrom).reduce((a, s) => a + s.beats, 0);
    this.loopBeats = Math.max(1, this.sections.slice(composition.loopFrom).reduce((a, s) => a + s.beats, 0));

    this.output = ctx.createGain();
    this.output.gain.value = 0;
    this.output.connect(destination);
    this.duckBus = ctx.createGain();
    this.duckBus.connect(this.output);

    const space = composition.space ?? { decay: 3.2, wet: 0.32, damping: 0.5 };
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = impulseResponse(ctx, space.decay, space.damping, composition.id.length);
    const wet = ctx.createGain();
    wet.gain.value = space.wet;
    this.reverb.connect(wet).connect(this.output);
    this.nodes.push(this.reverb, wet, this.duckBus);

    this.delay = this.createDelay();
    for (const [name, spec] of Object.entries(composition.instruments)) {
      const input = ctx.createGain();
      input.gain.value = spec.gain ?? 0.7;
      const pan = ctx.createStereoPanner();
      pan.pan.value = spec.pan ?? 0;
      input.connect(pan);
      pan.connect((spec.duck ?? 0) > 0 ? this.duckBus : this.output);
      if ((spec.reverb ?? 0) > 0) {
        const send = ctx.createGain();
        send.gain.value = spec.reverb ?? 0;
        pan.connect(send).connect(this.reverb);
        this.nodes.push(send);
      }
      if ((spec.delay ?? 0) > 0) {
        const send = ctx.createGain();
        send.gain.value = spec.delay ?? 0;
        pan.connect(send).connect(this.delay.input);
        this.nodes.push(send);
      }
      this.channels.set(name, { input, pan, layer: spec.layer ?? 0, open: (spec.layer ?? 0) <= this.intensity, lastGateBar: -1 });
      this.nodes.push(input, pan);
    }
  }

  /** Stereo ping-pong delay (dotted eighth) with a darkening feedback loop. */
  private createDelay(): { input: GainNode; nodes: AudioNode[] } {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const left = ctx.createDelay(2);
    const right = ctx.createDelay(2);
    const time = this.spb * 0.75;
    left.delayTime.value = time;
    right.delayTime.value = time;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.38;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3200;
    const merger = ctx.createChannelMerger(2);
    const out = ctx.createGain();
    out.gain.value = 0.55;
    input.connect(left);
    left.connect(right);
    right.connect(tone).connect(feedback).connect(left);
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    merger.connect(out).connect(this.output);
    const nodes = [input, left, right, feedback, tone, merger, out];
    this.nodes.push(...nodes);
    return { input, nodes };
  }

  start(atTime: number): void {
    this.origin = atTime;
    this.started = true;
    this.scheduledUntilBeat = 0;
  }

  beatAt(audioTime: number): number {
    if (!this.started) return -1;
    if (this.paused) return this.pausedBeat;
    return (audioTime - this.origin) / this.spb;
  }

  audioTimeOfBeat(beat: number): number {
    return this.origin + beat * this.spb;
  }

  /** Maps an absolute beat to (section index, beat within the section, section start beat). */
  private locate(beat: number): { index: number; within: number; start: number } {
    let b = Math.max(0, beat);
    let start = 0;
    if (b >= this.introBeats) {
      const loops = Math.floor((b - this.introBeats) / this.loopBeats);
      start = this.introBeats + loops * this.loopBeats;
      b = b - start;
      for (let i = this.composition.loopFrom; i < this.sections.length; i++) {
        const s = this.sections[i] as ExpandedSection;
        if (b < s.beats) return { index: i, within: b, start };
        b -= s.beats;
        start += s.beats;
      }
    }
    for (let i = 0; i < this.sections.length; i++) {
      const s = this.sections[i] as ExpandedSection;
      if (b < s.beats) return { index: i, within: b, start };
      b -= s.beats;
      start += s.beats;
    }
    return { index: this.sections.length - 1, within: 0, start };
  }

  section(beat: number): SectionInfo {
    const loc = this.locate(beat);
    const s = this.sections[loc.index] as ExpandedSection;
    return { index: loc.index, name: s.spec.name, kind: s.spec.kind, intensity: s.spec.intensity, startBeat: loc.start, endBeat: loc.start + s.beats };
  }

  upcoming(beat: number): { kind: SectionKind; beat: number } | null {
    let b = beat;
    for (let i = 0; i < this.sections.length * 2; i++) {
      const info = this.section(b);
      const next = this.section(info.endBeat + 0.001);
      if (next.kind === 'drop' || next.kind === 'build' || next.kind === 'break') return { kind: next.kind, beat: info.endBeat };
      b = info.endBeat + 0.001;
    }
    return null;
  }

  setIntensity(x: number): void {
    this.intensity = Math.max(0, Math.min(1, x));
  }

  private gateOpen(name: string, ch: Channel, bar: number, sectionIntensity: number): boolean {
    if (ch.lastGateBar !== bar) {
      ch.lastGateBar = bar;
      const effective = Math.min(1, sectionIntensity * 0.65 + this.intensity * 0.5);
      // Hysteresis keeps layers from flickering around the threshold.
      ch.open = ch.open ? effective >= ch.layer - 0.06 : effective >= ch.layer + 0.04;
      if (ch.layer <= 0) ch.open = true;
    }
    void name;
    return ch.open;
  }

  schedule(until: number): void {
    if (!this.started || this.paused) return;
    const untilBeat = (until - this.origin) / this.spb;
    let from = this.scheduledUntilBeat;
    while (from < untilBeat) {
      const loc = this.locate(from);
      const sec = this.sections[loc.index] as ExpandedSection;
      const sectionEnd = loc.start + sec.beats;
      const to = Math.min(untilBeat, sectionEnd);
      const fromStep = (from - loc.start) * STEPS_PER_BEAT;
      const toStep = (to - loc.start) * STEPS_PER_BEAT;
      for (const e of sec.events) {
        if (e.step < fromStep) continue;
        if (e.step >= toStep) break;
        const ch = this.channels.get(e.inst);
        const spec = this.composition.instruments[e.inst];
        if (!ch || !spec) continue;
        const absBeat = loc.start + e.step / STEPS_PER_BEAT;
        const bar = Math.floor(absBeat / this.beatsPerBar);
        if (!this.gateOpen(e.inst, ch, bar, sec.spec.intensity)) continue;
        const t = this.origin + absBeat * this.spb;
        if (t < this.ctx.currentTime - 0.01) continue;
        playNote(this.ctx, ch.input, spec, e.note, Math.max(t, this.ctx.currentTime), (e.dur / STEPS_PER_BEAT) * this.spb, e.vel);
        if (spec.kind === 'kick') this.duck(t);
        this.onNote?.(e.inst, t, e.note);
      }
      from = to;
    }
    this.scheduledUntilBeat = untilBeat;
  }

  /** Sidechain: dip the ducked bus on every kick. */
  private duck(t: number): void {
    const depth = Math.max(...Object.values(this.composition.instruments).map((i) => i.duck ?? 0));
    if (depth <= 0) return;
    const g = this.duckBus.gain;
    g.setValueAtTime(1 - depth, t);
    g.linearRampToValueAtTime(1, t + this.spb * 0.45);
  }

  stinger(at: number, strength: number): void {
    const name = this.composition.stinger ?? Object.keys(this.composition.instruments).find((k) => ['bell', 'pluck', 'mallet', 'epiano'].includes(this.composition.instruments[k]?.kind ?? ''));
    if (!name) return;
    const spec = this.composition.instruments[name];
    const ch = this.channels.get(name);
    if (!spec || !ch) return;
    const beat = this.beatAt(at);
    const sec = this.sections[this.locate(beat).index] as ExpandedSection;
    const bar = Math.floor((beat - this.section(beat).startBeat) / this.beatsPerBar);
    const chord = parseChord(sec.spec.chords[bar % sec.spec.chords.length] ?? 'i');
    const notes = voiceChord(this.composition.key, this.composition.scale, chord, 5, 'close');
    const top = degreeToMidi(this.composition.key, this.composition.scale, chord.degree, 6);
    const seq = [...notes, top].slice(0, 2 + Math.round(strength * 3));
    // Quantise to the next sixteenth so the flourish sits in the groove.
    const step = this.spb / STEPS_PER_BEAT;
    const start = this.origin + Math.ceil((at - this.origin) / step) * step;
    seq.forEach((n, i) => playNote(this.ctx, ch.input, spec, n, start + i * step, step * 2, 0.55 + strength * 0.3));
  }

  fadeTo(level: number, at: number, seconds: number): void {
    const g = this.output.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(g.value, at);
    g.linearRampToValueAtTime(level, at + Math.max(0.01, seconds));
  }

  stop(at: number): void {
    this.fadeTo(0, at, 0.05);
    this.started = false;
  }

  pause(now: number): void {
    if (this.paused) return;
    this.pausedBeat = this.beatAt(now);
    this.paused = true;
    this.fadeTo(0, now, 0.25);
  }

  resume(now: number): void {
    if (!this.paused) return;
    this.paused = false;
    // Continue from the paused beat, starting just ahead of now.
    this.origin = now + 0.08 - this.pausedBeat * this.spb;
    this.scheduledUntilBeat = this.pausedBeat;
    this.fadeTo(1, now, 0.4);
  }

  dispose(): void {
    this.output.disconnect();
    for (const n of this.nodes) n.disconnect();
  }
}

export interface FileTrackMeta {
  readonly title: string;
  readonly bpm: number;
  readonly beatsPerBar?: number;
  /** Seconds from the file start to the first downbeat. */
  readonly offset?: number;
  readonly loop?: { readonly startBar: number; readonly endBar: number };
  readonly sections?: readonly { readonly name: string; readonly kind: SectionKind; readonly startBar: number; readonly intensity: number }[];
}

/** Plays a decoded audio file with beat metadata (for the player's own music). */
export class FileTrackPlayer implements TrackPlayer {
  readonly output: GainNode;
  readonly id: string;
  readonly title: string;
  readonly bpm: number;
  readonly beatsPerBar: number;
  onNote = null;
  private source: AudioBufferSourceNode | null = null;
  private origin = 0;
  private started = false;
  paused = false;
  private pausedAt = 0;
  private readonly spb: number;
  private readonly offset: number;

  constructor(
    private readonly ctx: BaseAudioContext,
    readonly buffer: AudioBuffer,
    readonly meta: FileTrackMeta,
    destination: AudioNode,
    id: string,
  ) {
    this.id = id;
    this.title = meta.title;
    this.bpm = meta.bpm;
    this.beatsPerBar = meta.beatsPerBar ?? 4;
    this.spb = 60 / meta.bpm;
    this.offset = meta.offset ?? 0;
    this.output = ctx.createGain();
    this.output.gain.value = 0;
    this.output.connect(destination);
  }

  private startSource(at: number, fileTime: number): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    if (this.meta.loop) {
      src.loop = true;
      src.loopStart = this.offset + this.meta.loop.startBar * this.beatsPerBar * this.spb;
      src.loopEnd = Math.min(this.buffer.duration, this.offset + this.meta.loop.endBar * this.beatsPerBar * this.spb);
    } else src.loop = true;
    src.connect(this.output);
    src.start(at, fileTime);
    this.source = src;
  }

  start(atTime: number): void {
    // Beat 0 = the first downbeat, heard at atTime.
    this.origin = atTime;
    this.started = true;
    this.startSource(atTime, this.offset);
  }

  schedule(): void {
    /* buffer playback needs no lookahead scheduling */
  }

  beatAt(audioTime: number): number {
    if (!this.started) return -1;
    if (this.paused) return this.pausedAt;
    const elapsed = audioTime - this.origin;
    const loop = this.meta.loop;
    if (loop && this.source?.loop) {
      const loopStart = loop.startBar * this.beatsPerBar * this.spb;
      const loopLen = (loop.endBar - loop.startBar) * this.beatsPerBar * this.spb;
      if (elapsed > loopStart + loopLen && loopLen > 0) return (loopStart + ((elapsed - loopStart) % loopLen)) / this.spb;
    }
    return elapsed / this.spb;
  }

  audioTimeOfBeat(beat: number): number {
    return this.origin + beat * this.spb;
  }

  section(beat: number): SectionInfo {
    const bar = beat / this.beatsPerBar;
    const sections = this.meta.sections ?? [];
    let current = { name: 'main', kind: 'verse' as SectionKind, startBar: 0, intensity: 0.6 };
    let idx = 0;
    sections.forEach((s, i) => {
      if (s.startBar <= bar) {
        current = s;
        idx = i;
      }
    });
    const next = sections[idx + 1];
    return { index: idx, name: current.name, kind: current.kind, intensity: current.intensity, startBeat: current.startBar * this.beatsPerBar, endBeat: next ? next.startBar * this.beatsPerBar : Infinity };
  }

  upcoming(beat: number): { kind: SectionKind; beat: number } | null {
    const bar = beat / this.beatsPerBar;
    const next = (this.meta.sections ?? []).find((s) => s.startBar > bar && (s.kind === 'drop' || s.kind === 'build' || s.kind === 'break'));
    return next ? { kind: next.kind, beat: next.startBar * this.beatsPerBar } : null;
  }

  setIntensity(): void {
    /* fixed recording */
  }

  stinger(): void {
    /* recordings have no stinger instrument */
  }

  fadeTo(level: number, at: number, seconds: number): void {
    const g = this.output.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(g.value, at);
    g.linearRampToValueAtTime(level, at + Math.max(0.01, seconds));
  }

  stop(at: number): void {
    this.fadeTo(0, at, 0.05);
    this.source?.stop(at + 0.1);
    this.started = false;
  }

  pause(now: number): void {
    if (this.paused || !this.source) return;
    this.pausedAt = this.beatAt(now);
    this.paused = true;
    this.fadeTo(0, now, 0.2);
    this.source.stop(now + 0.25);
    this.source = null;
  }

  resume(now: number): void {
    if (!this.paused) return;
    this.paused = false;
    const at = now + 0.05;
    this.origin = at - this.pausedAt * this.spb;
    this.startSource(at, this.offset + this.pausedAt * this.spb);
    this.fadeTo(1, now, 0.3);
  }

  dispose(): void {
    try {
      this.source?.stop();
    } catch {
      /* not started */
    }
    this.output.disconnect();
  }
}
