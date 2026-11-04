/**
 * The Environment Music Director (brief §40.6): the one interpreter of the music for every world.
 *
 * It reads only the Music Analysis Engine's `AudioFeatures` and the heard beat grid (no audio
 * nodes, no second FFT) and publishes a typed `MusicDrive`: drives at distinct time scales, so large
 * things move slowly with the bass and fine things quickly with the treble, and governed cues for
 * the moments worth a visual event (an accent, a phrase, a build, a drop). Worlds subscribe to these
 * through bindings (`music.*`), call-ins (`music:<cue>`), shader uniforms (`environmentUniforms`) or
 * `EnvFrame.music`; none of them see the analysis internals.
 *
 * The reference study (BACKGROUND_VISUAL_REFERENCE.md) shaped the defaults: the world follows the
 * music's large shape strongly and its drum hits not at all, it trails the music by a fifth to half
 * a second, and big moments are rare. So nothing here pulses on every beat: `beat` fires on selected
 * beats only, and `accent` is rate-limited.
 *
 * Pure TypeScript (no three, DOM or audio), so it is unit-tested with synthetic feature streams.
 */
import type { AudioFeatures, BeatEvent } from '../../../audio/analysis/features';
import { MUSIC_CUES, MUSIC_DRIVES, type MusicCueKind, type MusicDriveName } from '../../../stages/music';
import { AudioFeatureNormalizer } from './normalizer';

export { MUSIC_CUES, MUSIC_DRIVES, type MusicCueKind, type MusicDriveName };

/** What one frame of interpreted music looks like (EnvFrame.music, since SDK 1.7). */
export type MusicDrive = {
  /**
   * - `body`: sub-bass and bass, for large slow masses (250 ms attack, 1.4 s release).
   * - `swell`: the slow breathing of the bass and loudness (seconds).
   * - `motion`: low mids and mids, for medium-sized objects (120 ms / 600 ms).
   * - `detail`: high mids and treble, for fine detail (30 ms / 250 ms, slew-limited against flicker).
   * - `shimmer`: treble rising above its recent level (sparkle), rate-limited.
   * - `flux`: spectral change.
   * - `energy`: loudness relative to the song.
   * - `intensity`: the section's composed intensity with energy and onset density (about 3 s).
   * - `tension`: rises through builds and the last bars before a drop; falls at the drop.
   * - `release`: the aftermath of a drop or peak, fading over about 6 s.
   * - `calm`: quiet passages, breaks and intros (1) versus dense sections (0).
   * - `accent`: governed transient pulses (at most a few per second, never every hit).
   * - `beat`: soft pulses on selected beats only (downbeats, accented or busy beats).
   * - `downbeat`: a pulse on the first beat of each bar.
   * - `phrase`: position in the phrase, 0..1 (phraseBars bars).
   */
  [K in MusicDriveName]: number;
} & {
  readonly section: string;
  readonly sectionKind: string;
  readonly beatPhase: number;
  readonly barPhase: number;
  /** Real music is being interpreted (music playing and audio reactivity on). */
  readonly active: boolean;
};

/** A moment in the music worth an event (EnvironmentComponent.onMusicCue, call-ins `music:<kind>`). */
export interface MusicCue {
  readonly kind: MusicCueKind;
  /** Size of the moment, 0..1.5. */
  readonly strength: number;
  readonly time: number;
  /** Section cues: the section kind entered and the one left (null for the first). */
  readonly section?: string;
  readonly previous?: string | null;
}

export interface DirectorInput {
  /** Real music features (false: silent metronome stand-in, music stopped, reactivity off). */
  readonly active: boolean;
  readonly flashReduction: boolean;
  readonly reducedMotion: boolean;
  readonly beatsPerBar: number;
  readonly phraseBars: number;
}

