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

export type TabId = 'gameplay' | 'controls' | 'controller' | 'vr' | 'graphics' | 'audio' | 'reactivity' | 'camera' | 'interface' | 'accessibility' | 'data' | 'developer';

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
    {
      kind: 'choice',
      section: 'graphics',
      key: 'blockStyle',
      label: 'Block style',
      description: 'World theme gives each world its own blocks (wood, ice, sandstone and more). Classic uses the traditional colours and glass blocks everywhere.',
      options: [
        { value: 'stage', label: 'World theme' },
        { value: 'classic', label: 'Classic' },
      ],
    },
    { kind: 'slider', section: 'graphics', key: 'blockGlow', label: 'Block glow', description: 'How brightly the pieces glow on their own. Lower values give calmer, more solid blocks.', min: 0, max: 1.5, step: 0.05, format: percent },
    { kind: 'slider', section: 'graphics', key: 'bloom', label: 'Bloom intensity', min: 0, max: 2, step: 0.05, format: percent, when: (s) => s.graphics.postProcessing },
    { kind: 'choice', section: 'graphics', key: 'shadows', label: 'Shadow quality', options: [{ value: 'off', label: 'Off' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] },
    { kind: 'toggle', section: 'graphics', key: 'ambientOcclusion', label: 'Ambient occlusion', description: 'Screen-space contact shadows (GTAO).', when: (s) => s.graphics.postProcessing },
    { kind: 'toggle', section: 'graphics', key: 'depthOfField', label: 'Depth of field', description: 'Softly blurs the distant world. The playfield always stays sharp.', when: (s) => s.graphics.postProcessing },
    { kind: 'slider', section: 'graphics', key: 'motionBlur', label: 'Motion blur', description: 'Blurs the world behind the playfield as the camera and creatures move. Never applied to the playfield, and off while reduced motion is on.', min: 0, max: 1, step: 0.05, format: (v) => (v === 0 ? 'Off' : percent(v)), when: (s) => s.graphics.postProcessing },
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
    { kind: 'slider', section: 'camera', key: 'movementIntensity', label: 'Camera movement', description: 'Gentle sway, beat emphasis and push-ins on big clears. Off keeps the playfield still.', min: 0, max: 1, step: 0.05, format: percent },
  ],
};

const signedMs = (v: number): string => (v === 0 ? 'None' : `${v > 0 ? '+' : ''}${v} ms`);

