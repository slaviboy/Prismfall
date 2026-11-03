import { describe, expect, it } from 'vitest';
import { TrackRotation } from './trackRotation';

describe('TrackRotation (world music takes turns)', () => {
  it('starts on the default track, then plays each next track and wraps around', () => {
    const r = new TrackRotation();
    const tracks = ['a', 'b', 'c'];
    expect([1, 2, 3, 4, 5].map(() => r.next('ice', tracks, 'a'))).toEqual(['a', 'b', 'c', 'a', 'b']);
  });

  it('starts on a default that is not first, continuing in manifest order', () => {
    const r = new TrackRotation();
    expect([1, 2, 3].map(() => r.next('space', ['orbit', 'leviathan', 'pulsar'], 'leviathan'))).toEqual(['leviathan', 'pulsar', 'orbit']);
  });

  it('keeps a separate turn for every world', () => {
    const r = new TrackRotation();
    expect(r.next('ice', ['a', 'b'], 'a')).toBe('a');
    expect(r.next('sand', ['x', 'y', 'z'], 'x')).toBe('x');
    expect(r.next('ice', ['a', 'b'], 'a')).toBe('b');
    expect(r.next('sand', ['x', 'y', 'z'], 'x')).toBe('y');
    expect(r.current('ice')).toBe('b');
    expect(r.current('garden')).toBeUndefined();
  });

  it('falls back to the first track without a valid default, and copes with a changed track list', () => {
    const r = new TrackRotation();
    expect(r.next('w', ['a', 'b'], 'missing')).toBe('a');
    expect(r.next('w', ['a', 'b'])).toBe('b');
    // The remembered track is gone: start again from the default.
    expect(r.next('w', ['c', 'd'], 'd')).toBe('d');
    expect(r.next('w', [], 'd')).toBeUndefined();
  });

  it('a world with one track always plays it; reset returns every world to its default', () => {
    const r = new TrackRotation();
    expect([1, 2, 3].map(() => r.next('solo', ['only'], 'only'))).toEqual(['only', 'only', 'only']);
    r.next('ice', ['a', 'b'], 'a');
    r.reset();
    expect(r.next('ice', ['a', 'b'], 'a')).toBe('a');
  });
});
