import { useEffect, useRef, type RefObject } from 'react';
import { useLatest } from '../useLatest';
import { focusFirst } from './MenuNavigator';

interface NavScopeOptions {
  onBack?: () => void;
  onTab?: (delta: number) => void;
  /** Focus the first (or data-autofocus) item on mount. */
  autoFocus?: boolean;
}

/** Wires a container as a navigation scope: back/tab handlers and initial focus. */
export function useNavScope<T extends HTMLElement>(options: NavScopeOptions = {}): RefObject<T | null> {
  const ref = useRef<T>(null);
  const handlers = useLatest(options);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onBack = (e: Event): void => {
      if (handlers.current.onBack) {
        e.preventDefault();
        handlers.current.onBack();
      }
    };
    const onTab = (e: Event): void => handlers.current.onTab?.((e as CustomEvent<number>).detail);
    el.addEventListener('navback', onBack);
    el.addEventListener('navtab', onTab);
    if (options.autoFocus !== false) {
      // Wait a frame so children are laid out.
      const id = requestAnimationFrame(() => focusFirst(el));
      return () => {
        cancelAnimationFrame(id);
        el.removeEventListener('navback', onBack);
        el.removeEventListener('navtab', onTab);
      };
    }
    return () => {
      el.removeEventListener('navback', onBack);
      el.removeEventListener('navtab', onTab);
    };
  }, [options.autoFocus, handlers]);

  return ref;
}

/** Listens for left/right adjustments while an element is focused. */
export function useNavAdjust<T extends HTMLElement>(onAdjust: (delta: number) => void): RefObject<T | null> {
  const ref = useRef<T>(null);
  const cb = useLatest(onAdjust);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: Event): void => cb.current((e as CustomEvent<number>).detail);
    el.addEventListener('navadjust', handler);
    return () => el.removeEventListener('navadjust', handler);
  }, [cb]);
  return ref;
}
