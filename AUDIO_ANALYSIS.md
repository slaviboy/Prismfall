# Audio analysis and reactivity

How Prismfall listens to its music and turns it into motion: the research behind the design, the signal path, the algorithms, and the measurements that set the defaults. Brief §24.

## 1. VLC research

VLC's visualisation modules were read for technique only. **No VLC code, constants tables or rendering is reused**, so their licences don't apply to Prismfall.

Source: `videolan/vlc` master at `8a47770f6333df6b60181329db5fdaad318bdb44` (2026-11-02), `modules/visualization/`.

| File | Licence | Notes |
|---|---|---|
| `glspectrum.c` | LGPL-2.1-or-later | 20 OpenGL box bars |
| `visual/visual.c`, `visual/effects.c` | LGPL-2.1-or-later | spectrum, spectrometer, scope, VU meter |
| `visual/fft.c`, `visual/fft.h` | **GPL-2.0-or-later** | "Mainly taken from XMMS's code" |
| `visual/window.c`, `visual/window_presets.h` | LGPL-2.1-or-later | Hann, flat top, Blackman-Harris, Kaiser |
| `goom.c` | LGPL-2.1-or-later | passes PCM to the external libgoom; no analysis of its own |

### What VLC does

- **Input:** one 512-sample FFT per audio block, taken from channel 0 only. There is no overlap. Samples are converted float → int16 before the FFT.
- **Windowing:** the default window is rectangular (`effect-fft-window = none`); windowing is applied in int16.
- **Bins:** at 44.1 kHz each bin is about 86 Hz wide.
- **Bands:** each band is the *maximum* bin within a fixed bin-index table (20 or 80 bands). These tables are tied to the FFT size, so their Hz edges move with the sample rate.
- **Scaling:** log scaling, e.g. `30·log(y + 0.1)` pixels for the spectrum. There is no normalisation or gain control.
- **Decay:** applied per call (5 px per block for bars, 1 px for peaks), so animation speed depends on block size and frame rate.
- **Rhythm:** no onset, beat or tempo analysis.

### What Prismfall keeps and changes

Ideas kept:
- fast-attack, slow-release bars with separate peak markers;
- selectable window functions;
- log-scaled display.

Changed:

| VLC | Prismfall |
|---|---|
| Channel 0, int16 | Float stereo downmix |
| 512-point FFT, no overlap | Two FFTs every 512 samples: 4096 for the bass bands, 2048 for flux and highs |
| Bands defined by bin index | Bands defined in Hz with fractional edge bins, independent of FFT size and sample rate |
| Per-call decay | Time-constant envelopes (`α = 1 − e^(−dt/τ)`), identical at any frame rate |
| No normalisation | Adaptive per-band level normalisation with a gate and a minimum window |
| No rhythm analysis | Spectral flux, onsets, tempo, beat phase and confidence, plus the music's own beat grid |

## 2. Signal path

```
music sources ─→ musicPre ─┬─→ analysisTap ─→ AudioWorklet (default) ─┐
                           │               └→ AnalyserNode (fallback, dashboard spectrum)
                           └─→ music fader ─→ pause filter ─→ master ─→ limiter ─→ speakers
```

- **Tap point.** Analysis taps the music *before* the volume fader. The music volume slider and the pause duck don't change what the world reacts to, and analysis keeps working with music turned down.
- **Worklet path** (`src/audio/analysis/analysis.worklet.ts`):
  - downmixes to mono and runs the DSP core every 512 samples (10.7 ms at 48 kHz);
  - stamps each frame with its audio-clock time;
  - posts frames in batches of 4, recycling the batch buffers.
- **Analyser path** reads the AnalyserNode once per render frame; `AnalyserFrameBuilder` turns that into the same frame layout.
- **Heard-time sync.** Both paths queue frames with their audio time. A frame is applied only once it is *heard*, using `AudioEngine.heardAt`, which maps audio time to `performance.now()` through `getOutputTimestamp()` with smoothing, plus the user's latency offset. Visuals therefore line up with what reaches the speakers, not with what the audio thread is processing.
- **Shared code.** The DSP core (`src/audio/analysis/dsp/`) is plain TypeScript with no Web Audio dependency. The worklet, the main thread, the offline profiler and the Node unit tests all use it.

## 3. Features

`AudioFeatures` (`src/audio/analysis/features.ts`) is a single object, updated in place every render frame. Stages and effects read it through bindings; nothing in rendering touches audio nodes.

