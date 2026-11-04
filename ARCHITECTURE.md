# Prismfall Architecture

Prismfall is a browser game. Its systems are built in these languages and libraries:

| Part | Built with |
|---|---|
| Gameplay engine | Pure TypeScript |
| Rendering | Three.js (WebGPU with WebGL 2 fallback, materials written in TSL) |
| Audio | Raw Web Audio API |
| Menus and HUD | React |
| Game content | Data-driven content modules |

This document covers how the systems fit together. Gameplay rules are described in REFERENCE_NOTES.md, content authoring in CONTENT_GUIDE.md, audio analysis in AUDIO_ANALYSIS.md, and measurements in PERFORMANCE.md.

## 1. Systems and boundaries

```
             ┌───────────────────────────── GameShell (src/app) ─────────────────────────────┐
             │ owns the single requestAnimationFrame loop and wires the systems together     │
             │                                                                               │
 keyboard ─┐ │  InputManager ──actions──► GameSession ──► Engine (1 ms fixed ticks, pure TS) │
 gamepad ──┴─┼► (contexts: gameplay /    │   (runner,      │                                │
             │   menu / capture)         │    replay)      ▼ GameEvents (tick-stamped)      │
             │                           │        ┌────────┼─────────────┬────────────┐      │
             │                           │        ▼        ▼             ▼            ▼      │
             │                           │ FeedbackDirector  SfxPlayer  MusicDirector HudStore│
             │                           │   (rendering/fx)  (audio)    (intensity)  (zustand)│
             │                           │        │                         │          │      │
             │  StageManager ─► StageModule ──────┼──► RenderSystem ◄── AudioFeatures   ▼      │
             │  (manifest+env+music+sfx)          │    (three.js)       (analysis)   React UI │
             │  SettingsStore ──slices──► every subsystem   Storage (IndexedDB) ◄─► repositories │
             └───────────────────────────────────────────────────────────────────────────────┘
```

| System | Location | Depends on | Must not depend on |
|---|---|---|---|
| Gameplay engine | `src/game` | nothing (pure TS) | DOM, three, audio, React |
| Input manager | `src/input` | DOM events, Gamepad API | game internals, React |
| Rendering | `src/rendering` | three, engine **read-only** state, AudioFeatures interface | audio nodes, React |
| Audio | `src/audio` | Web Audio | three, React |
| Stage system | `src/stages` | zod, Content SDK | concrete stage names |
| Content SDK | `src/sdk` | rendering/audio public APIs | engine internals |
| Settings | `src/settings` | zod, zustand | subsystems (they subscribe to it) |
| Persistence | `src/storage` | idb | UI |
| UI | `src/ui` | zustand stores, GameShell commands | engine internals, three |
| Content | `content/` | **only** `@prismfall/sdk`, three, three/tsl (ESLint-enforced) | everything in `src` |

## 2. Frame loop

Each `requestAnimationFrame` callback runs these steps in order:

1. **Input.** Poll gamepads. Queued keyboard events already carry `KeyboardEvent.timeStamp`.
2. **Simulation.** `GameSession.update(performance.now())`:
   - Converts each timestamped input into a 1 ms engine tick. An input stamped before the last simulated tick is clamped to the current tick.
   - Applies the inputs, then steps the engine up to "now".
   - Advances at most 100 ms per frame. Anything beyond that shifts the time base instead of applying burst gravity.
3. **Event dispatch.** Engine events are drained into the feedback, SFX and music systems and the HUD store.
4. **Music signals.** The audio clock, read through `getOutputTimestamp` and smoothed, gives the beat phase. The analysis frames supply the `AudioFeatures`.
5. **Render.** The frame limiter may skip **only** this step; simulation and input still run.

React is never inside this loop. The HUD updates on events through a zustand vanilla store. The timer text is written through a ref at about 20 Hz.

## 3. Determinism

