import { z } from 'zod';

/**
 * MaterialAudioProfile: how a world's blocks sound when they hit, land, lock and break.
 * Stages name a built-in profile or define their own in stage.json (`sfx.material`). The audio
 * engine only knows the profile, never the renderer's block material.
 */

export const SCATTER_KINDS = ['sand', 'dust', 'pebbles', 'shards', 'chimes', 'bubbles', 'crackle', 'leaves', 'sparks'] as const;
export type ScatterKind = (typeof SCATTER_KINDS)[number];

const mode = z.object({ ratio: z.number().positive(), decay: z.number().positive(), gain: z.number().min(0) });

const layers = {
  /** Overall level trim for this material (loudness matching between worlds). */
  gain: z.number().min(0).max(2).default(1),
  transient: z.object({ level: z.number().min(0).default(0.6), freq: z.number().positive().default(3000), q: z.number().positive().default(0.8), ms: z.number().positive().default(4), click: z.number().min(0).default(0.2) }).prefault({}),
  body: z
    .object({
      level: z.number().min(0).default(0.7),
      baseHz: z.number().positive().default(220),
      modes: z.array(mode).min(1).max(12).default([{ ratio: 1, decay: 0.25, gain: 1 }]),
      /** How much harder hits brighten the upper modes. */
      brightness: z.number().min(0).default(1),
      /** Pitch sag after the hit (0..0.2). */
      drop: z.number().min(0).max(0.3).default(0.03),
      noise: z.number().min(0).default(0),
      noiseCutoff: z.number().positive().default(1800),
      noiseDecay: z.number().positive().default(0.12),
    })
    .prefault({}),
  resonance: z.object({ kind: z.enum(['band', 'cavity', 'comb']).default('band'), level: z.number().min(0).default(0), freq: z.number().positive().default(400), q: z.number().positive().default(8), decay: z.number().positive().default(0.3) }).prefault({}),
  scatter: z
    .object({
      kind: z.enum(SCATTER_KINDS).default('pebbles'),
      level: z.number().min(0).default(0),
      count: z.number().int().min(0).max(400).default(0),
      lo: z.number().positive().default(1500),
      hi: z.number().positive().default(5000),
      delay: z.number().min(0).default(0.01),
      spread: z.number().min(0).default(0.25),
      width: z.number().min(0).max(1).default(0.6),
    })
    .prefault({}),
  tail: z.object({ kind: z.enum(['hiss', 'air', 'rumble', 'shimmer']).default('air'), level: z.number().min(0).default(0), freq: z.number().positive().default(2000), decay: z.number().positive().default(0.5) }).prefault({}),
  reverb: z.object({ wet: z.number().min(0).max(1).default(0.15), size: z.number().min(0.3).max(2).default(1) }).prefault({}),
  sub: z.object({ level: z.number().min(0).default(0.4), from: z.number().positive().default(110), to: z.number().positive().default(45), decay: z.number().positive().default(0.25) }).prefault({}),
};

const partialLayers = z.object(layers).partial();

export const materialAudioSchema = z.object({
  ...layers,
  /** Extra stage response layered on four-line clears (overrides of the layers above). */
  signature: partialLayers.optional(),
  /** Environmental answer to a hard drop, played on the stage-effects bus (overrides). */
  response: partialLayers.optional(),
});

export type MaterialAudioProfile = z.infer<typeof materialAudioSchema>;
export type MaterialAudioInput = z.input<typeof materialAudioSchema>;

const m = (input: MaterialAudioInput): MaterialAudioProfile => materialAudioSchema.parse(input);

