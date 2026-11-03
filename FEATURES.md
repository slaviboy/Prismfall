# Features: requirements audit

This audit checks the brief (`prompt.md`, §1–§27) against the code as of 2026-11-03.

| Status | Meaning |
|---|---|
| **Done** | Implemented, with the main evidence listed. |
| **Partial** | Some of it is implemented; the note says what is missing. |
| **Not done** | Not implemented. |
| **Manual check** | Implemented, but whether it is good can only be judged by a person or on real hardware; see [MANUAL_CHECKS.md](MANUAL_CHECKS.md). |

How to read the Evidence column:

- It lists the main source file(s), then the tests that cover them.
- Unit tests sit next to their modules, for example `src/game/core/engine.test.ts`.
- Browser tests are in `e2e/`.
- "No automated test" means the item was verified only by reading the code.
- Performance and soak results are not repeated here; they are in [PERFORMANCE.md](PERFORMANCE.md).

## The core rule: this must be guideline tetromino play

| Requirement | Status | Evidence |
|---|---|---|
| Only the seven tetrominoes (I, O, T, S, Z, J, L) | Done | `src/game/pieces/pieces.ts`; `pieces.test.ts` ("exactly the seven tetrominoes") |
| Falling, moving, rotating, soft and hard drop, locking, line clears, scoring, levels, previews, hold, combos | Done | `src/game/core/engine.ts`; `engine.test.ts` |
| SRS rotation with wall kicks | Done | `pieces.ts`, `engine.ts`; `pieces.test.ts` (SRS states, kick tables), `engine.test.ts` (I kick off the wall) |
| Every mode stays the same game | Done | `src/game/modes/modes.ts`: modes only set `RuleConfig` values |

## §1 Non-negotiable requirements

| Requirement | Status | Evidence |
|---|---|---|
| Runs in a modern browser; TypeScript throughout | Done | `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`); `npm run typecheck` |
| React for menus, settings, HUD and overlays | Done | `src/ui/` |
| three.js, WebGPU preferred, WebGL 2 fallback | Done | `src/rendering/renderer/RenderSystem.ts`; `e2e/rendering.spec.ts` (real WebGPU adapter, forced WebGL 2, no-WebGPU fallback) |
| Custom deterministic engine | Done | `src/game/`; `engine.test.ts` (replay reproduces the state hash; 200k-tick fuzz) |
| Web Audio API | Done | `src/audio/engine/AudioEngine.ts`; `e2e/audio.spec.ts` |
| Keyboard and controllers | Done | `src/input/`; `input.test.ts`, `e2e/controls.spec.ts`, `e2e/gamepad.spec.ts` |
| Mouse control (optional): piece follows the pointer, left click hard drop, right click rotate, middle click hold | Done | `src/input/mouse/mouseControl.ts` (one-cell `nudge` actions, replay-safe); `mouseControl.test.ts`, `e2e/mouse.spec.ts` |
| Developer mode unlocks every world, with a switch | Done | `DataPanel.tsx`, `StageSelect.tsx`, Developer tab; `e2e/stage-select.spec.ts` |
| Extensive settings | Partial | See §11: reflection quality is not implemented |
| Data-driven levels | Done | `src/stages/`, `content/stages/`; `src/stages/content.test.ts` |
| High-DPI and high-refresh displays | Done / Manual check | `e2e/rendering.spec.ts` (DPR 2, resize to 2560×1080); 144 Hz feel is a manual check |
| Saves settings and progress | Done | `src/storage/`; `storage.test.ts`, `e2e/smoke.spec.ts` (a setting survives a reload) |
| Private repository, no public deployment | Done | Local git with no remote; no CI or deploy scripts; [DEPLOYMENT.md](DEPLOYMENT.md) |
| No analytics, ads, trackers or needless third parties | Done | No external requests in `src/` or `index.html` (no automated test) |
| Single player only | Done | No multiplayer, accounts or social code |

## §2 Reference-game investigation

| Requirement | Status | Evidence |
|---|---|---|
| Play and observe the Steam game; screenshots and clips | Not done | No desktop-control tools were available. [REFERENCE_NOTES.md](REFERENCE_NOTES.md) §0 records this; the repository has no reference screenshots |
| REFERENCE_NOTES.md covering gameplay, UI, settings and feedback | Partial | The document exists, but every reference column reads "Not observed". The design follows genre conventions and the brief |
| Feature-parity checklist | Partial | REFERENCE_NOTES.md §C says no parity can be claimed. This file is the implementation checklist |

## §3 Technical stack and rendering subsystem

| Requirement | Status | Evidence |
|---|---|---|
| Vite, Zustand, Vitest, Playwright; pinned dependencies | Done | `package.json` (exact versions), `package-lock.json` |
| Separate rendering subsystem with renderer code isolated | Done | `src/rendering/renderer/` |
| High DPI, configurable render resolution, manual and dynamic scale | Done | `RenderSystem.ts` (`updateDynamicResolution`); `e2e/rendering.spec.ts` (render scale 0.6 and 1.5, DPR 2). No automated test of dynamic resolution itself |
| Post-processing: bloom, tone mapping, AA (FXAA, SMAA, MSAA), GTAO, DOF, FSR 1 upscaling | Done | `src/rendering/postprocessing/PostPipeline.ts`; `e2e/rendering.spec.ts` (toggles applied live) |
| Ambient lighting and shadows | Done | `src/rendering/lighting/LightRig.ts`, PMREM environment in `RenderSystem.ts` |
| Particle systems | Done | `src/rendering/particles/BurstSystem.ts`, `environments/components/particles.ts`, `emitter.ts`, `swarm.ts` |
| Fullscreen | Done | "Enter fullscreen" in Settings → Graphics (`src/ui/settings/graphicsPanels.tsx`). No automated test |
| Camera control | Done | `src/rendering/camera/CameraRig.ts`, Camera settings tab |
| React never re-renders per frame; the loop is independent of React | Done | Single rAF loop in `src/app/GameShell.ts`; the HUD uses a zustand vanilla store, and the timer is written through a ref (no automated test) |

