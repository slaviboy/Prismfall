/**
 * Visual sound cues (accessibility): the audio side announces sounds that carry information so
 * the HUD can show them. Emitting is a no-op unless the HUD's cue display is subscribed.
 */
export type SoundCue =
  | { readonly kind: 'beat'; readonly downbeat: boolean }
  | { readonly kind: 'heartbeat' }
  | { readonly kind: 'caption'; readonly text: string; readonly tone: 'info' | 'warn' | 'music' };

const listeners = new Set<(cue: SoundCue) => void>();

export function emitCue(cue: SoundCue): void {
  for (const l of listeners) l(cue);
}

export function onCue(listener: (cue: SoundCue) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function hasCueListeners(): boolean {
  return listeners.size > 0;
}
