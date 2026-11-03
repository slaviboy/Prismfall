/**
 * World music in free play: a world's tracks take turns, one game at a time. The first game in a
 * world plays its default track; each later game plays the next track in manifest order, wrapping
 * around. Kept in memory only (keyed by stage id), so every session starts on the default track.
 */
export class TrackRotation {
  private readonly last = new Map<string, string>();

  /** Picks the track for a new game in `stageId` and remembers it. Undefined when the world has no tracks. */
  next(stageId: string, trackIds: readonly string[], defaultId?: string): string | undefined {
    if (trackIds.length === 0) return undefined;
    const prev = this.last.get(stageId);
    const at = prev === undefined ? -1 : trackIds.indexOf(prev);
    const first = defaultId !== undefined && trackIds.includes(defaultId) ? defaultId : (trackIds[0] as string);
    const pick = at < 0 ? first : (trackIds[(at + 1) % trackIds.length] as string);
    this.last.set(stageId, pick);
    return pick;
  }

  /** The track the last game in `stageId` played (undefined before the first). */
  current(stageId: string): string | undefined {
    return this.last.get(stageId);
  }

  reset(): void {
    this.last.clear();
  }
}