## §4 Gameplay engine

| Requirement | Status | Evidence |
|---|---|---|
| 10 × 20 playfield with configurable hidden rows | Done | `src/game/rules/rules.ts` (20 hidden rows by default; set per rules, not a player option); `board.test.ts` |
| 7-bag randomiser and deterministic seeds | Done | `src/game/random/`; `randomizer.test.ts` |
| Movement, CW, CCW and optional 180° rotation, soft and hard drop, ghost, hold, next queue (1–6), gravity, lock delay, collision | Done | `engine.ts`; `engine.test.ts` (movement, rotation, gravity and locking, hold), `board.test.ts` |
| Line clears, scoring, levels, combos, back-to-back, T-spins and minis, perfect clears | Done | `src/game/scoring/scoring.ts`, `src/game/rules/spin.ts`; `scoring.test.ts`, `engine.test.ts` |
| Game over, pause and resume, restart | Done | `engine.test.ts`, `e2e/smoke.spec.ts` ("pauses, resumes, restarts and quits") |
| High scores and session statistics | Done | `src/storage/repositories.ts`; `storage.test.ts`, `e2e/smoke.spec.ts` (Sprint result recorded) |
| Replays (extra) | Done | `src/game/simulation/replay.ts`, `src/ui/menus/ReplayControls.tsx`; `engine.test.ts`, `e2e/smoke.spec.ts` (viewer seek, speed, restart) |
| Configurable DAS and ARR, input buffering, no dropped inputs, timing independent of frames | Done / Manual check | `engine.ts`, `src/app/GameSession.ts`; `engine.test.ts` ("DAS and ARR timing to the millisecond", "inputs at their timestamp tick", "clamps late inputs"). Feel is a manual check |
| Visual effects never affect gameplay timing | Done | The frame limiter skips only rendering (`GameShell.ts`), and the engine has no rendering dependencies |
| Score, best, level, lines, time, combo and back-to-back shown | Done | `src/ui/hud/Hud.tsx` |
| Scoring configurable and testable in isolation | Done | `scoring.test.ts` ("accepts a custom table") |
| Placement AI for automated play (extra) | Done | `src/game/ai/bot.ts`; `engine.test.ts` ("the AI completes a 40-line Sprint") |

## §5 3D art direction

| Requirement | Status | Evidence |
|---|---|---|
| Real 3D bevelled blocks: PBR-style, edge highlights, controlled emissive, inner light | Done / Manual check | `src/rendering/board/blockGeometry.ts`, `blockLibrary.ts` (Blender GLBs: chamfer, faceted, framed, pillow, soft), `src/rendering/materials/blockMaterial.ts`; `e2e/blocks.spec.ts`, `e2e/block-themes.spec.ts` |
| Instanced rendering | Done | `src/rendering/board/BoardView.ts` (instanced meshes, one packed interleaved buffer) |
| Stage themes change materials without logic changes | Done | `blockPresets.ts`, `blockSurfaces.ts`, manifest `blocks` |
| Playfield: composed camera, frame, grid, landing effects, readability | Done / Manual check | `BoardView.ts`, `boardMaterials.ts`, `src/rendering/fx/FeedbackDirector.ts` |
| "Carefully controlled reflections" | Partial | PMREM environment reflections and per-material fresnel (the water surface) only. There are no screen-space or planar reflections, and the reflection quality setting does nothing (§11) |
| GPU particle systems: dust, distant fields, atmosphere, glow, trails, clears, streams, transitions, beats | Done | `particles.ts`, `emitter.ts`, `swarm.ts`, `BurstSystem.ts`, `lineClearEffects.ts`, `transitions.ts`; `transitions.test.ts` |
| Real 3D environments, not recoloured backdrops | Done / Manual check | 17 built-in components (`src/rendering/environments/builtins.ts`: terrain, water, sky, city, galaxy, aurora, lava, creatures and more); `e2e/stages.spec.ts` |

## §6 Stage and level system

| Requirement | Status | Evidence |
|---|---|---|
| Data-driven definition: name, description, environment, palette, lighting, particles, geometry, music, BPM, intensity, camera, line clears, unlocks | Done | `src/stages/schema.ts`; `content.test.ts` |
| Special environmental events | Partial | There is no dedicated events field. Worlds react through reactivity bindings on beats, sections and transients, and through quad "signature" responses |
| At least 10 distinct, playable worlds | Done | 13 worlds in `content/stages/`; `e2e/stages.spec.ts` ("every stage loads, renders and plays") |
| Stage selection, locked and unlocked stages, saved completion | Done | `src/ui/menus/StageSelect.tsx`, `src/stages/progression.ts`; `e2e/stage-select.spec.ts`, `e2e/voyage.spec.ts`, `campaign.test.ts` |
| New stages need no engine changes | Done | Folded Sky (see §22 I) |

## §7 Music and audio reactivity

