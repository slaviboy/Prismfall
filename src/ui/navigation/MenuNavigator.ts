import type { InputManager } from '../../input/inputManager';
import type { ActionEvent, MenuAction } from '../../input/types';

const FOCUSABLE = '[data-focusable]:not([disabled]):not([aria-disabled="true"])';
const REPEAT_DELAY = 360;
const REPEAT_INTERVAL = 85;

type Direction = 'up' | 'down' | 'left' | 'right';

/** Custom DOM events the navigator dispatches. */
export interface NavEvents {
  navback: CustomEvent<void>;
  navtab: CustomEvent<number>;
  navadjust: CustomEvent<number>;
}

/** Returns the active navigation scope: the last modal scope if any, else the last scope. */
export function activeScope(root: ParentNode = document): HTMLElement | null {
  const modals = root.querySelectorAll<HTMLElement>('[data-nav-scope][data-nav-modal]');
  if (modals.length > 0) return modals[modals.length - 1] ?? null;
  const scopes = root.querySelectorAll<HTMLElement>('[data-nav-scope]');
  return scopes.length > 0 ? (scopes[scopes.length - 1] ?? null) : null;
}

function focusables(scope: HTMLElement): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
}

export function focusFirst(scope: HTMLElement): void {
  const preferred = scope.querySelector<HTMLElement>(`[data-autofocus]${FOCUSABLE.slice('[data-focusable]'.length)}`);
  const target = preferred ?? focusables(scope)[0];
  target?.focus({ preventScroll: false });
}

/** Picks the nearest focusable in a direction (weighted toward the primary axis). */
export function findInDirection(from: DOMRect, candidates: readonly { el: HTMLElement; rect: DOMRect }[], dir: Direction): HTMLElement | null {
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const { el, rect } of candidates) {
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    let primary: number;
    let secondary: number;
    switch (dir) {
      case 'up': primary = -dy; secondary = Math.abs(dx); break;
      case 'down': primary = dy; secondary = Math.abs(dx); break;
      case 'left': primary = -dx; secondary = Math.abs(dy); break;
      case 'right': primary = dx; secondary = Math.abs(dy); break;
    }
    if (primary <= 1) continue;
    const score = primary + secondary * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/**
 * Drives DOM focus from menu actions (keyboard arrows, gamepad d-pad/stick) with held repeat.
 * Screens mark regions with data-nav-scope and items with data-focusable.
 */
export class MenuNavigator {
  private repeatTimer: ReturnType<typeof setTimeout> | null = null;
  private repeatAction: MenuAction | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Called after any navigation action (UI sounds). */
  onNavigate: ((kind: 'move' | 'confirm' | 'back' | 'tab' | 'adjust' | 'blocked') => void) | null = null;

  constructor(private readonly input: InputManager) {}

  attach(): void {
    this.unsubscribe = this.input.onMenu((e) => this.handle(e));
  }

  detach(): void {
    this.unsubscribe?.();
    this.stopRepeat();
  }

  private handle(e: ActionEvent<MenuAction>): void {
    if (!e.down) {
      if (this.repeatAction === e.action) this.stopRepeat();
      return;
    }
    this.perform(e.action);
    if (e.action === 'up' || e.action === 'down' || e.action === 'left' || e.action === 'right') {
      this.stopRepeat();
      this.repeatAction = e.action;
      const loop = (delay: number): void => {
        this.repeatTimer = setTimeout(() => {
          if (this.repeatAction !== e.action) return;
          this.perform(e.action);
          loop(REPEAT_INTERVAL);
        }, delay);
      };
      loop(REPEAT_DELAY);
    }
  }

  private stopRepeat(): void {
    if (this.repeatTimer) clearTimeout(this.repeatTimer);
    this.repeatTimer = null;
    this.repeatAction = null;
  }

  perform(action: MenuAction): void {
    const scope = activeScope();
    if (!scope) return;
    const active = document.activeElement instanceof HTMLElement && scope.contains(document.activeElement) ? document.activeElement : null;
    switch (action) {
      case 'confirm':
        if (active) {
          active.click();
          this.onNavigate?.('confirm');
        }
        return;
      case 'back': {
        const ev = new CustomEvent('navback', { cancelable: true });
        scope.dispatchEvent(ev);
        this.onNavigate?.('back');
        return;
      }
      case 'tabPrev':
      case 'tabNext':
        scope.dispatchEvent(new CustomEvent('navtab', { detail: action === 'tabNext' ? 1 : -1 }));
        this.onNavigate?.('tab');
        return;
      default:
        break;
    }
    if (!active) {
      focusFirst(scope);
      this.onNavigate?.('move');
      return;
    }
    if ((action === 'left' || action === 'right') && active.hasAttribute('data-nav-adjust')) {
      active.dispatchEvent(new CustomEvent('navadjust', { detail: action === 'right' ? 1 : -1, bubbles: true }));
      this.onNavigate?.('adjust');
      return;
    }
    const candidates = focusables(scope)
      .filter((el) => el !== active)
      .map((el) => ({ el, rect: el.getBoundingClientRect() }));
    const from = active.getBoundingClientRect();
    let target = findInDirection(from, candidates, action as Direction);
    if (!target && (action === 'up' || action === 'down')) {
      // Wrap vertically within the same column.
      const column = candidates.filter((c) => Math.abs(c.rect.left - from.left) < 40);
      const sorted = column.sort((a, b) => a.rect.top - b.rect.top);
      target = (action === 'down' ? sorted[0] : sorted[sorted.length - 1])?.el ?? null;
    }
    if (target) {
      target.focus({ preventScroll: false });
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      this.onNavigate?.('move');
    } else {
      this.onNavigate?.('blocked');
    }
  }
}
