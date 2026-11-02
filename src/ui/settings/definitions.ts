import type { Settings, SettingsSection } from '../../settings/schema';
import { ms, percent } from '../format';

export type SettingDef =
  | { kind: 'toggle'; section: SettingsSection; key: string; label: string; description?: string; when?: (s: Settings) => boolean }
  | {
      kind: 'slider';
      section: SettingsSection;
      key: string;
      label: string;
      description?: string;
      min: number;
      max: number;
      step: number;
      format?: (v: number) => string;
      when?: (s: Settings) => boolean;
    }
  | {
      kind: 'choice';
      section: SettingsSection;
      key: string;
      label: string;
      description?: string;
      options: readonly { value: string | number; label: string }[];
      when?: (s: Settings) => boolean;
    }
  | { kind: 'group'; label: string }
  | { kind: 'custom'; id: string };

export type TabId = 'gameplay' | 'controls' | 'controller' | 'graphics' | 'audio' | 'camera' | 'interface' | 'accessibility' | 'data' | 'developer';

export interface TabDef {
  readonly id: TabId;
  readonly label: string;
  readonly rows: readonly SettingDef[];
  /** Section restored by "Reset this tab". */
  readonly resets?: readonly SettingsSection[];
  readonly inGame?: boolean;
}

const sdf = (v: number): string => (v >= 41 ? 'Instant' : `${v}×`);

export const GAMEPLAY_TAB: TabDef = {
  id: 'gameplay',
  label: 'Gameplay',
  inGame: true,
  resets: ['gameplay'],
  rows: [
    { kind: 'group', label: 'Handling' },
    { kind: 'slider', section: 'gameplay', key: 'dasMs', label: 'Delayed auto shift', description: 'How long a direction is held before the piece starts sliding.', min: 0, max: 400, step: 1, format: ms },
    { kind: 'slider', section: 'gameplay', key: 'arrMs', label: 'Auto repeat rate', description: 'Time between steps while sliding. 0 moves straight to the wall.', min: 0, max: 100, step: 1, format: (v) => (v === 0 ? 'Instant' : ms(v)) },
    { kind: 'slider', section: 'gameplay', key: 'softDropFactor', label: 'Soft drop speed', description: 'Multiple of the current gravity while soft dropping.', min: 1, max: 41, step: 1, format: sdf },
    { kind: 'slider', section: 'gameplay', key: 'dasCutMs', label: 'Auto-shift pause after rotating', description: 'Briefly holds auto shift after spawning or rotating, to avoid overshooting.', min: 0, max: 200, step: 1, format: ms },
    { kind: 'toggle', section: 'gameplay', key: 'bufferInitialActions', label: 'Buffer rotate and hold', description: 'Rotate or hold pressed between pieces applies the moment the next piece appears.' },
    { kind: 'toggle', section: 'gameplay', key: 'bufferHardDrop', label: 'Buffer hard drop', description: 'A hard drop pressed between pieces drops the next piece immediately.' },
    { kind: 'toggle', section: 'gameplay', key: 'rotation180', label: '180° rotation', description: 'Enables the rotate 180° control.' },
    { kind: 'group', label: 'Playfield' },
    { kind: 'toggle', section: 'gameplay', key: 'showNext', label: 'Show next pieces' },
    { kind: 'slider', section: 'gameplay', key: 'nextCount', label: 'Next pieces shown', min: 1, max: 6, step: 1, when: (s) => s.gameplay.showNext },
    { kind: 'toggle', section: 'gameplay', key: 'showHold', label: 'Show hold piece' },
    { kind: 'toggle', section: 'gameplay', key: 'ghost', label: 'Ghost piece', description: 'Shows where the current piece will land.' },
    { kind: 'slider', section: 'gameplay', key: 'ghostOpacity', label: 'Ghost visibility', min: 0.1, max: 1, step: 0.05, format: percent, when: (s) => s.gameplay.ghost },
    { kind: 'toggle', section: 'gameplay', key: 'grid', label: 'Playfield grid' },
    { kind: 'toggle', section: 'gameplay', key: 'lockIndicator', label: 'Lock timer glow', description: 'The active piece dims as its lock delay runs out.' },
    { kind: 'slider', section: 'gameplay', key: 'effectsIntensity', label: 'Gameplay effects', description: 'Strength of line-clear, combo and landing effects.', min: 0, max: 1.5, step: 0.05, format: percent },
    { kind: 'toggle', section: 'gameplay', key: 'resumeCountdown', label: 'Countdown when resuming' },
  ],
};