| Requirement | Status | Evidence |
|---|---|---|
| Music, SFX and ambience channels; master and individual volumes; mute; enable and disable | Done | `AudioEngine.ts`; `e2e/audio.spec.ts` ("mute silences the output and volume scales it"), `e2e/audio-settings.spec.ts` |
| Track selection, looping, fades, transitions, pause and resume | Done | `src/audio/music-director/`, `src/ui/menus/MusicRoom.tsx`; a world's tracks take turns game by game in free play (`trackRotation.ts`); `trackRotation.test.ts`, `e2e/audio.spec.ts` (bar-line crossfade, stop-mode pause, tracks taking turns), `e2e/music-room.spec.ts` |
| Original music | Done / Manual check | 34 procedural compositions in `content/stages/*/music/*.ts`; `composition.test.ts`, `content.test.ts`; whole-track mix measurements in `e2e/audio-tracks.spec.ts` (on demand). Musical quality is a manual check |
| Architecture for the owner's own audio files | Done | `FileTrackPlayer` in `src/audio/music-director/tracks.ts`, `src/audio/library/UserMusic.ts`; `tracks.test.ts`, `e2e/audio.spec.ts` (WAV with beat metadata) |
| Beat metadata: BPM, beat and bar position, sections, intensity, cues | Done | `src/audio/sequencer/composition.ts`, `tracks.ts`; `tracks.test.ts` |
| Analyser-driven reactivity; gameplay never depends on analysis | Done | `src/audio/analysis/`, `src/rendering/environments/reactivity.ts`; `reactivity.test.ts`, `e2e/stages.spec.ts` |
| Reusable Music Director | Done | `src/audio/music-director/MusicDirector.ts` |

## §8 Gameplay feedback

| Requirement | Status | Evidence |
|---|---|---|
| Spawn, move, rotate, land, clears 1–4, combos, major events and level transitions each have visual and audio responses | Done / Manual check | `FeedbackDirector.ts`, `lineClearEffects.ts`, `src/audio/sound-effects/SfxBank.ts`; `e2e/rendering.spec.ts` (level-up tint and surge), `e2e/audio-acceptance.spec.ts` |
| Effects never block gameplay | Done | Events are drained after simulation, and rendering may be skipped without affecting the engine (`GameShell.ts`) |

## §9 UI, HUD and menus

| Requirement | Status | Evidence |
|---|---|---|
| HUD: next, hold, score, level, lines, combo, timer, pause button, callouts | Done | `Hud.tsx`; `e2e/smoke.spec.ts` |
| Customisable HUD: next on/off and count, per-element visibility, scale, opacity, mirroring | Done | Interface and Gameplay tabs (`src/ui/settings/definitions.ts`), `Hud.tsx` |
| Every listed menu: main, modes, campaign, stage select, pause, results, high scores, settings tabs | Done | `src/ui/menus/`, `src/ui/settings/`; `e2e/smoke.spec.ts`, `e2e/screens.spec.ts` |
| Keyboard and controller navigation everywhere | Done | `src/ui/navigation/MenuNavigator.ts`; `e2e/smoke.spec.ts`, `e2e/gamepad.spec.ts` |

## §10 Game modes

| Requirement | Status | Evidence |
|---|---|---|
| Voyage (campaign) | Done | `src/stages/campaign.ts`, `content/campaigns/voyage.json` (12 worlds in 4 areas); `campaign.test.ts`, `e2e/voyage.spec.ts` |
| Marathon (150 lines, endless), Sprint (20, 40, 100), Ultra (2, 3, 5 min), Zen (still, flowing), Practice | Done | `modes.ts`; `engine.test.ts` (Zen top-out, Ultra goal, AI Sprint), `e2e/smoke.spec.ts`, `e2e/practice.spec.ts` |
| One engine with per-mode rules | Done | `modes.ts` → `RuleConfig` |

## §11 Settings

| Requirement | Status | Evidence |
|---|---|---|
| Typed settings with validation, defaults, versioned migrations, IndexedDB | Done | `src/settings/schema.ts`, `store.ts`, `src/storage/`; `storage.test.ts` (old-save fixture, corrupt data) |
| Graphics presets Low to Ultra, plus Custom | Done | `src/settings/presets.ts`; `storage.test.ts`, `e2e/rendering.spec.ts` |
| Render scale, display info, fullscreen, frame-rate limit, AA, bloom, shadows, particle density, environment detail, AO, post-processing, DOF, FOV, zoom, screen-space effects, dynamic resolution | Done | Graphics and Camera tabs (`definitions.ts`), `RenderSystem.ts`, `PostPipeline.ts`; `e2e/rendering.spec.ts` covers part of this |
| Reflection quality | Not done | `graphics.reflections` is in the schema and presets, and it reaches environments as `quality.reflections`, but no component reads it and it is not in the Settings UI |
| Motion blur | Done | Graphics → Motion blur (off by default). Velocity MRT plus three's `motionBlur` in `PostPipeline.ts`, masked by depth so only the world behind the playfield blurs; off with reduced motion |
| Restore recommended graphics | Done | `graphicsPanels.tsx` (`recommendPreset`) |
| VSync explained honestly; live FPS and renderer indicator | Done | Frame rate limit description (`definitions.ts`), `src/ui/hud/PerfOverlay.tsx` |
| Audio: master, music, SFX, ambience, mute, enable, reactivity on/off, latency calibration | Done | Audio tab, `src/audio/calibration/LatencyCalibrator.ts`; `calibration.test.ts`, `e2e/audio-settings.spec.ts` (tap-along calibration) |
| Camera: zoom, zoom sensitivity, distance, FOV, shake, movement | Done | Camera tab, `CameraRig.ts`. No automated test of camera settings |
| Gameplay: next pieces, hold, ghost, grid, DAS, ARR, soft drop, buffering, effects intensity, reduced motion, high contrast | Done | Gameplay and Accessibility tabs; `e2e/smoke.spec.ts` (ARR persists) |
| Keyboard remapping: capture, conflict warnings, swap or replace, restore defaults, required actions | Done | `src/ui/settings/ControlsPanel.tsx`, `src/input/mappings/bindings.ts`; `input.test.ts`, `e2e/controls.spec.ts` |
| Gamepad API: connect and disconnect, DS4, DualSense, Xbox and generic families, glyphs, d-pad, sticks, dead zones, sensitivity, remapping, menus, status, button tester | Done | `src/input/gamepad/gamepadSource.ts`, `ControllerPanel.tsx`, `src/ui/components/Glyph.tsx`; `input.test.ts`, `e2e/gamepad.spec.ts`, `e2e/controls.spec.ts` |
| Custom mapping for unusual layouts (wizard) | Done | `MappingWizard` in `ControllerPanel.tsx`; `input.test.ts` (non-standard pad through a profile). The wizard UI itself has no e2e test |
| Vibration | Done / Manual check | `GamepadSource.rumble` (dual-rumble, trigger-rumble). The tests' fake pad has no actuator, so there is no automated test |

