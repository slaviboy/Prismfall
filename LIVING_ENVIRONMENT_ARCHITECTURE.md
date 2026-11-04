# Living environment architecture

How the worlds around the board keep moving, answer the music and stage their own events, and how much they do it (brief §40). This page covers the design. The per-world mappings are in [MUSIC_REACTIVE_ENVIRONMENTS.md](MUSIC_REACTIVE_ENVIRONMENTS.md), the authoring reference in [CONTENT_GUIDE.md](CONTENT_GUIDE.md) §6.5, the board's protection in [PROTECTED_PLAYFIELD.md](PROTECTED_PLAYFIELD.md), and the reference study behind the defaults in [BACKGROUND_VISUAL_REFERENCE.md](BACKGROUND_VISUAL_REFERENCE.md).

## 1. The pieces

```
 Music Analysis Engine ──AudioFeatures──┐      (one FFT path; the director never touches audio nodes)
 Music Director (beat grid, sections) ──┤
                                        ▼
                        EnvironmentMusicDirector ── MusicDrive (15 drives) ── environmentUniforms.music.*
                         (living/musicDirector.ts)  MusicCue[] (accent, phrase, build, drop, peak…)
                                        │
 Settings → World ── resolveBackground ─┤── BackgroundLevels (7 knobs) ─────── environmentUniforms.level.*
  (+ reduced motion, reduce flashing)   │
                                        ▼
                               EnvironmentHost (one per renderer)
                                        │  per world on screen, every frame:
                                        ▼
                               StageEnvironment ──────────────────────────────────────────┐
         ┌──────────────────────────────┼──────────────────────────────┐                 │
         ▼                              ▼                              ▼                 ▼
   ReactivityLayer               EnvironmentEventDirector       components          WorldSignals
   bindings (stage.json,         (callins.ts): game, music      update(frame)       clear fronts
   profiles, living.json         and ambient triggers, groups,  frame.music,        (+ music `wave`)
   music.*), section states,     variety, cooldowns, quantised  frame.levels,
   pulses; Background classes    to the music                   onMusicCue
         │                              │
         └───── reactive uniforms ◄─────┘ (`pulse`; other actions go to components' onCall)
```

| Piece | Where | What it does |
|---|---|---|
| **EnvironmentMusicDirector** | `src/rendering/environments/living/musicDirector.ts` | One interpretation of the music for every world. It turns AudioFeatures and the beat grid into 15 drives with their own time scales, plus governed cues. |
| **AudioFeatureNormalizer** | `living/normalizer.ts` | Song-relative contrast: each drive mixes the level with its excitation above a slow mean, so a quiet song moves the world as much as a loud one. |
| **EnvironmentEventDirector** | `src/rendering/environments/callins.ts` | The moments that call a layer to act, from game, music and ambient triggers, with groups that take turns, strength variation, gating, cooldowns and quantising. |
| **Background intensity** | `living/intensity.ts`, Settings → World | Presets and seven knobs. They scale every classified reactive target (its base value and every response on it), the event rates and the environment uniforms. |
| **Reaction profiles** | `content/stages/<id>/living.json` | Each world's music mapping, intensity classes and events. Data only, validated with the manifest (`src/stages/living.ts`). |
| **ReactivityLayer** | `src/rendering/environments/reactivity.ts` | Drives the reactive uniforms from bindings (raw features, `music.*` drives, `game.*` signals), section states and timed pulses, with class scaling. |
| **Environment uniforms** | `src/rendering/shaders/environmentUniforms.ts` | World-only TSL uniforms for custom shaders: drives pre-scaled by the music level, and the levels themselves. |

The user's suggested layout (`environment/core`, `animation`, `audio`, …) maps to these as follows:

| Suggested | Implemented as |
|---|---|
| `EnvironmentManager` | `EnvironmentHost` + `StageEnvironment` |
| `EnvironmentMusicDirector` | `living/musicDirector.ts` |
| `EnvironmentEventDirector` | `callins.ts` |
| `BackgroundIntensityManager` | `living/intensity.ts` + `EnvironmentHost.setBackground` |
| `EnvironmentAudioBridge`, `AudioFeatureNormalizer` | the director's input and `living/normalizer.ts` |
| `MusicMappingProfiles` | `living.json` |
| `Ambient`, `MusicReactive`, `Beat` and `EventAnimationSystem` | the four layers in §3 |
| Particles, assets, LOD | the existing components, asset cache and detail levels |

The stage-specific profiles live with their world's content, not in engine folders, so a new world is still content only.

## 2. Frame order

Inside `RenderSystem.render`, after the board and the world signals:

1. `EnvironmentHost.update`. The music director advances once, with real music only (`musicActive` comes from the shell; the silent metronome stand-in leaves the worlds at rest). It writes `environmentUniforms.music.*`.
2. For each world on screen:
   - its cues are delivered (`onMusicCue`), arming event calls;
   - its reactivity updates (bindings, states, pulses, levels);
   - section and signal triggers run;
   - due calls are delivered;
   - its components update with `frame.music` and `frame.levels`.
3. Beats are delivered (`onBeat`), releasing quantised calls on the next beat, bar or phrase.

React is never involved. The director, the event director and the reactivity layer are pure TypeScript with time-constant envelopes, so they behave the same at 60, 144 or 240 Hz (unit-tested), and they allocate nothing per frame beyond the cue list.