export const AUDIO_TAB: TabDef = {
  id: 'audio',
  label: 'Audio',
  inGame: true,
  resets: ['audio'],
  rows: [
    { kind: 'toggle', section: 'audio', key: 'enabled', label: 'Sound', description: 'Turns all game audio on or off. Off also stops audio processing.' },
    { kind: 'toggle', section: 'audio', key: 'muted', label: 'Mute', description: 'Silences the output but keeps the music running, so it is still in time when you unmute.', when: (s) => s.audio.enabled },
    { kind: 'group', label: 'Volume' },
    { kind: 'slider', section: 'audio', key: 'master', label: 'Master volume', min: 0, max: 1, step: 0.01, format: percent },
    { kind: 'slider', section: 'audio', key: 'music', label: 'Music', min: 0, max: 1, step: 0.01, format: percent },
    { kind: 'slider', section: 'audio', key: 'sfx', label: 'Sound effects', min: 0, max: 1, step: 0.01, format: percent },
    { kind: 'slider', section: 'audio', key: 'ambience', label: 'Ambience', description: 'Each world\u2019s background sound: waves, wind, machinery.', min: 0, max: 1, step: 0.01, format: percent },
    { kind: 'slider', section: 'audio', key: 'hardDrop', label: 'Hard drop and landing', description: 'Block impacts within the sound effects: hard drops, landings and locks.', min: 0, max: 1, step: 0.01, format: percent },
    { kind: 'slider', section: 'audio', key: 'stageFx', label: 'World effects', description: 'Sounds that belong to each world: its answer to big clears and the creatures walking through it.', min: 0, max: 1, step: 0.01, format: percent },
    { kind: 'slider', section: 'audio', key: 'menu', label: 'Menu sounds', min: 0, max: 1, step: 0.01, format: percent },
    { kind: 'group', label: 'Music' },
    { kind: 'toggle', section: 'audio', key: 'adaptiveMusic', label: 'Adaptive music', description: 'Layers join as you play: rhythm on active play, emphasis on combos, a climax on big clears. Off keeps one steady arrangement.' },
    { kind: 'slider', section: 'audio', key: 'musicIntensity', label: 'Music intensity', description: 'How far the music builds with your play.', min: 0.5, max: 1.5, step: 0.05, format: percent },
    { kind: 'group', label: 'Sound effects' },
    { kind: 'slider', section: 'audio', key: 'sfxVariation', label: 'Sound variation', description: 'Small pitch and level changes between repeats so long sessions don\u2019t sound repetitive.', min: 0, max: 1, step: 0.05, format: percent },
    { kind: 'toggle', section: 'audio', key: 'spatialAudio', label: 'Spatial audio', description: 'Places creature and world sounds around you in 3D. Best with headphones.' },
    { kind: 'custom', id: 'audioTest' },
    { kind: 'group', label: 'Behaviour' },
    {
      kind: 'choice',
      section: 'audio',
      key: 'pauseBehavior',
      label: 'Music while paused',
      options: [
        { value: 'duck', label: 'Quieter and muffled' },
        { value: 'stop', label: 'Stop' },
      ],
    },
    { kind: 'toggle', section: 'audio', key: 'musicPreview', label: 'Preview music while choosing', description: 'Browsing worlds plays each world’s music; otherwise the current music keeps playing until the game starts.' },
    {
      kind: 'toggle',
      section: 'audio',
      key: 'sfxAccentLayer',
      label: 'Musical clear accents',
      description: 'Line clears and spins also play a short phrase in the music\u2019s key, timed to the beat. The main sound effects always play instantly.',
    },
    { kind: 'group', label: 'Timing' },
    {
      kind: 'slider',
      section: 'audio',
      key: 'latencyOffsetMs',
      label: 'Audio offset',
      description: 'Shifts when music-reactive visuals and beat effects happen. Raise it if visuals land before the beat you hear (Bluetooth headphones need more).',
      min: -250,
      max: 250,
      step: 1,
      format: signedMs,
    },
    { kind: 'custom', id: 'latencyCalibration' },
  ],
};

export const REACTIVITY_TAB: TabDef = {
  id: 'reactivity',
  label: 'Reactivity',
  inGame: true,
  resets: ['reactivity'],
  rows: [
    { kind: 'toggle', section: 'reactivity', key: 'enabled', label: 'Music-reactive worlds', description: 'Environments, particles and lights respond to the music. Gameplay effects are unaffected.' },
    {
      kind: 'choice',
      section: 'reactivity',
      key: 'preset',
      label: 'Reaction style',
      description: 'The character of the response. The sliders below fine-tune any style.',
      options: [
        { value: 'cinematic', label: 'Cinematic' },
        { value: 'subtle', label: 'Subtle' },
        { value: 'energetic', label: 'Energetic' },
        { value: 'ambient', label: 'Ambient' },
        { value: 'hypnotic', label: 'Hypnotic' },
        { value: 'intense', label: 'Intense' },
        { value: 'custom', label: 'Neutral (sliders only)' },
      ],
      when: (s) => s.reactivity.enabled,
    },
    { kind: 'slider', section: 'reactivity', key: 'strength', label: 'Overall strength', min: 0, max: 2, step: 0.05, format: percent, when: (s) => s.reactivity.enabled },
    { kind: 'group', label: 'Sensitivity' },
    { kind: 'slider', section: 'reactivity', key: 'bassSensitivity', label: 'Bass', description: 'Low-frequency swells: breathing, heavy motion.', min: 0, max: 2, step: 0.05, format: percent, when: (s) => s.reactivity.enabled },
    { kind: 'slider', section: 'reactivity', key: 'trebleSensitivity', label: 'Treble', description: 'High-frequency detail: sparkle and shimmer.', min: 0, max: 2, step: 0.05, format: percent, when: (s) => s.reactivity.enabled },
    { kind: 'slider', section: 'reactivity', key: 'beatSensitivity', label: 'Beats and hits', description: 'Pulses on beats, drum hits and sudden changes.', min: 0, max: 2, step: 0.05, format: percent, when: (s) => s.reactivity.enabled },
    { kind: 'group', label: 'Response' },
    { kind: 'slider', section: 'reactivity', key: 'particleResponse', label: 'Particles', min: 0, max: 2, step: 0.05, format: percent, when: (s) => s.reactivity.enabled },
    { kind: 'slider', section: 'reactivity', key: 'environmentResponse', label: 'Environment', min: 0, max: 2, step: 0.05, format: percent, when: (s) => s.reactivity.enabled },
    { kind: 'slider', section: 'reactivity', key: 'lightingResponse', label: 'Lighting', min: 0, max: 2, step: 0.05, format: percent, when: (s) => s.reactivity.enabled },
    { kind: 'group', label: 'Analysis' },
    {
      kind: 'choice',
      section: 'reactivity',
      key: 'analysisPath',
      label: 'Analysis method',
      description: 'Auto uses an audio worklet, which analyses at a fixed rate independent of the frame rate, and falls back to an analyser node.',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'worklet', label: 'Audio worklet' },
        { value: 'analyser', label: 'Analyser node' },
      ],
    },
    {
      kind: 'choice',
      section: 'reactivity',
      key: 'fftSize',
      label: 'Low-frequency resolution',
      description: 'The long analysis window for sub-bass and bass. 4096 separates bass notes better; 2048 reacts slightly sooner.',
      options: [
        { value: 4096, label: '4096 (finer)' },
        { value: 2048, label: '2048 (faster)' },
      ],
    },
    { kind: 'custom', id: 'analysisInfo' },
  ],
};

