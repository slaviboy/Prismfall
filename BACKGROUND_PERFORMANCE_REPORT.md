# Background performance report

What the living-environment work costs (brief §40.13): the music director, the event director, Background intensity and the 23 world profiles. Every number here was measured on the test system (AMD Radeon RX 9070 XT, Ryzen 7 5800X3D, 32 GB, Windows 10, Chrome, three r187); none is estimated. General method: [PERFORMANCE.md](PERFORMANCE.md).

## 1. Summary

- **No measurable cost.** The current build and the build before the work (tag `bg-baseline`) were measured back to back under identical conditions. Frame rate and GPU time are equal within run-to-run noise in every world measured, at 2560×1080 and at 4K.
- **The new systems cost microseconds of CPU per frame and nothing on the GPU:**
  - the music director 0.46 µs;
  - a reactivity layer with 60 bindings 9.8 µs;
  - the event director 0.06 µs.

  The GPU only gains a multiply here and there (the panorama's exposure, the drives read in a few world shaders).
- **Every world runs above 110 fps at 2560×1080 on WebGPU** (median 372). At 4K the median is 143 fps. Two worlds fall below 60 at 4K, The Web (49) and The Veil (52), both GPU-bound by their ray-marched fog, which predates this work.

## 2. CPU cost of the new systems

Measured in Node on the Ryzen 7 5800X3D with a temporary benchmark: 200 000 frames of synthetic music at 144 Hz.

| System | Per frame |
|---|---|
| Environment Music Director (all 15 drives, accent governor, cues) | 0.46 µs |
| ReactivityLayer with 60 bindings (`music.*`, audio and game features, Background intensity classes) | 9.8 µs |
| Environment Event Director with 10 entries (ambient timers, music cues) | 0.06 µs |

- **Allocation.** Nothing in the frame path allocates beyond the cue list, which is reused, and The Web's scratch object. Drives and uniforms are written in place.
- **Off the frame's critical path.** None of it runs in React. The analysis stays on its audio worklet.
- **Frame-rate independent.** Every envelope is a time constant, so the result is the same at 60, 144 or 240 Hz (unit-tested).

## 3. Before and after, back to back

Both builds were measured with `scripts/perf.ts` on WebGPU at the High preset, the AI playing Zen, the frame rate uncapped:

- **The baseline:** the `bg-baseline` commit built from its own sources into `dist-before`.
- **The current build:** `dist-test`.

Each cell is **fps (p95 frame time in ms) · GPU time in ms**.

**Settled worlds** (`--settle 9000`, 8 s each, 2560×1080), the heaviest worlds:

| World | Before | After |
|---|---|---|
| The Lost Kingdom | 195 (5.5) · 4.02 | 198 (5.5) · 4.04 |
| The Web | 368 (3.1) · 1.65 | 370 (4.5) · 1.65 |
| Red Horizon | 253 (4.4) · 2.98 | 256 (4.3) · 3.01 |
| The Last Frontier | 108 (10.6) · 4.79 | 110 (10.1) · 4.92 |

**Quick runs** (8 s each). The order was after, before, after again, so the two "after" columns show the noise:

| World | Resolution | Before | After | After again |
|---|---|---|---|---|
| Luminous Tide | 2560×1080 | 345 (3.2) · 2.13 | 351 (3.2) · 2.12 | 341 (3.3) · 2.12 |
| Frozen Kingdom | 2560×1080 | 307 (3.6) · 2.20 | 311 (3.5) · 2.21 | 308 (3.6) · 2.21 |
| The Abyss | 2560×1080 | 522 (6.2) · 1.06 | 533 (2.2) · 1.07 | 550 (2.4) · 0.99 |
| Luminous Tide | 3840×2160 | 128 (8.2) · 5.97 | 129 (8.3) · 5.92 | 128 (8.3) · 5.99 |
| Frozen Kingdom | 3840×2160 | 94 (13.8) · 10.42 | 94 (13.8) · 10.38 | 94 (13.8) · 10.47 |
| The Abyss | 3840×2160 | 198 (5.9) · 2.86 | 212 (5.1) · 3.05 | 214 (5.1) · 2.99 |

## 4. Every world, current build

Measured with `node scripts/perf.ts --seconds 5 --settle 8000 --presets high --backends webgpu,webgl2 --resolutions 2560x1080,3840x2160 --stages <all 23>`. Raw data: `perf-results/perf-2026-11-04T07-44-24-855Z.json` (not committed; the same command regenerates it).

- Each cell is **fps (p95 ms)**; WebGPU cells add **· GPU ms** from timestamp queries.
- 4K is a 1920×1080 viewport at device pixel ratio 2.
- Draw calls and scene update are on WebGPU at 2560×1080. Scene update is the CPU time of the scene update per frame, which includes every environment's update and the music director.

| World | WebGPU 2560×1080 | WebGPU 3840×2160 | WebGL 2 2560×1080 | WebGL 2 3840×2160 | Draw calls | Scene update |
|---|---|---|---|---|---|---|
| Luminous Tide | 352 (3.1) · 2.2 | 123 (8.5) · 6.6 | 256 (4.7) | 116 (9.9) | 40 | 0.062 ms |
| Frozen Kingdom | 330 (3.3) · 2.2 | 128 (8.2) · 6.1 | 422 (2.8) | 344 (4.2) | 65 | 0.078 ms |
| Moving Sands | 443 (2.6) · 1.5 | 185 (5.7) · 3.8 | 265 (4.1) | 289 (8.2) | 73 | 0.129 ms |
| The Last Frontier | 111 (9.7) · 4.8 | 88 (15.3) · 8.5 | 353 (3.2) | 310 (5.0) | 1267 | 0.457 ms |
| Tradewind Cove | 196 (5.4) · 4.3 | 89 (11.6) · 9.8 | 185 (5.7) | 126 (8.8) | 61 | 0.112 ms |
| Ancient Garden | 891 (1.5) · 0.5 | 314 (3.5) · 1.6 | 411 (3.2) | 239 (6.6) | 34 | 0.029 ms |
| The Lost Kingdom | 200 (5.3) · 4.1 | 107 (9.8) · 7.6 | 48 (52.2) | 47 (60.5) | 109 | 0.227 ms |
| Deep Cosmos | 635 (1.9) · 0.9 | 189 (5.5) · 3.6 | 340 (3.2) | 185 (5.8) | 45 | 0.045 ms |
| Alpine Horizon | 712 (1.6) · 0.4 | 343 (3.2) · 1.3 | 432 (3.5) | 244 (4.9) | 49 | 0.127 ms |
| The Abyss | 572 (2.1) · 1.0 | 225 (4.9) · 2.9 | 332 (3.6) | 177 (6.2) | 43 | 0.097 ms |
| Enchanted Wilderness | 700 (1.7) · 0.7 | 273 (4.1) · 2.1 | 392 (3.1) | 213 (5.3) | 48 | 0.045 ms |
| Ember Foundry | 467 (2.5) · 0.9 | 234 (4.7) · 2.6 | 284 (4.0) | 163 (6.7) | 235 | 0.034 ms |
| Ember Core | 370 (3.0) · 2.1 | 143 (7.3) · 5.4 | 273 (4.1) | 133 (8.6) | 43 | 0.028 ms |
| Northern Lights | 247 (4.5) · 3.1 | 99 (10.5) · 8.3 | 251 (3.7) | 199 (14.6) | 95 | 0.091 ms |
| Future Nights | 655 (1.9) · 0.8 | 230 (4.7) · 2.8 | 360 (3.2) | 186 (6.0) | 45 | 0.026 ms |
| Dead Acre | 438 (2.6) · 1.6 | 188 (5.6) · 3.7 | 290 (3.9) | 153 (7.6) | 66 | 0.098 ms |
| The Veil | 126 (8.3) · 6.8 | 52 (20.9) · 17.1 | 604 (2.7) | 429 (4.9) | 172 | 0.035 ms |
| Ashen Vigil | 241 (4.4) · 3.3 | 87 (11.9) · 9.5 | 202 (5.5) | 100 (12.2) | 38 | 0.028 ms |
| The Warden's Spire | 210 (5.0) · 4.0 | 103 (10.0) · 8.1 | 238 (6.0) | 145 (11.7) | 80 | 0.150 ms |
| Red Horizon | 267 (4.3) · 2.9 | 119 (9.1) · 6.8 | 167 (5.7) | 102 (12.5) | 152 | 0.306 ms |
| Folded Sky | 808 (1.7) · 0.4 | 359 (3.3) · 1.2 | 460 (3.5) | 262 (4.5) | 31 | 0.120 ms |
| The Web | 372 (4.4) · 1.7 | 49 (44.3) · 17.2 | 86 (50.4) | 88 (54.3) | 222 | 0.096 ms |
| Dark Storm | 437 (2.5) · 1.5 | 194 (5.5) · 3.7 | 252 (6.1) | 154 (7.2) | 71 | 0.023 ms |

| Backend | Resolution | Lowest | Median | Below 144 fps | Below 60 fps | Worst p99 |
|---|---|---|---|---|---|---|
| WebGPU | 2560×1080 | 111 | 372 | 2 | 0 | 11.6 ms |
| WebGPU | 3840×2160 | 49 | 143 | 12 | 2 | 81.6 ms |
| WebGL 2 | 2560×1080 | 48 | 284 | 2 | 1 | 127.6 ms |
| WebGL 2 | 3840×2160 | 47 | 177 | 7 | 1 | 86.9 ms |

Reading the table:

- **The scene update stays under 0.5 ms** in every world, the music system included. The Last Frontier (0.46 ms) and Red Horizon (0.31 ms) are the heaviest, because of their own animated towns and machines.
- **The slow worlds were already slow, and for reasons of their own:**
  - **The Last Frontier:** 1 267 draw calls, so it is CPU-bound in the render encode.
  - **The Web and The Veil at 4K:** GPU-bound by their ray-marched fog (17 ms of GPU time).
  - **The Lost Kingdom and The Web on WebGL 2:** slow on that backend only.

  None of this comes from the living-environment work (§3).
- **The 144 Hz target is met** at 2560×1080 on WebGPU by 21 of 23 worlds (the owner's display is 2560×1080 at 144 Hz). At 4K, 11 of 23 worlds meet it.

## 5. A measurement fix made along the way

`scripts/perf.ts` measured 2.5 s after starting the game. For the heaviest worlds that was too soon: the previous world could still be crossfading out. A first full run showed "Lost Kingdom" at 72 fps with 1 265 draw calls, which was really The Last Frontier's scene still on screen. The script now takes `--settle <ms>`; the tables above use 8–9 s.

Earlier per-world tables in PERFORMANCE.md were measured with the 2.5 s settle. For worlds that follow a heavy world in alphabetical order, they may include part of a crossfade.

## 6. Design choices for performance

| Brief (§40.13) | How |
|---|---|
| GPU particles, shader animation | Particles, water, aurora, swarms, galaxies and creatures animate in their shaders. The drives reach them as uniforms; nothing is rebuilt per frame. |
| No expensive per-object CPU work | Reactions are uniform writes (one per bound target). Events are a handful of timers. |
| No large per-frame allocation | Drives, uniforms and the cue list are reused. |
| Phase-continuous rates | Particle drift, aurora, water swell, swarm wingbeats and galaxy rotation integrate their clocks on the CPU (one add per frame), so music-driven speed changes are smooth. |
| Independent of React | The director, event director and reactivity run in the render loop, never in React. |
| The audio clock for musical sync | Beats, sections and anticipation come from the Music Director's audio-clock timeline. Analysis frames are applied when they are heard. |
| Different refresh rates | Time-constant envelopes, the same at any frame rate (unit-tested). |
| WebGPU preferred, WebGL 2 fallback | Both measured above. No new compute or storage features. |
| A VR profile | VR keeps its own graphics setting (Settings → VR: performance, balanced, quality) and has screen effects off. The living system runs unchanged in VR. It was tested under emulation (`e2e/vr.spec.ts`, passing); there are no headset numbers. |

## 7. Not measured

- **A real VR headset.** Only emulation.
- **Background intensity presets compared with each other.** The presets scale uniforms, not particle counts (counts are fixed at build time by Graphics → particle density). Cinematic and Subtle therefore cost the same draw calls and nearly the same GPU time as Balanced.
