import { describe, expect, it } from 'vitest';
import { arp, bassline, beat, composition, expandComposition, hold, melody, STEPS_PER_BEAT, type Composition } from './composition';
import { degreeToMidi, keyRoot, noteToMidi, parseChord, voiceChord } from './theory';

const COMPOSITIONS = import.meta.glob('/content/**/music/*.ts', { eager: true, import: 'default' }) as Record<string, Composition>;

describe('music theory', () => {
  it('converts note names and degrees', () => {
    expect(noteToMidi('C4')).toBe(60);
    expect(noteToMidi('A4')).toBe(69);
    expect(noteToMidi('Bb2')).toBe(46);
    expect(keyRoot('F#')).toBe(6);
    expect(degreeToMidi('C', 'major', 1, 4)).toBe(60);
    expect(degreeToMidi('C', 'major', 8, 4)).toBe(72);
    expect(degreeToMidi('A', 'minor', 3, 3)).toBe(60);
  });

  it('builds diatonic chords that stay in key', () => {
    const iv = parseChord('iv');
    expect(iv.tones).toEqual([4, 6, 8]);
    expect(voiceChord('C', 'major', parseChord('V7'), 4)).toEqual([67, 71, 74, 77]);
    expect(parseChord('IIsus4').tones).toEqual([2, 5, 6]);
    expect(() => parseChord('X')).toThrow();
  });
});

describe('composition DSL', () => {
  const demo = composition({
    id: 'demo',
    title: 'Demo',
    bpm: 120,
    beatsPerBar: 4,
    key: 'C',
    scale: 'minor',
    swing: 0.2,
    instruments: { pad: { kind: 'pad' }, bass: { kind: 'bass' }, kick: { kind: 'kick' }, lead: { kind: 'pluck' } },
    sections: [
      {
        name: 'a',
        kind: 'verse',
        bars: 2,
        intensity: 0.5,
        chords: ['i', 'VI'],
        parts: { pad: hold(), bass: bassline('x.......x.......'), kick: beat('x...x...x...x...'), lead: [arp({ rate: 4 }), melody('1:4 3:4 5:8')] },
      },
    ],
    loopFrom: 0,
  });

  it('expands deterministically with swing', () => {
    const a = expandComposition(demo);
    const b = expandComposition(demo);
    expect(a[0]?.events).toEqual(b[0]?.events);
    const kicks = a[0]!.events.filter((e) => e.inst === 'kick');
    expect(kicks).toHaveLength(8);
    expect(a[0]!.beats).toBe(8);
    // Odd sixteenths are delayed by the swing amount.
    const lead = a[0]!.events.filter((e) => e.inst === 'lead' && Math.floor(e.step) % 2 === 1);
    for (const e of lead) expect(e.step % 1).toBeCloseTo(0.2);
  });

  it('shuffles off-beat eighths and ramps velocities across a section', () => {
    const c = composition({ ...demo, swing: 0, shuffle: 0.67, sections: [{ ...demo.sections[0]!, parts: { kick: beat('x.x.x.x.x.x.x.x.', { ramp: [0.2, 1] }), lead: melody('1:2 2:2', { ramp: [1, 0.5] }) } }] });
    const events = expandComposition(c)[0]!.events;
    const kicks = events.filter((e) => e.inst === 'kick');
    // Downbeats stay; every off-beat eighth moves to the triplet position.
    expect(kicks.filter((e) => e.step % STEPS_PER_BEAT === 0)).toHaveLength(8);
    const offbeats = kicks.filter((e) => Math.floor(e.step) % STEPS_PER_BEAT === 2);
    expect(offbeats).toHaveLength(8);
    for (const e of offbeats) expect(e.step % STEPS_PER_BEAT).toBeCloseTo(2.67);
    // The kick crescendos and the melody fades.
    expect(kicks[kicks.length - 1]!.vel).toBeGreaterThan(kicks[0]!.vel * 2.5);
    const lead = events.filter((e) => e.inst === 'lead');
    expect(lead[lead.length - 1]!.vel).toBeLessThan(lead[0]!.vel * 0.7);
    // Without the options nothing changes.
    expect(expandComposition({ ...c, shuffle: undefined })[0]!.events.filter((e) => e.inst === 'kick').every((e) => Number.isInteger(e.step))).toBe(true);
  });

  it('rejects unknown instruments', () => {
    expect(() => expandComposition({ ...demo, sections: [{ ...demo.sections[0]!, parts: { ghost: hold() } }] })).toThrow(/unknown instrument/);
  });
});

describe('shipped compositions', () => {
  const entries = Object.entries(COMPOSITIONS);
  it('exist', () => expect(entries.length).toBeGreaterThan(0));
  for (const [path, comp] of entries) {
    it(`${path} expands into playable notes`, () => {
      const sections = expandComposition(comp);
      expect(sections.length).toBeGreaterThan(0);
      expect(comp.loopFrom).toBeLessThan(comp.sections.length);
      let total = 0;
      for (const s of sections) {
        for (const e of s.events) {
          expect(e.note).toBeGreaterThanOrEqual(12);
          expect(e.note).toBeLessThanOrEqual(110);
          expect(e.vel).toBeGreaterThan(0);
          expect(e.vel).toBeLessThanOrEqual(1.2);
          expect(e.step).toBeLessThan(s.beats * STEPS_PER_BEAT + 1);
        }
        total += s.events.length;
      }
      expect(total).toBeGreaterThan(50);
      const minutes = sections.reduce((a, s) => a + s.beats, 0) / comp.bpm;
      expect(minutes).toBeGreaterThan(1.2);
    });
  }
});