- The engine uses integer milliseconds, integer fixed-point gravity (2^24 units per row) and a seeded `sfc32` PRNG with a 7-bag. Nothing in it is wall-clock dependent.
- A replay is `{engineVersion, seed, rules, inputs: [appliedTick, action, down][]}`. Re-simulating it must reproduce the state hash exactly, and unit tests enforce this.
- The placement AI (`src/game/ai`) plays automated sessions for e2e, perf and soak tests.

## 4. Rendering

- `WebGPURenderer` (three r187) uses the WebGPU backend when it is available. Otherwise it uses its built-in WebGL 2 backend.
  - A setting forces WebGL 2; it applies on reload.
  - All materials and post effects are written in TSL, so there is one shader codebase for both backends.
- **Board:** instanced meshes. Per-instance data is packed into one interleaved buffer, which keeps every pipeline within 8 vertex buffers.
- **Particles:** instanced billboards animated statelessly in shaders. Burst effects use a GPU ring buffer that the CPU writes only when an event spawns particles.
- **Lighting:** a fixed global light rig. Stages only configure it, which avoids shader recompiles in the middle of a game.
- **World reactions:** the renderer turns the clears it presents into long-lived signals (`heat`, the long `clearWave`) and up to four clear fronts that roll out through the world (`src/rendering/environments/worldSignals.ts`, `src/rendering/shaders/clearFront.ts`). Stage environments also track song sections (section states, `onSection`) and dispatch manifest event call-ins quantised to the music (`callins.ts`). All of it is derived from presented events and engine read-outs, never from inside the engine, so the simulation stays deterministic. See CONTENT_GUIDE.md, section 6.
- **Living worlds** (SDK 1.7, [LIVING_ENVIRONMENT_ARCHITECTURE.md](LIVING_ENVIRONMENT_ARCHITECTURE.md)):
  - The Environment Music Director turns the analysis features and the beat grid into slow, medium and fast drives and governed cues, once for every world.
  - Each world's `living.json` maps them onto its layers and schedules its events through the event director (music cues, ambient timers, groups).
  - Background intensity (Settings → World) scales the world's motion, music response, particles, light, events, creatures and atmosphere by target class.
  - None of it touches the board ([PROTECTED_PLAYFIELD.md](PROTECTED_PLAYFIELD.md)).
- **Post-processing** (`RenderPipeline`): bloom, colour grading, tone mapping and AA, plus optional GTAO, DOF and FSR1 depending on quality (no screen-space reflections; reflections come from the environment map and material fresnel). MSAA is used only when no depth-based pass is active.

## 5. Audio

- Bus graph: music, SFX, ambience and UI buses feed a master bus with a limiter.
- Music is generated live from TypeScript compositions by a lookahead sequencer. The `FileTrack` track type adds support for user audio files.
- The Music Director and BeatClock own all musical timing. They use the audio clock, never JS intervals.
- The Music Analysis Engine (`src/audio/analysis`) taps the music bus before the volume fader and publishes `AudioFeatures`. The renderer consumes that interface and never touches audio nodes.

## 6. Content

- A stage is a folder under `content/stages/<id>/`. It contains:
  - `stage.json`, the manifest, versioned and validated with zod;
  - an optional `stage.ts` that registers custom environment components, line-clear effects or transitions through the Content SDK (block surfaces and sound presets are chosen from built-ins);
  - music, models, textures and previews;
  - `assets.json` with licence metadata.
- Vite `import.meta.glob` discovers stages automatically, and the stage-select screen is built from them.
- Invalid stages are listed as "Unavailable (reason)" in world selection and in Settings → Developer → Content; they never crash the game.

## 7. Milestones