export const INTERFACE_TAB: TabDef = {
  id: 'interface',
  label: 'Interface',
  inGame: true,
  resets: ['interface'],
  rows: [
    { kind: 'slider', section: 'interface', key: 'hudScale', label: 'HUD size', min: 0.75, max: 1.5, step: 0.05, format: percent },
    { kind: 'slider', section: 'interface', key: 'hudOpacity', label: 'HUD opacity', min: 0.3, max: 1, step: 0.05, format: percent },
    { kind: 'toggle', section: 'interface', key: 'mirrored', label: 'Mirror HUD layout', description: 'Swaps the hold and next sides.' },
    { kind: 'toggle', section: 'interface', key: 'showScore', label: 'Show score' },
    { kind: 'toggle', section: 'interface', key: 'showLevel', label: 'Show level' },
    { kind: 'toggle', section: 'interface', key: 'showLines', label: 'Show lines' },
    { kind: 'toggle', section: 'interface', key: 'showTime', label: 'Show timer' },
    { kind: 'toggle', section: 'interface', key: 'showCombo', label: 'Show combo and back-to-back' },
    { kind: 'toggle', section: 'interface', key: 'showCallouts', label: 'Show clear callouts' },
    { kind: 'toggle', section: 'interface', key: 'showPracticeStats', label: 'Show speed stats in Practice' },
    { kind: 'toggle', section: 'interface', key: 'menuAnimations', label: 'Menu animations' },
  ],
};

export const ACCESSIBILITY_TAB: TabDef = {
  id: 'accessibility',
  label: 'Accessibility',
  inGame: true,
  resets: ['accessibility'],
  rows: [
    {
      kind: 'choice',
      section: 'accessibility',
      key: 'reducedMotion',
      label: 'Reduced motion',
      description: 'Removes camera motion and shake, and calms animations.',
      options: [
        { value: 'system', label: 'Follow system' },
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ],
    },
    { kind: 'toggle', section: 'accessibility', key: 'flashReduction', label: 'Reduce flashing', description: 'Caps bright full-screen flashes and bloom surges.' },
    { kind: 'slider', section: 'accessibility', key: 'screenEffects', label: 'Screen effects', description: 'Shockwaves, colour fringing and full-screen pulses.', min: 0, max: 1, step: 0.05, format: percent },
    { kind: 'toggle', section: 'accessibility', key: 'highContrast', label: 'High-contrast piece colours', description: 'A colour-blind-safe palette with stronger separation.' },
    { kind: 'toggle', section: 'accessibility', key: 'pieceGlyphs', label: 'Piece symbols', description: 'Adds a distinct symbol to each piece type.' },
    { kind: 'slider', section: 'accessibility', key: 'backgroundDim', label: 'Background dimming', description: 'Darkens the world behind the playfield.', min: 0, max: 0.9, step: 0.05, format: percent },
    { kind: 'toggle', section: 'accessibility', key: 'visualAudioCues', label: 'Visual cues for sounds', description: 'Shows beat, danger and level-up sounds on screen.' },
  ],
};

export const DATA_TAB: TabDef = {
  id: 'data',
  label: 'Data',
  rows: [{ kind: 'custom', id: 'data' }],
};

/** Tabs registered so far; later milestones append graphics, audio, camera and controls. */
export const TABS: TabDef[] = [GAMEPLAY_TAB, INTERFACE_TAB, ACCESSIBILITY_TAB, DATA_TAB];

export function registerTab(tab: TabDef, before?: TabId): void {
  if (TABS.some((t) => t.id === tab.id)) return;
  const idx = before ? TABS.findIndex((t) => t.id === before) : -1;
  if (idx >= 0) TABS.splice(idx, 0, tab);
  else TABS.push(tab);
}
