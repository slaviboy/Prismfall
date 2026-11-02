import { describe, expect, it } from 'vitest';
import { PIECE_TYPES, kickTests, pieceCells, spawnBoxBottom, spawnColumn, type Rotation } from './pieces';

const key = (cells: readonly { x: number; y: number }[]): string =>
  cells.map((c) => `${c.x},${c.y}`).sort().join(' ');

describe('tetromino definitions', () => {
  it('has exactly the seven tetrominoes with four cells in every rotation', () => {
    expect([...PIECE_TYPES].sort()).toEqual(['I', 'J', 'L', 'O', 'S', 'T', 'Z']);
    for (const t of PIECE_TYPES) for (const r of [0, 1, 2, 3] as Rotation[]) expect(pieceCells(t, r)).toHaveLength(4);
  });

  it('matches the SRS rotation states for T (y-up box coordinates)', () => {
    expect(key(pieceCells('T', 0))).toBe(key([{ x: 1, y: 2 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }]));
    expect(key(pieceCells('T', 1))).toBe(key([{ x: 1, y: 2 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 0 }]));
    expect(key(pieceCells('T', 2))).toBe(key([{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 0 }]));
    expect(key(pieceCells('T', 3))).toBe(key([{ x: 1, y: 2 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }]));
  });

  it('matches the SRS rotation states for I', () => {
    expect(key(pieceCells('I', 0))).toBe('0,2 1,2 2,2 3,2');
    expect(key(pieceCells('I', 1))).toBe('2,0 2,1 2,2 2,3');
    expect(key(pieceCells('I', 2))).toBe('0,1 1,1 2,1 3,1');
    expect(key(pieceCells('I', 3))).toBe('1,0 1,1 1,2 1,3');
  });

  it('keeps O identical in every rotation', () => {
    for (const r of [1, 2, 3] as Rotation[]) expect(key(pieceCells('O', r))).toBe(key(pieceCells('O', 0)));
  });

  it('matches S, Z, J, L spawn shapes', () => {
    expect(key(pieceCells('S', 0))).toBe('0,1 1,1 1,2 2,2');
    expect(key(pieceCells('Z', 0))).toBe('0,2 1,1 1,2 2,1');
    expect(key(pieceCells('J', 0))).toBe('0,1 0,2 1,1 2,1');
    expect(key(pieceCells('L', 0))).toBe('0,1 1,1 2,1 2,2');
  });

  it('provides five kick tests for 90° rotations and none for O', () => {
    for (const t of ['I', 'T', 'S', 'Z', 'J', 'L'] as const) {
      for (const [a, b] of [[0, 1], [1, 0], [1, 2], [2, 1], [2, 3], [3, 2], [3, 0], [0, 3]] as [Rotation, Rotation][]) {
        const tests = kickTests(t, a, b);
        expect(tests).toHaveLength(5);
        expect(tests[0]).toEqual([0, 0]);
      }
    }
    expect(kickTests('O', 0, 1)).toEqual([[0, 0]]);
  });

  it('uses opposite kicks for inverse rotations (SRS symmetry)', () => {
    for (const t of ['I', 'T'] as const) {
      const fwd = kickTests(t, 0, 1);
      const back = kickTests(t, 1, 0);
      fwd.forEach(([x, y], i) => expect(back[i]).toEqual([-x === 0 ? 0 : -x, -y === 0 ? 0 : -y]));
    }
  });

  it('spawns 3-wide pieces left of centre on a 10-wide board', () => {
    expect(spawnColumn('T', 10)).toBe(3);
    expect(spawnColumn('I', 10)).toBe(3);
    expect(spawnColumn('O', 10)).toBe(4);
    // Lowest cells sit on the spawn row.
    expect(spawnBoxBottom('T', 20)).toBe(19);
    expect(spawnBoxBottom('I', 20)).toBe(18);
    expect(spawnBoxBottom('O', 20)).toBe(20);
  });
});