## §12 Input architecture

| Requirement | Status | Evidence |
|---|---|---|
| Device → action mapping → gameplay action, with separate gameplay, menu and capture contexts | Done | `src/input/inputManager.ts`, `bindings.ts`; `input.test.ts` ("routes by context", capture mode) |
| Key repeat, polling, buffering, simultaneous inputs, focus loss, visibility, pause, disconnects, remapping | Done | `keyboardSource.ts`, `gamepadSource.ts`, `GameShell.ts`; `input.test.ts` (OS repeat ignored, focus loss, keyboard plus gamepad merge, disconnect release) |

## §13 Performance and GPU engineering

| Requirement | Status | Evidence |
|---|---|---|
| Instancing, GPU particles, resource reuse, disposal, lazy stage loading, asset caching, fixed-step simulation | Done | `BoardView.ts`, `BurstSystem.ts`, `src/rendering/assets/AssetCache.ts`, `src/stages/StageManager.ts`; `e2e/stage-memory.spec.ts` |
| Monitoring: FPS, frame time, GPU time, draw calls, CPU per subsystem, load times, memory | Done | `src/rendering/renderer/PerfMonitor.ts`. GPU memory is reported as geometry and texture counts plus JS heap, not bytes |
| Measured at 1440p and 4K against the 60 and 120 fps targets | Done (results: see PERFORMANCE.md) | `scripts/perf.ts`: resolution × preset × backend × stage matrix |
| Graceful degradation | Done | Presets, `recommendPreset`, dynamic resolution, and a Canvas 2D fallback view if 3D fails to start (`GameShell.createView`) |
| GPU device loss | Done | `RenderSystem` `onDeviceLost` → `GameShell.recoverRenderer` (pauses, rebuilds on a fresh canvas). No automated test |

## §14 Architecture

| Requirement | Status | Evidence |
|---|---|---|
| Independent subsystems behind typed interfaces | Done | [ARCHITECTURE.md](ARCHITECTURE.md) §1, `src/sdk/` |
| No `any`; strict TypeScript | Done | ESLint `no-explicit-any: error`, `tsconfig.base.json` |
| Avoid giant files | Done | Largest file: `GameShell.ts`, about 1,100 lines |

## §15 Privacy and data

| Requirement | Status | Evidence |
|---|---|---|
| No registration, analytics, ads, personal data or needless API calls; local saves; no secrets | Done | Code inspection; `.gitignore` excludes `.env*` |
| Deployable privately later, with real access control; no automatic publishing | Done | [DEPLOYMENT.md](DEPLOYMENT.md) |

## §16 Accessibility and comfort

| Requirement | Status | Evidence |
|---|---|---|
| Reduced motion (follow system, on, off), particle intensity, screen effects, camera shake, flash reduction, background dimming | Done | Accessibility tab, consumed in `RenderSystem.ts`, `FeedbackDirector.ts`, `CameraRig.ts`, `transitions.ts`; `transitions.test.ts` ("reduced motion thins every transition") |
| High-contrast colours and per-piece symbols | Done | `src/config/palette.ts`, `RenderSystem.ts` |
| HUD scale, input repeat, keyboard-only and gamepad-only use, SFX volume | Done | `e2e/smoke.spec.ts` (keyboard only), `e2e/gamepad.spec.ts` (controller only) |
| Visual indicators for important sounds | Done | `src/ui/hud/SoundCues.tsx`; `e2e/audio-settings.spec.ts` ("beat lamp follows the music") |

## §17 Testing

| Requirement | Status | Evidence |
|---|---|---|
| Gameplay tests: generation, rotations, boundaries, collision, locking, drops, hold, queue, clears, scoring, combos, levels, game over, restart, pause | Done | `engine.test.ts`, `board.test.ts`, `pieces.test.ts`, `randomizer.test.ts`, `scoring.test.ts` |
| Input tests: remapping, recognition, mapping, multiple events, disconnect, focus, conflicts | Done | `input.test.ts`, `e2e/controls.spec.ts`, `e2e/gamepad.spec.ts` |
| Rendering tests: WebGPU start-up, WebGL 2 fallback, resizing, high DPI, post-processing toggles, stage load and dispose | Done | `e2e/rendering.spec.ts`, `e2e/stage-memory.spec.ts`, `e2e/stages.spec.ts` |
| Fullscreen transitions | Not done | No automated test |
| Long-running gameplay | Done (results: see PERFORMANCE.md) | `e2e/soak.spec.ts`, `playwright.soak.config.ts` (`npm run test:soak`, both backends; asserts GPU resource counts, heap floor and frame-time trend); engine fuzz test |
| Particle performance | Done (results: see PERFORMANCE.md) | `scripts/perf.ts` |
| Audio tests: initialisation, unlocking, volume, mute, pause and resume, transitions, beat sync, reactivity | Done | `e2e/audio.spec.ts`, `e2e/audio-settings.spec.ts`, `dsp.test.ts`, `reactivity.test.ts` |
| E2E flows: start-up, menus, a full session, pause, settings persistence, restart, results | Done | `e2e/smoke.spec.ts`. Every e2e test also fails on any console error (`e2e/fixtures.ts`) |

