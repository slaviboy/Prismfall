import { Group } from 'three/webgpu';
import { registries } from '../../sdk/registry';
import type { BeatInfo, CallInfo, EnvFrame, EnvironmentComponent, EnvironmentContext, StageGameEvent } from '../../sdk/types';
import type { Binding, LayerSpec, StageManifest } from '../../stages/schema';
import { reactivityProfile } from '../../stages/registry';
import { frameUniforms } from '../shaders/uniforms';
import { CallInDispatcher, type DispatchedCall } from './callins';
import { parseBindings, ReactivityLayer, type ReactivitySettings } from './reactivity';
import { clearStrength } from './worldSignals';

const DETAIL_RANK = { low: 0, medium: 1, high: 2, ultra: 3 } as const;

interface Built {
  readonly spec: LayerSpec;
  readonly component: EnvironmentComponent;
}

/** A built (GPU-ready) stage environment: its components, reactivity and presence fade. */
export class StageEnvironment {
  readonly group = new Group();
  readonly reactivity = new ReactivityLayer();
  readonly warnings: string[] = [];
  private readonly built: Built[] = [];
  /** Event call-ins (manifest `events`). */
  readonly calls: CallInDispatcher;
  presence = 0;
  /** The section last seen (kind and name), for onSection and section call-ins. */
  private section: { kind: string; name: string } | null = null;
  private clock = 0;
  private signalsPrimed = false;
  /** Set once disposed (a cached promise may still hand it out). */
  disposed = false;

  private constructor(
    readonly manifest: StageManifest,
    readonly ctx: EnvironmentContext,
  ) {
    this.group.name = `stage:${manifest.id}`;
    this.calls = new CallInDispatcher(manifest.events, manifest.phraseBars);
    for (const e of this.calls.errors) this.warnings.push(e);
  }

  static async build(manifest: StageManifest, ctx: EnvironmentContext, onProgress?: (fraction: number) => void): Promise<StageEnvironment> {
    const env = new StageEnvironment(manifest, ctx);
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
    for (const w of env.warnings) console.warn(`[stage ${manifest.id}]`, w);
    env.setPresence(0);
    return env;
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
        if (target) this.reactivity.add(binding, target);
      }
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
        this.reactivity.addState(state, target, fade);
        wired++;
      }
      // A layer left out at this detail level is not an error.
      const declared = this.manifest.environment.layers.some((l) => state.layer === '*' || state.layer === l.id || state.layer === `type:${l.type}`);
      if (wired === 0 && (!declared || this.select(state.layer).length > 0)) this.warnings.push(`section state: no layer "${state.layer}" exposes "${state.target}"`);
    }
  }

  private deliver(call: DispatchedCall): void {
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

  update(frame: EnvFrame, reactivity: ReactivitySettings): void {
    this.clock = frame.time;
    this.reactivity.update(frame.dt, frame.audio, frame.game, reactivity);
    this.trackSection(frame);
    const calls = this.calls;
    calls.worldEvents = frameUniforms.worldEvents.value;
    calls.bpm = frame.audio.bpm;
    calls.beatsPerBar = this.manifest.music.beatsPerBar;
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
