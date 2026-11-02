import type { AudioFeatures } from '../../audio/analysis/features';
import type { GameSignals } from '../../sdk/types';
import { bindingSchema, type Binding } from '../../stages/schema';

export type ReactionPreset = 'cinematic' | 'subtle' | 'energetic' | 'ambient' | 'hypnotic' | 'intense' | 'custom';

/** Reaction styles: global gain, envelope time scaling and per-group weighting. */
export const REACTION_PRESETS: Record<ReactionPreset, { gain: number; attack: number; release: number; bass: number; treble: number; beat: number }> = {
  cinematic: { gain: 1, attack: 1, release: 1.2, bass: 1, treble: 0.8, beat: 0.9 },
  subtle: { gain: 0.5, attack: 1.4, release: 1.6, bass: 0.8, treble: 0.6, beat: 0.6 },
  energetic: { gain: 1.3, attack: 0.7, release: 0.8, bass: 1.2, treble: 1.1, beat: 1.3 },
  ambient: { gain: 0.75, attack: 2, release: 2.5, bass: 0.9, treble: 0.7, beat: 0.4 },
  hypnotic: { gain: 1, attack: 1.6, release: 2.2, bass: 1.2, treble: 0.5, beat: 1 },
  intense: { gain: 1.6, attack: 0.5, release: 0.7, bass: 1.4, treble: 1.3, beat: 1.5 },
  custom: { gain: 1, attack: 1, release: 1, bass: 1, treble: 1, beat: 1 },
};

export interface ReactivitySettings {
  enabled: boolean;
  preset: ReactionPreset;
  strength: number;
  bassSensitivity: number;
  trebleSensitivity: number;
  beatSensitivity: number;
  particleResponse: number;
  environmentResponse: number;
  lightingResponse: number;
}

const BASS = new Set(['subBass', 'bass', 'lowMid']);
const TREBLE = new Set(['highMid', 'treble', 'spectralCentroid']);
const BEAT = new Set(['beatPulse', 'barPulse', 'transientIntensity', 'spectralFlux']);

interface Resolved {
  readonly binding: Binding;
  readonly slot: TargetSlot;
  env: number;
}

/** One driven uniform; several bindings combine on it (mul factors multiply, add terms sum). */
interface TargetSlot {
  readonly target: { value: number };
  readonly base: number;
  mul: number;
  add: number;
  min: number;
  max: number;
}

function shape(curve: Binding['curve'], x: number): number {
  const v = Math.max(0, Math.min(1, x));
  switch (curve) {
    case 'smooth':
      return v * v * (3 - 2 * v);
    case 'pow2':
      return v * v;
    case 'sqrt':
      return Math.sqrt(v);
    default:
      return v;
  }
}

export function readFeature(name: Binding['feature'], audio: Readonly<AudioFeatures>, game: GameSignals): number {
  if (name.startsWith('game.')) {
    const key = name.slice(5) as keyof GameSignals;
    const v = game[key];
    if (key === 'combo') return Math.min(1, Math.max(0, v) / 10);
    if (key === 'level') return Math.min(1, (v - 1) / 19);
    return v;
  }
  const v = audio[name as keyof AudioFeatures];
  return typeof v === 'number' ? v : 0;
}

/**
 * Drives component uniforms from audio features and game signals through declarative bindings.
 * Time-based envelopes (α = 1 − e^(−dt/τ)) make the motion identical at any frame rate.
 */
export class ReactivityLayer {
  private readonly items: Resolved[] = [];
  private readonly slots = new Map<{ value: number }, TargetSlot>();

  add(binding: Binding, target: { value: number }): void {
    let slot = this.slots.get(target);
    if (!slot) {
      slot = { target, base: target.value, mul: 1, add: 0, min: -Infinity, max: Infinity };
      this.slots.set(target, slot);
    }
    if (binding.min !== undefined) slot.min = Math.max(slot.min, binding.min);
    if (binding.max !== undefined) slot.max = Math.min(slot.max, binding.max);
    this.items.push({ binding, slot, env: 0 });
  }

  get size(): number {
    return this.items.length;
  }

  update(dt: number, audio: Readonly<AudioFeatures>, game: GameSignals, s: ReactivitySettings): void {
    const preset = REACTION_PRESETS[s.preset];
    for (const slot of this.slots.values()) {
      slot.mul = 1;
      slot.add = 0;
    }
    for (const it of this.items) {
      const b = it.binding;
      let x = readFeature(b.feature, audio, game);
      const isGame = b.feature.startsWith('game.');
      if (!isGame) {
        if (!s.enabled) x = 0;
        else if (BASS.has(b.feature)) x *= s.bassSensitivity * preset.bass;
        else if (TREBLE.has(b.feature)) x *= s.trebleSensitivity * preset.treble;
        else if (BEAT.has(b.feature)) x *= s.beatSensitivity * preset.beat;
      }
      const target = shape(b.curve, x);
      const rising = target > it.env;
      const tau = Math.max(0.001, (rising ? b.attackMs * preset.attack : b.releaseMs * preset.release) / 1000);
      it.env += (target - it.env) * (1 - Math.exp(-dt / tau));
      const category = b.category === 'particles' ? s.particleResponse : b.category === 'lighting' ? s.lightingResponse : s.environmentResponse;
      const gain = isGame ? 1 : s.strength * preset.gain * category;
      const amount = b.amount * gain * it.env;
      if (b.mode === 'add') it.slot.add += amount;
      else it.slot.mul *= 1 + amount;
    }
    for (const slot of this.slots.values()) {
      slot.target.value = Math.min(slot.max, Math.max(slot.min, slot.base * slot.mul + slot.add));
    }
  }

  /** Restores every target to its base value. */
  reset(): void {
    for (const it of this.items) it.env = 0;
    for (const slot of this.slots.values()) slot.target.value = slot.base;
  }
}

export function parseBindings(raw: readonly unknown[]): Binding[] {
  const out: Binding[] = [];
  for (const r of raw) {
    const parsed = bindingSchema.safeParse(r);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
