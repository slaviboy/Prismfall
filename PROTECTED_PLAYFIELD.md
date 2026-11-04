# Protected playfield

The board, the seven pieces and the gameplay feedback are approved as they are (brief §40). Background and world work must leave them visually identical. This page lists what is protected, how it is checked, and the baseline it is checked against.

## 1. What is protected

| Area | Protected | Where it lives |
|---|---|---|
| Gameplay | Engine, rules, spawning, rotation, scoring, AI | `src/game/**` |
| The board | The well, frame line, plate, grid, ghost, hold and next pods, block instancing and animations | `src/rendering/board/**` |
| The blocks | Geometry, bevels, materials, shaders, surfaces, presets and designs; the block GLBs | `src/rendering/materials/**`, `content/shared/blocks/**` |
| Block lighting | The fixed light rig that lights the blocks | `src/rendering/lighting/LightRig.ts` |
| Framing | The gameplay camera | `src/rendering/camera/CameraRig.ts` |
| The final image | Bloom, grade, tone mapping, AA | `src/rendering/postprocessing/PostPipeline.ts` |
| Gameplay feedback | Landing, spawn and clear effects, and the board burst particles | `src/rendering/fx/FeedbackDirector.ts`, `lineClearEffects.ts`, `src/rendering/particles/BurstSystem.ts` |
| Uniforms the blocks read | `time`, `bass`, `beatPulse`, `reactivity`, `flashLimit`, `danger`, `clearPulse` and the rest of `frameUniforms` | `src/rendering/shaders/uniforms.ts` |
| Per-world board settings | `palette` (frame line, plate, clear colours), `lighting`, `grade`, `fog` (blocks are fogged too), `camera`, `blocks`, `effects.lineClear`, `effects.landing` | every `content/stages/*/stage.json` |

Rules that follow from this:

- **Environment signals are separate.** World-only uniforms (the music drives and the Background intensity levels) live in `src/rendering/shaders/environmentUniforms.ts`. They are never read by board, block or post code, and the existing `frameUniforms` keep their meaning.
- **No scene lights in worlds.** Worlds never add lights that reach the blocks. They light their own materials, as Dark Storm does.
- **Atmosphere control leaves scene fog alone.** The Background intensity atmosphere setting scales a world's own fog, cloud and haze layers, never the scene fog.
- **Not protected:** `RenderSystem.ts`, which wires the environment. Its board lines are left as they are.

## 2. How it is checked

1. **Source and manifest snapshot** (runs in `npm test`). `scripts/protectedPlayfield.test.ts` hashes every protected file and every world's protected manifest fields, and compares them with `scripts/protected-playfield.json`, written at the baseline (tag `bg-baseline`). Any change fails the test.
   - `node scripts/protectedPlayfield.ts` lists the differences.
   - `--update` writes a new snapshot. Use it only for a deliberate board change, in its own commit.
2. **Pixel baseline** (run after significant changes). `node scripts/playfield-baseline.ts --compare reference-capture/protected/baseline` renders the board alone in every world's look and diffs it with the baseline:
   - the world's blocks, palette, lights, grade, fog and camera, with every environment mesh hidden but its lights left on;
   - a fixed seed and a fixed tall stack;
   - a frozen clock stepped 60 frames;
   - no music and no reactivity.

   It reports identical, within noise (at most 6 levels, and at most 0.05 % of pixels over 2 levels) or CHANGED, and writes `diff-<world>.png` for changed worlds. Because world lights stay on, a world light that starts lighting the blocks would show up here too.
3. **Eyes.** `docs/protected/baseline-full.jpg` is the approved composition of every world with the same tall stack. Compare new tall-stack screenshots against it.

## 3. Baseline (2026-11-04, tag `bg-baseline`)

| File | Contents |
|---|---|
| `scripts/protected-playfield.json` | 34 protected files, 23 worlds |
| `docs/protected/baseline.json` | Pixel hashes of the 23 board-only captures (2560×1080, RX 9070 XT, WebGPU) |
| `docs/protected/baseline-board.jpg` | The board-only captures |
| `docs/protected/baseline-full.jpg` | The full frames with the world |
| `reference-capture/protected/baseline/` | The lossless captures the comparison uses (local, git-ignored) |

## 4. Results

Each verification run is recorded here. See also BACKGROUND_VISUAL_QUALITY_REPORT.md.

| Date | Build | Snapshot test | Pixel comparison |
|---|---|---|---|
| 2026-11-04 | `bg-baseline` | passes (written) | baseline captured |
