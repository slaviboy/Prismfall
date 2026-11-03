import { arp, bassline, beat, composition, hold, melody, once } from '@prismfall/sdk';

/**
 * "Pressure and Light": deep, fluid underwater ambient in F# Dorian. Slow-swelling pads, liquid
 * FM plucks with long delays, a soft organic pulse and glassy high textures. Original composition.
 */
export default composition({
  id: 'the-abyss-pressure-and-light',
  title: 'Pressure and Light',
  bpm: 72,
  beatsPerBar: 4,
  key: 'F#',
  scale: 'dorian',
  swing: 0.06,
  space: { decay: 8, wet: 0.55, damping: 0.6 },
  stinger: 'drops',
  instruments: {
    deep: { kind: 'pad', wave: 'sine', voices: 3, detune: 5, cutoff: 600, attack: 3.5, release: 6, gain: 0.42, reverb: 0.8 },
    pad: { kind: 'pad', wave: 'triangle', voices: 4, detune: 14, cutoff: 1100, attack: 3, release: 5.5, gain: 0.3, reverb: 0.85, layer: 0.3 },
    drops: { kind: 'bell', ratio: 1.5, index: 0.9, decay: 2.2, gain: 0.22, delay: 0.6, reverb: 0.7, pan: -0.25 },
    liquid: { kind: 'pluck', wave: 'sine', cutoff: 1800, envAmount: 1.2, decay: 0.7, gain: 0.24, delay: 0.55, reverb: 0.6, pan: 0.3, layer: 0.3 },
    glass: { kind: 'bell', ratio: 5.1, index: 0.6, decay: 3.6, gain: 0.12, reverb: 0.9, layer: 0.55 },
    lead: { kind: 'lead', wave: 'sine', cutoff: 1600, envAmount: 0.3, attack: 0.4, decay: 2.6, gain: 0.22, reverb: 0.85, delay: 0.5, glide: 0.15, layer: 0.55 },
    sub: { kind: 'sub', gain: 0.48, duck: 0.25, layer: 0.25 },
    pulse: { kind: 'tom', tone: 58, decay: 0.6, gain: 0.42, reverb: 0.6, layer: 0.35 },
    click: { kind: 'perc', gain: 0.16, pan: 0.3, layer: 0.45 },
    shaker: { kind: 'shaker', tone: 4200, gain: 0.12, pan: -0.35, layer: 0.6 },
    riser: { kind: 'riser', gain: 0.3, reverb: 0.8 },
    impact: { kind: 'impact', gain: 0.4, reverb: 0.9 },
  },
  sections: [
    {
      name: 'descent',
      kind: 'intro',
      bars: 8,
      intensity: 0.15,
      chords: ['i', 'IV', 'i', 'VII'],
      parts: {
        deep: hold({ octave: 2, voicing: 'open', vel: 0.55 }),
        drops: melody('5:8 4:8 | 3:16 | 2:8 3:8 | 1:16', { octave: 5, vel: 0.36 }),
      },
    },
    {
      name: 'reef',
      kind: 'verse',
      bars: 16,
      intensity: 0.42,
      chords: ['i', 'IV', 'III', 'VII', 'i', 'IV', 'v', 'i'],
      parts: {
        deep: hold({ octave: 2, voicing: 'open', vel: 0.5 }),
        pad: hold({ octave: 3, voicing: 'spread', vel: 0.4, every: 2 }),
        liquid: arp({ rate: 2, octave: 4, span: 2, order: 'pendulum', vel: 0.36 }),
        sub: bassline('x...............', { octave: 1 }),
        pulse: beat('x.......x.......', { vel: 0.7 }),
        click: beat('...x.....x...x..', { vel: 0.5, prob: 0.7 }),
      },
    },
    {
      name: 'current',
      kind: 'build',
      bars: 4,
      intensity: 0.62,
      chords: ['IV', 'v', 'VI', 'VII'],
      parts: {
        pad: hold({ octave: 3, voicing: 'spread', vel: 0.5 }),
        liquid: arp({ rate: 1, octave: 4, span: 2, order: 'up', vel: 0.38 }),
        pulse: beat('x...x...x...x...', { fillLastBar: 'x.x.x.x.xxxxxxxx' }),
        riser: once({ dur: 64, vel: 0.5 }),
      },
    },
    {
      name: 'bioluminescence',
      kind: 'drop',
      bars: 16,
      intensity: 0.82,
      chords: ['i', 'IV', 'III', 'VII', 'i', 'IV', 'VI', 'v'],
      parts: {
        impact: once({ dur: 4, vel: 0.55 }),
        deep: hold({ octave: 2, voicing: 'open', vel: 0.5 }),
        pad: hold({ octave: 3, voicing: 'spread', vel: 0.44 }),
        glass: hold({ octave: 5, voicing: 'close', vel: 0.3, every: 2 }),
        lead: melody('5:8 6:4 5:4 | 4:12 3:4 | 2:6 3:2 4:8 | 3:16 | 5:8 7:4 6:4 | 5:12 4:4 | 3:6 2:2 1:8 | 1:16', { octave: 4, vel: 0.5 }),
        liquid: arp({ rate: 2, octave: 4, span: 2, order: 'pendulum', vel: 0.34 }),
        sub: bassline('x.......x...x...', { octave: 1, fifths: 0.2 }),
        pulse: beat('x.......x.......'),
        click: beat('..x..x....x..x..', { vel: 0.55 }),
        shaker: beat('x.x.x.x.x.x.x.x.', { vel: 0.4, prob: 0.8 }),
      },
    },
    {
      name: 'stillness',
      kind: 'break',
      bars: 8,
      intensity: 0.22,
      chords: ['VI', 'IV', 'i', 'VII'],
      parts: {
        deep: hold({ octave: 2, voicing: 'open', vel: 0.5 }),
        drops: melody("1':8 6:8 | 5:8 4:8 | 3:8 2:4 3:4 | 1:16", { octave: 5, vel: 0.4 }),
      },
    },
  ],
  loopFrom: 1,
});
