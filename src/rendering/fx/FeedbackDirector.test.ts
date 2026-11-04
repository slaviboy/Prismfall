import { describe, expect, it } from 'vitest';
import { BoxGeometry } from 'three/webgpu';
import { Engine } from '../../game/core/engine';
import { buildModeRules } from '../../game/modes/modes';
import type { StageGameEvent } from '../../sdk/types';
import type { BurstSystem } from '../particles/BurstSystem';
import type { CameraRig } from '../camera/CameraRig';
import { FeedbackDirector, columnOf } from './FeedbackDirector';

const bursts = { budget: (n: number) => Math.round(n), emit: () => undefined, flush: () => undefined } as unknown as BurstSystem;
const camera = { addTrauma: () => undefined, addPush: () => undefined } as unknown as CameraRig;

describe('feedback director: piece motion for the world (SDK 1.5)', () => {
  it('works out a piece column from its cells', () => {
    expect(columnOf([{ x: 3 }, { x: 4 }, { x: 5 }, { x: 6 }])).toBe(5);
    expect(columnOf([{ x: 0 }, { x: 0 }])).toBe(0.5);
    expect(columnOf([])).toBe(5);
  });

  it('forwards spawn, move, rotate, hold, hard drop and lock with the piece column', () => {
    const engine = new Engine({ rules: buildModeRules('zen', 'still', { gravity: { kind: 'fixed', gravity: 0 } }), seed: 7 });
    engine.start();
    const fd = new FeedbackDirector(bursts, camera, new BoxGeometry());
    const seen: StageGameEvent[] = [];
    fd.onStageEvent = (e) => seen.push(e);
    const run = (act?: () => void): void => {
      act?.();
      for (let i = 0; i < 400; i++) engine.step();
      fd.handle(engine.drainEvents(), engine, engine.tick / 1000);
    };
    run();
    const spawn = seen.find((e) => e.kind === 'spawn');
    expect(spawn).toBeDefined();
    run(() => {
      engine.press('moveLeft');
      engine.release('moveLeft');
    });
    const move = seen.find((e) => e.kind === 'move');
    expect(move).toMatchObject({ kind: 'move', dx: -1 });
    run(() => {
      engine.press('rotateCW');
      engine.release('rotateCW');
    });
    expect(seen.some((e) => e.kind === 'rotate')).toBe(true);
    run(() => {
      engine.press('hold');
      engine.release('hold');
    });
    expect(seen.some((e) => e.kind === 'hold')).toBe(true);
    run(() => {
      engine.press('hardDrop');
      engine.release('hardDrop');
    });
    const drop = seen.find((e) => e.kind === 'hardDrop');
    const lock = seen.find((e) => e.kind === 'lock');
    for (const e of [spawn, move, drop, lock]) {
      const column = (e as { column?: number }).column;
      expect(column).toBeGreaterThan(0);
      expect(column).toBeLessThan(10);
    }
    fd.dispose();
  });
});
