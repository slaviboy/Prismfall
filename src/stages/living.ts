/**
 * A world's living profile (content/stages/<id>/living.json, since SDK 1.7): how the world lives
 * with the music and over time, kept beside the manifest that says what the world is.
 *
 * - `music`: the world's own reaction profile (EnvironmentReactionProfile in brief §40.8): which
 *   drive of the Environment Music Director moves which layer target, how much and how fast.
 * - `classes`: which Background intensity knob scales a layer or a target, where the defaults
 *   (by component type and target name) do not fit.
 * - `events`: ambient timers and music cues that call layers to act (same fields as manifest events).
 *
 * See CONTENT_GUIDE.md §6.5 and MUSIC_REACTIVE_ENVIRONMENTS.md. Pure data and zod.
 */
import { z } from 'zod';
import { MUSIC_DRIVES } from './music';
import { callInSchema, type Binding, type StageManifest } from './schema';

export const LIVING_SCHEMA_VERSION = 1;

/** Which Background intensity knob a target follows (`none`: left alone). */
export const TARGET_CLASSES = ['motion', 'light', 'particles', 'atmosphere', 'creatures', 'events', 'none'] as const;
export type TargetClass = (typeof TARGET_CLASSES)[number];

/** The artistic role of a reaction: the scale of thing it moves (documentation, developer dashboard). */
export const REACTION_ROLES = ['large', 'mid', 'fine', 'beat', 'section'] as const;
export type ReactionRole = (typeof REACTION_ROLES)[number];

export const reactionSchema = z.object({
  /** Layer id, `type:<componentType>` or `*`. */
  layer: z.string(),
  /** A reactive target the layer's component exposes. */
  target: z.string(),
  drive: z.enum(MUSIC_DRIVES),
  amount: z.number().default(0.4),
  mode: z.enum(['mul', 'add']).default('mul'),
  curve: z.enum(['linear', 'smooth', 'pow2', 'sqrt']).default('linear'),
  /** Extra smoothing on top of the drive's own envelope (0 = follow the drive). */
  attackMs: z.number().min(0).default(0),
  releaseMs: z.number().min(0).default(0),
  role: z.enum(REACTION_ROLES).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** Only in these sections (kinds or the composition's own names). */
  when: z.object({ section: z.array(z.string()).min(1) }).optional(),
  note: z.string().optional(),
});
export type Reaction = z.infer<typeof reactionSchema>;

export const livingSchema = z.object({
  schemaVersion: z.literal(LIVING_SCHEMA_VERSION),
  description: z.string().default(''),
  /** Intensity class per layer id (`aurora`) or per layer target (`aurora.speed`). */
  classes: z.record(z.string(), z.enum(TARGET_CLASSES)).default({}),
  music: z.array(reactionSchema).default([]),
  events: z.array(callInSchema).default([]),
  /** Bars per phrase for the `phrase` drive and cue; default: the manifest's `phraseBars`. */
  phraseBars: z.number().int().min(1).max(16).optional(),
});
export type LivingProfile = z.infer<typeof livingSchema>;

export const EMPTY_LIVING: LivingProfile = livingSchema.parse({ schemaVersion: LIVING_SCHEMA_VERSION });

/**
 * A reaction as a reactivity binding on `music.<drive>`. The category (which Reactivity response
 * slider also scales it) follows the target's intensity class.
 */
export function reactionBinding(r: Reaction, cls: TargetClass): Binding {
  return {
    layer: r.layer,
    target: r.target,
    feature: `music.${r.drive}`,
    amount: r.amount,
    mode: r.mode,
    curve: r.curve,
    attackMs: r.attackMs,
    releaseMs: r.releaseMs,
    category: cls === 'light' ? 'lighting' : cls === 'particles' ? 'particles' : 'environment',
    min: r.min,
    max: r.max,
    when: r.when,
  };
}

/** Layer ids a selector may name: `*` and `type:` selectors always pass. */
function selects(manifest: StageManifest, layer: string): boolean {
  if (layer === '*' || layer.startsWith('type:')) return true;
  return manifest.environment.layers.some((l) => l.id === layer);
}

/** Parses and checks a living profile against its manifest. */
export function validateLiving(raw: unknown, manifest: StageManifest): { profile: LivingProfile; errors: string[] } {
  if (raw === undefined) return { profile: EMPTY_LIVING, errors: [] };
  const parsed = livingSchema.safeParse(raw);
  if (!parsed.success) return { profile: EMPTY_LIVING, errors: parsed.error.issues.map((i) => `living.json ${i.path.join('.') || '(root)'}: ${i.message}`) };
  const p = parsed.data;
  const errors: string[] = [];
  for (const r of p.music) if (!selects(manifest, r.layer)) errors.push(`living.json music: no layer with id "${r.layer}"`);
  for (const e of p.events) if (!selects(manifest, e.layer)) errors.push(`living.json event "${e.on}": no layer with id "${e.layer}"`);
  for (const key of Object.keys(p.classes)) {
    const id = key.split('.')[0] as string;
    if (!manifest.environment.layers.some((l) => l.id === id)) errors.push(`living.json classes: no layer with id "${id}"`);
  }
  return { profile: p, errors };
}
