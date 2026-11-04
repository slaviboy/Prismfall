import { describe, expect, it } from 'vitest';
import type { StageEnvironment } from '../rendering/environments/StageEnvironment';
import type { RenderSystem } from '../rendering/renderer/RenderSystem';
import { StageManager } from './StageManager';

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

function manager() {
  const activated: string[] = [];
  const render = {
    environments: { activate: (env: { id: string }) => activated.push(env.id), preparedIds: [] as string[] },
    feedback: {},
    setBlockDesign: () => undefined,
  } as unknown as RenderSystem;
  const sm = new StageManager(render);
  const loads = new Map<string, ReturnType<typeof deferred<StageEnvironment>>>();
  sm.prepare = (id: string) => {
    const d = deferred<StageEnvironment>();
    loads.set(id, d);
    return d.promise;
  };
  const finish = (id: string) => loads.get(id)!.resolve({ id } as unknown as StageEnvironment);
  return { sm, activated, finish };
}

describe('stage manager requests', () => {
  it('a game start supersedes the menu preview still loading (the started world stays)', async () => {
    const { sm, activated, finish } = manager();
    sm.preview('luminous-tide', 0);
    await flush();
    const started = sm.show('folded-sky');
    finish('folded-sky');
    expect(await started).toBe(true);
    // The slower preview finishes afterwards: it must not take the screen back.
    finish('luminous-tide');
    await flush();
    expect(activated).toEqual(['folded-sky']);
    expect(sm.activeId).toBe('folded-sky');
  });

  it('a preview waiting on its timer is cancelled by a direct show', async () => {
    const { sm, activated, finish } = manager();
    sm.preview('luminous-tide', 20);
    const started = sm.show('the-web');
    finish('the-web');
    expect(await started).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(activated).toEqual(['the-web']);
  });

  it('a newer request still wins over an older one that loads last', async () => {
    const { sm, activated, finish } = manager();
    const first = sm.show('the-web');
    const second = sm.show('folded-sky');
    finish('folded-sky');
    expect(await second).toBe(true);
    finish('the-web');
    expect(await first).toBe(false);
    expect(activated).toEqual(['folded-sky']);
  });
});
