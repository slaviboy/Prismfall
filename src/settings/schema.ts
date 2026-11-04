import { z } from 'zod';

/**
 * Persistent settings. Every field has a default so partial or older data parses
 * into a complete object; `migrateSettings` handles structural changes between versions.
 */
export const SETTINGS_VERSION = 5;

export const INPUT_ACTIONS = [
  'moveLeft',
  'moveRight',
  'softDrop',
  'hardDrop',
  'rotateCW',
  'rotateCCW',
  'rotate180',
  'hold',
  'pause',
  'practiceUndo',
  'practiceReset',
  'confirm',
  'back',
] as const;
export type InputAction = (typeof INPUT_ACTIONS)[number];

export const MENU_DIRECTIONS = ['up', 'down', 'left', 'right', 'tabPrev', 'tabNext'] as const;
export type MenuDirection = (typeof MENU_DIRECTIONS)[number];

const n = (min: number, max: number, def: number) => z.number().min(min).max(max).catch(def).default(def);
const b = (def: boolean) => z.boolean().catch(def).default(def);
const e = <T extends readonly [string, ...string[]]>(values: T, def: T[number]) => z.enum(values).catch(def).default(def);

const bindingList = (def: string[]) => z.array(z.string()).max(2).catch(def).default(def);

export const DEFAULT_KEYBOARD: Record<InputAction, string[]> = {
  moveLeft: ['ArrowLeft'],
  moveRight: ['ArrowRight'],
  softDrop: ['ArrowDown'],
  hardDrop: ['Space'],
  rotateCW: ['ArrowUp', 'KeyX'],
  rotateCCW: ['KeyZ', 'ControlLeft'],
  rotate180: ['KeyA'],
  hold: ['KeyC', 'ShiftLeft'],
  pause: ['Escape', 'KeyP'],
  practiceUndo: ['Backspace'],
  practiceReset: ['KeyR'],
  confirm: ['Enter', 'NumpadEnter'],
  back: ['Escape', 'Backspace'],
};

/** Gamepad bindings use "button:<index>" or "axis:<index>:<+|->" on the standard mapping. */
export const DEFAULT_GAMEPAD: Record<InputAction, string[]> = {
  moveLeft: ['button:14', 'axis:0:-'],
  moveRight: ['button:15', 'axis:0:+'],
  softDrop: ['button:13', 'axis:1:+'],
  hardDrop: ['button:12'],
  rotateCW: ['button:0'],
  rotateCCW: ['button:1', 'button:2'],
  rotate180: ['button:3'],
  hold: ['button:4', 'button:5'],
  pause: ['button:9'],
  practiceUndo: ['button:8'],
  practiceReset: [],
  confirm: ['button:0'],
  back: ['button:1'],
};

/**
 * VR controller bindings: "xr:<left|right>:<control>" with controls trigger, squeeze, a, b (right),
 * x, y (left), stick-press and stick-left/right/up/down (thumbstick or touchpad).
 */
export const DEFAULT_XR: Record<InputAction, string[]> = {
  moveLeft: ['xr:left:stick-left', 'xr:right:stick-left'],
  moveRight: ['xr:left:stick-right', 'xr:right:stick-right'],
  softDrop: ['xr:left:stick-down', 'xr:right:stick-down'],
  hardDrop: ['xr:right:a', 'xr:right:stick-up'],
  rotateCW: ['xr:right:trigger'],
  rotateCCW: ['xr:left:trigger'],
  rotate180: [],
  hold: ['xr:right:squeeze', 'xr:left:squeeze'],
  // Stick press (or a touchpad centre press) pauses on controllers without face buttons.
  pause: ['xr:left:y', 'xr:left:stick-press'],
  practiceUndo: ['xr:left:x'],
  practiceReset: [],
  confirm: ['xr:right:trigger', 'xr:right:a'],
  back: ['xr:right:b', 'xr:left:y'],
};

const bindingsSchema = (defaults: Record<InputAction, string[]>) =>
  z
    .object(Object.fromEntries(INPUT_ACTIONS.map((a) => [a, bindingList(defaults[a])])) as Record<InputAction, ReturnType<typeof bindingList>>)
    .prefault({});

/** Remapping for a specific non-standard pad: logical standard id -> raw control on that pad. */
const padProfileSchema = z.object({
  name: z.string().catch('Controller'),
  /** Button-name style; 'auto' follows the detected controller. */
  family: e(['auto', 'playstation', 'xbox', 'generic'] as const, 'auto'),
  rawMap: z.record(z.string(), z.string()).catch({}).default({}),
});

