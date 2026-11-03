import { arp, bassline, beat, composition, hold, melody, once } from '@prismfall/sdk';

/**
 * "Where the Fireflies Gather": organic cinematic ambient in A minor with Dorian colour. Delicate
 * piano, warm strings, marimba-like plucks and soft hand percussion over breathing pads.
 */
export default composition({
  id: 'enchanted-wilderness-fireflies',
  title: 'Where the Fireflies Gather',
  bpm: 90,
  beatsPerBar: 4,
  key: 'A',
  scale: 'dorian',
  swing: 0.07,
  space: { decay: 5.5, wet: 0.42, damping: 0.5 },
  stinger: 'keys',
  instruments: {
    pad: { kind: 'pad', wave: 'triangle', voices: 3, detune: 8, cutoff: 1300, attack: 2.2, release: 4, gain: 0.32, reverb: 0.75 },
    strings: { kind: 'strings', wave: 'sawtooth', voices: 4, detune: 11, cutoff: 1500, attack: 1.6, release: 3.5, gain: 0.32, reverb: 0.75, layer: 0.3 },
    keys: { kind: 'epiano', ratio: 1, index: 0.6, decay: 2.4, gain: 0.3, reverb: 0.6, pan: -0.15 },
    marimba: { kind: 'mallet', ratio: 4, index: 1.4, decay: 0.7, gain: 0.26, reverb: 0.45, delay: 0.25, pan: 0.25, layer: 0.25 },
    flute: { kind: 'lead', wave: 'sine', cutoff: 2600, envAmount: 0.4, attack: 0.15, decay: 1.6, gain: 0.22, reverb: 0.7, delay: 0.3, glide: 0.06, layer: 0.5 },
    chime: { kind: 'bell', ratio: 3.5, index: 0.8, decay: 2.8, gain: 0.14, reverb: 0.8, layer: 0.55 },
    sub: { kind: 'sub', gain: 0.4, duck: 0.2, layer: 0.3 },
    drum: { kind: 'tom', tone: 80, decay: 0.4, gain: 0.45, reverb: 0.4, layer: 0.35 },
    tap: { kind: 'perc', gain: 0.24, pan: 0.3, layer: 0.3 },
    shaker: { kind: 'shaker', gain: 0.16, pan: -0.3, layer: 0.45 },
    riser: { kind: 'riser', gain: 0.3, reverb: 0.7 },
    impact: { kind: 'impact', gain: 0.38, reverb: 0.85 },
  },
  sections: [
    {
      name: 'dusk canopy',
      kind: 'intro',
      bars: 8,
      intensity: 0.15,
      chords: ['i', 'IV', 'i', 'VII'],
      parts: {
        pad: hold({ octave: 3, voicing: 'open', vel: 0.48 }),
        keys: melody('5:4 4:4 3:8 | 4:4 3:4 1:8 | 2:4 3:4 4:4 5:4 | 3:16', { octave: 4, vel: 0.46 }),
      },
    },
    {
      name: 'deep woods',
      kind: 'verse',
      bars: 16,
      intensity: 0.42,
      chords: ['i', 'IV', 'III', 'VII', 'i', 'IV', 'v', 'VII'],
      parts: {
        pad: hold({ octave: 3, voicing: 'open', vel: 0.44 }),
        strings: hold({ octave: 3, voicing: 'spread', vel: 0.38, every: 2 }),
        marimba: arp({ rate: 2, octave: 4, span: 2, order: 'pendulum', vel: 0.38 }),
        sub: bassline('x.......x.......', { octave: 1 }),
        drum: beat('x.....x...x.....', { vel: 0.7 }),
        tap: beat('..x.x...x...x.x.', { vel: 0.55, prob: 0.85 }),
      },
    },
    {
      name: 'gathering light',
      kind: 'build',
      bars: 4,
      intensity: 0.62,
      chords: ['IV', 'v', 'VI', 'VII'],
      parts: {
        strings: hold({ octave: 3, voicing: 'spread', vel: 0.5 }),
        marimba: arp({ rate: 1, octave: 4, span: 2, order: 'up', vel: 0.4 }),
        drum: beat('x...x...x...x...', { fillLastBar: 'x.x.x.x.xxxxxxxx' }),
        riser: once({ dur: 64, vel: 0.5 }),
      },
    },
    {
      name: 'firefly bloom',
      kind: 'drop',
      bars: 16,
      intensity: 0.84,
      chords: ['i', 'IV', 'III', 'VII', 'i', 'IV', 'VI', 'v'],
      parts: {
        impact: once({ dur: 4, vel: 0.55 }),
        pad: hold({ octave: 3, voicing: 'open', vel: 0.42 }),
        strings: hold({ octave: 3, voicing: 'spread', vel: 0.48 }),
        chime: hold({ octave: 5, voicing: 'close', vel: 0.28, every: 2 }),
        flute: melody('5:6 6:2 5:4 3:4 | 4:8 3:8 | 2:4 3:4 5:4 7:4 | 5:16 | 6:6 5:2 4:4 3:4 | 2:8 4:8 | 3:4 2:4 1:4 2:4 | 1:16', { octave: 4, vel: 0.5 }),
        marimba: arp({ rate: 2, octave: 4, span: 2, order: 'pendulum', vel: 0.34 }),
        keys: arp({ rate: 4, octave: 4, span: 1, order: 'up', vel: 0.26 }),
        sub: bassline('x.....x...x.....', { octave: 1, fifths: 0.2 }),
        drum: beat('x.....x...x.....'),
        tap: beat('..x.xx..x.x.xx.x', { vel: 0.55 }),
        shaker: beat('x.x.x.x.x.x.x.x.', { vel: 0.42, prob: 0.85 }),
      },
    },
    {
      name: 'moss and starlight',
      kind: 'break',
      bars: 8,
      intensity: 0.24,
      chords: ['VI', 'IV', 'i', 'VII'],
      parts: {
        pad: hold({ octave: 3, voicing: 'open', vel: 0.44 }),
        keys: melody("1':6 7:2 5:8 | 6:6 5:2 3:8 | 4:4 3:4 2:4 3:4 | 1:16", { octave: 4, vel: 0.44 }),
      },
    },
  ],
  loopFrom: 1,
});
