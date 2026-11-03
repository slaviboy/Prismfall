# Prismfall

Prismfall is an original 3D, music-reactive falling-block puzzle game for the browser, built as a personal project to play daily on one PC. The gameplay is guideline-style play with the seven standard tetrominoes, SRS rotation with wall kicks, a 7-bag randomiser, hold, next queue and lock delay. Around the playfield, each world has its own 3D environment, block material, particles, creatures, music and sound design. The music is original and synthesised live in the browser. There are no recorded stems and no DAW projects. The modes are **Voyage** (the campaign, which travels through the worlds mid-game), **Marathon**, **Sprint**, **Ultra**, **Zen** and **Practice**. There are 13 worlds, one folder each under `content/stages/`. Folded Sky is one of them: a content-only world added to prove the content system can grow without engine changes. Optional immersive VR runs through WebXR.

Stack: TypeScript, React 19, Vite 8, three.js r187 `WebGPURenderer` (WebGPU with automatic WebGL 2 fallback, materials in TSL), Web Audio, Zustand, zod, idb (IndexedDB), Vitest and Playwright.

## Requirements

| Need | Version / note |
|---|---|
| Node.js | 22 or newer (`engines.node` is `>=22` in `package.json`) |
| Browser | Current Chrome or Edge. WebGPU is used when available, and WebGL 2 otherwise. VR needs a WebXR-capable browser and headset. |
| Blender (optional) | 5.2, only for regenerating 3D assets with `npm run assets:blender`. Set `BLENDER_PATH` if it is not at `C:/Program Files/Blender Foundation/Blender 5.2/blender.exe`. Playing never needs Blender. |
| ffmpeg (optional) | Only for `npm run audio:encode`, when adding recorded music. Put it on `PATH` or set `FFMPEG_PATH`. |

## Quick start

**Play (Windows):** double-click `Play.cmd` in the repository root. It:

1. installs dependencies if `node_modules/` is missing;
2. builds the game if `dist/` is missing (`Play.cmd --rebuild` forces a fresh build after updating the code);
3. serves the production build with `vite preview` on http://localhost:4173;
4. opens Chrome (or Edge) in app mode with its own profile under `%LOCALAPPDATA%\Prismfall\chrome-profile`.