## §19 Acceptance criteria (summary)

| Area | Status | Notes |
|---|---|---|
| Gameplay: correct mechanics, no corrupt board, reliable saves | Done | Engine tests, including fuzz and replay hash, plus storage tests |
| Gameplay: responsive keyboard and controller | Manual check | Timing is unit-tested; feel needs a person |
| Graphics: real 3D, distinct worlds, particles, music-reactive visuals, no placeholders | Done / Manual check | `content.test.ts` rejects placeholder content in release builds; the art itself needs review |
| Audio: engine, SFX, independent volumes, transitions, beat-aware effects, original content | Done / Manual check | Audio e2e and unit tests; listening review pending |
| User experience: menus, settings, remapping, stage select, modes, persistence | Partial | Complete except reflection quality (§11) |
| Performance: no per-frame React, no leaks, no degradation, measured | Done (results: see PERFORMANCE.md) | Soak test and perf matrix |
| Project quality: strict TypeScript, no console errors, documented setup and deployment | Done | Typecheck, lint, e2e console-error guard, README.md, DEPLOYMENT.md |

## §20 Deliverables

| Deliverable | Status | Evidence |
|---|---|---|
| Game, source, worlds, modes, settings, input, audio, test suite | Done | This repository |
| README.md, ARCHITECTURE.md, REFERENCE_NOTES.md, PERFORMANCE.md, DEPLOYMENT.md | Done | Repository root |
| ASSET_LICENSES.md | Done | Repository root; Folded Sky also has a per-stage `assets.json` |
| List of tested features; known limitations | Done | This file |
| Exact commands to install, develop, test, build, preview | Done | [README.md](README.md) |

## §22 Content expansion system

| Requirement | Status | Evidence |
|---|---|---|
| A. Each stage is a self-contained, consistently structured module | Done | `content/stages/<id>/` (`stage.json`, `music/`, `models/`, `previews/`, optional `stage.ts`); [CONTENT_GUIDE.md](CONTENT_GUIDE.md) |
| B. Typed, versioned, validated manifest | Partial | `schema.ts` (`schemaVersion`), `validate.ts`; `content.test.ts`. Missing: a separate preview image (the thumbnail serves both roles), per-stage combo effects and per-theme spawn animation. `recommendedQuality` is declared but unused |
| No hard-coded stage names in the engine | Done | Discovery through `import.meta.glob` (`src/stages/registry.ts`) |
| C, D. Each world looks and sounds different, with independent audiovisual control | Done / Manual check | Per-world environment, blocks, palette, lighting, music, ambience, impact profile, clear effect and transition in each manifest |
| E. Discover, validate, load on demand, preview, cache, unload, dispose, handle errors, show progress, preload | Done | `registry.ts`, `StageManager.ts`, `EnvironmentHost.ts`, `LoadingScreen` in `src/ui/menus/screens.tsx`; `e2e/stage-memory.spec.ts`, `e2e/stages.spec.ts` |
| F. New worlds without core changes | Partial | Environments, line clears and transitions can come from content through the SDK. New block surface types, SFX timbre presets and impact profiles still need code in `src/`: the SDK has no registry for them, and manifests can only tune built-in presets (`blocks.overrides`, inline `sfx.material`) |
| G. Stage select built from manifests: art, name, description, music preview, live preview, lock state, completion, loading | Done | `StageSelect.tsx`; `e2e/stage-select.spec.ts` |
| New stages never break saved progress | Done | `storage.test.ts` ("keeps old progress readable when new stages are added") |
| H. Documented local content packs | Partial | Build-time packs only: `content/packs/<pack>/pack.json` plus `stages/`, discovered at build time with an engine-version check (`registry.ts`). A pack needs a rebuild; there is no runtime (in-browser) pack import, no pack in the repository and no test that exercises packs |
| Versioned manifests, dependency validation, compatibility checks | Done | `requires.sdk`, `requires.components`, `satisfiesRange`; `content.test.ts` ("checks semver ranges", "reports unknown components…") |
| I. Scalability acceptance test | Done | `content/stages/folded-sky/`: its own `stage.ts` registers a paper-crane component, a fold-into-cranes clear and a paper-fold transition; own track "Paper Wind" at 136 BPM; no engine or menu changes. Its block material and impact sound use built-in presets (see F). Covered by `content.test.ts`, `e2e/stages.spec.ts`, `e2e/stage-memory.spec.ts` |

## §23 Blender pipeline

| Requirement | Status | Evidence |
|---|---|---|
| Blender availability checked; scripted, repeatable generation | Done | `scripts/build-blender-assets.ts` (Blender 5.2, headless), `assets/blender/pipeline.json`, `assets/blender/scripts/*.py` |
| GLB export optimised for the web | Done | `gltf-transform optimize` with meshopt geometry and WebP textures; meshopt decoder in `AssetCache.ts` |
| Reusable block asset library | Done | `content/shared/blocks/*.glb`; `e2e/blocks.spec.ts` |
| Stage environments built with Blender assets, combined with procedural three.js | Done | Desert, ice, Japan and foundry kits under `content/stages/*/models/`; creatures and flora in `content/shared/` |
| Editable `.blend` sources kept | Done | `assets/blender/source/` |
| Assets load and unload correctly | Done | Ref-counted `AssetCache.release`; `e2e/stage-memory.spec.ts` |
| Level of detail | Partial | Creature particles thin out with distance. Blender scenery has no mesh LOD levels |
| Workflow documented | Done | [BLENDER_PIPELINE.md](BLENDER_PIPELINE.md) |