registerTab(GRAPHICS_TAB, 'interface');
registerTab(CAMERA_TAB, 'interface');
registerTab(AUDIO_TAB, 'interface');
registerTab(REACTIVITY_TAB, 'interface');

export const DEVELOPER_TAB: TabDef = {
  id: 'developer',
  label: 'Developer',
  inGame: true,
  rows: [
    { kind: 'toggle', section: 'developer', key: 'audioDashboard', label: 'Audio analysis dashboard', description: 'Spectrum, band meters, onsets, tempo, beat phase and the stage\u2019s live reactivity bindings, with tuning sliders. F9 toggles it.' },
    { kind: 'toggle', section: 'graphics', key: 'showPerfOverlay', label: 'Performance overlay', description: 'Frame rate, frame time, GPU time and renderer details.' },
    { kind: 'custom', id: 'contentReport' },
  ],
};

registerTab(DEVELOPER_TAB);

export const CONTROLS_TAB: TabDef = {
  id: 'controls',
  label: 'Controls',
  inGame: true,
  rows: [{ kind: 'custom', id: 'controls' }],
};

export const CONTROLLER_TAB: TabDef = {
  id: 'controller',
  label: 'Controller',
  inGame: true,
  resets: ['controller'],
  rows: [
    { kind: 'custom', id: 'controller' },
    { kind: 'group', label: 'Sticks and triggers' },
    { kind: 'slider', section: 'controller', key: 'deadzoneInner', label: 'Stick dead zone', description: 'Stick movement ignored around the centre. Raise it if pieces drift on their own.', min: 0, max: 0.6, step: 0.01, format: percent },
    { kind: 'slider', section: 'controller', key: 'deadzoneOuter', label: 'Stick outer edge', description: 'Where the stick counts as fully pushed.', min: 0.7, max: 1, step: 0.01, format: percent },
    { kind: 'slider', section: 'controller', key: 'stickThreshold', label: 'Stick sensitivity', description: 'How far the stick must be pushed to move a piece. Lower is more sensitive.', min: 0.2, max: 0.95, step: 0.01, format: percent },
    { kind: 'slider', section: 'controller', key: 'triggerThreshold', label: 'Trigger threshold', description: 'How far a trigger must be pulled to count as pressed.', min: 0.05, max: 0.95, step: 0.01, format: percent },
    { kind: 'toggle', section: 'controller', key: 'highRatePolling', label: 'Precise input timing', description: 'Reads the controller about 250 times a second instead of once per frame, so presses are timed more exactly.' },
    { kind: 'group', label: 'Feedback and buttons' },
    { kind: 'toggle', section: 'controller', key: 'rumble', label: 'Rumble', description: 'Vibration on hard drops, clears and danger, when the controller supports it.' },
    { kind: 'slider', section: 'controller', key: 'rumbleStrength', label: 'Rumble strength', min: 0, max: 1, step: 0.05, format: percent, when: (s) => s.controller.rumble },
    { kind: 'toggle', section: 'controller', key: 'swapConfirmBack', label: 'Swap confirm and back', description: 'Use the right face button to confirm and the bottom one to go back in menus.' },
  ],
};

