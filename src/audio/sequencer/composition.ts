import { degreeToMidi, parseChord, voiceChord, type Chord, type ScaleName } from './theory';

/** Resolution: 16 steps per 4/4 bar (sixteenth notes). */
export const STEPS_PER_BEAT = 4;

export type InstrumentKind =
  | 'pad'
  | 'strings'
  | 'choir'
  | 'pluck'
  | 'lead'
  | 'bass'
  | 'sub'
  | 'bell'
  | 'epiano'
  | 'mallet'
  | 'kick'
  | 'snare'
  | 'clap'
  | 'hat'
  | 'openhat'
  | 'ride'
  | 'shaker'
  | 'tom'
  | 'perc'
  | 'crash'
  | 'riser'
  | 'impact';

export interface InstrumentSpec {
  readonly kind: InstrumentKind;
  /** Linear gain into the instrument channel (0..1). */
  readonly gain?: number;
  readonly pan?: number;
  readonly reverb?: number;
  readonly delay?: number;
  /** Intensity threshold (0..1): the part only plays while the music intensity reaches it. */
  readonly layer?: number;
  /** Sidechain ducking amount from the kick (0..1). */
  readonly duck?: number;
  /** Synth character, interpreted per kind (see synth/instruments.ts). */
  readonly wave?: OscillatorType;
  readonly cutoff?: number;
  readonly resonance?: number;
  readonly attack?: number;
  readonly decay?: number;
  readonly sustain?: number;
  readonly release?: number;
  readonly detune?: number;
  readonly voices?: number;
  /** FM ratio / index for bell, epiano, mallet. */
  readonly ratio?: number;
  readonly index?: number;
  /** Filter envelope amount in octaves (pluck, bass, lead). */
  readonly envAmount?: number;
  /** Portamento in seconds for lead voices: notes in a phrase slide from the previous pitch. */
  readonly glide?: number;
  readonly drive?: number;
  /** Pitch for drums (Hz) or brightness. */
  readonly tone?: number;
}

export interface NoteEvent {
  readonly inst: string;
  /** Sixteenth-note step from the section start (may be fractional after swing). */
  readonly step: number;
  readonly note: number;
  /** Duration in steps. */
  readonly dur: number;
  readonly vel: number;
}

export interface PartContext {
  readonly inst: string;
  readonly bars: number;
  readonly beatsPerBar: number;
  readonly key: string;
  readonly scale: ScaleName;
  /** Chord for each bar of the section. */
  readonly chords: readonly Chord[];
  readonly rand: () => number;
}

export type PartGenerator = (ctx: PartContext) => NoteEvent[];

export type SectionKind = 'intro' | 'verse' | 'build' | 'drop' | 'break' | 'bridge' | 'outro';

export interface SectionSpec {
  readonly name: string;
  readonly kind: SectionKind;
  readonly bars: number;
  /** Composed baseline intensity 0..1 (gameplay may push layers higher). */
  readonly intensity: number;
  /** Roman-numeral chords, one per bar (cycled). */
  readonly chords: readonly string[];
  readonly parts: Readonly<Record<string, PartGenerator | readonly PartGenerator[]>>;
}

export interface Composition {
  readonly id: string;
  readonly title: string;
  readonly bpm: number;
  readonly beatsPerBar: number;
  readonly key: string;
  readonly scale: ScaleName;
  /** 0..0.5 delays every off-beat sixteenth. */
  readonly swing: number;
  /**
   * Eighth-note swing in sixteenth steps: delays every off-beat eighth (the "and" of each beat).
   * 0.67 is a triplet shuffle; with `swing` 0.33 the other sixteenths follow the triplet grid.
   */
  readonly shuffle?: number;
  readonly instruments: Readonly<Record<string, InstrumentSpec>>;
  readonly sections: readonly SectionSpec[];
  /** Section index the music loops back to after the last section. */
  readonly loopFrom: number;
  /** Instrument used for gameplay stingers (QUAD, perfect clear). */
  readonly stinger?: string;
  /** Reverb character. */
  readonly space?: { readonly decay: number; readonly wet: number; readonly damping: number };
}