/** Envelope time constants (seconds), exported for documentation and tests. */
export const DRIVE_TIMING = {
  body: { attack: 0.25, release: 1.4 },
  swell: { attack: 2.5, release: 5 },
  motion: { attack: 0.12, release: 0.6 },
  detail: { attack: 0.03, release: 0.25, slew: 5 },
  shimmer: { attack: 0.02, release: 0.35, slew: 6 },
  flux: { attack: 0.05, release: 0.4 },
  energy: { attack: 0.4, release: 1.2 },
  intensity: { attack: 3, release: 3 },
  tension: { attack: 1.5, release: 0.5 },
  release: { decay: 6 },
  calm: { attack: 2, release: 2 },
  accent: { decay: 0.28 },
  beat: { decay: 0.16 },
  downbeat: { decay: 0.4 },
} as const;

/**
 * Accent governor: an accent is an onset that stands out from the recent onsets (at least `relative`
 * × their running level), at least `minBeats` beats and `minSeconds` apart; measured on the
 * shipped tracks this keeps accents to about 15-40 a minute in dense sections, not every beat.
 */
export const ACCENT = { minBeats: 1, minSeconds: 0.35, maxPerSecond: 2.5, relative: 1.08, flashMinSeconds: 0.6, flashScale: 0.6 } as const;

/** Peak cue: the music's intensity rises above `on` (re-armed below `off`). */
export const PEAK = { on: 0.68, off: 0.55 } as const;

const BREAKS = new Set(['break', 'intro', 'outro']);

function env(value: number, target: number, dt: number, attack: number, release: number): number {
  const tau = Math.max(1e-3, target > value ? attack : release);
  return value + (target - value) * (1 - Math.exp(-dt / tau));
}