const metres = (v: number): string => `${v.toFixed(2)} m`;
const degrees = (v: number): string => `${Math.round(v)}\u00b0`;

export const VR_TAB: TabDef = {
  id: 'vr',
  label: 'VR',
  inGame: true,
  resets: ['vr'],
  rows: [
    { kind: 'custom', id: 'vrStatus' },
    { kind: 'group', label: 'Playfield' },
    {
      kind: 'choice',
      section: 'vr',
      key: 'layout',
      label: 'Play position',
      description: 'Seated brings the playfield to your eye level wherever you sit. Standing uses your real height above the floor.',
      options: [
        { value: 'seated', label: 'Seated' },
        { value: 'standing', label: 'Standing' },
      ],
    },
    { kind: 'slider', section: 'vr', key: 'boardDistance', label: 'Distance', description: 'How far the playfield floats in front of you.', min: 0.5, max: 3, step: 0.05, format: metres },
    { kind: 'slider', section: 'vr', key: 'boardHeight', label: 'Height', description: 'Raise or lower the playfield relative to your eyes.', min: -0.6, max: 0.6, step: 0.01, format: metres },
    { kind: 'slider', section: 'vr', key: 'boardScale', label: 'Size', description: '100% is about one metre tall.', min: 0.5, max: 2, step: 0.05, format: percent },
    { kind: 'slider', section: 'vr', key: 'boardTilt', label: 'Tilt', description: 'Lean the top of the playfield away from you.', min: -30, max: 30, step: 1, format: degrees },
    { kind: 'group', label: 'Score panel' },
    { kind: 'slider', section: 'vr', key: 'hudOffset', label: 'Panel distance', description: 'How far the score panel sits in front of the playfield.', min: -0.3, max: 0.5, step: 0.01, format: metres },
    { kind: 'slider', section: 'vr', key: 'hudScale', label: 'Panel size', min: 0.5, max: 2, step: 0.05, format: percent },
    { kind: 'group', label: 'Comfort and quality' },
    {
      kind: 'choice',
      section: 'vr',
      key: 'graphics',
      label: 'VR graphics',
      description: 'Performance keeps the frame rate steady on standalone headsets; Quality renders sharper for PC VR.',
      options: [
        { value: 'performance', label: 'Performance' },
        { value: 'balanced', label: 'Balanced' },
        { value: 'quality', label: 'Quality' },
      ],
    },
    { kind: 'slider', section: 'vr', key: 'dimWorld', label: 'Dim the world', description: 'Darkens the surroundings so the playfield stands out. The camera never moves in VR, and there is no shake or motion blur.', min: 0, max: 0.8, step: 0.05, format: percent },
    { kind: 'toggle', section: 'vr', key: 'haptics', label: 'Controller vibration', description: 'Pulses on hard drops, locks and clears.' },
    { kind: 'slider', section: 'vr', key: 'hapticStrength', label: 'Vibration strength', min: 0, max: 1, step: 0.05, format: percent, when: (s) => s.vr.haptics },
    { kind: 'toggle', section: 'vr', key: 'showRays', label: 'Pointer rays', description: 'Lines from the controllers for pointing at menus.' },
    { kind: 'group', label: 'Controller sensitivity' },
    { kind: 'slider', section: 'vr', key: 'stickThreshold', label: 'Stick sensitivity', description: 'How far a thumbstick (or touchpad) must be pushed to move a piece. Lower is more sensitive.', min: 0.2, max: 0.9, step: 0.01, format: percent },
    { kind: 'slider', section: 'vr', key: 'triggerThreshold', label: 'Trigger threshold', description: 'How far a trigger or grip must be pulled to count as pressed.', min: 0.1, max: 0.9, step: 0.01, format: percent },
    { kind: 'custom', id: 'vrBindings' },
  ],
};

registerTab(CONTROLS_TAB, 'graphics');
registerTab(CONTROLLER_TAB, 'graphics');
registerTab(VR_TAB, 'graphics');
