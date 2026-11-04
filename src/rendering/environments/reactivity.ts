import type { AudioFeatures } from '../../audio/analysis/features';
import type { GameSignals } from '../../sdk/types';
import { bindingSchema, type Binding, type SectionState } from '../../stages/schema';
import { baseScale, NEUTRAL_LEVELS, responseScale, type BackgroundLevels, type TargetClass } from './living/intensity';
import type { MusicDrive } from './living/musicDirector';

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

const BASS = new Set(['subBass', 'bass', 'lowMid', 'music.body', 'music.swell']);
const TREBLE = new Set(['highMid', 'treble', 'spectralCentroid', 'music.detail', 'music.shimmer']);
const BEAT = new Set(['beatPulse', 'barPulse', 'transientIntensity', 'spectralFlux', 'music.accent', 'music.beat', 'music.downbeat', 'music.flux']);

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

/** A timed swell of a target (the `pulse` call-in action, SDK 1.7). */
export interface PulseSpec {
  /** mul: base × (1 + amount × envelope); add: base + amount × envelope. */
  readonly mode: 'mul' | 'add';
  readonly amount: number;
  /** Seconds to rise, hold and fall. */
  readonly attack: number;
  readonly hold: number;
  readonly release: number;
}

interface PulseItem {
  readonly slot: TargetSlot;
  readonly spec: PulseSpec;
  readonly strength: number;
  age: number;
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

/** The envelope of a pulse `age` seconds after it started: rise, hold, fall (smooth). */
export function pulseEnvelope(spec: Pick<PulseSpec, 'attack' | 'hold' | 'release'>, age: number): number {
  if (age < 0) return 0;
  const smooth = (x: number) => x * x * (3 - 2 * x);
  if (age < spec.attack) return smooth(age / Math.max(1e-3, spec.attack));
  const t = age - spec.attack - spec.hold;
  if (t < 0) return 1;
  if (t >= spec.release) return 0;
  return 1 - smooth(t / Math.max(1e-3, spec.release));
}

/** One driven uniform; several bindings combine on it (mul factors multiply, add terms sum). */
interface TargetSlot {
  readonly target: { value: number };
  readonly base: number;
  /** Which Background intensity knob scales it. */
  cls: TargetClass;
  /** The target's name (bounded classes look at it: sizes, visible shares). */
  name: string;
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

export function readFeature(name: Binding['feature'], audio: Readonly<AudioFeatures>, game: GameSignals, music?: Readonly<MusicDrive>): number {
  if (name.startsWith('game.')) {
    const key = name.slice(5) as keyof GameSignals;
    const v = game[key] ?? 0;
    if (key === 'combo') return Math.min(1, Math.max(0, v) / 10);
    if (key === 'level') return Math.min(1, (v - 1) / 19);
    // Back-to-back chain: 0 none, a quarter on the first, full after four in a row.
    if (key === 'backToBack') return v < 0 ? 0 : Math.min(1, (v + 1) / 4);
    return v;
  }
  if (name.startsWith('music.')) {
    const v = music ? (music as unknown as Record<string, number>)[name.slice(6)] : 0;
    return typeof v === 'number' ? v : 0;
  }
  const v = audio[name as keyof AudioFeatures];
  return typeof v === 'number' ? v : 0;
}

/** What the layer also gets each frame since SDK 1.7 (all optional: without them, as before). */
export interface ReactivityExtras {
  /** The Environment Music Director's drives (bindings on `music.*`). */
  readonly music?: Readonly<MusicDrive>;
  /** Background intensity levels (class scaling of bases and responses). */
  readonly levels?: BackgroundLevels;
}

/**
 * Drives component uniforms from audio features, the music drives and game signals through
 * declarative bindings, section states and timed pulses. Time-based envelopes (α = 1 − e^(−dt/τ))
 * make the motion identical at any frame rate. Background intensity scales each target's base and
 * every response on it by the knob of its class (living/intensity.ts); Balanced (all 1) leaves the
 * world exactly as authored.
 */
export class ReactivityLayer {
  private readonly items: Resolved[] = [];
  private readonly states: StateItem[] = [];
  private readonly pulses: PulseItem[] = [];
  private readonly slots = new Map<{ value: number }, TargetSlot>();
  private levels: BackgroundLevels = NEUTRAL_LEVELS;

  private slotFor(target: { value: number }, cls: TargetClass = 'none', name = ''): TargetSlot {
    let slot = this.slots.get(target);
    if (!slot) {
      slot = { target, base: target.value, cls, name, mul: 1, add: 0, min: -Infinity, max: Infinity };
      this.slots.set(target, slot);
    } else if (slot.cls === 'none' && cls !== 'none') {
      slot.cls = cls;
      slot.name = name;
    }
    return slot;
  }