| # | Milestone | Status | Delivered |
|---|---|---|---|
| 1 | Investigation & planning | done | Repository setup, REFERENCE_NOTES.md (reference game not operable, so the notes use genre conventions), this architecture, Blender smoke test |
| 2 | Gameplay foundation | done | Deterministic engine (SRS, 7-bag, DAS/ARR, lock delay, hold, scoring, modes, replays, AI), settings schema and IndexedDB persistence, input architecture, playable app with menus and HUD |
| 3 | 3D rendering foundation | done | `WebGPURenderer` with WebGL 2 fallback, TSL block materials, board, camera, light rig, post-processing, rendering e2e tests, perf harness and baseline |
| 4 | Effects, environments, Content SDK | done | Content SDK and stage manifests, environment components, GPU particles, line-clear feedback, first stages including the Blender-built Ember Foundry, stage memory test |
| 5 | Audio engine + Music Analysis Engine | done | Bus graph, synthesiser and composition DSL, Music Director, SFX, ambience, analysis engine with acceptance corpus, reactivity profiles, developer dashboard (AUDIO_ANALYSIS.md) |
| 6 | Complete interface + all modes | done | World select with live previews, Voyage campaign, Music Room, replay viewer, practice options, level-up feedback, gamepad menu navigation |
| 7 | Controls & customisation | done | Keyboard and controller rebinding with conflict handling, controller tab (tester, mapping wizard, glyphs, rumble), old-save migration test |
| 8 | Worlds, block themes, creatures, stage audio | done | 13 worlds (12 in Voyage, plus the content-only Folded Sky scalability world), procedural block themes, the living creature system and terrain, material-aware impact sounds, extra mixer buses, sound test, adaptive stems and Opus pipeline, themed transitions |
| 9 | VR | done | WebXR immersive mode on a dedicated WebGL 2 renderer, VR settings, XR controller input and remapping, spatial menus and HUD, emulated (IWER) e2e tests. Not yet verified on a real headset |
| 10 | Optimisation & verification | in progress | `Play.cmd` launcher, soak test, experimental shared-audio analysis, performance measurements (PERFORMANCE.md), requirements audit (FEATURES.md) and manual checklist (MANUAL_CHECKS.md) |

### Subsystem docs

- **Project:** [README.md](README.md) (setup, scripts, controls, saves), [FEATURES.md](FEATURES.md) (requirements audit and known limitations), [MANUAL_CHECKS.md](MANUAL_CHECKS.md) (checks only a person can make), [DEPLOYMENT.md](DEPLOYMENT.md) (local play and private access) and [CLAUDE.md](CLAUDE.md) (working rules for AI-assisted changes).
- **Content and assets:** [CONTENT_GUIDE.md](CONTENT_GUIDE.md) (authoring worlds), [BLENDER_PIPELINE.md](BLENDER_PIPELINE.md), [ASSET_LICENSES.md](ASSET_LICENSES.md) and [AUDIO_ASSETS.md](AUDIO_ASSETS.md).
- **VR:** [VR_ARCHITECTURE.md](VR_ARCHITECTURE.md), [VR_SETTINGS.md](VR_SETTINGS.md), [VR_TESTING.md](VR_TESTING.md) and [VR_REFERENCE_RESEARCH.md](VR_REFERENCE_RESEARCH.md).

## 8. Technical risks and mitigations

| Risk | Mitigation |
|---|---|
| TSL / WebGPU API churn | Pin three r187; renderer-specific code stays isolated in `src/rendering/renderer` |
| WebGL 2 backend parity | No required compute shaders; packed vertex attributes; both backends covered by e2e tests |
| Headless WebGPU false positives | E2E probe asserts `backend.isWebGPUBackend` and a non-fallback adapter |
| Mid-game shader-compile hitches | Fixed light rig, `compileAsync` warm-up, preloading |
| Audio scheduling starved by long tasks | Lookahead extended to ≥ 1 bar before heavy work |
| Synthesized music quality | Strong synth/FX layer, measured mix checks, user tuning pass |
| Gamepad differences (XInput ids, Steam Input duplicates) | Polling as source of truth, id heuristics, mapping wizard, active-pad selection |
| Per-origin save storage | Fixed ports (`strictPort`), `navigator.storage.persist()`, JSON export/import |
