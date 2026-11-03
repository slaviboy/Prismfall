import type { MouseEvent } from 'react';

/**
 * Hover-to-focus for menu items, but only when the pointer actually moved. Browsers also fire
 * mouseenter when the layout shifts under a resting pointer (a row appears or disappears), which
 * would steal focus from keyboard and controller players mid-navigation.
 */
let lastMove = -Infinity;
let lastX = Number.NaN;
let lastY = Number.NaN;

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointermove',
    (e) => {
      if (e.clientX !== lastX || e.clientY !== lastY) {
        lastX = e.clientX;
        lastY = e.clientY;
        lastMove = performance.now();
      }
    },
    { capture: true, passive: true },
  );
}

/** True when the pointer moved within the last few frames. */
export function pointerRecentlyMoved(windowMs = 120): boolean {
  return performance.now() - lastMove < windowMs;
}

/** onMouseEnter handler: focus the hovered item if the player is using the mouse. */
export function hoverFocus(e: MouseEvent<HTMLElement>): void {
  if (pointerRecentlyMoved()) e.currentTarget.focus({ preventScroll: true });
}