export function composition(c: Composition): Composition {
  return c;
}

// --------------------------------------------------------------------------- helpers

function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Velocity scale at `step` of `total` for a `[from, to]` crescendo/decrescendo (1 without a ramp). */
function rampAt(ramp: readonly [number, number] | undefined, step: number, total: number): number {
  return ramp ? ramp[0] + (ramp[1] - ramp[0]) * Math.min(1, Math.max(0, step / Math.max(1, total))) : 1;
}

/** Parses "x...x.x." style patterns: x = hit, X = accent, o = ghost, . = rest. */
function parsePattern(pattern: string): { step: number; vel: number }[] {
  const clean = pattern.replace(/[\s|]/g, '');
  const hits: { step: number; vel: number }[] = [];
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === 'x') hits.push({ step: i, vel: 0.8 });
    else if (c === 'X') hits.push({ step: i, vel: 1 });
    else if (c === 'o') hits.push({ step: i, vel: 0.45 });
  }
  return hits;
}

// --------------------------------------------------------------------------- part generators

/** Holds the bar's chord for the whole bar (pads, strings, choirs). */
export function hold(opts: { octave?: number; voicing?: 'close' | 'open' | 'spread'; vel?: number; every?: number } = {}): PartGenerator {
  return (ctx) => {
    const out: NoteEvent[] = [];
    const stepsPerBar = ctx.beatsPerBar * STEPS_PER_BEAT;
    const every = opts.every ?? 1;
    for (let bar = 0; bar < ctx.bars; bar += every) {
      const chord = ctx.chords[bar] as Chord;
      for (const note of voiceChord(ctx.key, ctx.scale, chord, opts.octave ?? 3, opts.voicing ?? 'open')) {
        out.push({ inst: ctx.inst, step: bar * stepsPerBar, note, dur: stepsPerBar * every, vel: opts.vel ?? 0.6 });
      }
    }
    return out;
  };
}

/** Arpeggiates the bar's chord. */
export function arp(opts: { rate?: number; octave?: number; span?: number; order?: 'up' | 'down' | 'updown' | 'random' | 'pendulum'; gate?: number; vel?: number; accent?: number; startBar?: number; ramp?: readonly [number, number] } = {}): PartGenerator {
  return (ctx) => {
    const out: NoteEvent[] = [];
    const rate = opts.rate ?? 2;
    const stepsPerBar = ctx.beatsPerBar * STEPS_PER_BEAT;
    for (let bar = opts.startBar ?? 0; bar < ctx.bars; bar++) {
      const chord = ctx.chords[bar] as Chord;
      const base = voiceChord(ctx.key, ctx.scale, chord, opts.octave ?? 4, 'close');
      const notes: number[] = [];
      for (let o = 0; o < (opts.span ?? 2); o++) for (const n of base) notes.push(n + o * 12);
      let seq = notes;
      if (opts.order === 'down') seq = [...notes].reverse();
      if (opts.order === 'updown' || opts.order === 'pendulum') seq = [...notes, ...notes.slice(1, -1).reverse()];
      for (let s = 0, i = 0; s < stepsPerBar; s += rate, i++) {
        const note = opts.order === 'random' ? (notes[Math.floor(ctx.rand() * notes.length)] as number) : (seq[i % seq.length] as number);
        const accent = s % (STEPS_PER_BEAT * 2) === 0 ? (opts.accent ?? 0.15) : 0;
        const step = bar * stepsPerBar + s;
        out.push({ inst: ctx.inst, step, note, dur: rate * (opts.gate ?? 0.8), vel: Math.min(1, ((opts.vel ?? 0.55) + accent + (ctx.rand() - 0.5) * 0.08) * rampAt(opts.ramp, step, ctx.bars * stepsPerBar)) });
      }
    }
    return out;
  };
}

