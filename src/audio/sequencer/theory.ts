/** Minimal music theory for generative compositions: notes, scales and diatonic chords. */

const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
  pentatonicMinor: [0, 3, 5, 7, 10],
  pentatonicMajor: [0, 2, 4, 7, 9],
  /** Japanese "in" (miyako-bushi) pentatonic: melancholic, with a minor second. */
  inScale: [0, 1, 5, 7, 8],
  /** Japanese "yo" pentatonic: open and bright. */
  yoScale: [0, 2, 5, 7, 9],
} as const;

export type ScaleName = keyof typeof SCALES;

/** "C4" → 60, "F#3" → 54, "Bb2" → 46. */
export function noteToMidi(name: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(name.trim());
  if (!m) throw new Error(`Bad note name "${name}"`);
  const pc = (PITCH_CLASS[(m[1] as string).toUpperCase()] as number) + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return (Number(m[3]) + 1) * 12 + pc;
}

export function keyRoot(key: string): number {
  const m = /^([A-Ga-g])([#b]?)$/.exec(key.trim());
  if (!m) throw new Error(`Bad key "${key}"`);
  return (((PITCH_CLASS[(m[1] as string).toUpperCase()] as number) + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0)) + 12) % 12;
}

export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** MIDI note of a 1-based scale degree in an octave (degrees beyond the scale wrap upward). */
export function degreeToMidi(key: string, scale: ScaleName, degree: number, octave: number): number {
  const steps = SCALES[scale];
  const n = steps.length;
  const zero = degree - 1;
  const oct = Math.floor(zero / n);
  const idx = ((zero % n) + n) % n;
  return (octave + 1 + oct) * 12 + keyRoot(key) + (steps[idx] as number);
}

export interface Chord {
  /** Root scale degree (1-based). */
  readonly degree: number;
  /** Scale degrees of the chord tones (1-based, may exceed 7 for extensions). */
  readonly tones: readonly number[];
  readonly symbol: string;
}

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7 };

/**
 * Diatonic chord from a roman numeral with optional suffix: "i", "VI", "iv7", "v9", "IIsus4", "iadd9".
 * Case is ignored — chord quality comes from the scale, keeping everything in key.
 */
export function parseChord(symbol: string): Chord {
  const m = /^([ivIV]+)(.*)$/.exec(symbol.trim());
  if (!m) throw new Error(`Bad chord "${symbol}"`);
  const degree = ROMAN[(m[1] as string).toLowerCase()];
  if (!degree) throw new Error(`Bad chord "${symbol}"`);
  const suffix = (m[2] ?? '').toLowerCase();
  let tones = [degree, degree + 2, degree + 4];
  if (suffix.includes('sus2')) tones = [degree, degree + 1, degree + 4];
  if (suffix.includes('sus4')) tones = [degree, degree + 3, degree + 4];
  if (suffix.includes('7') || suffix.includes('9')) tones.push(degree + 6);
  if (suffix.includes('9')) tones.push(degree + 8);
  if (suffix.includes('add9')) tones = [degree, degree + 2, degree + 4, degree + 8];
  return { degree, tones, symbol };
}

/** Chord tones as MIDI notes in a voicing around an octave. */
export function voiceChord(key: string, scale: ScaleName, chord: Chord, octave: number, voicing: 'close' | 'open' | 'spread' = 'close'): number[] {
  const notes = chord.tones.map((d) => degreeToMidi(key, scale, d, octave));
  if (voicing === 'open' && notes.length >= 3) notes[1] = (notes[1] as number) + 12;
  if (voicing === 'spread') return notes.map((n, i) => n + (i % 2 === 1 ? 12 : 0) + (i >= 3 ? 12 : 0));
  return notes;
}