That profile keeps its own saves, separate from your normal browser window. See [Saves and data](#saves-and-data). The server keeps running in a minimised "Prismfall server" window after you close the game; close that window to stop it (the next `Play.cmd` starts it again).

**Develop:**

```sh
npm install
npm run dev          # http://localhost:5173
```

Other common commands:

```sh
npm test             # unit tests (Vitest)
npm run test:e2e     # browser tests (Playwright, installed Chrome, real GPU)
npm run build        # typecheck + production build into dist/
npm run preview      # serve dist/ on http://localhost:4173
```

All three ports use `strictPort`. If a port is taken, the server refuses to start rather than moving to another port, because a different port would also mean a different save.

## npm scripts

| Script | What it does |
|---|---|
| `dev` | Vite dev server on http://localhost:5173 with hot reload. The dev/test debug hooks are enabled. |
| `typecheck` | `tsc --noEmit` for the app, the Node-side files (scripts, configs) and the audio worklet. |
| `lint` | ESLint over the repository. It also enforces that `content/` imports only `@prismfall/sdk`, `three` and `three/tsl`. |
| `test` | Vitest unit tests (`src/**/*.test.ts`, `content/**/*.test.ts`, `scripts/**/*.test.ts`). |
| `test:watch` | Vitest in watch mode. |
| `test:e2e` | Playwright end-to-end tests in the installed Chrome. They run against a test build served on http://localhost:4174, which is built and started automatically when nothing is listening there. `PW_DEV=1` targets the dev server instead. |
| `test:soak` | Long-run stability test (`playwright.soak.config.ts`, `e2e/soak.spec.ts`). The AI plays Zen for `SOAK_MINUTES` (default 30) on each backend, WebGPU and WebGL 2, and switches world every five minutes. Results go to `perf-results/soak-*.json`. |
| `content:validate` | Validates every stage manifest, reactivity profile and the Voyage campaign (`src/stages/content.test.ts`). |
| `prebuild` | Runs `content:validate` automatically before `build`. |
| `build` | `typecheck`, then a production build into `dist/`. The debug hooks are compiled out. |
| `build:test` | Builds into `dist-test/` with the debug hooks (mode `test`). Used by the e2e, perf and capture scripts. |
| `preview` | Serves `dist/` on http://localhost:4173. |
| `perf` | Performance matrix (`scripts/perf.ts`): plays Zen with the AI across resolutions, presets, backends and stages, and writes `perf-results/perf-*.json`. Needs a test build. See [PERFORMANCE.md](PERFORMANCE.md). |
| `assets:blender` | Runs the Blender generators headless and optimises the GLBs into `content/` (meshopt geometry, WebP textures). Needs Blender 5.2. |
| `content:thumbnails` | Renders each world's menu view into `content/stages/<id>/previews/thumb.jpg`. |
| `content:shots` | Captures acceptance screenshots of every world (default output `docs/acceptance/`). |
| `audio:encode` | Encodes WAV masters from `assets/audio/` into Ogg Opus in `content/stages/<id>/music/`. Needs ffmpeg. |

To run one test file: `npx vitest run src/game/core/engine.test.ts`, or `npx playwright test e2e/smoke.spec.ts`.

## Controls

All gameplay controls can be rebound in **Settings → Controls** (keyboard and controller) and **Settings → VR**. Each action holds up to two bindings. Conflicts within the same context can swap or replace, and Pause, Confirm and Back can never be left unbound.

| Action | Keyboard | Controller (standard layout) | VR controllers |
|---|---|---|---|
| Move left / right | ← / → | D-pad left / right, left stick | Either thumbstick left / right |
| Soft drop | ↓ | D-pad down, left stick down | Either thumbstick down |
| Hard drop | Space | D-pad up | Right A, right thumbstick up |
| Rotate clockwise | ↑, X | Cross / A | Right trigger |
| Rotate counter-clockwise | Z, Left Ctrl | Circle / B, Square / X | Left trigger |
| Rotate 180° (off until enabled in Gameplay settings) | A | Triangle / Y | unbound |
| Hold | C, Left Shift | L1 / LB, R1 / RB | Either grip |
| Pause | Esc, P | Options / Menu | Left Y, left thumbstick press |
| Practice: undo | Backspace | Create / View | Left X |
| Practice: reset board | R | unbound | unbound |
| Confirm (menus) | Enter, Num Enter | Cross / A | Right trigger, right A |
| Back (menus) | Esc, Backspace | Circle / B | Right B, left Y |

Menu navigation also uses fixed controls:

- **Keyboard:** arrows or WASD; Q/E or Page Up/Page Down switch tabs.
- **Controller:** D-pad or left stick; L1/R1 (LB/RB) switch tabs.
- **VR:** either thumbstick, or point a controller ray at a panel and pull the trigger; the grips switch tabs.

Button names and glyphs follow the detected controller family (PlayStation, Xbox, generic), and you can override them per controller. Settings → Controller has a live button tester, a mapping wizard for non-standard pads, rumble test, dead zones and thresholds. It can also "Use only this controller" or ignore a pad, which helps when Steam Input or DS4Windows creates a duplicate.

In play, the mouse wheel zooms the camera. With developer tools enabled (Settings → Data), F9 toggles the audio analysis dashboard, and every world is unlocked (a switch on the world list and in the Developer tab turns this off again).

**Level creator** (main menu): make your own levels from any world, any world's music (or your own files from the Music Room) and any block design. Levels are saved with your settings. Play one and it becomes the world in the mode setup, until you choose another world or press "Play … as it is". **Block design** (Settings → Graphics) uses one design in every world.

**Mouse control** (Settings → Gameplay, off by default): move the mouse and the piece, with its ghost, follows the pointer across the board. Left click hard drops, right click rotates clockwise and middle click holds. The keyboard and controllers keep working; the mouse steers again as soon as it moves or clicks.

## Saves and data

- **Where saves live:** in the browser's IndexedDB (database `prismfall`). If IndexedDB is unavailable, web storage is used instead.
- **Saves are per origin**, meaning scheme, host and port. Each of the following has its own, separate save:
  - http://localhost:5173 (dev);
  - http://localhost:4173 (preview and `Play.cmd`);
  - http://localhost:4174 (e2e);
  - every browser profile, including the `Play.cmd` Chrome profile.
- **What is saved:** settings, world progress and unlocks, lifetime statistics, high scores, replays and music files you add in the Music Room.
  - The newest 40 replays are kept, plus every replay attached to a high score.
  - The game asks the browser for persistent storage, so saves are not evicted automatically.
- **Export and import:** **Settings → Data** can export a JSON save file and import one. Use it to back up a save or move it between origins and profiles. Settings saved by older versions are migrated on import.
  - The export holds settings, progress, lifetime statistics, high scores and replays.
  - It does **not** include music files you added in the Music Room.
- **Reset:** Settings → Data can also erase progress or restore all settings, and has the "Unlock every stage" switch.

## Project layout

| Folder | Contents |
|---|---|
| `src/` | The application. Main subsystems: `app` (`GameShell` orchestrator, session loop), `game` (deterministic engine: no DOM, three.js or audio), `rendering`, `audio`, `input`, `settings`, `stages`, `storage`, `sdk` (the public Content SDK), `ui` (React), `xr` (WebXR). Unit tests sit next to the modules they test. |
| `content/` | Game content, loaded only through the Content SDK. `stages/<id>/` holds one world each (manifest, music compositions, models, previews). `shared/` holds block GLBs, creature rigs, flora and reactivity profiles. `campaigns/voyage.json` defines the campaign. |
| `assets/` | Production sources that do not ship: `blender/` (generator scripts, `.blend` sources, exports, `pipeline.json`) and `audio/` (the layout for lossless masters). |
| `e2e/` | Playwright specs and fixtures, including `soak.spec.ts`. |
| `scripts/` | Node tools: perf matrix, Blender build, thumbnails, acceptance shots, audio encoding, GPU probe. |
| `perf-results/` | JSON output of `npm run perf` and `npm run test:soak`. Ignored by git except `.gitkeep`. |

Generated and ignored: `dist/`, `dist-test/`, `node_modules/`, `playwright-report/`, `test-results/`.

## Documentation

| Document | Topic |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Systems, boundaries, frame loop, determinism, milestones |
| [FEATURES.md](FEATURES.md) | Requirements audit against `prompt.md`: status, evidence and known limitations |
| [MANUAL_CHECKS.md](MANUAL_CHECKS.md) | What only a person can verify: feel, listening, visuals, controllers, VR |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Local play, static builds and private access from other devices |
| [PERFORMANCE.md](PERFORMANCE.md) | Benchmark method and measured results (perf matrix and soak test) |
| [AUDIO_ANALYSIS.md](AUDIO_ANALYSIS.md) | Music analysis engine, reactivity, acceptance corpus, dashboard |
| [AUDIO_ASSETS.md](AUDIO_ASSETS.md) | Soundtrack, sound effects, ambience and the audio asset pipeline |
| [CONTENT_GUIDE.md](CONTENT_GUIDE.md) | How to author worlds, components, materials and content packs |
| [BLENDER_PIPELINE.md](BLENDER_PIPELINE.md) | Blender generators, export and optimisation settings |
| [ASSET_LICENSES.md](ASSET_LICENSES.md) | Source and licence of every asset and dependency |
| [REFERENCE_NOTES.md](REFERENCE_NOTES.md) | Reference investigation (brief §2) and its limitations |
| [VR_ARCHITECTURE.md](VR_ARCHITECTURE.md) | WebXR subsystem design |
| [VR_SETTINGS.md](VR_SETTINGS.md) | VR settings reference |
| [VR_TESTING.md](VR_TESTING.md) | What has been tested in VR and the real-headset checklist |
| [VR_REFERENCE_RESEARCH.md](VR_REFERENCE_RESEARCH.md) | Moon Rider and WebXR research notes |
| [CLAUDE.md](CLAUDE.md) | Guidance for AI-assisted work in this repository |

The original brief is `prompt.md`. The repository is private and local-only, and nothing is deployed. The game makes no analytics or external network calls.
