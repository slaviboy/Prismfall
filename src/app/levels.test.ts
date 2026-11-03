import { describe, expect, it } from 'vitest';
import { defaultSettings, migrateSettings } from '../settings/schema';
import { activeLevel, levelBlocks, levelMusic } from './levels';

const level = { id: 'lvl-1', name: 'Night swim', stageId: 'the-abyss', music: 'stage:frozen-kingdom:frozen-kingdom-hoarfrost-waltz', blocks: 'marble', created: 1 };

function settingsWith(setup: { levelId: string; stageId: string }) {
  const s = defaultSettings();
  return { ...s, setup: { ...s.setup, ...setup }, creator: { levels: [level] } };
}

describe('player levels', () => {
  it('is active only while its world is the selected world', () => {
    expect(activeLevel(settingsWith({ levelId: 'lvl-1', stageId: 'the-abyss' }))).toEqual(level);
    expect(activeLevel(settingsWith({ levelId: 'lvl-1', stageId: 'luminous-tide' }))).toBeNull();
    expect(activeLevel(settingsWith({ levelId: '', stageId: 'the-abyss' }))).toBeNull();
    expect(activeLevel(settingsWith({ levelId: 'gone', stageId: 'the-abyss' }))).toBeNull();
  });

  it("falls back to the world's own music and blocks", () => {
    expect(levelBlocks(level)).toBe('marble');
    expect(levelMusic(level)).toBe(level.music);
    expect(levelBlocks({ ...level, blocks: 'stage' })).toBeNull();
    expect(levelMusic({ ...level, music: 'stage' })).toBeNull();
    expect(levelBlocks(null)).toBeNull();
  });

  it('survives corrupt saved levels', () => {
    const parsed = migrateSettings({ creator: { levels: [level, { name: 5 }, 'junk', { id: 'x', stageId: 'ember-core', blocks: 7 }] } }).settings;
    expect(parsed.creator.levels.map((l) => l.id)).toEqual(['lvl-1', 'x']);
    expect(parsed.creator.levels[1]?.blocks).toBe('stage');
    expect(migrateSettings({ creator: 'nonsense' }).settings.creator.levels).toEqual([]);
  });
});
