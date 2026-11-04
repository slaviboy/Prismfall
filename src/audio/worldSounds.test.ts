import { describe, expect, it } from 'vitest';
import { MATERIAL_JOBS } from './sound-effects/materialJobs';
import { busOf, SFX_IDS } from './sound-effects/SfxBank';
import { WORLD_SOUND_SPECS, WORLD_SOUNDS, WORLD_SOUNDS_PER_SECOND, WorldSoundBudget, type WorldSoundId } from './worldSounds';

/** How many of `id` the budget lets through when requested `count` times at `now`. */
function burst(b: WorldSoundBudget, id: WorldSoundId, count: number, now: number): number {
  let n = 0;
  for (let i = 0; i < count; i++) if (b.take(id, now)) n++;
  return n;
}

describe('world sounds', () => {
  it('every world sound is a rendered effect on the stage-effects bus', () => {
    for (const id of WORLD_SOUNDS) {
      expect(SFX_IDS).toContain(id);
      expect(MATERIAL_JOBS[id], id).toBeDefined();
      expect(busOf(id), id).toBe('stage');
      expect(WORLD_SOUND_SPECS[id].perSecond, id).toBeGreaterThan(0);
    }
  });

  it('footsteps keep their budget: a burst of 6, then 6 per second', () => {
    const b = new WorldSoundBudget();
    expect(burst(b, 'footstep', 20, 1000)).toBe(6);
    expect(burst(b, 'footstep', 20, 1500)).toBe(3);
    expect(burst(b, 'footstep', 20, 2500)).toBe(6);
  });

  it('each sound has its own limit, so a chatty one cannot starve another', () => {
    const b = new WorldSoundBudget();
    expect(burst(b, 'skitter', 20, 0)).toBe(WORLD_SOUND_SPECS.skitter.perSecond);
    expect(burst(b, 'crawl', 20, 0)).toBe(WORLD_SOUND_SPECS.crawl.perSecond);
    expect(burst(b, 'skitter', 20, 1200 / WORLD_SOUND_SPECS.skitter.perSecond)).toBe(1);
  });

  it('all world sounds together share a limit', () => {
    const b = new WorldSoundBudget();
    const total = (['footstep', 'crawl', 'skitter', 'silk', 'webHum'] as const).reduce((n, id) => n + burst(b, id, 20, 0), 0);
    expect(total).toBe(WORLD_SOUNDS_PER_SECOND);
    expect(b.take('webHum', 0)).toBe(false);
    // The shared bucket refills at its own rate.
    expect(burst(b, 'webHum', 20, 100)).toBe(1);
  });
});
