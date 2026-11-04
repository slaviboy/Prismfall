import type { SfxId } from './sound-effects/SfxBank';

/**
 * World sounds requested by environment components (creature footfalls and the like). Components
 * never touch audio nodes: they emit a named sound at a world position and the audio system decides
 * whether and how to play it (spatial panning, budget, volume).
 *
 * - `footstep`: a creature's footfall, rendered from the world's block material.
 * - `skitter`: a small spider's dash, a quick patter of tiny claw ticks on stone.
 * - `crawl`: one step of a large spider, a few legs landing with a low thud of weight.
 * - `silk`: a silk thread stretching or creaking, soft and airy.
 * - `webHum`: a web vibrating, a soft plucked-string shimmer in the music's key.
 */
export const WORLD_SOUNDS = ['footstep', 'skitter', 'crawl', 'silk', 'webHum'] as const satisfies readonly SfxId[];
export type WorldSoundId = (typeof WORLD_SOUNDS)[number];

/** How the audio system plays each world sound. */
export interface WorldSoundSpec {
  /** Most plays per second (token bucket: also the burst size). */
  readonly perSecond: number;
  /** Distance (world units) within which it plays at full level: small sounds carry less far. */
  readonly refDistance: number;
  /** The gain also picks how heavy the contacts sound (the variants run light to heavy). */
  readonly weighted?: boolean;
  /** Tonal: transposed into the music's key. */
  readonly keyed?: boolean;
}

export const WORLD_SOUND_SPECS: Readonly<Record<WorldSoundId, WorldSoundSpec>> = {
  footstep: { perSecond: 6, refDistance: 30 },
  skitter: { perSecond: 3, refDistance: 16, weighted: true },
  crawl: { perSecond: 4, refDistance: 30, weighted: true },
  silk: { perSecond: 2, refDistance: 16 },
  webHum: { perSecond: 2, refDistance: 24, keyed: true },
};

/** All world sounds together: plays per second (and burst), and voices sounding at once. */
export const WORLD_SOUNDS_PER_SECOND = 10;
export const MAX_WORLD_VOICES = 12;

/**
 * Rate limits for world sounds: a token bucket per sound plus one shared by all of them, so a
 * chatty sound cannot starve the others or flood the mix. Pure (times in milliseconds).
 */
export class WorldSoundBudget {
  private readonly tokens = new Map<WorldSoundId, number>();
  private shared = WORLD_SOUNDS_PER_SECOND;
  private stamp: number | null = null;

  /** True, spending a token, when `id` may play at `now` (ms). */
  take(id: WorldSoundId, now: number): boolean {
    const dt = this.stamp === null ? 0 : Math.max(0, now - this.stamp) / 1000;
    this.stamp = now;
    for (const [k, v] of this.tokens) {
      const rate = WORLD_SOUND_SPECS[k].perSecond;
      this.tokens.set(k, Math.min(rate, v + dt * rate));
    }
    this.shared = Math.min(WORLD_SOUNDS_PER_SECOND, this.shared + dt * WORLD_SOUNDS_PER_SECOND);
    const own = this.tokens.get(id) ?? WORLD_SOUND_SPECS[id].perSecond;
    if (own < 1 || this.shared < 1) {
      this.tokens.set(id, own);
      return false;
    }
    this.tokens.set(id, own - 1);
    this.shared--;
    return true;
  }
}

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
