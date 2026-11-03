import { arp, bassline, beat, composition, hold, melody, once } from '@prismfall/sdk';

/**
 * "Above the Treeline": cinematic orchestral ambient in G major. Warm strings and a gentle piano
 * line grow over pads and natural percussion into a broad, open chorus. Original composition.
 */
export default composition({
  id: 'alpine-horizon-treeline',
  title: 'Above the Treeline',
  bpm: 88,
  beatsPerBar: 4,
  key: 'G',
  scale: 'major',
  swing: 0.03,
  space: { decay: 6.5, wet: 0.45, damping: 0.4 },
  stinger: 'keys',
  instruments: {
    pad: { kind: 'pad', wave: 'triangle', voices: 3, detune: 6, cutoff: 1500, attack: 2.4, release: 4.5, gain: 0.3, reverb: 0.75 },
    strings: { kind: 'strings', wave: 'sawtooth', voices: 5, detune: 12, cutoff: 1700, attack: 1.4, release: 3.5, gain: 0.36, reverb: 0.8 },
    cello: { kind: 'strings', wave: 'sawtooth', voices: 3, detune: 8, cutoff: 900, attack: 0.9, release: 2.5, gain: 0.3, reverb: 0.6, layer: 0.3 },
    keys: { kind: 'epiano', ratio: 1, index: 0.7, decay: 2.6, gain: 0.3, reverb: 0.6, pan: -0.15 },
    horn: { kind: 'lead', wave: 'sawtooth', cutoff: 1100, envAmount: 0.5, attack: 0.25, decay: 2, gain: 0.2, reverb: 0.75, glide: 0.05, layer: 0.6 },
    harp: { kind: 'pluck', wave: 'triangle', cutoff: 3000, envAmount: 1.6, decay: 1.1, gain: 0.2, reverb: 0.6, delay: 0.25, pan: 0.3, layer: 0.35 },
    sub: { kind: 'sub', gain: 0.38, duck: 0.15, layer: 0.3 },
    frame: { kind: 'tom', tone: 90, decay: 0.45, gain: 0.45, reverb: 0.5, layer: 0.4 },
    shaker: { kind: 'shaker', gain: 0.16, pan: 0.35, layer: 0.45 },
    timpani: { kind: 'tom', tone: 55, decay: 0.9, gain: 0.5, reverb: 0.7, layer: 0.6 },
    riser: { kind: 'riser', gain: 0.32, reverb: 0.7 },
    impact: { kind: 'impact', gain: 0.4, reverb: 0.85 },
  },
  sections: [
    {
      name: 'first light',
      kind: 'intro',
      bars: 8,
      intensity: 0.15,
      chords: ['I', 'V', 'vi', 'IV'],
      parts: {
        pad: hold({ octave: 3, voicing: 'open', vel: 0.48 }),
        keys: melody('3:4 5:4 1\':8 | 7:4 5:4 3:8 | 6:4 5:4 3:4 2:4 | 1:16', { octave: 4, vel: 0.48 }),
      },
    },
    {
      name: 'valley',
      kind: 'verse',
      bars: 16,
      intensity: 0.42,
      chords: ['I', 'V', 'vi', 'IV', 'I', 'iii', 'IV', 'V'],
      parts: {
        pad: hold({ octave: 3, voicing: 'open', vel: 0.42 }),
        strings: hold({ octave: 3, voicing: 'spread', vel: 0.4, every: 2 }),
        keys: arp({ rate: 2, octave: 4, span: 2, order: 'updown', vel: 0.38 }),
        cello: bassline('x.......x...x...', { octave: 2, fifths: 0.3 }),
        frame: beat('x.......x.......', { vel: 0.7 }),
        shaker: beat('..x...x...x...x.', { vel: 0.5, prob: 0.8 }),
      },
    },
    {
      name: 'ascent',
      kind: 'build',
      bars: 4,
      intensity: 0.65,
      chords: ['IV', 'V', 'vi', 'V'],
      parts: {
        strings: hold({ octave: 3, voicing: 'spread', vel: 0.52 }),
        harp: arp({ rate: 1, octave: 4, span: 2, order: 'up', vel: 0.4 }),
        timpani: beat('x...x...x...x...', { fillLastBar: 'x.x.x.x.xxxxxxxx' }),
        riser: once({ dur: 64, vel: 0.55 }),
      },
    },
    {
      name: 'summit',
      kind: 'drop',
      bars: 16,
      intensity: 0.85,
      chords: ['I', 'V', 'vi', 'IV', 'I', 'V', 'IV', 'V'],
      parts: {
        impact: once({ dur: 4, vel: 0.6 }),
        pad: hold({ octave: 3, voicing: 'open', vel: 0.4 }),
        strings: hold({ octave: 3, voicing: 'spread', vel: 0.5 }),
        horn: melody('5:8 6:4 5:4 | 3:12 2:4 | 4:6 3:2 2:4 1:4 | 2:16 | 5:8 6:4 1\':4 | 7:8 5:8 | 6:4 5:4 4:4 2:4 | 1:16', { octave: 4, vel: 0.5 }),
        keys: arp({ rate: 2, octave: 4, span: 2, order: 'updown', vel: 0.34 }),
        harp: arp({ rate: 4, octave: 5, span: 1, order: 'up', vel: 0.26 }),
        cello: bassline('x.....x.x.......', { octave: 2, fifths: 0.3 }),
        sub: bassline('x.......x.......', { octave: 1 }),
        frame: beat('x.....x...x.....'),
        timpani: beat('x...............', { vel: 0.8 }),
        shaker: beat('x.x.x.x.x.x.x.x.', { vel: 0.45, prob: 0.85 }),
      },
    },
    {
      name: 'high meadow',
      kind: 'break',
      bars: 8,
      intensity: 0.25,
      chords: ['vi', 'IV', 'I', 'V'],
      parts: {
        pad: hold({ octave: 3, voicing: 'open', vel: 0.44 }),
        keys: melody('1\':6 7:2 6:4 5:4 | 4:8 3:8 | 2:4 3:4 4:4 5:4 | 1:16', { octave: 4, vel: 0.46 }),
      },
    },
  ],
  loopFrom: 1,
});
