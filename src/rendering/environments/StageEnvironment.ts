import { Group } from 'three/webgpu';
import { registries } from '../../sdk/registry';
import type { BeatInfo, CallInfo, EnvFrame, EnvironmentComponent, EnvironmentContext, StageGameEvent } from '../../sdk/types';
import type { Binding, LayerSpec, StageManifest } from '../../stages/schema';
import { EMPTY_LIVING, reactionBinding, type LivingProfile, type TargetClass } from '../../stages/living';
import { livingProfile, reactivityProfile } from '../../stages/registry';
import { frameUniforms } from '../shaders/uniforms';
import { EnvironmentEventDirector, type CallInSpec, type DispatchedCall } from './callins';
import { classifyTarget } from './living/intensity';
import type { MusicCue } from './living/musicDirector';
import { parseBindings, ReactivityLayer, type PulseSpec, type ReactivitySettings } from './reactivity';
import { clearStrength } from './worldSignals';

const DETAIL_RANK = { low: 0, medium: 1, high: 2, ultra: 3 } as const;
/** Reactive targets a component sets itself: never scaled by Background intensity. */
const SELF_DRIVEN = new Set(['presence', 'music', 'clock', 'time', 'reveal']);

interface Built {
  readonly spec: LayerSpec;
  readonly component: EnvironmentComponent;
}

/** Number param of a call, clamped, or the default. */
function num(params: Readonly<Record<string, unknown>>, key: string, def: number, min: number, max: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def;
}

/**
 * A built (GPU-ready) stage environment: its components, reactivity (bindings, section states,
 * the living profile's music reactions and pulses), the event director and the presence fade.
 */
export class StageEnvironment {
  readonly group = new Group();
  readonly reactivity = new ReactivityLayer();
  readonly warnings: string[] = [];
  private readonly built: Built[] = [];
  /** Event call-ins and ambient events (manifest `events` and living.json `events`). */
  readonly calls: EnvironmentEventDirector;
  /** The world's living profile (living.json; empty when it has none). */
  readonly living: LivingProfile;
  presence = 0;
  /** The section last seen (kind and name), for onSection and section call-ins. */
  private section: { kind: string; name: string } | null = null;
  private clock = 0;
  private signalsPrimed = false;
  /** Set once disposed (a cached promise may still hand it out). */
  disposed = false;
  /** Sends a wave out through the world (set by the host; the `wave` action). */
  onWave: ((strength: number) => void) | null = null;

  private constructor(
    readonly manifest: StageManifest,
    readonly ctx: EnvironmentContext,
    living: LivingProfile | null,
  ) {
    this.group.name = `stage:${manifest.id}`;
    this.living = living ?? EMPTY_LIVING;
    const specs: CallInSpec[] = [...manifest.events, ...this.living.events];
    this.calls = new EnvironmentEventDirector(specs, this.living.phraseBars ?? manifest.phraseBars);
    for (const e of this.calls.errors) this.warnings.push(e);
  }