function slew(value: number, target: number, dt: number, perSecond: number): number {
  const step = perSecond * dt;
  return value + Math.max(-step, Math.min(step, target - value));
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createMusicDrive(): MusicDrive {
  const d = Object.fromEntries(MUSIC_DRIVES.map((k) => [k, 0])) as Record<MusicDriveName, number>;
  return { ...d, calm: 1, section: '', sectionKind: '', beatPhase: 0, barPhase: 0, active: false };
}

export class EnvironmentMusicDirector {
  /** Updated in place every frame. */
  readonly drive: MusicDrive = createMusicDrive();
  private readonly cues: MusicCue[] = [];
  private readonly norm = {
    body: new AudioFeatureNormalizer(),
    motion: new AudioFeatureNormalizer(),
    detail: new AudioFeatureNormalizer(),
    energy: new AudioFeatureNormalizer(),
  };
  private detailTarget = 0;
  private trebleMean = 0;
  private lastTransient = 0;
  private lastAccent = -1e9;
  private accentRate = 0;
  /** Running level of recent onsets (accents must stand out from it). */
  private onsetLevel = 0.6;
  private lastSectionKind: string | null = null;
  private lastSectionName: string | null = null;
  private sectionStart = 0;
  private sectionIntensityAtStart = 0.5;
  private peakArmed = true;
  private calmArmed = true;
  private energySlow = 0;
  private time = 0;

  /**
   * Advances the interpretation by `dt` seconds. `beats` are the beats heard since the last frame.
   * Returns the cues of this frame (valid until the next call).
   */
  update(dt: number, time: number, f: Readonly<AudioFeatures>, beats: readonly BeatEvent[], input: DirectorInput): readonly MusicCue[] {
    this.cues.length = 0;
    this.time = time;
    const d = this.drive as Record<MusicDriveName, number> & { section: string; sectionKind: string; beatPhase: number; barPhase: number; active: boolean };
    const live = input.active && !f.quiet;
    d.active = input.active;
    d.beatPhase = f.beatPhase;
    d.barPhase = f.barPhase;
    const phraseBars = Math.max(1, input.phraseBars);
    d.phrase = (((f.bar % phraseBars) + phraseBars) % phraseBars + f.barPhase) / phraseBars;

    // Raw channels from the analysis bands, then song-relative contrast (normalizer.ts).
    const bodyRaw = live ? 0.45 * f.subBass + 0.55 * f.bass : 0;
    const motionRaw = live ? 0.4 * f.lowMid + 0.6 * f.mid : 0;
    const detailRaw = live ? 0.55 * f.highMid + 0.45 * f.treble : 0;
    const energyRaw = live ? f.overallEnergy : 0;
    const body = this.norm.body.update(bodyRaw, dt, live);
    const motion = this.norm.motion.update(motionRaw, dt, live);
    const detail = this.norm.detail.update(detailRaw, dt, live);
    const energy = this.norm.energy.update(energyRaw, dt, live);

    const T = DRIVE_TIMING;
    d.body = env(d.body, body, dt, T.body.attack, T.body.release);
    d.swell = env(d.swell, live ? 0.5 * body + 0.5 * energy : 0, dt, T.swell.attack, T.swell.release);
    d.motion = env(d.motion, motion, dt, T.motion.attack, T.motion.release);
    // Fine detail: fast, but slew-limited so it never strobes; slower still with Reduce flashing.
    const detailRelease = input.flashReduction ? 0.5 : T.detail.release;
    this.detailTarget = env(this.detailTarget, detail, dt, T.detail.attack, detailRelease);
    d.detail = slew(d.detail, this.detailTarget, dt, input.flashReduction ? T.detail.slew / 2 : T.detail.slew);
    // Shimmer: treble rising above its own recent level.
    this.trebleMean = env(this.trebleMean, live ? f.treble : 0, dt, 2.5, 2.5);
    const shimmerTarget = live ? clamp01((f.treble - this.trebleMean) * 3) * (input.flashReduction ? 0.5 : 1) : 0;
    d.shimmer = slew(env(d.shimmer, shimmerTarget, dt, T.shimmer.attack, T.shimmer.release), shimmerTarget, dt, T.shimmer.slew);
    d.flux = env(d.flux, live ? f.spectralFlux : 0, dt, T.flux.attack, T.flux.release);
    d.energy = env(d.energy, energy, dt, T.energy.attack, T.energy.release);
    this.energySlow = env(this.energySlow, energy, dt, 4, 4);

    // Governed accents from the analysis onsets (transientIntensity jumps at each onset).
    const beatSeconds = 60 / Math.max(30, Math.min(300, f.bpm || 120));
    const jump = f.transientIntensity - this.lastTransient;
    this.lastTransient = f.transientIntensity;
    this.accentRate *= Math.exp(-dt / 2);
    if (live && jump > 0.15 && f.transientIntensity > 0.45) {
      const v = f.transientIntensity;
      const standsOut = v >= this.onsetLevel * ACCENT.relative || v > 0.92;
      this.onsetLevel += (v - this.onsetLevel) * 0.2;
      const minGap = input.flashReduction ? Math.max(ACCENT.flashMinSeconds, 1.5 * beatSeconds) : Math.max(ACCENT.minSeconds, ACCENT.minBeats * beatSeconds);
      if (standsOut && time - this.lastAccent >= minGap && this.accentRate < ACCENT.maxPerSecond * 2) {
        let strength = clamp01((f.transientIntensity - 0.4) / 0.6) * 0.8 + 0.2;
        // On the music's grid an accent counts fully; between beats it is a lesser one.
        if (f.beatConfidence > 0.5) {
          const off = Math.min(f.beatPhase, 1 - f.beatPhase);
          if (off > 0.18) strength *= 0.6;
        }
        if (input.flashReduction) strength *= ACCENT.flashScale;
        this.lastAccent = time;
        this.accentRate += 1;
        d.accent = Math.max(d.accent, strength);
        this.cues.push({ kind: 'accent', strength, time });
      }
    }
    d.accent *= Math.exp(-dt / (input.flashReduction ? 0.45 : T.accent.decay));

    // Musical intensity: the composition's section intensity, the song-relative energy and how busy
    // the onsets are, over a few seconds.
    const intensityTarget = live ? clamp01(0.55 * f.sectionIntensity + 0.3 * this.energySlow + 0.15 * Math.min(1, this.accentRate / 3)) : 0;
    d.intensity = env(d.intensity, intensityTarget, dt, T.intensity.attack, T.intensity.release);

    // Sections: build, drop, break, peak and calm cues; tension and release.
    this.trackSections(f, time, input, live);
    const inBuild = f.sectionKind === 'build';
    const buildRamp = inBuild ? 0.55 + 0.45 * clamp01((time - this.sectionStart) / 16) : 0;
    const tensionTarget = live ? Math.max(buildRamp, f.anticipation) : 0;
    d.tension = env(d.tension, tensionTarget, dt, T.tension.attack, T.tension.release);
    d.release *= Math.exp(-dt / T.release.decay);
    const calmTarget = !input.active ? 1 : f.quiet ? 1 : Math.max(BREAKS.has(f.sectionKind) ? 0.7 : 0, clamp01(1 - (d.intensity - 0.2) / 0.45));
    d.calm = env(d.calm, calmTarget, dt, T.calm.attack, T.calm.release);
    if (d.intensity > PEAK.on && this.peakArmed && live) {
      this.peakArmed = false;
      this.cues.push({ kind: 'peak', strength: 1, time });
      d.release = Math.max(d.release, 0.6);
    } else if (d.intensity < PEAK.off) this.peakArmed = true;
    if (d.calm > 0.65 && this.calmArmed && input.active) {
      this.calmArmed = false;
      this.cues.push({ kind: 'calm', strength: 1, time });
    } else if (d.calm < 0.45) this.calmArmed = true;

    // Beats: only selected beats get a visual pulse.
    const beatDecay = T.beat.decay * Math.min(1.5, Math.max(0.6, beatSeconds / 0.5));
    d.beat *= Math.exp(-dt / beatDecay);
    d.downbeat *= Math.exp(-dt / T.downbeat.decay);
    if (input.active) {
      for (const b of beats) {
        if (b.downbeat) {
          d.downbeat = 1;
          this.cues.push({ kind: 'downbeat', strength: 1, time });
          if (((b.bar % phraseBars) + phraseBars) % phraseBars === 0) this.cues.push({ kind: 'phrase', strength: 1, time });
        }
        const accented = time - this.lastAccent < 0.09;
        const busy = d.intensity > 0.65 && b.beatInBar % 2 === 0;
        if (b.downbeat || accented || busy) d.beat = Math.max(d.beat, input.reducedMotion ? 0.5 : 1);
      }
    }
    return this.cues;
  }

  private trackSections(f: Readonly<AudioFeatures>, time: number, input: DirectorInput, live: boolean): void {
    const d = this.drive as { section: string; sectionKind: string; release: number };
    const kind = f.sectionKind ?? '';
    const name = f.section ?? '';
    if (kind === this.lastSectionKind && name === this.lastSectionName) return;
    const previous = this.lastSectionKind;
    const first = this.lastSectionName === null;
    const prevIntensity = this.sectionIntensityAtStart;
    this.lastSectionKind = kind;
    this.lastSectionName = name;
    d.section = name;
    d.sectionKind = kind;
    this.sectionStart = time;
    this.sectionIntensityAtStart = f.sectionIntensity;
    if (first || !input.active) return;
    this.cues.push({ kind: 'section', strength: 1, time, section: kind, previous });
    if (!live) return;
    if (kind === 'build') this.cues.push({ kind: 'build', strength: 1, time, section: kind, previous });
    else if (kind === 'drop') {
      const strength = Math.min(1.5, 0.8 + Math.max(0, (this.drive.tension ?? 0) * 0.4) + Math.max(0, 0.5 - prevIntensity) * 0.4);
      this.cues.push({ kind: 'drop', strength, time, section: kind, previous });
      d.release = 1;
      (this.drive as { tension: number }).tension *= 0.3;
    } else if (BREAKS.has(kind) && previous && !BREAKS.has(previous)) this.cues.push({ kind: 'break', strength: 1, time, section: kind, previous });
  }

  /** The cues of the last update (also returned by update). */
  get lastCues(): readonly MusicCue[] {
    return this.cues;
  }

  /** Seconds of the director's clock (for tests). */
  get clock(): number {
    return this.time;
  }

  /** Back to rest: a new song or a world change does not inherit the previous song's state. */
  reset(): void {
    Object.assign(this.drive, createMusicDrive());
    for (const n of Object.values(this.norm)) n.reset();
    this.detailTarget = 0;
    this.trebleMean = 0;
    this.lastTransient = 0;
    this.lastAccent = -1e9;
    this.accentRate = 0;
    this.onsetLevel = 0.6;
    this.lastSectionKind = null;
    this.lastSectionName = null;
    this.peakArmed = true;
    this.calmArmed = true;
    this.energySlow = 0;
  }
}