## §24 Music analysis

| Requirement | Status | Evidence |
|---|---|---|
| A. VLC source researched and documented, with no code reused | Done | [AUDIO_ANALYSIS.md](AUDIO_ANALYSIS.md) §1 |
| B. Web Audio analysis with AnalyserNode and AudioWorklet paths, float data, FFT 2048 and 4096 profiled | Done | `AnalysisEngine.ts`, `analysis.worklet.ts`, `dsp/analyserFrame.ts`, `dsp/fft.ts`; `dsp.test.ts`, `e2e/audio-profile.spec.ts` |
| C. Six log-spaced bands; raw, normalised, smoothed and peak values, RMS, transients; silence handled | Done | `dsp/bands.ts`, `smoothing.ts`, `frameAnalyzer.ts`; `dsp.test.ts` |
| D. Spectral flux, onsets, beat detection, BPM, beat phase, centroid, energy, dynamic range, peaks | Done | `dsp/rhythm.ts`, `featureProcessor.ts`; `dsp.test.ts`, `trackAnalysis.test.ts` |
| E. Time-based smoothing: per-band attack and release, adaptive normalisation, noise gate, curves, limits | Done | `smoothing.ts`, `reactivity.ts`; `reactivity.test.ts` (same response at 60, 144 and 240 Hz) |
| F. Audio Features API with every named field; renderer decoupled from audio nodes | Done | `src/audio/analysis/features.ts` |
| G, H. Per-stage mapping profiles driving environments and GPU particles | Done / Manual check | `reactivity.ts`, `content/shared/reactivity/*.json`, `src/rendering/shaders/uniforms.ts`; `e2e/stages.spec.ts` ("stages wire their reactivity profiles") |
| I. Track metadata (sections, build and drop markers, intensity), anticipation, audio clock as reference | Done | `composition.ts`, `tracks.ts`, `MusicDirector.ts` (`anticipation`); `tracks.test.ts`, `e2e/audio.spec.ts` |
| J. Seven reaction presets plus master controls, applied live | Done | Reactivity tab; `e2e/audio-settings.spec.ts` |
| K. Developer dashboard, hidden unless enabled | Done | `src/devtools/AudioDashboard.ts`, `src/ui/devtools/AudioDashboardPanel.tsx`; `e2e/devtools.spec.ts` |
| L. Never blocks gameplay or rendering; typed arrays reused | Done | AUDIO_ANALYSIS.md §8; `e2e/audio-profile.spec.ts` |
| M. User-selected music files | Done | Music Room; `e2e/music-room.spec.ts` |
| M. External audio through user-mediated capture | Done / Manual check | Experimental and developer tools only: "Analyse shared audio (experimental)" in the dashboard uses `getDisplayMedia` (`src/audio/analysis/externalCapture.ts`, `AudioEngine.setAnalysisInput`). The shared audio replaces the game music as analysis input and is never played back; `externalCapture.test.ts`. The browser's share prompt cannot be automated |
| N. Acceptance across music styles | Done / Manual check | `e2e/audio-acceptance.spec.ts`, thresholds in AUDIO_ANALYSIS.md §7. The corpus is synthesised by the game's own synth, not taken from commercial recordings. Behaviour with real music is a manual check |

## §25 Worlds, creatures and block themes

### Worlds

| Brief world | Prismfall world (folder) | Environment highlights | Creatures | Blocks / clear / entrance | Status |
|---|---|---|---|---|---|
| 1 Ice | Frozen Kingdom (`frozen-kingdom`) | Blender ice citadel, ice spires, icebergs, frozen lake, northern glow, snowstorm | Ice spirits (particle rig) | `frozenCrystal` / frost wave / frost | Done / Manual check |
| 2 Japan | Ancient Garden (`ancient-garden`) | Blender temple, pond, cherry grove, pines, sky lanterns, petals, mist | Koi, cranes | `carvedWood` / petal shatter / petals | Done / Manual check |
| 3 Desert | Moving Sands (`moving-sands`) | Dune terrain, Blender ruins, blowing sand, sandstorm, golden motes | Particle camels on an animated rig: lone, groups and caravans at different speeds, fading in haze, spatial footsteps | `desertSandstone` / sand spiral / sand | Done / Manual check |
| 4 Dark space | Deep Cosmos (`celestial-drift`) | Galaxy, giant planet, asteroids, meteors, energy streams, nebula, pulsars, rings | Star whale | `cosmicCrystal` / supernova / stars | Done / Manual check |
| 5 Mountain | Alpine Horizon (`alpine-horizon`) | Valley terrain, lake, waterfall and mist, forested slopes, clouds, pollen | Chamois, eagles, birds | `alpineStone` / crumble dust / mist | Done / Manual check |
| 6 Ocean | The Abyss (`the-abyss`) | Seafloor with caustics, sunken ruins, light shafts, kelp, reef, bubbles | Fish schools, jellyfish, rays, turtles, whale | `oceanGlass` / bubble ascent / bubbles | Done / Manual check |
| 7 Forest | Enchanted Wilderness (`enchanted-wilderness`) | Giant trees, pool, glowing mushrooms, sun rays, fireflies, leaves, mist | Deer, forest spirit, butterflies, birds | `forestEmerald` / bloom seeds / leaves | Done / Manual check |
| 8 Volcanic | Ember Core (`ember-core`) | Volcano terrain with flowing lava, obsidian spires, eruption, ash plume, embers | Fire birds | `volcanicObsidian` / ignite-quench / embers | Done / Manual check |
| 9 Aurora | Northern Lights (`northern-lights`) | Two aurora layers, tundra, mirror lake, frozen arches, taiga, light streams | Reindeer, light birds | `auroraCrystal` / frost wave (mixed colour) / aurora | Done / Manual check |
| 10 Neon city | Future Nights (`future-nights`) | Streets and skyline (city component), wet street, traffic, rain and splashes | Drones | `neonGlass` / glitch slice / digital | Done / Manual check |
| Extra | Luminous Tide, Ember Foundry, Folded Sky | Night ocean; Blender foundry hall with molten channel; paper world | Paper cranes in Folded Sky only | `pearlGlass`, `forgedMetal`, `washiSheet` | Done / Manual check |

