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
- **Post-processing** (`RenderPipeline`): bloom, colour grading, tone mapping and AA, plus optional GTAO, SSR, DOF and FSR1 depending on quality. MSAA is used only when no depth-based pass is active.

## 5. Audio

- Bus graph: music, SFX, ambience and UI buses feed a master bus with a limiter.
- Music is generated live from TypeScript compositions by a lookahead sequencer. The `FileTrack` track type adds support for user audio files.
- The Music Director and BeatClock own all musical timing. They use the audio clock, never JS intervals.
- The Music Analysis Engine (`src/audio/analysis`) taps the music bus before the volume fader and publishes `AudioFeatures`. The renderer consumes that interface and never touches audio nodes.

## 6. Content

- A stage is a folder under `content/stages/<id>/`. It contains:
  - `stage.json`, the manifest, versioned and validated with zod;
  - an optional `stage.ts` that registers custom components, effects or materials through the Content SDK;
  - music, models, textures and previews;
  - `assets.json` with licence metadata.
- Vite `import.meta.glob` discovers stages automatically, and the stage-select screen is built from them.
- Invalid stages show as "Unavailable" with the reason; they never crash the game.

## 7. Milestones

| # | Milestone | Status |
|---|---|---|
| 1 | Investigation & planning | done |
| 2 | Gameplay foundation (playable) | done |
| 3 | 3D rendering foundation | done |
| 4 | Effects, environments, Content SDK, first 3 stages | in progress |
| 5 | Audio engine + Music Analysis Engine | planned |
| 6 | Complete interface + all modes | planned |
| 7 | Controllers, settings, persistence | planned |
| 8 | Final content (10 stages + Folded Sky scalability test) | planned |
| 9 | Optimization & verification | planned |

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
