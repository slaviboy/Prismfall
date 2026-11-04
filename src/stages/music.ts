/**
 * Names of the Environment Music Director's drives and cues (src/rendering/environments/living/
 * musicDirector.ts), shared by the manifest schemas (bindings `music.<drive>`, call-ins
 * `music:<cue>`) and the runtime. Pure data.
 */

/** Continuous drives, 0..1 (see MusicDrive for what each one follows and how fast). */
export const MUSIC_DRIVES = [
  'body',
  'swell',
  'motion',
  'detail',
  'shimmer',
  'flux',
  'energy',
  'intensity',
  'tension',
  'release',
  'calm',
  'accent',
  'beat',
  'downbeat',
  'phrase',
] as const;
export type MusicDriveName = (typeof MUSIC_DRIVES)[number];

/** Moments in the music worth an event. */
export const MUSIC_CUES = ['accent', 'downbeat', 'phrase', 'build', 'drop', 'break', 'peak', 'calm', 'section'] as const;
export type MusicCueKind = (typeof MUSIC_CUES)[number];
