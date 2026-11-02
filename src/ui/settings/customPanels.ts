import type { ComponentType } from 'react';

/** Custom (non-generic) settings panels, registered by id from the modules that implement them. */
export const CUSTOM_PANELS: Record<string, ComponentType> = {};

export function registerCustomPanel(id: string, panel: ComponentType): void {
  CUSTOM_PANELS[id] = panel;
}
