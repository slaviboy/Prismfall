import { describe, expect, it } from 'vitest';
import { createAudioFeatures, type AudioFeatures, type BeatEvent } from '../../../audio/analysis/features';
import { ACCENT, EnvironmentMusicDirector, type DirectorInput, type MusicCue } from './musicDirector';
import { AudioFeatureNormalizer } from './normalizer';

const INPUT: DirectorInput = { active: true, flashReduction: false, reducedMotion: false, beatsPerBar: 4, phraseBars: 4 };

/** Runs the director at `hz` for `seconds`, letting `shape(t, f)` set the features each frame. */
function run(
  seconds: number,
  shape: (t: number, f: AudioFeatures) => void,
  opts: { hz?: number; input?: Partial<DirectorInput>; director?: EnvironmentMusicDirector; start?: number; bpm?: number } = {},
): { director: EnvironmentMusicDirector; cues: MusicCue[] } {
  const hz = opts.hz ?? 60;
  const director = opts.director ?? new EnvironmentMusicDirector();
  const f = createAudioFeatures();
  f.bpm = opts.bpm ?? 120;
  f.beatConfidence = 1;
  const dt = 1 / hz;
  const cues: MusicCue[] = [];
  const start = opts.start ?? 0;
  let lastBeat = Math.floor(start * (f.bpm / 60)) - 1;
  for (let i = 0; i < Math.round(seconds * hz); i++) {
    const t = start + i * dt;
    const beatPos = t * (f.bpm / 60);
    const beat = Math.floor(beatPos);
    f.beatPhase = beatPos - beat;
    f.bar = Math.floor(beat / 4);
    f.beatInBar = beat % 4;
    f.barPhase = (f.beatInBar + f.beatPhase) / 4;
    shape(t, f);
    const beats: BeatEvent[] = [];
    while (lastBeat < beat) {
      lastBeat++;
      beats.push({ beat: lastBeat, bar: Math.floor(lastBeat / 4), beatInBar: lastBeat % 4, downbeat: lastBeat % 4 === 0, time: t });
    }
    cues.push(...director.update(dt, t, f, beats, { ...INPUT, ...opts.input }));
  }
  return { director, cues };
}

describe('AudioFeatureNormalizer', () => {
  it('lets a swell stand out over steady material and returns 0 without music', () => {
    const n = new AudioFeatureNormalizer();
    let steady = 0;
    for (let i = 0; i < 600; i++) steady = n.update(0.45, 1 / 60, true);
    let swell = 0;
    for (let i = 0; i < 30; i++) swell = n.update(0.9, 1 / 60, true);
    expect(swell).toBeGreaterThan(steady + 0.25);
    expect(n.update(0.9, 1 / 60, false)).toBe(0);
  });
});