  add(binding: Binding, target: { value: number }, cls: TargetClass = 'none'): void {
    const slot = this.slotFor(target, cls, binding.target);
    if (binding.min !== undefined) slot.min = Math.max(slot.min, binding.min);
    if (binding.max !== undefined) slot.max = Math.min(slot.max, binding.max);
    this.items.push({ binding, slot, env: 0 });
  }

  /** A section state on `target`, crossfading over `fade` seconds (manifest `sectionStates`). */
  addState(state: SectionState, target: { value: number }, fade: number, cls: TargetClass = 'none'): void {
    this.states.push({ state, slot: this.slotFor(target, cls, state.target), fade, weight: 0 });
  }

  /**
   * Registers a target that only Background intensity scales (no binding or state on it), so its
   * base follows the levels too. Since SDK 1.7.
   */
  track(target: { value: number }, cls: TargetClass, name: string): void {
    if (cls !== 'none') this.slotFor(target, cls, name);
  }

  /** Starts a timed swell of `target` (the `pulse` action). Since SDK 1.7. */
  addPulse(target: { value: number }, spec: PulseSpec, strength = 1, cls: TargetClass = 'none', name = ''): void {
    // A few overlapping pulses per target at most; the oldest gives way.
    const slot = this.slotFor(target, cls, name);
    const same = this.pulses.filter((p) => p.slot === slot);
    if (same.length >= 3) this.pulses.splice(this.pulses.indexOf(same[0] as PulseItem), 1);
    this.pulses.push({ slot, spec, strength: Math.max(0, Math.min(1.5, strength)), age: 0 });
  }

  get size(): number {
    return this.items.length;
  }

  get stateCount(): number {
    return this.states.length;
  }

  get pulseCount(): number {
    return this.pulses.length;
  }

  /** Live section-state weights (debug dashboard, tests). */
  inspectStates(): { state: SectionState; weight: number; value: number }[] {
    return this.states.map((st) => ({ state: st.state, weight: st.weight, value: st.slot.target.value }));
  }

  /** Live view of every binding: its envelope (0..1) and the driven value (debug dashboard). */
  inspect(): { binding: Binding; env: number; value: number }[] {
    return this.items.map((it) => ({ binding: it.binding, env: it.env, value: it.slot.target.value }));
  }

  update(dt: number, audio: Readonly<AudioFeatures>, game: GameSignals, s: ReactivitySettings, extras: ReactivityExtras = {}): void {
    const preset = REACTION_PRESETS[s.preset];
    const levels = extras.levels ?? NEUTRAL_LEVELS;
    this.levels = levels;
    for (const slot of this.slots.values()) {
      slot.mul = 1;
      slot.add = 0;
    }
    for (const it of this.items) {
      const b = it.binding;
      let x = readFeature(b.feature, audio, game, extras.music);
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
      const gain = isGame ? 1 : s.strength * preset.gain * category * levels.music;
      const amount = b.amount * gain * it.env * responseScale(it.slot.cls, levels);
      if (b.mode === 'add') it.slot.add += amount;
      else it.slot.mul *= 1 + amount;
    }
    for (const st of this.states) {
      st.weight = crossfade(st.weight, sectionStateTarget(st.state, audio), dt, st.fade);
      const k = responseScale(st.slot.cls, levels);
      st.slot.mul *= 1 + (st.state.scale - 1) * st.weight * k;
      st.slot.add += st.state.add * st.weight * k;
    }
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i] as PulseItem;
      p.age += dt;
      if (p.age > p.spec.attack + p.spec.hold + p.spec.release) {
        this.pulses.splice(i, 1);
        continue;
      }
      const e = pulseEnvelope(p.spec, p.age) * p.strength * responseScale(p.slot.cls, levels);
      if (p.spec.mode === 'add') p.slot.add += p.spec.amount * e;
      else p.slot.mul *= Math.max(0, 1 + p.spec.amount * e);
    }
    for (const slot of this.slots.values()) {
      const base = slot.base * baseScale(slot.cls, slot.name, levels);
      slot.target.value = Math.min(slot.max, Math.max(slot.min, base * slot.mul + slot.add));
    }
  }

  /** Restores every target to its base value (as scaled by the current levels). */
  reset(): void {
    for (const it of this.items) it.env = 0;
    for (const st of this.states) st.weight = 0;
    this.pulses.length = 0;
    for (const slot of this.slots.values()) slot.target.value = slot.base * baseScale(slot.cls, slot.name, this.levels);
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
