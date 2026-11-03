import type { ComponentFactory, LineClearEffect, Registry, SdkRegistries, TransitionEffect } from './types';

/** Simple keyed registry; later registrations of the same key replace earlier ones (stage overrides). */
export class KeyedRegistry<T extends { readonly id?: string; readonly type?: string }> implements Registry<T> {
  private readonly items = new Map<string, T>();

  constructor(private readonly label: string) {}

  private keyOf(item: T): string {
    const key = item.type ?? item.id;
    if (!key) throw new Error(`${this.label}: item has no id/type`);
    return key;
  }

  register(item: T): void {
    this.items.set(this.keyOf(item), item);
  }

  get(key: string): T | undefined {
    return this.items.get(key);
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  keys(): string[] {
    return [...this.items.keys()];
  }
}

/** The global registries content and built-ins register into. */
export const registries: SdkRegistries = {
  components: new KeyedRegistry<ComponentFactory>('components'),
  lineClearEffects: new KeyedRegistry<LineClearEffect>('lineClearEffects'),
  transitions: new KeyedRegistry<TransitionEffect>('transitions'),
};
