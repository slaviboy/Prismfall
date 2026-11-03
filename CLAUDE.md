# CLAUDE.md

Guidance for AI-assisted work on Prismfall, a personal browser 3D falling-block game. Brief: `prompt.md`. Overview: [README.md](README.md). Design: [ARCHITECTURE.md](ARCHITECTURE.md). Requirement status: [FEATURES.md](FEATURES.md).

## Commands

```sh
npm run typecheck          # tsc: app, node-side files, audio worklet
npm run lint               # ESLint (also enforces content import rules)
npm test                   # Vitest unit tests
npm run test:e2e           # Playwright, installed Chrome, real GPU, one worker
npm run build              # content validation + typecheck + vite build → dist/
```

**Running a single test:**
- Unit tests: `npx vitest run src/game/core/engine.test.ts`. Add `-t "name"` to filter by test name.
- End-to-end: `npx playwright test e2e/smoke.spec.ts`. Add `-g "title"` to filter by title.
- `PW_DEV=1` runs the e2e tests against the dev server on 5173 instead of the test build.

**Other commands:**
- `npm run test:soak`: long run, `SOAK_MINUTES`, both backends.
- `npm run perf`: perf matrix; results in `perf-results/`.
- `npm run build:test`: test build in `dist-test/`, with the debug hooks.
- `npm run content:validate`: stage manifests, profiles and the campaign.
- `npm run content:record`: gameplay video of every world (transitions, play, clears 1–4) plus frame pacing, into `reference-capture/ours/`. `-- --stages <id>` for one world.

**Ports** (all `strictPort`):
- 5173 dev;
- 4173 preview and `Play.cmd`;
- 4174 e2e test build.

**Stale-build trap:**
- Playwright reuses any server already listening on 4174 (`reuseExistingServer: true`). After changing code, **stop the 4174 preview server**; otherwise the tests run the old build. With the server stopped, Playwright rebuilds `dist-test/` and restarts it.
- `scripts/perf.ts`, `content:thumbnails`, `content:shots` and `content:record` also reuse 4174 and only build `dist-test/` when it is missing. Run `npm run build:test`, with no stale server, before using them on new code.

**E2E behaviour:** tests fail on any console error or page error (`e2e/fixtures.ts`). They drive the game through the `window.__PRISMFALL__` debug hooks and the built-in AI (`shell.aiStep()`).

## Architecture pointers

- **`src/app/GameShell.ts`** is the orchestrator. It owns the **single `requestAnimationFrame` loop**, which runs in this order:
  1. input poll;
  2. `GameSession.update` (1 ms fixed engine ticks from timestamped inputs);
  3. event dispatch to feedback, SFX, music and the HUD store;
  4. music features;
  5. render.

  The frame limiter may skip only the render step. In VR the XR session drives the same frame function.
- **`src/game` is deterministic and pure TypeScript.** No DOM, three.js, audio or React imports. It uses integer milliseconds, fixed-point gravity and a seeded `sfc32` 7-bag. Replays must re-simulate to the same state hash.
- **Rendering reads engine state only.**
  - `src/rendering` never mutates the engine and never touches audio nodes. It consumes the `AudioFeatures` interface.
  - React is never in the frame loop. The HUD updates through a zustand vanilla store.
- **Content goes through `@prismfall/sdk` only** (`src/sdk`).
  - Worlds live in `content/stages/<id>/`: a `stage.json` manifest, plus an optional `stage.ts` that registers components, effects or materials through the SDK.
  - They are discovered with `import.meta.glob`, at build time.
  - ESLint forbids `content/**` from importing `src/**`.
  - See [CONTENT_GUIDE.md](CONTENT_GUIDE.md).
- **VR:** `src/xr/XRManager.ts` uses its own WebGL 2 renderer for the XR session. Game state is untouched on enter and exit. VR has been tested only under IWER emulation. See [VR_ARCHITECTURE.md](VR_ARCHITECTURE.md).
- **Audio:**
  - The bus graph is in `src/audio/engine/AudioEngine.ts`.
  - Music is synthesised live from TypeScript compositions (`content/stages/*/music/*.ts`).
  - The analysis engine (`src/audio/analysis`) taps the music bus before the fader.
  - See [AUDIO_ANALYSIS.md](AUDIO_ANALYSIS.md) and [AUDIO_ASSETS.md](AUDIO_ASSETS.md).

## Conventions

- **Materials are written in TSL**: one shader codebase for the WebGPU and WebGL 2 backends. Do not require compute shaders. Keep instanced pipelines within 8 vertex buffers by packing per-instance data, as the board does.
- **Additive sprites** must set `material.fog = false` and fade with `additiveFog()` (`src/rendering/shaders/uniforms.ts`). Built-in fog draws visible rectangles on additive quads.
- **New worlds are content-only.** Add a folder under `content/stages/`. Never touch the engine, menus or scoring for a stage, and never write stage-specific React components. Run `npm run content:validate`.
- **Persisted data uses zod schemas** where every field has a `.catch()` and a default, so old or corrupt saves still parse.
  - Structural changes go in `migrateSettings` (`src/settings/schema.ts`): bump `SETTINGS_VERSION`.
  - Stage manifests carry `schemaVersion`.
  - Keep the old-save fixture tests in `src/storage/storage.test.ts` passing.
- **Tests sit next to their modules** (`foo.ts` → `foo.test.ts`). Browser flows go in `e2e/*.spec.ts`.
- **Debug hooks** (`window.__PRISMFALL__`) exist only in dev and test builds, behind the `__PRISMFALL_HOOKS__` define. Never rely on them in game code, and never ship them in production.
- **Visual taste:** blocks must read as solid, saturated, crisp cubes. Avoid strong self-glow, bloom halos and washed-out pastels. Check new block themes and worlds with a tall-stack screenshot.
- **Measurements, not estimates:** performance numbers go in [PERFORMANCE.md](PERFORMANCE.md) only when measured with `npm run perf` or `npm run test:soak`.

## Windows tooling

- **Shell:** Git Bash or PowerShell on Windows. Bash heredocs that contain nested quotes or backticks are fragile and can break the tool wrapper. Write multi-step scripts to a file in the scratchpad and run that file instead.
- **Python file writes:** text mode writes CRLF on this machine, but the repository is LF (`.gitattributes`). Use `open(path, 'w', encoding='utf-8', newline='')`.
- **Node cannot run `src/**` TypeScript directly** (extensionless imports). For quick experiments, use a temporary Vitest file and delete it before committing. `node:fs` imports also fail the app typecheck.
- `scripts/*.ts` run with plain `node`.

## Git

- **Local repository only.** Never add a remote, never push, never create a hosted repository.
- Commit after each coherent, tested unit of work, never with failing typecheck or tests.
- End every commit message with the Co-Authored-By line used in `git log`. Currently: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Hard rules

- No assets, audio or code from Tetris Effect or any other game. Do not imitate specific copyrighted compositions.
- No VLC code. VLC was studied for research only, and its visualisers are GPL.
- Never deploy publicly. Remote access needs HTTPS plus real server-side access control; see [DEPLOYMENT.md](DEPLOYMENT.md). Never disable browser security features as a workaround.
- No analytics, trackers, ads or external network calls.
- Record every new asset's source and licence in [ASSET_LICENSES.md](ASSET_LICENSES.md).
