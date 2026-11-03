import { arp, bassline, beat, composition, hold, melody, once } from '@prismfall/sdk';

/**
 * "Curtains of the Sky": ethereal cinematic ambient in B major. Evolving pads, a delicate
 * sequenced pattern, soft piano and wide strings with gentle percussion. Original composition.
 */
export default composition({
  id: 'northern-lights-curtains',
  title: 'Curtains of the Sky',
  bpm: 80,
  beatsPerBar: 4,
  key: 'B',
  scale: 'major',
  swing: 0.03,
  space: { decay: 7.5, wet: 0.52, damping: 0.3 },
  stinger: 'keys',
  instruments: {
    pad: { kind: 'pad', wave: 'sawtooth', voices: 4, detune: 18, cutoff: 1300, attack: 3, release: 5.5, gain: 0.3, reverb: 0.85 },
    warm: { kind: 'pad', wave: 'triangle', voices: 3, detune: 6, cutoff: 900, attack: 2.4, release: 4.5, gain: 0.3, reverb: 0.75 },
    strings: { kind: 'strings', wave: 'sawtooth', voices: 5, detune: 13, cutoff: 1500, attack: 2, release: 4, gain: 0.3, reverb: 0.85, layer: 0.35 },
    seq: { kind: 'bell', ratio: 3, index: 0.7, decay: 1.2, gain: 0.2, delay: 0.5, reverb: 0.6, pan: 0.25, layer: 0.2 },
    keys: { kind: 'epiano', ratio: 1, index: 0.6, decay: 2.6, gain: 0.28, reverb: 0.7, pan: -0.15 },
    lead: { kind: 'lead', wave: 'triangle', cutoff: 2600, envAmount: 0.5, attack: 0.25, decay: 2.4, gain: 0.2, reverb: 0.85, delay: 0.45, glide: 0.1, layer: 0.55 },
    sparkle: { kind: 'bell', ratio: 6.3, index: 0.6, decay: 2.8, gain: 0.1, reverb: 0.9, pan: -0.3, layer: 0.5 },
    sub: { kind: 'sub', gain: 0.4, duck: 0.2, layer: 0.3 },
    kick: { kind: 'kick', tone: 90, decay: 0.45, gain: 0.42, layer: 0.5 },
    snap: { kind: 'snare', tone: 200, decay: 0.14, gain: 0.16, reverb: 0.8, layer: 0.55 },
    tick: { kind: 'hat', tone: 9500, decay: 0.03, gain: 0.12, pan: 0.3, layer: 0.4 },
    riser: { kind: 'riser', gain: 0.32, reverb: 0.75 },
    impact: { kind: 'impact', gain: 0.38, reverb: 0.9 },
  },
  sections: [
    {
      name: 'polar night',
      kind: 'intro',
      bars: 8,
      intensity: 0.15,
      chords: ['I', 'IV', 'vi', 'V'],
      parts: {
        warm: hold({ octave: 3, voicing: 'open', vel: 0.5 }),
        keys: melody("3:8 5:8 | 1':12 7:4 | 6:8 5:8 | 3:16", { octave: 4, vel: 0.44 }),
      },
    },
    {
      name: 'first glow',
      kind: 'verse',
      bars: 16,
      intensity: 0.4,
      chords: ['I', 'IV', 'vi', 'V', 'I', 'iii', 'IV', 'V'],
      parts: {
        warm: hold({ octave: 3, voicing: 'open', vel: 0.45 }),
        pad: hold({ octave: 3, voicing: 'spread', vel: 0.38, every: 2 }),
        seq: arp({ rate: 2, octave: 5, span: 2, order: 'up', vel: 0.34 }),
        sub: bassline('x...............', { octave: 1 }),
        tick: beat('..x...x...x...x.', { vel: 0.45, prob: 0.7 }),
      },
    },
    {
      name: 'rising curtains',
      kind: 'build',
      bars: 4,
      intensity: 0.62,
      chords: ['IV', 'V', 'vi', 'V'],
      parts: {
        strings: hold({ octave: 3, voicing: 'spread', vel: 0.5 }),
        seq: arp({ rate: 1, octave: 5, span: 2, order: 'up', vel: 0.36 }),
        snap: beat('....x.......x...', { fillLastBar: '..x.x.x.xxxxxxxx' }),
        riser: once({ dur: 64, vel: 0.55 }),
      },
    },
    {
      name: 'corona',
      kind: 'drop',
      bars: 16,
      intensity: 0.82,
      chords: ['I', 'IV', 'vi', 'V', 'I', 'iii', 'IV', 'V'],
      parts: {
        impact: once({ dur: 4, vel: 0.55 }),
        warm: hold({ octave: 3, voicing: 'open', vel: 0.42 }),
        pad: hold({ octave: 3, voicing: 'spread', vel: 0.44 }),
        strings: hold({ octave: 3, voicing: 'open', vel: 0.46 }),
        sparkle: hold({ octave: 5, voicing: 'close', vel: 0.28, every: 2 }),
        lead: melody("5:8 6:4 5:4 | 3:8 2:8 | 4:6 3:2 2:4 1:4 | 2:16 | 5:8 1':4 7:4 | 6:8 5:8 | 4:4 3:4 2:4 3:4 | 1:16", { octave: 4, vel: 0.5 }),
        seq: arp({ rate: 2, octave: 5, span: 2, order: 'pendulum', vel: 0.3 }),
        sub: bassline('x.......x.......', { octave: 1, fifths: 0.2 }),
        kick: beat('x.........x.....'),
        snap: beat('....x.......x...'),
        tick: beat('x.x.x.x.x.x.x.x.', { vel: 0.4, prob: 0.85 }),
      },
    },
    {
      name: 'after light',
      kind: 'break',
      bars: 8,
      intensity: 0.22,
      chords: ['vi', 'IV', 'I', 'V'],
      parts: {
        warm: hold({ octave: 3, voicing: 'open', vel: 0.45 }),
        keys: melody("1':6 7:2 6:8 | 5:6 4:2 3:8 | 2:4 3:4 5:4 6:4 | 5:16", { octave: 4, vel: 0.44 }),
      },
    },
  ],
  loopFrom: 1,
});
