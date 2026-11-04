/**
 * Triggers and actions of event call-ins (manifest `events`), shared by the manifest schema and the
 * runtime dispatcher (src/rendering/environments/callins.ts). Pure TypeScript.
 */
export const CALL_ACTIONS = ['pass', 'clip', 'burst', 'show', 'hide', 'reveal'] as const;
export type CallAction = (typeof CALL_ACTIONS)[number];
export type Quantize = 'none' | 'beat' | 'bar' | 'phrase';

/** A parsed `on` trigger. */
export type CallTrigger =
  | { readonly kind: 'clear'; readonly min: number }
  | { readonly kind: 'combo'; readonly min: number }
  | { readonly kind: 'b2b' }
  | { readonly kind: 'perfect' }
  | { readonly kind: 'spin' }
  | { readonly kind: 'levelUp' }
  | { readonly kind: 'danger' }
  | { readonly kind: 'section'; readonly section: string }
  | { readonly kind: 'progress'; readonly min: number }
  | { readonly kind: 'heat'; readonly min: number };

/**
 * Parses a trigger: `clear>=N` (lines, a perfect clear counts as 4), `combo>=N`, `b2b`, `perfect`,
 * `spin`, `levelUp`, `danger` (the stack enters the danger zone), `section:<kind or name>` (the
 * music enters that section), `progress>=x` and `heat>=x` (crossing upwards, 0..1). Null if invalid.
 */
export function parseTrigger(on: string): CallTrigger | null {
  const s = on.trim();
  const cmp = /^(clear|combo|progress|heat)\s*>=\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (cmp) {
    const kind = cmp[1] as 'clear' | 'combo' | 'progress' | 'heat';
    const min = Number(cmp[2]);
    if ((kind === 'progress' || kind === 'heat') && min > 1) return null;
    return { kind, min };
  }
  const sec = /^section:([A-Za-z0-9_-]+)$/.exec(s);
  if (sec) return { kind: 'section', section: sec[1] as string };
  if (s === 'b2b' || s === 'perfect' || s === 'spin' || s === 'levelUp' || s === 'danger') return { kind: s };
  return null;
}

