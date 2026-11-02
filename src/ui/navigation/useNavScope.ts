import { useEffect, useRef, type RefObject } from 'react';
import { useLatest } from '../useLatest';
import { focusFirst } from './MenuNavigator';

interface NavScopeOptions {
  onBack?: () => void;
  onTab?: (delta: number) => void;
  /** Focus the first (or data-autofocus) item on mount. */
  autoFocus?: boolean;
}

/** Last focused item per screen (scope test id → item test id), restored when the screen returns. */
const lastFocus = new Map<string, string>();

function focusInitial(el: HTMLElement): void {
  const key = el.dataset.testid;
  const remembered = key ? lastFocus.get(key) : undefined;
  const target = remembered ? el.querySelector<HTMLElement>(`[data-testid="${CSS.escape(remembered)}"]`) : null;
  if (target && !target.hasAttribute('disabled')) target.focus({ preventScroll: true });
  else focusFirst(el);
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
    // Remember the focused item when leaving, so coming back lands where the player was.
    const remember = (e: FocusEvent): void => {
      const id = (e.target as HTMLElement | null)?.dataset?.testid;
      if (el.dataset.testid && id) lastFocus.set(el.dataset.testid, id);
    };
    el.addEventListener('focusin', remember);
    const cleanup = (): void => {
      el.removeEventListener('navback', onBack);
      el.removeEventListener('navtab', onTab);
      el.removeEventListener('focusin', remember);
    };
    if (options.autoFocus !== false) {
      // Wait a frame so children are laid out.
      const id = requestAnimationFrame(() => focusInitial(el));
      return () => {
        cancelAnimationFrame(id);
        cleanup();
      };
    }
    return cleanup;
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
