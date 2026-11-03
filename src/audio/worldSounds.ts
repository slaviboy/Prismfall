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

/**
 * Continuous weather from a world (SDK 1.5): how hard it rains and blows. A component keeps it alive
 * by sending it every frame or so; the rain and wind beds fade out by themselves soon after it stops.
 */
export interface WeatherSound {
  /** Rain intensity: 0 dry, 1 heavy rain, up to about 1.5 in a cloudburst. */
  readonly rain: number;
  /** Wind strength 0..1.2. */
  readonly wind: number;
  /** Current gust 0..1, on top of the wind. */
  readonly gust?: number;
  /** What the rain falls on near the listener (relative mix, 0..1 each): puddles, rock, wood, grass and heather. */
  readonly surfaces?: { readonly water?: number; readonly rock?: number; readonly wood?: number; readonly foliage?: number };
}

/**
 * A storm sound at a moment on the audio clock (SDK 1.5): the thunder of a strike after its delay,
 * or the crack of a nearby strike now. `distance` is the apparent distance in metres (drives the
 * clap, the filtering, the roll and the mix between the near and distant thunder buses), `energy`
 * 0..1 its strength, `delay` seconds from now. Everything is synthesised for this one event.
 */
export interface StormSound {
  readonly kind: 'thunder' | 'crack';
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly distance: number;
  readonly energy: number;
  readonly delay?: number;
  readonly seed?: number;
  /** Return stroke offsets (s) after the first, for thunder. */
  readonly strokes?: readonly number[];
  /** A channel to the ground or one inside and between clouds (a longer, softer roll). */
  readonly channel?: 'ground' | 'cloud';
  /** An id the world uses for its own records (debug logs pair strikes with their thunder). */
  readonly tag?: number;
}

const weatherListeners = new Set<(w: WeatherSound) => void>();

export function emitWeather(state: WeatherSound): void {
  weatherListeners.forEach((l) => l(state));
}

export function onWeather(l: (w: WeatherSound) => void): () => void {
  weatherListeners.add(l);
  return () => weatherListeners.delete(l);
}

const stormListeners = new Set<(s: StormSound) => void>();

export function emitStormSound(sound: StormSound): void {
  stormListeners.forEach((l) => l(sound));
}

export function onStormSound(l: (s: StormSound) => void): () => void {
  stormListeners.add(l);
  return () => stormListeners.delete(l);
}
