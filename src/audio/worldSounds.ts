/**
 * World sounds requested by environment components (creature footfalls and the like). Components
 * never touch audio nodes: they emit a named sound at a world position and the audio system decides
 * whether and how to play it (spatial panning, budget, volume).
 */
export const WORLD_SOUNDS = ['footstep'] as const;
export type WorldSoundId = (typeof WORLD_SOUNDS)[number];

export interface WorldSound {
  readonly id: WorldSoundId;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly gain: number;
}

const listeners = new Set<(s: WorldSound) => void>();

export function emitWorldSound(id: WorldSoundId, x: number, y: number, z: number, gain = 1): void {
  if (listeners.size === 0) return;
  const s = { id, x, y, z, gain };
  listeners.forEach((l) => l(s));
}

export function onWorldSound(l: (s: WorldSound) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
