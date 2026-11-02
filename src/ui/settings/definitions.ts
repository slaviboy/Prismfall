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

const scalePct = (v: number): string => `${Math.round(v * 100)}%`;

export const GRAPHICS_TAB: TabDef = {
  id: 'graphics',
  label: 'Graphics',
  inGame: true,
  resets: ['graphics'],
  rows: [
    {
      kind: 'choice',
      section: 'graphics',
      key: 'preset',
      label: 'Quality preset',
      description: 'Sets every option below. Changing any of them switches to Custom.',
      options: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'ultra', label: 'Ultra' },
        { value: 'custom', label: 'Custom' },
      ],
    },
    { kind: 'custom', id: 'graphicsInfo' },
    { kind: 'group', label: 'Resolution and frame rate' },
    { kind: 'slider', section: 'graphics', key: 'renderScale', label: 'Render resolution', description: 'Rendered pixels relative to your display. Below 100% is upscaled; above 100% supersamples.', min: 0.5, max: 2, step: 0.05, format: scalePct },
    { kind: 'choice', section: 'graphics', key: 'upscaler', label: 'Upscaling', description: 'How lower render resolutions are scaled up to the display.', options: [{ value: 'fsr1', label: 'FSR 1 (sharper)' }, { value: 'bilinear', label: 'Bilinear' }] },
    { kind: 'toggle', section: 'graphics', key: 'dynamicResolution', label: 'Dynamic resolution', description: 'Lowers render resolution automatically when the frame rate drops below the target.' },
    { kind: 'slider', section: 'graphics', key: 'dynamicTargetFps', label: 'Dynamic resolution target', min: 30, max: 240, step: 1, format: (v) => `${v} fps`, when: (s) => s.graphics.dynamicResolution },
    {
      kind: 'choice',
      section: 'graphics',
      key: 'fpsCap',
      label: 'Frame rate limit',
      description: 'The browser synchronises to your display (VSync) and cannot exceed its refresh rate. Limits that do not divide the refresh rate evenly cause judder.',
      options: [
        { value: 'display', label: 'Display refresh' },
        { value: 'half', label: 'Half refresh' },
        { value: 'third', label: 'Third refresh' },
        { value: '30', label: '30 fps' },
        { value: '60', label: '60 fps' },
        { value: '120', label: '120 fps' },
        { value: '144', label: '144 fps' },
      ],
    },
    { kind: 'group', label: 'Image quality' },
    { kind: 'choice', section: 'graphics', key: 'antialias', label: 'Anti-aliasing', description: 'MSAA is replaced by SMAA automatically while ambient occlusion or depth of field is on.', options: [{ value: 'none', label: 'Off' }, { value: 'fxaa', label: 'FXAA' }, { value: 'smaa', label: 'SMAA' }, { value: 'msaa', label: 'MSAA 4×' }] },
    { kind: 'toggle', section: 'graphics', key: 'postProcessing', label: 'Post-processing', description: 'Bloom, colour grading and screen effects.' },
    { kind: 'slider', section: 'graphics', key: 'bloom', label: 'Bloom intensity', min: 0, max: 2, step: 0.05, format: percent, when: (s) => s.graphics.postProcessing },
    { kind: 'choice', section: 'graphics', key: 'shadows', label: 'Shadow quality', options: [{ value: 'off', label: 'Off' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] },
    { kind: 'toggle', section: 'graphics', key: 'ambientOcclusion', label: 'Ambient occlusion', description: 'Screen-space contact shadows (GTAO).', when: (s) => s.graphics.postProcessing },
    { kind: 'choice', section: 'graphics', key: 'reflections', label: 'Reflection quality', options: [{ value: 'off', label: 'Off' }, { value: 'low', label: 'Low' }, { value: 'high', label: 'High' }, { value: 'ultra', label: 'Ultra' }] },
    { kind: 'toggle', section: 'graphics', key: 'depthOfField', label: 'Depth of field', description: 'Softly blurs the distant world. The playfield always stays sharp.', when: (s) => s.graphics.postProcessing },
    { kind: 'slider', section: 'graphics', key: 'motionBlur', label: 'Motion blur', description: 'World motion only, never applied to pieces.', min: 0, max: 1, step: 0.05, format: percent, when: (s) => s.graphics.postProcessing },
    { kind: 'toggle', section: 'graphics', key: 'screenSpaceEffects', label: 'Screen-space effects', description: 'Shockwave distortion and light streaks on big clears.' },
    { kind: 'group', label: 'World' },
    { kind: 'slider', section: 'graphics', key: 'particleDensity', label: 'Particle density', min: 0, max: 2, step: 0.05, format: percent },
    { kind: 'choice', section: 'graphics', key: 'environmentDetail', label: 'Environment detail', options: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'ultra', label: 'Ultra' }] },
    { kind: 'group', label: 'Renderer' },
    { kind: 'choice', section: 'graphics', key: 'backend', label: 'Graphics API', description: 'Applies after reloading the page. Auto uses WebGPU when available, otherwise WebGL 2.', options: [{ value: 'auto', label: 'Auto' }, { value: 'webgpu', label: 'WebGPU' }, { value: 'webgl2', label: 'WebGL 2' }] },
    { kind: 'toggle', section: 'graphics', key: 'showPerfOverlay', label: 'Performance overlay', description: 'Frame rate, frame time, GPU time and renderer details.' },
    { kind: 'custom', id: 'graphicsActions' },
  ],
};

export const CAMERA_TAB: TabDef = {
  id: 'camera',
  label: 'Camera',
  inGame: true,
  resets: ['camera'],
  rows: [
    { kind: 'slider', section: 'camera', key: 'zoom', label: 'Zoom', description: 'Never crops the playfield, hold or next pieces.', min: 0.8, max: 1.25, step: 0.01, format: percent },
    { kind: 'slider', section: 'camera', key: 'zoomSensitivity', label: 'Zoom sensitivity', description: 'Mouse wheel zoom speed during play.', min: 0.1, max: 2, step: 0.05, format: percent },
    { kind: 'slider', section: 'camera', key: 'distance', label: 'Camera distance', min: -4, max: 6, step: 0.1, format: (v) => (v === 0 ? 'Default' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`) },
    { kind: 'slider', section: 'camera', key: 'fov', label: 'Field of view', description: 'Lower values flatten perspective; the playfield size stays the same.', min: 30, max: 70, step: 1, format: (v) => `${v}°` },
    { kind: 'toggle', section: 'camera', key: 'shake', label: 'Camera shake' },
    { kind: 'slider', section: 'camera', key: 'shakeIntensity', label: 'Shake intensity', min: 0, max: 1, step: 0.05, format: percent, when: (s) => s.camera.shake },
    { kind: 'slider', section: 'camera', key: 'movementIntensity', label: 'Camera movement', description: 'Gentle sway and beat emphasis.', min: 0, max: 1, step: 0.05, format: percent },
  ],
};

registerTab(GRAPHICS_TAB, 'interface');
registerTab(CAMERA_TAB, 'interface');
