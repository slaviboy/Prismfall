import type { AudioFeatures } from '../../audio/analysis/features';
import type { GameSignals } from '../../sdk/types';
import { bindingSchema, type Binding, type SectionState } from '../../stages/schema';

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

/** A section state on one target, crossfading in and out (weight 0..1). */
interface StateItem {
  readonly state: SectionState;
  readonly slot: TargetSlot;
  readonly fade: number;
  weight: number;
}

/** Whether the music's current section (kind or name) is one of `list`. */
export function inSection(list: readonly string[], audio: Readonly<Pick<AudioFeatures, 'section' | 'sectionKind'>>): boolean {
  return list.includes(audio.sectionKind) || list.includes(audio.section);
}

/**
 * Target weight of a section state: 1 inside its sections; before an upcoming section of that kind,
 * `anticipate` × the music's anticipation; otherwise 0.
 */
export function sectionStateTarget(state: Pick<SectionState, 'section' | 'anticipate'>, audio: Readonly<Pick<AudioFeatures, 'section' | 'sectionKind' | 'nextEvent' | 'anticipation'>>): number {
  if (inSection(state.section, audio)) return 1;
  if (state.anticipate > 0 && audio.nextEvent && state.section.includes(audio.nextEvent)) return Math.max(0, Math.min(1, audio.anticipation)) * state.anticipate;
  return 0;
}

/** Crossfade step: reaches about 95 % of the way in `fade` seconds, at any frame rate. */
export function crossfade(weight: number, target: number, dt: number, fade: number): number {
  return weight + (target - weight) * (1 - Math.exp((-3 * dt) / Math.max(0.05, fade)));
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
    const v = game[key] ?? 0;
    if (key === 'combo') return Math.min(1, Math.max(0, v) / 10);
    if (key === 'level') return Math.min(1, (v - 1) / 19);
    // Back-to-back chain: 0 none, a quarter on the first, full after four in a row.
    if (key === 'backToBack') return v < 0 ? 0 : Math.min(1, (v + 1) / 4);
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
  private readonly states: StateItem[] = [];
  private readonly slots = new Map<{ value: number }, TargetSlot>();

  private slotFor(target: { value: number }): TargetSlot {
    let slot = this.slots.get(target);
    if (!slot) {
      slot = { target, base: target.value, mul: 1, add: 0, min: -Infinity, max: Infinity };
      this.slots.set(target, slot);
    }
    return slot;
  }

  add(binding: Binding, target: { value: number }): void {
    const slot = this.slotFor(target);
    if (binding.min !== undefined) slot.min = Math.max(slot.min, binding.min);
    if (binding.max !== undefined) slot.max = Math.min(slot.max, binding.max);
    this.items.push({ binding, slot, env: 0 });
  }

  /** A section state on `target`, crossfading over `fade` seconds (manifest `sectionStates`). */
  addState(state: SectionState, target: { value: number }, fade: number): void {
    this.states.push({ state, slot: this.slotFor(target), fade, weight: 0 });
  }

  get size(): number {
    return this.items.length;
  }

  get stateCount(): number {
    return this.states.length;
  }

  /** Live section-state weights (debug dashboard, tests). */
  inspectStates(): { state: SectionState; weight: number; value: number }[] {
    return this.states.map((st) => ({ state: st.state, weight: st.weight, value: st.slot.target.value }));
  }

  /** Live view of every binding: its envelope (0..1) and the driven value (debug dashboard). */
  inspect(): { binding: Binding; env: number; value: number }[] {
    return this.items.map((it) => ({ binding: it.binding, env: it.env, value: it.slot.target.value }));
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
      if (b.when && !inSection(b.when.section, audio)) x = 0;
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
    for (const st of this.states) {
      st.weight = crossfade(st.weight, sectionStateTarget(st.state, audio), dt, st.fade);
      st.slot.mul *= 1 + (st.state.scale - 1) * st.weight;
      st.slot.add += st.state.add * st.weight;
    }
    for (const slot of this.slots.values()) {
      slot.target.value = Math.min(slot.max, Math.max(slot.min, slot.base * slot.mul + slot.add));
    }
  }

  /** Restores every target to its base value. */
  reset(): void {
    for (const it of this.items) it.env = 0;
    for (const st of this.states) st.weight = 0;
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
