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