## 3. Four layers of motion

| Layer | Source | Examples |
|---|---|---|
| **1. Ambient** | Every component animates on its own clock, with or without music | Clouds, wind, water, fog, aurora folds, drifting particles, creatures walking their paths, ambient call-ins on timers |
| **2. Music-reactive** | The `body`, `swell`, `motion`, `detail`, `shimmer`, `flux`, `energy` and `intensity` drives through `living.json` bindings | The bass breathing through lava or aurora; the mids stirring vegetation and lights; the treble in fine particles |
| **3. Beat** | `beat`, `downbeat` and `accent` (selected, governed) | A lantern pulse on some downbeats, a short flare of sand on a strong accent |
| **4. Major events** | Cues (`build`, `drop`, `peak`, `break`, `phrase`, `section`) and game moments through the event director | An aurora surge and a wave of light on the drop, a vortex of glowing fish at the peak, a creature passing on a phrase |

The layers stack on the same reactive targets. Bindings multiply or add, pulses ride on top, and the Background intensity classes scale all of it.

## 4. Why it moves this way

The reference study measured that the world follows the music's large shape (r up to 0.84) and not its drum hits (r ≈ 0), that it trails the music by 0.2–0.5 s, and that it has rare, discrete big moments. So:

- **Distinct time scales per band.** `body` has a 250 ms attack and a 1.4 s release, `motion` 120/600 ms, `detail` 30/250 ms with a slew limit. Large things move slowly; fine things quickly but never strobing.
- **No global beat pulse.** `beat` fires only on downbeats, accented beats and, in busy sections, every other beat. `accent` must stand out from the recent onsets and is at least a beat and 0.35 s apart: measured on the shipped tracks, 15–40 a minute in dense music.
- **Structure first.** `intensity` (about 3 s), `tension` (builds and the last bars before a drop) and `release` (the 6 s after a drop) carry the song's shape. The drop, build, break and peak cues mark it.
- **Variety.** Ambient timers draw random intervals, slightly shorter in busy music. Groups never repeat the same visitor twice in a row, and `vary` changes the strength. So the world does not loop visibly.
- **Quiet passages stay alive.** Layer 1 never stops, and `calm` brings out quiet-time details, for example more fireflies.

## 5. Background intensity

| Knob | Scales |
|---|---|
| Environmental animation | `motion` targets: speed, sway, turbulence, amplitude, drift, wind, flow |
| Music reactivity | Every audio and music binding's amount, and `environmentUniforms.music.*` |
| Particle intensity | Particle layers' density, brightness and amount (not size) |
| Lighting intensity | `light` targets: glow, emissive, brightness, stars, heat, windows, beams |
| Event frequency | Call-in cooldowns and chances, ambient intervals, event-rate targets such as the meteors' `rate` |
| Creature activity | Creature `pace`, `tempo` and `activity` (a herd's visible share only where a world opts in) |
| Atmospheric density | `atmosphere` targets: opacity, fog, haze, mist, smoke, density |

- **Presets:** Subtle, Balanced (every knob at 1: the worlds as authored), Immersive, Cinematic, and Custom, which uses the sliders.
- **Reduced motion** halves animation, sets creatures to 0.7 and music to 0.8.
- **Reduce flashing** caps lighting at 1 and makes the director's accents and detail rarer and softer.
- **World events** (calm or off) still applies on top.

**Classes.** Each reactive target has a class from its component type and name (`classifyTarget`). A world can override any class in `living.json` (`"layer.target": "none"`, for instance). Targets a component sets itself (`presence`, `music`, `time`) are never touched.

**Static scenery is never thinned.** A `visible` share is not scaled by default, because `model` layers also place rocks and ruins.

## 6. Protection of the board

- Nothing here reads or writes the board, block, light-rig, camera or post code.
- The board-coupled `frameUniforms` (`bass`, `beatPulse`, `reactivity`, …) keep their meaning; worlds get their own uniforms.
- Scene fog is not scaled: the atmosphere knob acts on a world's own layers.
- Waves reuse the clear-front slots but never heat the run or displace a young clear front.
- Checked by `scripts/protectedPlayfield.test.ts` (in `npm test`) and the pixel comparison in `scripts/playfield-baseline.ts`.

## 7. Adding a world

Write `content/stages/<id>/living.json` next to its `stage.json`:

- the music reactions: large things on `body` or `swell`, medium on `motion`, fine on `detail` or `shimmer`, the song's shape on `intensity`, `tension` or `release`;
- class overrides, where a default class does not fit;
- events: drops and peaks, phrases, ambient visitors in a group.

Then:

- Measure how the world's track moves the drives with `node scripts/living-survey.ts --stages <id>`.
- Record it with `node scripts/record-living.ts --stages <id>`.
- Check that `npm run content:validate` and `npm test` pass.

Nothing in `src/` changes for a new world.

## 8. Engine fixes made for it

- **Phase continuity.** Reactive rates used to multiply absolute time (`time × speed`), so any change of speed teleported every particle or wave. The particle drift, aurora folds, water swell, swarm wingbeats and galaxy rotation now integrate their own clocks on the CPU.
- **Side-on creature passes.** `pass.path: "lateral"` crosses one side of the frame at a near-constant distance, never inside the board's widened rectangle. This is the "caravan in the distance" crossing that axial passes could not make.