/** One player-made level. Unknown worlds, tracks or designs fall back to the world's own at play time. */
export const customLevelSchema = z.object({
  id: z.string().catch(''),
  name: z.string().max(40).catch('My level').default('My level'),
  stageId: z.string().catch(''),
  /** 'stage' = the world's music, or a music catalogue id ("stage:<world>:<track>", "user:<id>"). */
  music: z.string().catch('stage').default('stage'),
  /** 'stage' = the world's blocks, or a BLOCK_DESIGNS id. */
  blocks: z.string().catch('stage').default('stage'),
  created: z.number().catch(0).default(0),
});
export type CustomLevel = z.infer<typeof customLevelSchema>;

export const settingsSchema = z.object({
  version: z.number().catch(SETTINGS_VERSION).default(SETTINGS_VERSION),
  gameplay: z
    .object({
      showNext: b(true),
      nextCount: n(1, 6, 5),
      showHold: b(true),
      ghost: b(true),
      ghostOpacity: n(0.1, 1, 0.5),
      grid: b(true),
      dasMs: n(0, 500, 167),
      arrMs: n(0, 200, 33),
      /** 41 = instant (sonic) soft drop. */
      softDropFactor: n(1, 41, 20),
      dasCutMs: n(0, 250, 0),
      rotation180: b(false),
      bufferInitialActions: b(true),
      bufferHardDrop: b(true),
      effectsIntensity: n(0, 1.5, 1),
      resumeCountdown: b(true),
      lockIndicator: b(true),
      mouseControl: b(false),
    })
    .prefault({}),
  keyboard: bindingsSchema(DEFAULT_KEYBOARD),
  gamepad: bindingsSchema(DEFAULT_GAMEPAD),
  xr: bindingsSchema(DEFAULT_XR),
  vr: z
    .object({
      /** Seated: the board comes to you (local space). Standing: floor-relative layout. */
      layout: e(['seated', 'standing'] as const, 'seated'),
      /** Metres from your eyes to the playfield. */
      boardDistance: n(0.5, 3, 1.1),
      /** Metres above (+) or below (−) eye level for the playfield centre. */
      boardHeight: n(-0.6, 0.6, -0.08),
      /** 1 = the playfield is one metre tall. */
      boardScale: n(0.5, 2, 1),
      /** Degrees the playfield leans back. */
      boardTilt: n(-30, 30, 6),
      /** Score panel distance in front of the playfield (metres) and size. */
      hudOffset: n(-0.3, 0.5, 0.04),
      hudScale: n(0.5, 2, 1),
      graphics: e(['performance', 'balanced', 'quality'] as const, 'balanced'),
      haptics: b(true),
      hapticStrength: n(0, 1, 0.6),
      /** Darkens the world around the playfield for focus (0 = off). */
      dimWorld: n(0, 0.8, 0),
      showRays: b(true),
      /** Stick push and trigger pull needed to register (lower = more sensitive). */
      stickThreshold: n(0.2, 0.9, 0.55),
      triggerThreshold: n(0.1, 0.9, 0.55),
    })
    .prefault({}),
  controller: z
    .object({
      activePadId: z.string().nullable().catch(null).default(null),
      ignoredPadIds: z.array(z.string()).catch([]).default([]),
      deadzoneInner: n(0, 0.6, 0.22),
      deadzoneOuter: n(0.7, 1, 0.95),
      stickThreshold: n(0.2, 0.95, 0.55),
      triggerThreshold: n(0.05, 0.95, 0.35),
      rumble: b(true),
      rumbleStrength: n(0, 1, 0.7),
      swapConfirmBack: b(false),
      highRatePolling: b(true),
      profiles: z.record(z.string(), padProfileSchema).catch({}).default({}),
    })
    .prefault({}),
  graphics: z
    .object({
      preset: e(['low', 'medium', 'high', 'ultra', 'custom'] as const, 'high'),
      backend: e(['auto', 'webgpu', 'webgl2'] as const, 'auto'),
      renderScale: n(0.5, 2, 1),
      dynamicResolution: b(false),
      dynamicTargetFps: n(30, 240, 60),
      fpsCap: e(['display', 'half', 'third', '30', '60', '120', '144'] as const, 'display'),
      antialias: e(['none', 'fxaa', 'smaa', 'msaa'] as const, 'msaa'),
      bloom: n(0, 2, 1),
      blockGlow: n(0, 1.5, 0.6),
      /** 'stage' = each world's block theme; 'classic' = traditional colours and glass blocks everywhere. */
      blockStyle: e(['stage', 'classic'] as const, 'stage'),
      /** A design from BLOCK_DESIGNS used in every world; '' = each world's own design. */
      blockDesign: z.string().catch('').default(''),
      shadows: e(['off', 'low', 'medium', 'high'] as const, 'medium'),
      particleDensity: n(0, 2, 1),
      environmentDetail: e(['low', 'medium', 'high', 'ultra'] as const, 'high'),
      reflections: e(['off', 'low', 'high', 'ultra'] as const, 'low'),
      ambientOcclusion: b(false),
      postProcessing: b(true),
      motionBlur: n(0, 1, 0),
      depthOfField: b(false),
      screenSpaceEffects: b(true),
      upscaler: e(['bilinear', 'fsr1'] as const, 'fsr1'),
      showPerfOverlay: b(false),
    })
    .prefault({}),
  camera: z
    .object({
      zoom: n(0.8, 1.25, 1),
      zoomSensitivity: n(0.1, 2, 1),
      distance: n(-4, 6, 0),
      fov: n(30, 70, 42),
      shake: b(false),
      shakeIntensity: n(0, 1, 0.6),
      movementIntensity: n(0, 1, 0),
    })
    .prefault({}),
  audio: z
    .object({
      enabled: b(true),
      muted: b(false),
      master: n(0, 1, 0.8),
      music: n(0, 1, 0.8),
      sfx: n(0, 1, 0.75),
      ambience: n(0, 1, 0.6),
      /** Hard drops, landings and locks (within gameplay effects). */
      hardDrop: n(0, 1, 0.8),
      /** World-specific effects: signature clears, creature sounds. */
      stageFx: n(0, 1, 0.7),
      menu: n(0, 1, 0.7),
      /** Scales how strongly the music builds with gameplay (0.5 calm .. 1.5 intense). */
      musicIntensity: n(0.5, 1.5, 1),
      /** Music layers follow the game; off = a steady arrangement. */
      adaptiveMusic: b(true),
      /** HRTF positioning for creature and environment sounds (headphones). */
      spatialAudio: b(true),
      /** Pitch and level spread between repeated sounds (0 = identical repeats). */
      sfxVariation: n(0, 1, 0.5),
      latencyOffsetMs: n(-250, 250, 0),
      pauseBehavior: e(['duck', 'stop'] as const, 'duck'),
      musicPreview: b(true),
      sfxAccentLayer: b(true),
    })
    .prefault({}),
  /**
   * Weather worlds (Dark Storm and any world that uses the SDK's weather and storm sounds): how
   * intense the storm is (environment only, never gameplay) and the levels of its sound buses.
   */
  weather: z
    .object({
      intensity: e(['subtle', 'normal', 'heavy', 'extreme'] as const, 'normal'),
      rain: n(0, 1, 0.8),
      wind: n(0, 1, 0.7),
      thunderDistant: n(0, 1, 0.85),
      thunderNear: n(0, 1, 0.85),
      lightningCrack: n(0, 1, 0.75),
    })
    .prefault({}),
  reactivity: z
    .object({
      enabled: b(true),
      preset: e(['cinematic', 'subtle', 'energetic', 'ambient', 'hypnotic', 'intense', 'custom'] as const, 'cinematic'),
      strength: n(0, 2, 1),
      bassSensitivity: n(0, 2, 1),
      trebleSensitivity: n(0, 2, 1),
      beatSensitivity: n(0, 2, 1),
      particleResponse: n(0, 2, 1),
      environmentResponse: n(0, 2, 1),
      lightingResponse: n(0, 2, 1),
      analysisPath: e(['auto', 'worklet', 'analyser'] as const, 'auto'),
      fftSize: z.union([z.literal(2048), z.literal(4096)]).catch(4096).default(4096),
    })
    .prefault({}),
  interface: z
    .object({
      hudScale: n(0.75, 1.5, 1),
      hudOpacity: n(0.3, 1, 1),
      showScore: b(true),
      showLevel: b(true),
      showLines: b(true),
      showTime: b(true),
      showCombo: b(true),
      showPracticeStats: b(true),
      showCallouts: b(true),
      mirrored: b(false),
      menuAnimations: b(true),
      /** World select and the level creator build each focused world live (heavy) instead of showing its picture. */
      liveWorldPreviews: b(false),
    })
    .prefault({}),
  accessibility: z
    .object({
      reducedMotion: e(['system', 'on', 'off'] as const, 'system'),
      flashReduction: b(false),
      screenEffects: n(0, 1, 1),
      highContrast: b(false),
      pieceGlyphs: b(false),
      backgroundDim: n(0, 0.9, 0.25),
      visualAudioCues: b(false),
      /** Creature appearances and sudden world events (shadows, fog surges) in worlds that have them. */
      worldEvents: e(['full', 'calm', 'off'] as const, 'full'),
    })
    .prefault({}),
  practice: z
    .object({
      gravityMode: e(['level', 'custom', 'none'] as const, 'level'),
      level: n(1, 20, 1),
      msPerRow: n(1, 5000, 1000),
      lockMode: e(['move', 'step', 'infinite'] as const, 'move'),
      lockDelayMs: n(100, 5000, 500),
      areMs: n(0, 1000, 0),
      lineClearDelayMs: n(0, 1000, 0),
      previewCount: n(0, 6, 5),
      holdMode: e(['normal', 'infinite', 'off'] as const, 'normal'),
      randomizer: e(['bag7', 'random', 'drill'] as const, 'bag7'),
      drillPieces: z.array(z.enum(['I', 'O', 'T', 'S', 'Z', 'J', 'L'])).catch(['T']).default(['T']),
      allSpin: b(false),
    })
    .prefault({}),
  setup: z
    .object({
      lastMode: e(['voyage', 'marathon', 'sprint', 'ultra', 'zen', 'practice'] as const, 'marathon'),
      variants: z.record(z.string(), z.string()).catch({}).default({}),
      stageId: z.string().catch('luminous-tide').default('luminous-tide'),
      /** 'stage' = stage default, 'shuffle', or a track id. */
      music: z.string().catch('stage').default('stage'),
      unlockAll: b(false),
      /** The player's level chosen for play (an id from creator.levels); '' = the world itself. */
      levelId: z.string().catch('').default(''),
    })
    .prefault({}),
  /** Levels made in the level creator: a world, its music and its blocks, under a name. */
  creator: z
    .object({
      levels: z
        .array(z.unknown())
        .catch([])
        .default([])
        .transform((items) => items.flatMap((item) => {
          const parsed = customLevelSchema.safeParse(item);
          return parsed.success && parsed.data.id && parsed.data.stageId ? [parsed.data] : [];
        })),
    })
    .prefault({}),
  developer: z
    .object({
      enabled: b(false),
      audioDashboard: b(false),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsSection = Exclude<keyof Settings, 'version'>;

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

/** Brings any stored object (possibly older/corrupt) to the current schema. */
export function migrateSettings(raw: unknown): { settings: Settings; migrated: boolean; valid: boolean } {
  if (raw === null || typeof raw !== 'object') return { settings: defaultSettings(), migrated: false, valid: raw === undefined || raw === null };
  const data = { ...(raw as Record<string, unknown>) };
  const from = typeof data.version === 'number' ? data.version : 0;
  // v2: the playfield stays still by default; camera shake and movement become opt-in.
  if (from < 2 && data.camera && typeof data.camera === 'object') data.camera = { ...(data.camera as Record<string, unknown>), shake: false, movementIntensity: 0 };
  // v3: background depth of field is off (it blurred the photographic horizons); it stays opt-in.
  if (from < 3 && data.graphics && typeof data.graphics === 'object') data.graphics = { ...(data.graphics as Record<string, unknown>), depthOfField: false };
  // v4: free play goes back to each world's own music (a track picked once in the Music Room
  // silently replaced every world's music).
  if (from < 4 && data.setup && typeof data.setup === 'object') data.setup = { ...(data.setup as Record<string, unknown>), music: 'stage' };
  // v5: every world unlocked for the owner's testing (Settings > Data > Unlock every stage turns it off).
  if (from < 5) data.setup = { ...(data.setup && typeof data.setup === 'object' ? (data.setup as Record<string, unknown>) : {}), unlockAll: true };
  data.version = SETTINGS_VERSION;
  const parsed = settingsSchema.safeParse(data);
  if (!parsed.success) return { settings: defaultSettings(), migrated: false, valid: false };
  return { settings: parsed.data, migrated: from !== SETTINGS_VERSION, valid: true };
}
