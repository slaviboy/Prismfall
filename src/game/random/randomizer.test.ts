import { describe, expect, it } from 'vitest';
import { PIECE_TYPES } from '../pieces/pieces';
import { PieceQueue } from './randomizer';
import { Rng, hashString } from './rng';

describe('Rng', () => {
  it('is deterministic for a seed and varies across seeds', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const c = new Rng(43);
    const sa = Array.from({ length: 20 }, () => a.nextUint32());
    expect(Array.from({ length: 20 }, () => b.nextUint32())).toEqual(sa);
    expect(Array.from({ length: 20 }, () => c.nextUint32())).not.toEqual(sa);
  });

  it('produces unbiased-looking integers in range', () => {
    const r = new Rng(7);
    const counts = new Array(7).fill(0);
    for (let i = 0; i < 70000; i++) counts[r.nextInt(7)]++;
    for (const n of counts) expect(Math.abs(n - 10000)).toBeLessThan(500);
  });

  it('hashes strings stably', () => {
    expect(hashString('prismfall')).toBe(hashString('prismfall'));
    expect(hashString('a')).not.toBe(hashString('b'));
  });
});

describe('7-bag randomizer', () => {
  it('deals every tetromino exactly once per bag', () => {
    const q = new PieceQueue(1234);
    for (let bag = 0; bag < 50; bag++) {
      const pieces = Array.from({ length: 7 }, () => q.next());
      expect([...pieces].sort()).toEqual([...PIECE_TYPES].sort());
    }
  });

  it('never gaps more than 12 pieces between the same tetromino', () => {
    const q = new PieceQueue(99);
    const last = new Map<string, number>();
    for (let i = 0; i < 7000; i++) {
      const p = q.next();
      const prev = last.get(p);
      if (prev !== undefined) expect(i - prev).toBeLessThanOrEqual(13);
      last.set(p, i);
    }
  });

  it('peek matches the following draws and the sequence is reproducible', () => {
    const a = new PieceQueue(5);
    const b = new PieceQueue(5);
    const peeked = a.peek(6);
    expect(Array.from({ length: 6 }, () => a.next())).toEqual(peeked);
    expect(Array.from({ length: 6 }, () => b.next())).toEqual(peeked);
  });

  it('drill mode only deals the chosen tetrominoes', () => {
    const q = new PieceQueue(3, { kind: 'drill', pieces: ['T', 'I'] });
    for (let i = 0; i < 100; i++) expect(['T', 'I']).toContain(q.next());
  });
});