describe('EnvironmentMusicDirector', () => {
  it('rests without music: drives fall to zero and the world reads calm', () => {
    const { director } = run(6, (_, f) => {
      f.bass = 0.9;
      f.treble = 0.9;
      f.overallEnergy = 0.8;
    }, { input: { active: false } });
    const d = director.drive;
    expect(d.body).toBeLessThan(0.01);
    expect(d.detail).toBeLessThan(0.01);
    expect(d.intensity).toBeLessThan(0.05);
    expect(d.calm).toBeGreaterThan(0.95);
    expect(d.active).toBe(false);
  });

  it('separates the bands: bass drives the body, treble the detail', () => {
    const bass = run(4, (_, f) => {
      f.subBass = 0.9;
      f.bass = 0.9;
    }).director.drive;
    const treble = run(4, (_, f) => {
      f.highMid = 0.9;
      f.treble = 0.9;
    }).director.drive;
    expect(bass.body).toBeGreaterThan(0.4);
    expect(bass.detail).toBeLessThan(0.05);
    expect(treble.detail).toBeGreaterThan(0.4);
    expect(treble.body).toBeLessThan(0.05);
  });

  it('moves large things slower than fine detail', () => {
    // Quiet first, then a step in every band.
    const director = new EnvironmentMusicDirector();
    run(4, (_, f) => {
      f.bass = 0.1;
      f.subBass = 0.1;
      f.treble = 0.1;
      f.highMid = 0.1;
    }, { director });
    run(0.12, (_, f) => {
      f.bass = 0.95;
      f.subBass = 0.95;
      f.treble = 0.95;
      f.highMid = 0.95;
    }, { director, start: 4 });
    const d = director.drive;
    expect(d.detail).toBeGreaterThan(d.body * 1.5);
  });

  it('is frame-rate independent', () => {
    const shape = (t: number, f: AudioFeatures) => {
      f.bass = 0.5 + 0.4 * Math.sin(t * 1.3);
      f.mid = 0.5 + 0.3 * Math.sin(t * 2.1);
      f.treble = 0.4 + 0.3 * Math.sin(t * 3.7);
      f.overallEnergy = 0.6;
      f.sectionIntensity = 0.6;
    };
    const a = run(5, shape, { hz: 60 }).director.drive;
    const b = run(5, shape, { hz: 144 }).director.drive;
    for (const k of ['body', 'swell', 'motion', 'detail', 'energy', 'intensity'] as const) expect(Math.abs(a[k] - b[k])).toBeLessThan(0.03);
  });

  it('governs accents: never closer than the minimum gap, fewer with Reduce flashing', () => {
    // An onset every 50 ms (far denser than any accent may be).
    const onsets = (t: number, f: AudioFeatures) => {
      f.transientIntensity = Math.floor(t * 20) % 2 === 0 ? 0.95 : 0.2;
    };
    const normal = run(10, onsets).cues.filter((c) => c.kind === 'accent');
    const calm = run(10, onsets, { input: { flashReduction: true } }).cues.filter((c) => c.kind === 'accent');
    const gaps = normal.slice(1).map((c, i) => c.time - (normal[i] as MusicCue).time);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(Math.max(ACCENT.minSeconds, ACCENT.minBeats * 0.5) - 1e-6);
    expect(normal.length).toBeLessThanOrEqual(10 * ACCENT.maxPerSecond);
    expect(calm.length).toBeLessThan(normal.length);
  });

  it('pulses only on selected beats: downbeats in a calm section', () => {
    const director = new EnvironmentMusicDirector();
    const samples: number[] = [];
    const f0 = (_: number, f: AudioFeatures) => {
      f.sectionIntensity = 0.2;
      f.overallEnergy = 0.2;
      samples.push(director.drive.beat);
    };
    run(8, f0, { director });
    // Peaks of the beat drive come once per bar (2 s at 120 BPM in 4/4), not once per beat (0.5 s).
    let peaks = 0;
    for (let i = 1; i < samples.length - 1; i++) if ((samples[i] as number) > 0.9 && (samples[i - 1] as number) < 0.9) peaks++;
    expect(peaks).toBeGreaterThanOrEqual(3);
    expect(peaks).toBeLessThanOrEqual(5);
  });

  it('reads song structure: build raises tension, the drop releases it and is cued', () => {
    const director = new EnvironmentMusicDirector();
    const section = (kind: string, intensity: number) => (_: number, f: AudioFeatures) => {
      f.section = kind;
      f.sectionKind = kind;
      f.sectionIntensity = intensity;
      f.overallEnergy = intensity;
      f.bass = intensity;
    };
    run(8, section('verse', 0.4), { director });
    const build = run(10, section('build', 0.6), { director, start: 8 });
    expect(build.cues.some((c) => c.kind === 'build')).toBe(true);
    const tensionInBuild = director.drive.tension;
    expect(tensionInBuild).toBeGreaterThan(0.5);
    const drop = run(1, section('drop', 1), { director, start: 18 });
    const cue = drop.cues.find((c) => c.kind === 'drop');
    expect(cue).toBeDefined();
    expect(cue?.previous).toBe('build');
    expect(director.drive.release).toBeGreaterThan(0.8);
    expect(director.drive.tension).toBeLessThan(tensionInBuild);
    const brk = run(6, section('break', 0.2), { director, start: 19 });
    expect(brk.cues.some((c) => c.kind === 'break')).toBe(true);
    expect(director.drive.calm).toBeGreaterThan(0.5);
  });

  it('cues phrases every phraseBars bars', () => {
    const { cues } = run(16.01, () => undefined, { input: { phraseBars: 4 } });
    // 120 BPM: a bar every 2 s, a 4-bar phrase every 8 s: phrases at 0, 8 and 16 s.
    expect(cues.filter((c) => c.kind === 'phrase').length).toBe(3);
  });
});
