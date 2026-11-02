import { Group } from 'three/webgpu';
import { registries } from '../../sdk/registry';
import type { BeatInfo, EnvFrame, EnvironmentComponent, EnvironmentContext, StageGameEvent } from '../../sdk/types';
import type { Binding, LayerSpec, StageManifest } from '../../stages/schema';
import { reactivityProfile } from '../../stages/registry';
import { parseBindings, ReactivityLayer, type ReactivitySettings } from './reactivity';

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
  presence = 0;

  private constructor(
    readonly manifest: StageManifest,
    readonly ctx: EnvironmentContext,
  ) {
    this.group.name = `stage:${manifest.id}`;
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

  setPresence(v: number): void {
    this.presence = v;
    this.group.visible = v > 0.001;
    for (const b of this.built) b.component.setPresence?.(v);
  }

  update(frame: EnvFrame, reactivity: ReactivitySettings): void {
    this.reactivity.update(frame.dt, frame.audio, frame.game, reactivity);
    for (const b of this.built) b.component.update?.(frame);
  }

  onBeat(beat: BeatInfo): void {
    for (const b of this.built) b.component.onBeat?.(beat);
  }

  onGameEvent(event: StageGameEvent): void {
    for (const b of this.built) b.component.onGameEvent?.(event);
  }

  get componentCount(): number {
    return this.built.length;
  }

  dispose(): void {
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