### Systems

| Requirement | Status | Evidence |
|---|---|---|
| Every world: environment, identity, animation, blocks, particles, music, reactivity profile, clear effect, landing, lighting, preview image, manifest | Done / Manual check | All 13 manifests validate (`content.test.ts`); every world has `previews/thumb.jpg` |
| Living creature system: Blender models, procedural skeletal gait on the GPU, particles sampled from the mesh surface, paths, distance LOD, footsteps | Done | `src/rendering/creatures/` (`rig.ts`, `surface.ts`, `paths.ts`), `components/creatureHerd.ts`, `swarm.ts`; `creatures.test.ts` |
| BlockTheme: material, surface, palette, roughness, metalness, emissive, edges, internal effects, per-world clear and landing, classic option | Done | `blockPresets.ts`, `blockSurfaces.ts` (12 surface types), Graphics → Block style; `e2e/block-themes.spec.ts` (all themes, both backends) |
| BlockTheme: transparency, optional particles, spawn animation | Partial | Blocks are opaque: translucency (ice, glass, water) is simulated in the shader, with no refraction pass. No per-theme block particles or spawn animation |
| Seven pieces always distinguishable | Done / Manual check | Every surface keeps the piece colour (`blockSurfaces.ts`); high-contrast palette and piece symbols |
| Cinematic transitions with preloading, progress and music crossfade | Done | `src/rendering/fx/transitions.ts`, Voyage preloading (`StageManager.preload`); `transitions.test.ts`, `e2e/voyage.spec.ts`, `e2e/audio.spec.ts` |
| Final artistic acceptance test | Manual check | `npm run content:shots` captures each world; the judgement belongs to the owner |

## §26 Virtual reality (WebXR)

| Requirement | Status | Evidence |
|---|---|---|
| A. Moon Rider research | Done | [VR_REFERENCE_RESEARCH.md](VR_REFERENCE_RESEARCH.md) |
| B. Dedicated XR subsystem; the rest of the app is independent of WebXR | Done | `src/xr/XRManager.ts`, `xrInput.ts`, `vrPanel.ts`; [VR_ARCHITECTURE.md](VR_ARCHITECTURE.md) |
| C. Verified backend for VR: WebGL 2; WebGPU VR not enabled | Done | `XRManager.setUp` creates a `forceWebGL` renderer for the session |
| D. Detection, Enter VR button, explanation when unavailable, user gesture, exit back to the same game | Done | `XRManager.detect`, `enter`, `tearDown`; `src/ui/vr/VRControls.tsx`; `e2e/vr.spec.ts` (emulated Quest 3) |
| D. Session interruption and focus changes | Done | Session end restores the desktop game; the game pauses when the session becomes hidden or blurred (headset system menu), `XRManager.setUp` |
| E. Spatial playfield at real-world scale: seated default and standing; distance, height, scale, tilt, HUD distance and scale; reset | Done | `XRManager.applyLayout`, VR tab ("Reset this tab"), "Recentre view" in the headset panel; `e2e/vr.spec.ts`. There is no sideways board offset |
| F. All worlds in VR | Done / Manual check | VR renders the same scene graph; tested in emulation |
| G. Controllers: input profiles, remapping, sticks and touchpads, buttons, triggers, haptics, buffering, no double activation | Done | `xrInput.ts`, `src/ui/vr/VRBindings.tsx`; `xrInput.test.ts`, `e2e/vr.spec.ts` |
| G. VR controller sensitivity; detected-controller status in settings | Done | Settings → VR: stick sensitivity and trigger threshold (`XRControllerInput`, `xrInput.test.ts`); detected controllers are listed (`VRControls.tsx`) |
| H. VR menus with rays and sticks | Partial | The in-headset panel offers Marathon, Zen, Voyage, world choice, recentre and exit, plus pause and results panels. Sprint, Ultra, Practice and the settings, audio, graphics and controller configuration are not available inside the headset; they are on the desktop VR tab |
| I. VR HUD | Done | Score, level, lines, time and combo or callout panel, following the Interface tab's visibility toggles; next and hold are 3D pods on the board; distance and scale adjustable |
| J. Same audio engine and analysis; spatial audio | Partial | Shared engine, and the listener follows the headset. Only creature footsteps are positioned; ambience is stereo |
| K. VR graphics profiles | Partial | Three profiles (Performance, Balanced, Quality) set framebuffer scale, foveation and the particle cap. There is no Low/Medium/High/Ultra/Custom set and no separate VR render scale, particle, shadow or post-processing controls. VR renders without post-processing (no bloom) and without shadows |
| L. Comfort: stationary viewpoint, no shake or motion blur, world dimming, fades, exit at any time | Done | Fixed camera rig in `XRManager`, VR tab "Dim the world" |
| M. Dedicated VR settings category, persisted | Partial | The VR tab has enter and exit, seated and standing, board and HUD placement, remapping, vibration, graphics profile, dimming, rays and reset. Controller sensitivity, render scale and particle density have no VR-specific controls. Reduced motion and audio use the global settings |
| N. Secure context; HTTPS for remote access; no security bypass | Done | `XRManager.detect` reports `insecure`; [DEPLOYMENT.md](DEPLOYMENT.md) |
| O, P. Emulator testing | Done | `e2e/vr.spec.ts` with IWER (`src/xr/xrEmulator.ts`): enter mid-game, controller play, panels, exit with state intact |
| O, P. Real-headset testing | Not done | Never run on a real headset; see [VR_TESTING.md](VR_TESTING.md) |
| Q. VR documents | Done | VR_ARCHITECTURE.md, VR_SETTINGS.md, VR_TESTING.md, VR_REFERENCE_RESEARCH.md |

