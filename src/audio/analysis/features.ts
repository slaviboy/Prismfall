/**
 * Audio Features API — the only audio data the renderer sees.
 * Published once per frame by an AudioFeatureSource; updated in place (no per-frame allocation).
 */
export const SPECTRUM_BARS = 64;

export interface AudioFeatures {
  // Six bands, smoothed and normalised to 0..1.
  subBass: number;
  bass: number;
  lowMid: number;
  mid: number;
  highMid: number;
  treble: number;
  overallEnergy: number;
  waveformRms: number;
  /** Onset-strength signal, normalised 0..1. */
  spectralFlux: number;
  /** Brightness 0 (dark) .. 1 (bright). */
  spectralCentroid: number;
  transientIntensity: number;
  /** True on the frame a beat occurs. */
  beatDetected: boolean;
  /** Position within the current beat, 0..1. */
  beatPhase: number;
  beatConfidence: number;
  estimatedBpm: number;
  // Musical timeline (curated metadata when available, estimates otherwise).
  bpm: number;
  beat: number;
  bar: number;
  beatInBar: number;
  barPhase: number;
  /** The current section's name in the composition (e.g. `cranes`). */
  section: string;
  /** Its kind: intro, verse, build, drop, break, bridge or outro ('' when the music has no sections). */
  sectionKind: string;
  sectionIntensity: number;
  /** 0..1 ramp before an upcoming marked event (drop/build end), for wind-up animations. */
  anticipation: number;
  nextEvent: string;
  timeToNextEvent: number;
  // Derived envelopes for convenient visual use.
  beatPulse: number;
  barPulse: number;
  /** Quiet passage detected (dynamic-range aware). */
  quiet: boolean;
  dynamicRange: number;
  /** Log-spaced spectrum bars (0..1). */
  readonly spectrum: Float32Array;
}

export function createAudioFeatures(): AudioFeatures {
  return {
    subBass: 0,
    bass: 0,
    lowMid: 0,
    mid: 0,
    highMid: 0,
    treble: 0,
    overallEnergy: 0,
    waveformRms: 0,
    spectralFlux: 0,
    spectralCentroid: 0.5,
    transientIntensity: 0,
    beatDetected: false,
    beatPhase: 0,
    beatConfidence: 0,
    estimatedBpm: 0,
    bpm: 120,
    beat: 0,
    bar: 0,
    beatInBar: 0,
    barPhase: 0,
    section: 'intro',
    sectionKind: '',
    sectionIntensity: 0.5,
    anticipation: 0,
    nextEvent: '',
    timeToNextEvent: Infinity,
    beatPulse: 0,
    barPulse: 0,
    quiet: false,
    dynamicRange: 0,
    spectrum: new Float32Array(SPECTRUM_BARS),
  };
}

export interface BeatEvent {
  readonly beat: number;
  readonly bar: number;
  readonly beatInBar: number;
  readonly downbeat: boolean;
  /** performance.now()-compatible time the beat is heard. */
  readonly time: number;
}

/** Anything that publishes AudioFeatures each frame (stub metronome now, real analysis in M5). */
export interface AudioFeatureSource {
  readonly features: AudioFeatures;
  /** Advances to `now` (ms); returns beats that occurred since the last call. */
  update(now: number, dt: number): readonly BeatEvent[];
}

/**
 * Metronome-driven stand-in used before the audio engine exists (and when audio is disabled):
 * beats follow the stage BPM on the performance clock, bands are gentle synthetic envelopes.
 */
export class MetronomeFeatureSource implements AudioFeatureSource {
  readonly features = createAudioFeatures();
  private origin = performance.now();
  private lastBeat = -1;
  private readonly beats: BeatEvent[] = [];
  beatsPerBar = 4;

  constructor(bpm = 100) {
    this.features.bpm = bpm;
    this.features.estimatedBpm = bpm;
    this.features.beatConfidence = 1;
  }

  setBpm(bpm: number, now = performance.now()): void {
    // Keep phase continuous across tempo changes.
    const beats = ((now - this.origin) / 60000) * this.features.bpm;
    this.features.bpm = bpm;
    this.features.estimatedBpm = bpm;
    this.origin = now - (beats / bpm) * 60000;
  }

  update(now: number, dt: number): readonly BeatEvent[] {
    const f = this.features;
    this.beats.length = 0;
    const beatPos = Math.max(0, ((now - this.origin) / 60000) * f.bpm);
    const beat = Math.floor(beatPos);
    f.beatPhase = beatPos - beat;
    f.beatDetected = false;
    while (this.lastBeat < beat) {
      this.lastBeat++;
      const inBar = ((this.lastBeat % this.beatsPerBar) + this.beatsPerBar) % this.beatsPerBar;
      const ev: BeatEvent = { beat: this.lastBeat, bar: Math.floor(this.lastBeat / this.beatsPerBar), beatInBar: inBar, downbeat: inBar === 0, time: now };
      this.beats.push(ev);
      f.beatDetected = true;
      f.beatPulse = 1;
      if (ev.downbeat) f.barPulse = 1;
    }
    f.beat = beat;
    f.bar = Math.floor(beat / this.beatsPerBar);
    f.beatInBar = beat % this.beatsPerBar;
    f.barPhase = (f.beatInBar + f.beatPhase) / this.beatsPerBar;
    const decay = Math.exp(-dt * 6);
    f.beatPulse *= decay;
    f.barPulse *= Math.exp(-dt * 2.5);
    const t = now / 1000;
    f.bass = 0.25 + f.beatPulse * 0.55;
    f.subBass = f.bass * 0.9;
    f.lowMid = 0.3 + 0.1 * Math.sin(t * 0.7);
    f.mid = 0.35 + 0.15 * Math.sin(t * 0.43 + 1);
    f.highMid = 0.3 + 0.15 * Math.sin(t * 1.3 + 2);
    f.treble = 0.25 + 0.1 * Math.sin(t * 2.1);
    f.overallEnergy = (f.bass + f.mid + f.treble) / 3;
    f.waveformRms = f.overallEnergy * 0.6;
    f.spectralFlux = f.beatPulse * 0.7;
    f.transientIntensity = f.beatPulse;
    f.sectionIntensity = 0.5 + 0.15 * Math.sin(t * 0.05);
    for (let i = 0; i < f.spectrum.length; i++) f.spectrum[i] = Math.max(0, f.bass * (1 - i / f.spectrum.length) + 0.1 * Math.sin(t * 2 + i * 0.4));
    return this.beats;
  }
}
