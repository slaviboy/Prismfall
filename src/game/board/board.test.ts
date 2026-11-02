import { describe, expect, it } from 'vitest';
import { Board } from './board';

describe('Board', () => {
  it('treats walls and floor as blocked, the space above the buffer as free', () => {
    const b = new Board(10, 20, 20);
    expect(b.isBlocked(-1, 0)).toBe(true);
    expect(b.isBlocked(10, 5)).toBe(true);
    expect(b.isBlocked(3, -1)).toBe(true);
    expect(b.isBlocked(3, 40)).toBe(false);
    expect(b.isBlocked(3, 0)).toBe(false);
  });

  it('detects piece collisions against cells and boundaries', () => {
    const b = new Board(10, 20, 20);
    expect(b.collides('I', 0, 0, 0)).toBe(false);
    expect(b.collides('I', 0, 7, 0)).toBe(true); // cells x 7..10
    expect(b.collides('O', 0, 0, -1)).toBe(true);
    b.set(5, 2, 8);
    expect(b.collides('O', 0, 4, 1)).toBe(true);
    expect(b.collides('O', 0, 6, 1)).toBe(false);
  });

  it('clears non-contiguous full rows and collapses the stack', () => {
    const b = new Board(4, 6, 2);
    b.loadRows(['.X..', 'XXXX', 'X.X.', 'XXXX']);
    expect(b.fullRows()).toEqual([0, 2]);
    b.clearRows([0, 2]);
    expect(b.get(0, 0)).toBe(8);
    expect(b.get(1, 0)).toBe(0);
    expect(b.get(2, 0)).toBe(8);
    expect(b.get(1, 1)).toBe(8);
    expect(b.stackHeight()).toBe(2);
    expect(b.filledCount()).toBe(3);
  });

  it('bumps version on mutation', () => {
    const b = new Board(10, 20, 20);
    const v = b.version;
    b.place('T', 0, 0, 0, 3);
    expect(b.version).toBeGreaterThan(v);
  });
});