## §27 Soundtrack and sound design

| Requirement | Status | Evidence |
|---|---|---|
| A. An original soundtrack per world | Done / Manual check | 13 worlds, 34 compositions (two or three per world), each with its own tempo, meter, key and instrumentation; in free play a world's tracks take turns. All are procedural; listening review pending |
| B. Adaptive layers and sections that follow gameplay (calm, active, combo, climax, pause, transitions) | Done | Layer thresholds in `composition.ts`, intensity in `src/audio/AudioSystem.ts`, stems for recorded tracks in `tracks.ts`; `tracks.test.ts` (stems in sync, fading by intensity) |
| C. Full event library: spawn, move, both rotations, drops, lock, clears 1–4, hold, combo, back-to-back, spin, level up, stage complete, game over, pause, resume, menu sounds, unlock | Done | `SFX_IDS` in `SfxBank.ts`; `e2e/audio-acceptance.spec.ts` (headroom, no NaN or DC) |
| D. Material-aware impact profiles per world | Done | 14 profiles in `src/audio/sound-effects/materialAudio.ts`, `impactSynth.ts`; `impactSynth.test.ts`, `e2e/audio-acceptance.spec.ts` ("hard drop outweighs lock and soft drop, and each world has its own colour") |
| E. Layered hard drop that scales with drop distance; lighter soft drop and lock | Done | `AudioSystem.ts` (gain and the heavy variant by rows dropped, world response at 6+ rows) |
| F. Distinct single, double, triple and quad, plus combo escalation | Done / Manual check | `clear1`–`clear4`, `signature`, `combo`, `comboMid`, `comboHigh` |
| G. Buses for master, music, gameplay SFX, impacts, stage effects, ambience and menu, plus limiter and headroom | Done | `AudioEngine.ts`; `e2e/audio-settings.spec.ts` ("sound test plays a world's material sounds on their own buses") |
| H. Organised audio asset pipeline (OGG/Opus, stems, masters) | Done | `assets/audio/README.md`, `scripts/encode-audio.ts`. No recorded audio ships: all music and SFX are synthesised |
| I. Composition and mastering quality | Manual check | No DAW and no recorded masters; the TypeScript compositions are the source. Quality is the owner's judgement |
| J. Integrated with the analysis engine | Done | One analysis engine on the music bus |
| K. Spatial audio for VR and creatures | Partial | HRTF panning for creature footsteps (`SfxBank.playAt`, `src/audio/worldSounds.ts`). Birds, marine life and ambience are not positioned |
| L. Audio settings, persisted, and a sound test screen | Done | Audio tab (hard-drop, world-effects and menu volumes, music intensity, adaptive music, spatial audio, variation, calibration) and Sound test; `e2e/audio-settings.spec.ts` |
| M. Audio acceptance | Done / Manual check | Automated: headroom, material weight and colour, bus routing, pause, transitions. Listening on headphones and speakers is pending |

## Known limitations

1. **Reference game never inspected.** No desktop-control tools were available, so REFERENCE_NOTES.md rests on genre conventions and the brief. No feature parity is claimed.
2. **Motion blur is background-only by design.** It is off by default and never applied to the playfield; samples near the board's edge can pick up a little of the board's colour.
3. **Reflection quality does nothing.** The `graphics.reflections` setting is passed to environments but read by none, and it is not in the UI. Reflections come only from the environment map and material fresnel; there are no screen-space or planar reflections.
4. **VR is unverified on hardware.** It has been tested only under IWER emulation. In addition:
   - it renders without post-processing and shadows;
   - the in-headset menus are limited, and settings must be changed on the desktop.
5. **Music is synthesised live.** There are no recorded masters, stems or DAW projects. Whether it meets the "commercial soundtrack" bar is the owner's call. The analysis acceptance corpus is synthetic, too.
6. **Content packs are build-time only.** There is no runtime import. New block surfaces, SFX timbre presets and impact profiles still need code in `src/`.
7. **Save export leaves out Music Room files.** Settings, progress, stats, high scores and replays are exported; the player's own audio files are not. Every origin and browser profile has its own save (`Play.cmd` uses its own Chrome profile).
8. **Spatial audio is limited.** Only creature footsteps are positioned in 3D.
9. **Some features have no automated test:** fullscreen, GPU device-loss recovery, dynamic resolution, controller rumble and VR haptics, the mapping wizard UI, camera settings.
10. **Block themes have gaps.** Blocks are opaque (translucency is shader-simulated), and there are no per-theme spawn animations or theme particles.
11. **Some schema fields are unused:**
    - the manifest's `recommendedQuality` is unused;
    - hidden spawn rows are configurable only in `RuleConfig`, not by the player.
12. **External audio analysis is experimental.** It is a developer-tools feature, and it depends on the browser's screen-share prompt including audio.
13. **GPU memory is not measured in bytes.** It is reported as geometry and texture counts plus JS heap.
14. **Tempo detection has known weak spots.** It can lock to double or half tempo on very slow or very fast unknown music, and syncopated grooves take longer to lock (AUDIO_ANALYSIS.md §10). The game's own tracks use their exact beat grid.