/** Built-in profiles. Frequencies and decays follow the character the brief describes per world. */
export const MATERIAL_PROFILES: Record<string, MaterialAudioProfile> = {
  glass: m({
    transient: { level: 0.5, freq: 4200, ms: 3 },
    body: { level: 0.6, baseHz: 520, modes: [{ ratio: 1, decay: 0.35, gain: 1 }, { ratio: 2.32, decay: 0.25, gain: 0.5 }, { ratio: 4.25, decay: 0.15, gain: 0.3 }], drop: 0.01 },
    scatter: { kind: 'shards', level: 0.25, count: 10, lo: 3500, hi: 8000, spread: 0.18 },
    tail: { kind: 'shimmer', level: 0.08, freq: 6000, decay: 0.5 },
    sub: { level: 0.35, from: 120, to: 50, decay: 0.2 },
  }),
  pearl: m({
    transient: { level: 0.4, freq: 3000, ms: 4 },
    body: { level: 0.65, baseHz: 330, modes: [{ ratio: 1, decay: 0.45, gain: 1 }, { ratio: 2.01, decay: 0.3, gain: 0.4 }, { ratio: 3.9, decay: 0.2, gain: 0.2 }], drop: 0.015 },
    scatter: { kind: 'bubbles', level: 0.2, count: 6, lo: 500, hi: 1400, spread: 0.3 },
    tail: { kind: 'air', level: 0.1, freq: 1200, decay: 0.7 },
    reverb: { wet: 0.25, size: 1.2 },
  }),
  metal: m({
    transient: { level: 0.7, freq: 3500, ms: 3, click: 0.4 },
    body: { level: 0.7, baseHz: 180, modes: [{ ratio: 1, decay: 0.6, gain: 1 }, { ratio: 2.76, decay: 0.45, gain: 0.6 }, { ratio: 5.4, decay: 0.3, gain: 0.4 }, { ratio: 8.93, decay: 0.2, gain: 0.25 }], drop: 0.005 },
    resonance: { kind: 'comb', level: 0.25, freq: 310, decay: 0.5 },
    scatter: { kind: 'sparks', level: 0.2, count: 14, lo: 2500, hi: 6000, spread: 0.2 },
    sub: { level: 0.5, from: 100, to: 40, decay: 0.3 },
  }),
  // DESERT: heavy sandstone contact, deep dry stone body, granular sand scattering, short sandy tail.
  sandstone: m({
    gain: 1,
    transient: { level: 0.7, freq: 1800, q: 0.7, ms: 5, click: 0.25 },
    body: { level: 0.75, baseHz: 92, modes: [{ ratio: 1, decay: 0.16, gain: 1 }, { ratio: 1.58, decay: 0.12, gain: 0.6 }, { ratio: 2.41, decay: 0.08, gain: 0.35 }, { ratio: 3.7, decay: 0.05, gain: 0.2 }], drop: 0.06, noise: 0.55, noiseCutoff: 1400, noiseDecay: 0.1 },
    scatter: { kind: 'sand', level: 0.5, count: 140, lo: 1800, hi: 7500, delay: 0.015, spread: 0.45, width: 0.8 },
    tail: { kind: 'hiss', level: 0.16, freq: 3800, decay: 0.55 },
    reverb: { wet: 0.08, size: 0.8 },
    sub: { level: 0.55, from: 95, to: 38, decay: 0.28 },
    signature: { tail: { kind: 'hiss', level: 0.4, freq: 2200, decay: 1.8 }, scatter: { kind: 'sand', level: 0.6, count: 380, lo: 900, hi: 7000, delay: 0.05, spread: 1.6, width: 1 }, sub: { level: 0.6, from: 70, to: 30, decay: 1 }, reverb: { wet: 0.35, size: 1.6 } },
    response: { transient: { level: 0 }, body: { level: 0, modes: [{ ratio: 1, decay: 0.1, gain: 0 }] }, sub: { level: 0 }, scatter: { kind: 'dust', level: 0.25, count: 22, lo: 600, hi: 2500, delay: 0.08, spread: 0.7, width: 1 }, tail: { kind: 'hiss', level: 0.12, freq: 1600, decay: 1 } },
  }),
  // ICE: solid crystalline impact, short frozen resonance, ice fragments, glass-like highs.
  ice: m({
    transient: { level: 0.65, freq: 5200, q: 1, ms: 2.5, click: 0.35 },
    body: { level: 0.6, baseHz: 640, modes: [{ ratio: 1, decay: 0.22, gain: 1 }, { ratio: 2.93, decay: 0.16, gain: 0.6 }, { ratio: 5.61, decay: 0.1, gain: 0.4 }, { ratio: 8.2, decay: 0.07, gain: 0.25 }], drop: 0.005 },
    resonance: { kind: 'band', level: 0.25, freq: 2900, q: 28, decay: 0.4 },
    scatter: { kind: 'shards', level: 0.4, count: 26, lo: 3200, hi: 9500, delay: 0.01, spread: 0.3, width: 0.8 },
    tail: { kind: 'shimmer', level: 0.1, freq: 7000, decay: 0.6 },
    sub: { level: 0.4, from: 130, to: 55, decay: 0.18 },
    signature: { scatter: { kind: 'shards', level: 0.55, count: 140, lo: 2500, hi: 10000, delay: 0.02, spread: 1, width: 1 }, tail: { kind: 'shimmer', level: 0.25, freq: 6500, decay: 1.6 }, reverb: { wet: 0.35, size: 1.5 } },
    response: { transient: { level: 0 }, body: { level: 0, modes: [{ ratio: 1, decay: 0.1, gain: 0 }] }, sub: { level: 0 }, scatter: { kind: 'chimes', level: 0.1, count: 4, lo: 2600, hi: 6000, delay: 0.1, spread: 0.6 }, tail: { kind: 'shimmer', level: 0.06, freq: 8000, decay: 0.9 } },
  }),
  // JAPAN WOOD: deep wooden knock, warm hollow resonance, wooden vibration, fine particles.
  wood: m({
    transient: { level: 0.55, freq: 2400, q: 1.2, ms: 3, click: 0.3 },
    body: { level: 0.85, baseHz: 160, modes: [{ ratio: 1, decay: 0.18, gain: 1 }, { ratio: 2.57, decay: 0.1, gain: 0.55 }, { ratio: 4.1, decay: 0.06, gain: 0.3 }, { ratio: 6.3, decay: 0.04, gain: 0.15 }], drop: 0.02 },
    resonance: { kind: 'cavity', level: 0.5, freq: 210, q: 12, decay: 0.32 },
    scatter: { kind: 'pebbles', level: 0.12, count: 8, lo: 1800, hi: 4500, delay: 0.02, spread: 0.15 },
    tail: { kind: 'air', level: 0.05, freq: 900, decay: 0.4 },
    reverb: { wet: 0.18, size: 0.9 },
    sub: { level: 0.4, from: 110, to: 55, decay: 0.2 },
    signature: { resonance: { kind: 'cavity', level: 0.7, freq: 180, q: 14, decay: 0.9 }, scatter: { kind: 'leaves', level: 0.3, count: 40, lo: 1500, hi: 6000, delay: 0.1, spread: 1.4, width: 1 }, reverb: { wet: 0.35, size: 1.4 } },
  }),
  // DARK SPACE: deep cosmic impact, electronic resonance, energy pulse, spatial tail.
  cosmic: m({
    transient: { level: 0.45, freq: 2600, ms: 4 },
    body: { level: 0.55, baseHz: 70, modes: [{ ratio: 1, decay: 0.5, gain: 1 }, { ratio: 1.5, decay: 0.35, gain: 0.4 }, { ratio: 3, decay: 0.2, gain: 0.2 }], drop: 0.12 },
    resonance: { kind: 'comb', level: 0.3, freq: 220, decay: 0.7 },
    scatter: { kind: 'sparks', level: 0.12, count: 10, lo: 1800, hi: 5000, delay: 0.05, spread: 0.5 },
    tail: { kind: 'shimmer', level: 0.12, freq: 3000, decay: 1.4 },
    reverb: { wet: 0.4, size: 1.8 },
    sub: { level: 0.6, from: 80, to: 28, decay: 0.55 },
    signature: { resonance: { kind: 'comb', level: 0.4, freq: 110, decay: 1.6 }, tail: { kind: 'shimmer', level: 0.3, freq: 2400, decay: 2.2 }, sub: { level: 0.7, from: 60, to: 22, decay: 1.4 }, reverb: { wet: 0.55, size: 2 } },
    response: { transient: { level: 0 }, body: { level: 0, modes: [{ ratio: 1, decay: 0.1, gain: 0 }] }, sub: { level: 0 }, tail: { kind: 'shimmer', level: 0.1, freq: 1800, decay: 1.6 }, reverb: { wet: 0.5, size: 2 } },
  }),
  // MOUNTAINS: mineral impact, stone resonance, small rock fragments.
  mineral: m({
    transient: { level: 0.65, freq: 2600, q: 0.9, ms: 4, click: 0.3 },
    body: { level: 0.75, baseHz: 120, modes: [{ ratio: 1, decay: 0.2, gain: 1 }, { ratio: 1.86, decay: 0.15, gain: 0.55 }, { ratio: 3.1, decay: 0.1, gain: 0.35 }, { ratio: 4.9, decay: 0.07, gain: 0.2 }], drop: 0.03, noise: 0.3, noiseCutoff: 2400, noiseDecay: 0.08 },
    resonance: { kind: 'band', level: 0.2, freq: 640, q: 10, decay: 0.3 },
    scatter: { kind: 'pebbles', level: 0.35, count: 18, lo: 1200, hi: 4200, delay: 0.03, spread: 0.4 },
    tail: { kind: 'air', level: 0.08, freq: 1500, decay: 0.8 },
    reverb: { wet: 0.25, size: 1.5 },
    sub: { level: 0.45, from: 100, to: 42, decay: 0.24 },
    signature: { scatter: { kind: 'pebbles', level: 0.45, count: 70, lo: 900, hi: 4000, delay: 0.05, spread: 1.4, width: 1 }, tail: { kind: 'air', level: 0.3, freq: 700, decay: 2 }, reverb: { wet: 0.45, size: 1.9 } },
  }),
  // OCEAN: deep watery impact, fluid movement, bubbles, aquatic resonance.
  water: m({
    transient: { level: 0.25, freq: 1500, ms: 6 },
    body: { level: 0.6, baseHz: 85, modes: [{ ratio: 1, decay: 0.35, gain: 1 }, { ratio: 1.7, decay: 0.25, gain: 0.4 }], drop: 0.15, noise: 0.3, noiseCutoff: 600, noiseDecay: 0.25 },
    resonance: { kind: 'band', level: 0.3, freq: 300, q: 6, decay: 0.5 },
    scatter: { kind: 'bubbles', level: 0.5, count: 24, lo: 380, hi: 1500, delay: 0.04, spread: 0.7, width: 0.8 },
    tail: { kind: 'rumble', level: 0.15, freq: 400, decay: 0.9 },
    reverb: { wet: 0.3, size: 1.3 },
    sub: { level: 0.5, from: 70, to: 35, decay: 0.4 },
    signature: { scatter: { kind: 'bubbles', level: 0.55, count: 120, lo: 300, hi: 1800, delay: 0.05, spread: 1.8, width: 1 }, tail: { kind: 'rumble', level: 0.35, freq: 500, decay: 1.8 } },
    response: { transient: { level: 0 }, body: { level: 0, modes: [{ ratio: 1, decay: 0.1, gain: 0 }] }, sub: { level: 0 }, scatter: { kind: 'bubbles', level: 0.25, count: 10, lo: 500, hi: 1600, delay: 0.12, spread: 0.8 } },
  }),
  // FOREST: warm organic impact, wood/crystal resonance, leaves and natural particles.
  organic: m({
    transient: { level: 0.45, freq: 2000, ms: 4 },
    body: { level: 0.75, baseHz: 140, modes: [{ ratio: 1, decay: 0.2, gain: 1 }, { ratio: 2.3, decay: 0.12, gain: 0.5 }, { ratio: 3.6, decay: 0.08, gain: 0.25 }], drop: 0.025 },
    resonance: { kind: 'band', level: 0.25, freq: 1800, q: 18, decay: 0.45 },
    scatter: { kind: 'leaves', level: 0.3, count: 12, lo: 1800, hi: 6500, delay: 0.03, spread: 0.45, width: 0.9 },
    tail: { kind: 'air', level: 0.06, freq: 1200, decay: 0.6 },
    reverb: { wet: 0.2, size: 1.1 },
    sub: { level: 0.38, from: 105, to: 50, decay: 0.2 },
    signature: { scatter: { kind: 'leaves', level: 0.4, count: 70, lo: 1200, hi: 7000, delay: 0.05, spread: 1.6, width: 1 }, resonance: { kind: 'band', level: 0.35, freq: 2100, q: 24, decay: 1.2 } },
  }),
  // VOLCANIC: heavy obsidian impact, low body, molten crackle, embers.
  obsidian: m({
    transient: { level: 0.75, freq: 3000, q: 0.8, ms: 3, click: 0.4 },
    body: { level: 0.8, baseHz: 78, modes: [{ ratio: 1, decay: 0.28, gain: 1 }, { ratio: 2.2, decay: 0.18, gain: 0.5 }, { ratio: 4.7, decay: 0.08, gain: 0.3 }], drop: 0.05, noise: 0.35, noiseCutoff: 900, noiseDecay: 0.15 },
    scatter: { kind: 'crackle', level: 0.45, count: 40, lo: 1800, hi: 6500, delay: 0.04, spread: 0.9, width: 0.9 },
    tail: { kind: 'rumble', level: 0.2, freq: 180, decay: 0.9 },
    reverb: { wet: 0.15, size: 1.2 },
    sub: { level: 0.7, from: 85, to: 30, decay: 0.45 },
    signature: { scatter: { kind: 'crackle', level: 0.55, count: 160, lo: 1500, hi: 7000, delay: 0.05, spread: 2, width: 1 }, tail: { kind: 'rumble', level: 0.45, freq: 140, decay: 2 }, sub: { level: 0.75, from: 60, to: 24, decay: 1.2 } },
    response: { transient: { level: 0 }, body: { level: 0, modes: [{ ratio: 1, decay: 0.1, gain: 0 }] }, sub: { level: 0 }, scatter: { kind: 'crackle', level: 0.25, count: 18, lo: 1500, hi: 5000, delay: 0.15, spread: 1 } },
  }),
  // AURORA: crystalline impact, luminous resonance, airy highs.
  aurora: m({
    transient: { level: 0.4, freq: 4800, ms: 3 },
    body: { level: 0.55, baseHz: 440, modes: [{ ratio: 1, decay: 0.5, gain: 1 }, { ratio: 2.01, decay: 0.4, gain: 0.5 }, { ratio: 3.02, decay: 0.3, gain: 0.3 }, { ratio: 5.04, decay: 0.2, gain: 0.15 }], drop: 0 },
    resonance: { kind: 'band', level: 0.2, freq: 1760, q: 30, decay: 0.8 },
    scatter: { kind: 'chimes', level: 0.15, count: 5, lo: 1800, hi: 5200, delay: 0.05, spread: 0.6 },
    tail: { kind: 'shimmer', level: 0.15, freq: 5000, decay: 1.2 },
    reverb: { wet: 0.35, size: 1.6 },
    sub: { level: 0.3, from: 100, to: 50, decay: 0.2 },
    signature: { scatter: { kind: 'chimes', level: 0.3, count: 26, lo: 1500, hi: 6000, delay: 0.05, spread: 1.8, width: 1 }, tail: { kind: 'shimmer', level: 0.3, freq: 4200, decay: 2.4 } },
  }),
  // NEON CITY: clean electronic impact, tight punch, short synthetic resonance.
  neon: m({
    transient: { level: 0.8, freq: 3800, q: 1.4, ms: 2, click: 0.5 },
    body: { level: 0.55, baseHz: 110, modes: [{ ratio: 1, decay: 0.12, gain: 1 }, { ratio: 2, decay: 0.08, gain: 0.4 }], drop: 0.25 },
    resonance: { kind: 'comb', level: 0.2, freq: 880, decay: 0.18 },
    scatter: { kind: 'sparks', level: 0.25, count: 8, lo: 2000, hi: 6000, delay: 0.01, spread: 0.12 },
    tail: { kind: 'air', level: 0.04, freq: 3000, decay: 0.25 },
    sub: { level: 0.65, from: 140, to: 45, decay: 0.2 },
    signature: { scatter: { kind: 'sparks', level: 0.4, count: 60, lo: 1500, hi: 7000, delay: 0.02, spread: 0.9, width: 1 }, resonance: { kind: 'comb', level: 0.35, freq: 440, decay: 0.8 } },
  }),
  paper: m({
    transient: { level: 0.35, freq: 2600, ms: 5 },
    body: { level: 0.5, baseHz: 200, modes: [{ ratio: 1, decay: 0.08, gain: 1 }, { ratio: 2.4, decay: 0.05, gain: 0.4 }], drop: 0.02, noise: 0.4, noiseCutoff: 3500, noiseDecay: 0.06 },
    scatter: { kind: 'leaves', level: 0.2, count: 6, lo: 2500, hi: 7000, spread: 0.2 },
    sub: { level: 0.25, from: 110, to: 60, decay: 0.12 },
  }),
};

/** Resolves a stage's material reference (name or inline profile); unknown names fall back to glass. */
export function resolveMaterialAudio(ref: string | MaterialAudioInput | undefined, fallback = 'glass'): MaterialAudioProfile {
  if (ref && typeof ref === 'object') {
    const parsed = materialAudioSchema.safeParse(ref);
    if (parsed.success) return parsed.data;
  }
  if (typeof ref === 'string' && MATERIAL_PROFILES[ref]) return MATERIAL_PROFILES[ref]!;
  return MATERIAL_PROFILES[fallback] ?? MATERIAL_PROFILES.glass!;
}

/** A profile with a partial override applied layer by layer (signature, response). */
export function withOverrides(base: MaterialAudioProfile, over: Partial<MaterialAudioProfile> | undefined): MaterialAudioProfile {
  if (!over) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    const prev = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && prev && typeof prev === 'object' ? { ...(prev as object), ...(v as object) } : v;
  }
  return out as MaterialAudioProfile;
}
