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

/**
 * A sustained world voice (a hum, a drone) that a component keeps alive by setting it every frame
 * or so; it fades out on its own shortly after it stops being set (world hidden, game paused).
 * `hz` is its pitch, `brightness` (0..1) opens its tone, `level` (0..1) its loudness, `pan` -1..1.
 */
export interface WorldDrone {
  readonly id: string;
  readonly level: number;
  readonly hz: number;
  readonly brightness: number;
  readonly pan: number;
}

const droneListeners = new Set<(d: WorldDrone) => void>();

export function setWorldDrone(id: string, level: number, hz: number, brightness = 0.5, pan = 0): void {
  if (droneListeners.size === 0) return;
  const d = { id, level, hz, brightness, pan };
  droneListeners.forEach((l) => l(d));
}

export function onWorldDrone(l: (d: WorldDrone) => void): () => void {
  droneListeners.add(l);
  return () => droneListeners.delete(l);
}