/** Bass on the chord root following a rhythm; `fifths` = chance of playing the fifth instead. */
export function bassline(pattern: string, opts: { octave?: number; fifths?: number; octaves?: number; gate?: number; vel?: number } = {}): PartGenerator {
  const hits = parsePattern(pattern);
  const len = pattern.replace(/[\s|]/g, '').length;
  return (ctx) => {
    const out: NoteEvent[] = [];
    const stepsPerBar = ctx.beatsPerBar * STEPS_PER_BEAT;
    const total = ctx.bars * stepsPerBar;
    for (let start = 0; start < total; start += len) {
      hits.forEach((h, i) => {
        const step = start + h.step;
        if (step >= total) return;
        const chord = ctx.chords[Math.floor(step / stepsPerBar)] as Chord;
        let degree = chord.degree;
        const r = ctx.rand();
        if (i > 0 && r < (opts.fifths ?? 0)) degree += 4;
        let note = degreeToMidi(ctx.key, ctx.scale, degree, opts.octave ?? 2);
        if (i > 0 && r > 1 - (opts.octaves ?? 0)) note += 12;
        const next = hits[i + 1]?.step ?? len;
        out.push({ inst: ctx.inst, step, note, dur: Math.max(1, (next - h.step) * (opts.gate ?? 0.85)), vel: (opts.vel ?? 0.8) * h.vel / 0.8 });
      });
    }
    return out;
  };
}

/** Drum/percussion pattern repeated over the section. `prob` thins hits deterministically. */
export function beat(pattern: string, opts: { vel?: number; prob?: number; fillLastBar?: string; ramp?: readonly [number, number] } = {}): PartGenerator {
  const hits = parsePattern(pattern);
  const len = pattern.replace(/[\s|]/g, '').length;
  return (ctx) => {
    const out: NoteEvent[] = [];
    const stepsPerBar = ctx.beatsPerBar * STEPS_PER_BEAT;
    const total = ctx.bars * stepsPerBar;
    for (let start = 0; start < total; start += len) {
      const lastBar = start >= total - stepsPerBar && opts.fillLastBar;
      const use = lastBar ? parsePattern(opts.fillLastBar as string) : hits;
      for (const h of use) {
        const step = start + h.step;
        if (step >= total) continue;
        if (opts.prob !== undefined && ctx.rand() > opts.prob && h.vel < 1) continue;
        out.push({ inst: ctx.inst, step, note: 60, dur: 1, vel: (opts.vel ?? 1) * h.vel * (0.94 + ctx.rand() * 0.12) * rampAt(opts.ramp, step, total) });
      }
    }
    return out;
  };
}

/**
 * Melody from scale degrees with durations in steps: "1:4 3:2 5:2 -:4 6':4".
 * `'` raises an octave, `,` lowers; `-` is a rest. The phrase repeats to fill the section.
 */