  static async build(manifest: StageManifest, ctx: EnvironmentContext, onProgress?: (fraction: number) => void, living?: LivingProfile | null): Promise<StageEnvironment> {
    const env = new StageEnvironment(manifest, ctx, living === undefined ? livingProfile(manifest.id) : living);
    const layers = manifest.environment.layers.filter((l) => DETAIL_RANK[l.minDetail] <= DETAIL_RANK[ctx.quality.detail]);
    let done = 0;
    for (const spec of layers) {
      const factory = registries.components.get(spec.type);
      if (!factory) {
        env.warnings.push(`component "${spec.type}" is not registered`);
        continue;
      }
      const params = factory.schema.safeParse(spec.params);
      if (!params.success) {
        env.warnings.push(`layer "${spec.id ?? spec.type}": ${params.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(', ')}`);
        continue;
      }
      try {
        const component = await factory.create(ctx, params.data);
        env.built.push({ spec, component });
        env.group.add(component.object);
      } catch (err) {
        env.warnings.push(`layer "${spec.id ?? spec.type}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      done++;
      onProgress?.(done / Math.max(1, layers.length));
    }
    env.wireBindings();
    env.wireSectionStates();
    env.trackTargets();
    for (const w of env.warnings) console.warn(`[stage ${manifest.id}]`, w);
    env.setPresence(0);
    return env;
  }

  /** The Background intensity class of a layer's target: living.json first, then the defaults. */
  classOf(b: Built, target: string): TargetClass {
    const id = b.spec.id;
    const classes = this.living.classes;
    const override = id ? (classes[`${id}.${target}`] ?? classes[id]) : undefined;
    return classifyTarget(b.spec.type, target, override);
  }

  private wireBindings(): void {
    // Each binding may carry a scope: the layer ids a scoped profile is limited to.
    const all: { binding: Binding; only?: ReadonlySet<string> }[] = [
      ...this.built.flatMap((b) => b.spec.bind.map((bind) => ({ binding: { ...bind, layer: b.spec.id ?? `type:${b.spec.type}` } }))),
      ...this.manifest.reactivity.profiles.flatMap((ref) => {
        const only = ref.layers ? new Set(ref.layers) : undefined;
        return parseBindings(reactivityProfile(ref.name)).map((binding) => ({ binding: { ...binding, amount: binding.amount * ref.amount }, only }));
      }),
      ...this.manifest.reactivity.bindings.map((binding) => ({ binding })),
    ];
    for (const { binding, only } of all) {
      for (const b of this.built) {
        if (only && !(b.spec.id && only.has(b.spec.id))) continue;
        const matches = binding.layer === '*' || binding.layer === b.spec.id || binding.layer === `type:${b.spec.type}`;
        const target = matches ? b.component.reactive?.[binding.target] : undefined;
        if (target) this.reactivity.add(binding, target, this.classOf(b, binding.target));
      }
    }
    // The living profile's music reactions (SDK 1.7).
    for (const r of this.living.music) {
      let wired = 0;
      for (const b of this.select(r.layer)) {
        const target = b.component.reactive?.[r.target];
        if (!target) continue;
        const cls = this.classOf(b, r.target);
        this.reactivity.add(reactionBinding(r, cls), target, cls);
        wired++;
      }
      const declared = this.manifest.environment.layers.some((l) => r.layer === '*' || r.layer === l.id || r.layer === `type:${l.type}`);
      if (wired === 0 && (!declared || this.select(r.layer).length > 0)) this.warnings.push(`living.json music: no layer "${r.layer}" exposes "${r.target}"`);
    }
  }

  /** Layers a selector names: a layer id, `type:<componentType>` or `*`. */
  private select(layer: string): Built[] {
    return this.built.filter((b) => layer === '*' || layer === b.spec.id || layer === `type:${b.spec.type}`);
  }

  private wireSectionStates(): void {
    const { fade, states } = this.manifest.sectionStates;
    for (const state of states) {
      let wired = 0;
      for (const b of this.select(state.layer)) {
        const target = b.component.reactive?.[state.target];
        if (!target) continue;
        this.reactivity.addState(state, target, fade, this.classOf(b, state.target));
        wired++;
      }
      // A layer left out at this detail level is not an error.
      const declared = this.manifest.environment.layers.some((l) => state.layer === '*' || state.layer === l.id || state.layer === `type:${l.type}`);
      if (wired === 0 && (!declared || this.select(state.layer).length > 0)) this.warnings.push(`section state: no layer "${state.layer}" exposes "${state.target}"`);
    }
  }

  /** Every classified reactive target follows the Background intensity levels, bound or not. */
  private trackTargets(): void {
    for (const b of this.built) {
      for (const [name, target] of Object.entries(b.component.reactive ?? {})) {
        if (SELF_DRIVEN.has(name)) continue;
        this.reactivity.track(target, this.classOf(b, name), name);
      }
    }
  }

  private deliver(call: DispatchedCall): void {
    if (call.action === 'wave') {
      this.onWave?.(Math.max(0, Math.min(1.5, num(call.params, 'strength', 0.5, 0, 1.5) * call.strength)));
      return;
    }
    if (call.action === 'pulse') {
      const name = typeof call.params.target === 'string' ? call.params.target : '';
      const spec: PulseSpec = {
        mode: call.params.mode === 'add' ? 'add' : 'mul',
        amount: num(call.params, 'amount', 0.5, -4, 8),
        attack: num(call.params, 'attack', 0.6, 0, 30),
        hold: num(call.params, 'hold', 1, 0, 60),
        release: num(call.params, 'release', 3, 0.05, 60),
      };
      for (const b of this.select(call.layer)) {
        const target = b.component.reactive?.[name];
        if (target) this.reactivity.addPulse(target, spec, call.strength, this.classOf(b, name), name);
      }
      return;
    }
    const info: CallInfo = { action: call.action, params: call.params, trigger: call.trigger, strength: call.strength, time: call.time };
    for (const b of this.select(call.layer)) {
      try {
        b.component.onCall?.(info);
      } catch (err) {
        console.warn(`[stage ${this.manifest.id}] call-in failed`, err);
      }
    }
  }

  setPresence(v: number): void {
    this.presence = v;
    this.group.visible = v > 0.001;
    for (const b of this.built) b.component.setPresence?.(v);
  }

  /** A cue of the Environment Music Director (call-ins `music:<cue>`, components' onMusicCue). */
  onMusicCue(cue: MusicCue): void {
    this.calls.onMusicCue(cue.kind, cue.strength, cue.time);
    for (const b of this.built) {
      try {
        b.component.onMusicCue?.(cue);
      } catch (err) {
        console.warn(`[stage ${this.manifest.id}] music cue failed`, err);
      }
    }
  }

  update(frame: EnvFrame, reactivity: ReactivitySettings): void {
    this.clock = frame.time;
    this.reactivity.update(frame.dt, frame.audio, frame.game, reactivity, { music: frame.music, levels: frame.levels });
    this.trackSection(frame);
    const calls = this.calls;
    calls.worldEvents = frameUniforms.worldEvents.value;
    calls.frequency = frame.levels.events;
    calls.bpm = frame.audio.bpm;
    calls.beatsPerBar = this.manifest.music.beatsPerBar;
    calls.onMusicState(frame.music);
    // Progress and heat crossings count from what the world first sees (not from 0 on entry).
    if (!this.signalsPrimed) {
      calls.resetSignals(frame.game.progress);
      this.signalsPrimed = true;
    }
    calls.onSignals(frame.game.progress, frame.game.heat, frame.time);
    for (const c of calls.update(frame.time)) if (frame.presence > 0.05) this.deliver(c);
    for (const b of this.built) b.component.update?.(frame);
  }

  private trackSection(frame: EnvFrame): void {
    const kind = frame.audio.sectionKind ?? '';
    const name = frame.audio.section ?? '';
    const prev = this.section;
    if (prev && prev.kind === kind && prev.name === name) return;
    this.section = { kind, name };
    const info = { kind, name, intensity: frame.audio.sectionIntensity, previous: prev ? prev.kind : null, time: frame.time };
    for (const b of this.built) b.component.onSection?.(info);
    // Section call-ins fire on real changes, not on the section the world happens to open in.
    if (prev) this.calls.onSection(kind, name, frame.time);
  }

  onBeat(beat: BeatInfo): void {
    this.calls.onBeat(beat, this.clock);
    for (const b of this.built) b.component.onBeat?.(beat);
  }

  onGameEvent(event: StageGameEvent): void {
    this.calls.onGameEvent(event, this.clock, event.kind === 'clear' ? clearStrength(event) : 1);
    for (const b of this.built) b.component.onGameEvent?.(event);
  }

  get componentCount(): number {
    return this.built.length;
  }

  /** Layer ids and types with their reactive targets and classes (developer dashboard). */
  describeTargets(): { layer: string; type: string; target: string; cls: TargetClass }[] {
    return this.built.flatMap((b) => Object.keys(b.component.reactive ?? {}).map((target) => ({ layer: b.spec.id ?? '', type: b.spec.type, target, cls: this.classOf(b, target) })));
  }

  dispose(): void {
    this.disposed = true;
    for (const b of this.built) {
      try {
        b.component.dispose();
      } catch (err) {
        console.warn('[stage] dispose failed', err);
      }
    }
    this.built.length = 0;
    this.group.removeFromParent();
  }
}
