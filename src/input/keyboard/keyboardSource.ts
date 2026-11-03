import type { RawInputEvent } from '../types';

/**
 * Keyboard device source. Uses physical key codes (layout independent), ignores OS
 * auto-repeat, and synthesizes releases when the window loses focus.
 */
export class KeyboardSource {
  private readonly held = new Set<string>();
  private readonly onRaw: (e: RawInputEvent) => void;
  private readonly onFocusLost: () => void;
  /** Codes whose default browser action should be suppressed (bound gameplay keys). */
  preventDefaultCodes = new Set<string>();
  /** Rebinding capture: every key's default action is suppressed. */
  captureAll = false;
  /** Keys held when capture ended: their key-up is suppressed too (no stray button activation). */
  private readonly swallowUp = new Set<string>();

  endCaptureAll(): void {
    this.captureAll = false;
    for (const code of this.held) this.swallowUp.add(code);
  }
  private attached = false;

  constructor(onRaw: (e: RawInputEvent) => void, onFocusLost: () => void) {
    this.onRaw = onRaw;
    this.onFocusLost = onFocusLost;
  }

  private target: EventTarget | null = null;
  private doc: ({ visibilityState: DocumentVisibilityState } & EventTarget) | null = null;

  attach(target: EventTarget = window, doc: { visibilityState: DocumentVisibilityState } & EventTarget = document): void {
    if (this.attached) return;
    this.attached = true;
    this.target = target;
    this.doc = doc;
    target.addEventListener('keydown', this.handleDown as EventListener, { capture: true });
    target.addEventListener('keyup', this.handleUp as EventListener, { capture: true });
    target.addEventListener('blur', this.handleBlur);
    doc.addEventListener('visibilitychange', this.handleVisibility);
  }

  detach(): void {
    if (!this.attached || !this.target) return;
    this.attached = false;
    this.target.removeEventListener('keydown', this.handleDown as EventListener, { capture: true });
    this.target.removeEventListener('keyup', this.handleUp as EventListener, { capture: true });
    this.target.removeEventListener('blur', this.handleBlur);
    this.doc?.removeEventListener('visibilitychange', this.handleVisibility);
  }

  isHeld(code: string): boolean {
    return this.held.has(code);
  }

  private isTextField(target: EventTarget | null): boolean {
    if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
  }

  private readonly handleDown = (e: KeyboardEvent): void => {
    if (this.isTextField(e.target) && e.code !== 'Escape') return;
    if (this.captureAll || this.preventDefaultCodes.has(e.code)) e.preventDefault();
    if (e.repeat || this.held.has(e.code)) return;
    this.held.add(e.code);
    this.onRaw({ device: 'keyboard', pad: -1, control: e.code, down: true, time: e.timeStamp });
  };

  private readonly handleUp = (e: KeyboardEvent): void => {
    if (this.captureAll || this.swallowUp.delete(e.code) || this.preventDefaultCodes.has(e.code)) e.preventDefault();
    if (!this.held.delete(e.code)) return;
    this.onRaw({ device: 'keyboard', pad: -1, control: e.code, down: false, time: e.timeStamp });
  };

  /** Releases every held key (focus loss, visibility change, pause). */
  releaseAll(time = performance.now()): void {
    for (const code of [...this.held]) {
      this.held.delete(code);
      this.onRaw({ device: 'keyboard', pad: -1, control: code, down: false, time });
    }
  }

  private readonly handleBlur = (): void => {
    this.releaseAll();
    this.onFocusLost();
  };

  private readonly handleVisibility = (): void => {
    if (this.doc?.visibilityState === 'hidden') {
      this.releaseAll();
      this.onFocusLost();
    }
  };
}