export function melody(phrase: string, opts: { octave?: number; vel?: number; gate?: number; bars?: number; ramp?: readonly [number, number] } = {}): PartGenerator {
  const tokens = phrase.replace(/\|/g, ' ').split(/\s+/).filter(Boolean);
  return (ctx) => {
    const out: NoteEvent[] = [];
    const stepsPerBar = ctx.beatsPerBar * STEPS_PER_BEAT;
    const total = (opts.bars ?? ctx.bars) * stepsPerBar;
    let step = 0;
    let guard = 0;
    while (step < total && guard++ < 10000) {
      for (const tok of tokens) {
        if (step >= total) break;
        const [deg, durText] = tok.split(':');
        const dur = Number(durText ?? 2) || 2;
        if (deg && deg !== '-') {
          const up = (deg.match(/'/g) ?? []).length;
          const down = (deg.match(/,/g) ?? []).length;
          const d = Number(deg.replace(/['|,]/g, ''));
          const note = degreeToMidi(ctx.key, ctx.scale, d, (opts.octave ?? 4) + up - down);
          out.push({ inst: ctx.inst, step, note, dur: dur * (opts.gate ?? 0.9), vel: (opts.vel ?? 0.6) * (0.92 + ctx.rand() * 0.16) * rampAt(opts.ramp, step, total) });
        }
        step += dur;
      }
    }
    return out;
  };
}

/** Chord stabs on a rhythm. */
export function stab(pattern: string, opts: { octave?: number; voicing?: 'close' | 'open' | 'spread'; gate?: number; vel?: number } = {}): PartGenerator {
  const hits = parsePattern(pattern);
  const len = pattern.replace(/[\s|]/g, '').length;
  return (ctx) => {
    const out: NoteEvent[] = [];
    const stepsPerBar = ctx.beatsPerBar * STEPS_PER_BEAT;
    const total = ctx.bars * stepsPerBar;
    for (let start = 0; start < total; start += len) {
      for (const h of hits) {
        const step = start + h.step;
        if (step >= total) continue;
        const chord = ctx.chords[Math.floor(step / stepsPerBar)] as Chord;
        for (const note of voiceChord(ctx.key, ctx.scale, chord, opts.octave ?? 4, opts.voicing ?? 'close')) {
          out.push({ inst: ctx.inst, step, note, dur: opts.gate ?? 1.5, vel: (opts.vel ?? 0.55) * h.vel / 0.8 });
        }
      }
    }
    return out;
  };
}

/** One-shot at the start of the section (risers, impacts, crashes). */
export function once(opts: { step?: number; dur?: number; vel?: number; note?: number } = {}): PartGenerator {
  return (ctx) => [{ inst: ctx.inst, step: opts.step ?? 0, note: opts.note ?? 60, dur: opts.dur ?? ctx.bars * ctx.beatsPerBar * STEPS_PER_BEAT, vel: opts.vel ?? 0.8 }];
}

// --------------------------------------------------------------------------- expansion

export interface ExpandedSection {
  readonly spec: SectionSpec;
  readonly index: number;
  /** Length in beats. */
  readonly beats: number;
  readonly events: readonly NoteEvent[];
}

/** Expands every section into time-ordered note events (deterministic). */
export function expandComposition(c: Composition): ExpandedSection[] {
  return c.sections.map((spec, index) => {
    const chords = Array.from({ length: spec.bars }, (_, bar) => parseChord(spec.chords[bar % spec.chords.length] ?? 'i'));
    const events: NoteEvent[] = [];
    for (const [inst, gen] of Object.entries(spec.parts)) {
      if (!c.instruments[inst]) throw new Error(`${c.id}/${spec.name}: unknown instrument "${inst}"`);
      const gens = Array.isArray(gen) ? (gen as readonly PartGenerator[]) : [gen as PartGenerator];
      gens.forEach((g, gi) => {
        const rand = seededRandom(hashString(`${c.id}:${spec.name}:${inst}:${gi}`));
        for (const e of g({ inst, bars: spec.bars, beatsPerBar: c.beatsPerBar, key: c.key, scale: c.scale, chords, rand })) {
          let swung = c.swing > 0 && Math.floor(e.step) % 2 === 1 ? e.step + c.swing : e.step;
          if ((c.shuffle ?? 0) > 0 && e.step % STEPS_PER_BEAT === 2) swung += c.shuffle as number;
          events.push({ ...e, step: swung });
        }
      });
    }
    events.sort((a, b) => a.step - b.step);
    return { spec, index, beats: spec.bars * c.beatsPerBar, events };
  });
}

/** Total beats of all sections from `from` to the end. */
export function sectionStarts(sections: readonly ExpandedSection[]): number[] {
  const starts: number[] = [];
  let acc = 0;
  for (const s of sections) {
    starts.push(acc);
    acc += s.beats;
  }
  return starts;
}