| Group | Fields |
|---|---|
| Bands (0..1, smoothed) | `subBass` 20–60 Hz, `bass` 60–250, `lowMid` 250–500, `mid` 500–2k, `highMid` 2–6k, `treble` 6–16k |
| Level | `waveformRms`, `overallEnergy`, `dynamicRange` (dB), `quiet` |
| Spectrum | `spectralFlux`, `spectralCentroid` (brightness), `transientIntensity`, 64 log-spaced `spectrum` bars |
| Detected rhythm | `estimatedBpm`, plus tempo confidence and phase in `processor.tempo` |
| Music timeline (authoritative for Prismfall's own tracks) | `bpm`, `beat`, `bar`, `beatInBar`, `beatPhase`, `barPhase`, `beatPulse`, `barPulse`, `beatDetected`, `beatConfidence`, `section`, `sectionIntensity`, `nextEvent`, `timeToNextEvent`, `anticipation` |

**Beats never come from loudness.** For Prismfall's tracks the beat grid comes from the composition itself: the sequencer knows exactly where every beat is. Detected tempo and phase are used for music without that metadata, and they are always reported with a confidence value.

## 4. Algorithms

### Frames (`frameAnalyzer.ts`)

Each 512-sample hop runs two FFTs over the most recent samples:

- **Long FFT, Hann, 4096 points** (11.7 Hz bins). Feeds `subBass` and `bass`.
- **Short FFT, 2048 points.** Feeds the higher bands, the centroid and the flux.

Band energy is the power sum over Hz-defined edges, with fractional weights for edge bins, so the narrow sub band keeps at least two bins of support.

The short FFT is 2048 rather than 1024 because a 21 ms window is shorter than one cycle of a 40 Hz sub. Its power then swings with phase and fakes onsets: on the corpus, bass-heavy onset F was 0.64 with 1024 and is 0.95 with 2048.

### Normalisation (`smoothing.ts`)

`AdaptiveNormalizer` tracks two levels per band, in dB:

| Tracker | Behaviour |
|---|---|
| Mean | rises with τ 2.5 s, falls with τ 6 s |
| Peak | attacks in 30 ms, releases with τ 3 s |

Output mapping:

- the mean level maps to about 0.45 and the peak to 1, so steady material sits mid-scale and accents stand out;
- the window is at least 24 dB wide, so quiet noise is never stretched to full scale;
- anything below the −70 dBFS gate reads 0.

An earlier design let its ceiling decay toward the current level, which drove every band to about 0.85 regardless of the music. The corpus caught this.

### Spectral flux

Flux is computed on `log10(1 + 1000·|X|)` magnitudes. Bins below about −60 dBFS (reverb tails, noise) contribute almost nothing. Each bin is compared with the maximum of its neighbours in the previous frame, which suppresses vibrato and detuned-unison beating. Only rises are counted (half-wave rectified), averaged over bins.

### Onsets (`rhythm.ts` `OnsetDetector`)

An onset is a local flux maximum above all of these thresholds:

- a floor of 0.006;
- median + 3.5 × MAD (scaled) over the last 48 frames;
- 30 % of a decaying recent maximum (τ 0.6 s), which rejects decay tails;

and at least 70 ms after the previous onset. Reported times subtract the window latency, (2048 + 512) / 2 samples. These parameters were tuned by grid search on the corpus.

### Tempo

1. **Envelope.** One impulse per onset, fed on a fixed 10.7 ms grid. The analyser path delivers frames at render rate, so its onsets are carried to the next grid step.
2. **Autocorrelation** over 60–200 BPM, weighted by a log-Gaussian prior around 120 BPM (σ 0.9 octave).
3. **Refinement.** Parabolic interpolation, then a second interpolation on the largest multiple of the lag that fits (up to one bar), which divides the lag error by that multiple.
4. **Hysteresis.** A competing tempo must score 15 % higher in two consecutive estimates before it replaces the current one. Near octave boundaries the prior is almost flat, so this stops flip-flopping.

Onset impulses beat continuous flux as the envelope: flux keeps the texture of sustained parts, which pulled arpeggiated and ambient material off the beat.

### Beat phase

**Accents.** Each onset carries an accent: the rise of each band over the last ~85 ms, weighted 0.6, 0.6, 1, 1, 0.6 and 0.15 from sub to treble. Snare body and crack count as much as kick sub; hats count little. The accent is also split into kick-like (low-band) and snare-like (mid-band) parts.

**Comb.** Every candidate grid offset is scored:

- by recency-weighted (0.85 per beat), accent-weighted impulses, so a small tempo error doesn't skew the newest beat;
- plus a bonus where a low-dominant accent and a mid-dominant accent fall on adjacent beats, i.e. kick/snare alternation. This resolves syncopated grooves whose off-beat kicks outweigh the backbeat.

**Locking.**

- A lock forms after three agreeing estimates.
- A PLL then nudges the phase on every accented onset within 0.2 beat of a predicted beat (gain 0.25 × accent weight).
- Moving to a different grid requires 25 % more comb score in three consecutive estimates.
- When the tempo changes, phase keeps the elapsed time since the last beat.
- Through rests (2 s without onsets) tempo and phase coast instead of re-estimating.

### Quiet passages

`quiet` is true after half a second below the long-term loudness by 10 dB, or below −50 dBFS. The world eases to its rest state rather than jumping: band envelopes release and bindings fall back to their base values.

## 5. Reactivity

**Bindings.** A stage maps features to component uniforms with bindings: `{ target, feature, amount, mode (mul|add), curve, attackMs, releaseMs, category, min, max }`. Envelopes are time-based, so the response is the same at 60, 144 and 240 Hz (unit-tested).

**Profiles** (`content/shared/reactivity/*.json`) are reusable mappings that stages combine, optionally scoped to particular layers and scaled:

| Profile | Character |
|---|---|
| `bass-breath` | Slow, heavy swells on the bass: water amplitude, sky glow, planet atmosphere |
| `treble-sparkle` | Fast, small glints from the treble on particles and stars |
| `beat-lights` | Water, rings and beams flash on the beat grid |
| `flux-turbulence` | Particles stir when the spectrum changes |
| `transient-strike` | Emissive seams and beams flare on drum hits |
| `mid-architecture` | Low mids heat lava and thicken haze; mids warm emissive structures |
| `section-swell` | Beams and rings grow through builds and drops; the sky glows ahead of a drop (`anticipation`) |

**Reaction presets** (Cinematic, Subtle, Energetic, Ambient, Hypnotic, Intense, Neutral) scale gain, attack and release times, and the bass, treble and beat groups.

**Player controls** apply on top of the preset and take effect live: overall strength; bass, treble and beat sensitivity; particle, environment and lighting response. Accessibility settings (reduced motion, flash reduction) cap the result.

## 6. Timing and calibration

- `AudioEngine.heardAt` maps audio time to the moment it is heard. It uses `getOutputTimestamp()` when available, otherwise `currentTime` plus `outputLatency`, smoothed because `currentTime` advances in steps on some platforms.
- **Settings → Audio → Calibrate by tapping along:**
  - plays 20 clicks at 100 BPM on the audio clock, with the music ducked;
  - accepts taps from any key, pad button or the tap area, using input-event timestamps;
  - ignores the first four clicks and takes the median tap-minus-click difference, with a steadiness (MAD) check.
- Gameplay timing never depends on audio.

## 7. Acceptance corpus

`e2e/audio-acceptance.spec.ts` renders nine styles offline with the game's own synthesiser and limiter (`src/audio/lab/AudioLab.ts`). It scores the engine against the sequencer's exact note log. Ground-truth onsets are note starts of sharp-attack instruments (drums, plucks, bass, bells); pads, strings, choir, sub and risers swell in and are excluded. Simultaneous hits count once, and matches are within ±50 ms. Results from the latest run (16 s per style):

| Style | BPM | Onset F (precision / recall) | Detected tempo | Worst phase error after 10 s | Peak |
|---|---|---|---|---|---|
| Electronic | 128 | 1.00 (1.00 / 1.00) | 127.9 | 3.0 ms | −5.4 dBFS |
| Ambient | 70 | — | 69.9 | 11.9 ms | −15.6 dBFS |
| Orchestral | 96 | — | 96.1 | 2.7 ms | −11.8 dBFS |
| Cinematic (no pulse) | 80 | — | none (confidence 0) | — | −10.3 dBFS |
| Percussion (syncopated) | 110 | 0.955 (1.00 / 0.91) | 109.9 | 4.3 ms | −4.5 dBFS |
| Bass-heavy | 140 | 0.949 (0.90 / 1.00) | 139.8 | 5.0 ms | −3.7 dBFS |
| Slow | 60 | 1.00 (1.00 / 1.00) | 120.1 (octave, flagged) | 3.7 ms | −7.0 dBFS |
| Fast | 174 | 0.995 (0.99 / 1.00) | 174.2 | 6.8 ms | −5.5 dBFS |
| Quiet passages | 100 | 1.00 (1.00 / 1.00) | 100.0 | 4.8 ms | −4.8 dBFS |

The spec enforces these thresholds:

| Criterion | Requirement |
|---|---|
| Onset F (percussive styles) | ≥ 0.85 |
| Tempo (rhythmic styles) | within 2 %; octave errors flagged and allowed only where the groove is genuinely ambiguous |
| Beat phase (rhythmic styles) | < 30 ms after lock |
| Beatless material | tempo confidence < 0.5 |
| Band dominance | low bands above high bands in bass-heavy music; percussive transients well above ambient |
| Quiet passages | energy below 0.15 during silence |
| Response steps | no energy step above 0.35 per hop |
| Signal integrity | peak ≤ −1 dBFS, no NaN, no DC, all features within 0..1 |

The same spec checks every SFX in every preset and the first 24 s of every shipped track for peak level, NaN and DC.

## 8. Profiling: analysis path and FFT size

`e2e/audio-profile.spec.ts` (`src/audio/lab/pathProfile.ts`) runs the rhythmic corpus styles through the worklet DSP at both long-FFT sizes. It also runs them through a **real AnalyserNode** read at 60 Hz and 144 Hz render rates, offline with `suspend`/`resume` at each frame time, exactly as the live fallback reads it. Measured in Chrome on a Ryzen 7 5800X3D:

| Configuration | Mean onset F | Tempo within 2 % | Worst phase error | Cost per update | Updates/s |
|---|---|---|---|---|---|
| **Worklet, long FFT 4096 (default)** | 0.983 | 7 / 7 | 6.9 ms | 209 µs | 93.75 |
| Worklet, long FFT 2048 | 0.983 | 7 / 7 | 6.9 ms | 142 µs | 93.75 |
| Analyser 4096 @ 60 Hz | 0.988 | 7 / 7 | 311 ms | 175 µs | 60 |
| Analyser 4096 @ 144 Hz | 0.964 | 5 / 7 | 167 ms | 173 µs | 144 |
| Analyser 2048 @ 60 Hz | 0.951 | 5 / 7 | 304 ms | 94 µs | 60 |
| Analyser 2048 @ 144 Hz | 0.929 | 6 / 7 | 162 ms | 92 µs | 144 |

| Long FFT | Sub-band leakage from a 100 Hz tone | Bass rise time to within 3 dB |
|---|---|---|
| 4096 | −44.5 dB | 55 ms |
| 2048 | −23.7 dB | 33 ms |

Conclusions:

- **Worklet as the default.** It is the only path whose results don't depend on the display's frame rate, and the only one that keeps beat phase locked. At 60 Hz the analyser matches it on onsets, but the analyser's numbers shift between 60 and 144 Hz and its phase lock fails.
- **Cost.** The worklet costs about 2 % of one core on the audio thread at 4096. The main thread only applies finished frames, a few µs each.
- **Long FFT 4096 as the default.** Rhythm comes from the short FFT, so the long size changes only the bass bands. 4096 separates sub from bass 20 dB more cleanly; its extra 22 ms of rise time is within the 35–40 ms attack the bass envelopes use anyway.
- **When to choose otherwise.** Settings → Reactivity offers both choices for players who prefer the alternatives.

## 9. Developer dashboard

Open it with `?devtools`, or turn on Developer mode in Settings → Data and use the Developer tab. **F9** toggles it.

It draws on canvas, outside React:

- a log-frequency spectrum with the six band edges;
- band meters (smoothed, raw normalised, peak hold, dBFS);
- the waveform;
- a four-second flux history with onset markers, and a transient meter;
- a beat dial comparing the track grid with the detected beat, with a confidence arc;
- level meters (RMS, energy, brightness, dynamic range, anticipation, section intensity);
- the current stage's bindings with their live envelopes and driven values.

Sliders tune sensitivity, treble scale and per-band attack and release live; **Copy as JSON** exports the tuning together with the reactivity settings.

## 10. Limitations

- **Other applications' audio can't be analysed.** A browser page can't inspect audio from another program, such as a video player. The only route is a user-granted tab or screen capture with audio (`getDisplayMedia`). This exists as an experimental developer option: the audio dashboard's "Analyse shared audio" button (`src/audio/analysis/externalCapture.ts`) replaces the game music as the analysis input until sharing stops; the shared sound is never played back.
- **The corpus is synthetic.** It is rendered by Prismfall's own synthesiser, so it tests the engine against exact ground truth, not against mastered commercial recordings.
- **Octave errors on ambiguous tempos.** Very slow (≈60 BPM) or very fast (≈174 BPM) music may be detected at double or half tempo. Phase still aligns with the true grid, and Prismfall's own tracks use their exact grid.
- **Syncopated grooves take longer to lock.** Phase can need up to about six seconds when off-beat accents compete with the backbeat; the first estimate may sit on the off-beat.
- **The analyser fallback has unreliable beat phase**, as measured above. It is used only when AudioWorklet is unavailable.
