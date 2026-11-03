import { describe, expect, it } from 'vitest';
import { FileTrackPlayer, type FileTrackMeta } from './tracks';

/** Just enough of an AudioContext for FileTrackPlayer's clock (no audio is produced). */
function fakeContext(): BaseAudioContext {
  const param = { value: 0, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} };
  const node = { gain: param, connect: () => node, disconnect() {} };
  const source = { buffer: null, loop: false, loopStart: 0, loopEnd: 0, connect: () => source, start() {}, stop() {} };
  return { createGain: () => node, createBufferSource: () => ({ ...source }) } as unknown as BaseAudioContext;
}

const buffer = (seconds: number): AudioBuffer => ({ duration: seconds }) as AudioBuffer;
const destination = {} as AudioNode;

describe('FileTrackPlayer beat clock', () => {
  const bpm = 120; // 0.5 s per beat, 2 s per bar
  it('counts beats from the first downbeat', () => {
    const p = new FileTrackPlayer(fakeContext(), buffer(20), { title: 't', bpm, offset: 0.25 }, destination, 'x');
    p.start(10);
    expect(p.beatAt(10)).toBe(0);
    expect(p.beatAt(11.5)).toBeCloseTo(3);
    expect(p.audioTimeOfBeat(4)).toBeCloseTo(12);
  });

  it('wraps on the loop region from metadata', () => {
    const meta: FileTrackMeta = { title: 't', bpm, offset: 0.25, loop: { startBar: 1, endBar: 3 } };
    const p = new FileTrackPlayer(fakeContext(), buffer(20), meta, destination, 'x');
    p.start(0);
    // Loop = bars 1..3 = 2..6 s after the downbeat; 7 s is 1 s into the second pass → beat 6.
    expect(p.beatAt(5.9)).toBeCloseTo(11.8);
    expect(p.beatAt(7)).toBeCloseTo(6);
  });

  it('without loop metadata loops the music after the lead-in, not the whole file', () => {
    // 10.25 s file with a 0.25 s lead-in: the musical loop is 10 s (20 beats).
    const p = new FileTrackPlayer(fakeContext(), buffer(10.25), { title: 't', bpm, offset: 0.25 }, destination, 'x');
    p.start(0);
    expect(p.beatAt(9.5)).toBeCloseTo(19);
    expect(p.beatAt(11)).toBeCloseTo(2);
  });
});

describe('FileTrackPlayer stems', () => {
  /** Records every source start and gain target so sync and layering can be checked. */
  function recordingContext(): { ctx: BaseAudioContext; starts: { at: number; offset: number }[]; targets: number[] } {
    const starts: { at: number; offset: number }[] = [];
    const targets: number[] = [];
    const makeParam = () => ({ value: 0, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime(v: number) { targets.push(v); } });
    const ctx = {
      currentTime: 0,
      createGain: () => {
        const g = { gain: makeParam(), connect: () => g, disconnect() {} };
        return g;
      },
      createBufferSource: () => {
        const s = { buffer: null, loop: false, loopStart: 0, loopEnd: 0, connect: () => s, start: (at: number, offset: number) => starts.push({ at, offset }), stop() {} };
        return s;
      },
    } as unknown as BaseAudioContext;
    return { ctx, starts, targets };
  }

  it('starts every stem on the same instant and file position as the main mix', () => {
    const { ctx, starts } = recordingContext();
    const stems = [0.3, 0.6, 0.85].map((layer) => ({ buffer: buffer(20), layer, gain: 1 }));
    const p = new FileTrackPlayer(ctx, buffer(20), { title: 't', bpm: 120, offset: 0.4 }, destination, 'x', stems);
    p.start(3);
    expect(starts).toHaveLength(4);
    for (const s of starts) expect(s).toEqual({ at: 3, offset: 0.4 });
    p.pause(5);
    p.resume(6);
    const resumed = starts.slice(4);
    expect(resumed).toHaveLength(4);
    expect(new Set(resumed.map((s) => `${s.at}:${s.offset}`)).size).toBe(1);
  });

  it('fades stems in by intensity threshold', async () => {
    const { stemLevel } = await import('./tracks');
    expect(stemLevel(0.6, 0.3)).toBe(0);
    expect(stemLevel(0.6, 0.6)).toBeCloseTo(0.5);
    expect(stemLevel(0.6, 0.8)).toBe(1);
    const { ctx, targets } = recordingContext();
    const p = new FileTrackPlayer(ctx, buffer(20), { title: 't', bpm: 120 }, destination, 'x', [{ buffer: buffer(20), layer: 0.7, gain: 0.8 }]);
    p.setIntensity(0.2);
    p.setIntensity(0.95);
    expect(targets[0]).toBe(0);
    expect(targets[1]).toBeCloseTo(0.8);
  });
});
