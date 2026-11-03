import type { CustomLevel, Settings } from '../settings/schema';

/**
 * The player's level chosen for free play, or null. A level stays active only while its world is
 * the selected world, so choosing another world in the world list simply leaves the level.
 */
export function activeLevel(settings: Settings): CustomLevel | null {
  const { levelId, stageId } = settings.setup;
  if (!levelId) return null;
  return settings.creator.levels.find((l) => l.id === levelId && l.stageId === stageId) ?? null;
}

/** The block design a level asks for, or null for the world's own blocks. */
export function levelBlocks(level: CustomLevel | null): string | null {
  return level && level.blocks !== 'stage' ? level.blocks : null;
}

/** The music a level asks for (a catalogue id), or null for the usual music choice. */
export function levelMusic(level: CustomLevel | null): string | null {
  return level && level.music !== 'stage' ? level.music : null;
}
