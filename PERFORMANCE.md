# Performance

All numbers here are measured with `npm run perf`, never estimated.

## How the benchmark works

`npm run perf` plays Zen with the built-in AI in Google Chrome, using the machine's real GPU. It covers every combination of resolution, quality preset, graphics backend and stage, then saves a JSON report to `perf-results/`.

| Setting | Detail |
|---|---|
| Frame rate | Runs uncapped (`--disable-gpu-vsync --disable-frame-rate-limit`), so fps shows headroom rather than the display limit. |
| GPU time | WebGPU timestamp queries over all passes in a frame. Shown as n/a on WebGL 2. |
| CPU time | Timing per subsystem: scene update and render encoding. |
| 4K measurement | A 1920×1080 viewport at device pixel ratio 2, which renders 3840×2160 pixels. |

**Test system:** AMD Radeon RX 9070 XT (RDNA 4), Ryzen 7 5800X3D, 32 GB RAM, Windows 10, Chrome 156, three r187.

## Baseline — Milestone 3 (board only, before stage environments)

Measured 2026-11-02 with `npm run perf -- --quick --seconds 6`.

| Backend | Resolution | Preset | FPS (uncapped) | p95 frame | GPU time |
|---|---|---|---|---|---|
| WebGPU | 2560×1080 | High | 907 | 1.60 ms | 0.20 ms |
| WebGPU | 2560×1080 | Ultra | 517 | 2.50 ms | 0.29 ms |
| WebGPU | 3840×2160 | High | 380 | 2.90 ms | 1.05 ms |
| WebGPU | 3840×2160 | Ultra | 306 | 3.70 ms | 0.87 ms |
| WebGL 2 | 2560×1080 | High | 551 | 2.40 ms | n/a |
| WebGL 2 | 2560×1080 | Ultra | 448 | 2.80 ms | n/a |
| WebGL 2 | 3840×2160 | High | 302 | 3.70 ms | n/a |
| WebGL 2 | 3840×2160 | Ultra | 255 | 4.30 ms | n/a |

**Reading the numbers:** the board and post-processing chain together cost well under 2 ms of frame time even at 4K Ultra. That leaves a large budget for the stage environments added in Milestone 4. Later sections record per-stage results.

## All worlds — Milestone 10

Measured 2026-11-03 with `npm run perf -- --quick --seconds 5 --stages <all 13 worlds>`, the AI playing Zen, uncapped frame rate. Raw data: `perf-results/perf-2026-11-03T03-40-13-990Z.json` (not committed; regenerate with the same command).

Each cell is **fps (p95 frame time in ms)**; WebGPU cells add **· GPU time in ms** from timestamp queries.

### WebGPU

| World | 2560×1080 High | 2560×1080 Ultra | 3840×2160 High | 3840×2160 Ultra |
|---|---|---|---|---|
| alpine-horizon | 529 (2.1) · 1.2 | 338 (3.6) · 2.1 | 191 (5.5) · 3.6 | 138 (7.7) · 4.4 |
| ancient-garden | 523 (2.5) · 1.1 | 360 (3.4) · 1.4 | 204 (5.3) · 3.3 | 147 (7.1) · 3.9 |
| celestial-drift | 434 (2.6) · 1.6 | 280 (5.3) · 2.7 | 134 (7.9) · 5.9 | 108 (9.7) · 6.6 |
| ember-core | 362 (3.9) · 2.1 | 241 (6.0) · 3.4 | 140 (7.4) · 5.6 | 93 (11.4) · 9.7 |
| ember-foundry | 491 (2.2) · 0.8 | 380 (3.5) · 1.1 | 244 (4.3) · 2.5 | 165 (6.6) · 3.3 |
| enchanted-wilderness | 491 (2.4) · 1.3 | 288 (7.8) · 2.2 | 180 (5.8) · 3.9 | 136 (7.9) · 4.4 |
| folded-sky | 669 (2.4) · 0.8 | 360 (7.3) · 1.2 | 249 (4.3) · 2.4 | 160 (6.7) · 3.5 |
| frozen-kingdom | 482 (2.3) · 1.3 | 301 (4.0) · 2.3 | 177 (5.9) · 4.0 | 127 (8.2) · 6.9 |
| future-nights | 580 (2.0) · 1.1 | 341 (3.5) · 2.1 | 203 (5.7) · 3.4 | 137 (7.8) · 4.3 |
| luminous-tide | 498 (3.9) · 1.1 | 333 (3.8) · 1.6 | 185 (5.7) · 3.8 | 132 (7.9) · 6.6 |
| moving-sands | 610 (1.9) · 0.9 | 377 (3.6) · 1.2 | 244 (4.4) · 2.5 | 162 (6.5) · 3.4 |
| northern-lights | 361 (3.1) · 2.1 | 238 (4.7) · 3.3 | 140 (7.4) · 5.5 | 93 (11.2) · 9.6 |
| the-abyss | 273 (4.0) · 2.9 | 192 (5.9) · 3.8 | 110 (9.4) · 7.3 | 73 (14.4) · 11.1 |

### WebGL 2

| World | 2560×1080 High | 2560×1080 Ultra | 3840×2160 High | 3840×2160 Ultra |
|---|---|---|---|---|
| alpine-horizon | 314 (5.1) | 266 (4.6) | 164 (9.1) | 134 (8.6) |
| ancient-garden | 323 (4.0) | 267 (5.4) | 170 (7.1) | 143 (9.0) |
| celestial-drift | 272 (5.0) | 222 (5.7) | 131 (10.3) | 101 (12.3) |
| ember-core | 252 (6.3) | 210 (5.7) | 126 (10.3) | 93 (12.7) |
| ember-foundry | 325 (3.7) | 256 (5.6) | 175 (7.4) | 144 (8.1) |
| enchanted-wilderness | 295 (4.3) | 251 (4.7) | 152 (8.7) | 128 (9.5) |
| folded-sky | 377 (4.3) | 299 (5.3) | 191 (7.5) | 153 (8.5) |
| frozen-kingdom | 286 (5.0) | 241 (5.7) | 151 (8.7) | 124 (8.9) |
| future-nights | 340 (4.8) | 264 (5.8) | 169 (8.0) | 135 (10.1) |
| luminous-tide | 322 (4.9) | 257 (5.5) | 162 (7.6) | 123 (9.3) |
| moving-sands | 339 (4.7) | 283 (4.4) | 188 (6.6) | 153 (9.0) |
| northern-lights | 251 (5.2) | 199 (7.1) | 124 (9.0) | 91 (12.2) |
| the-abyss | 205 (6.6) | 175 (7.7) | 103 (12.2) | 74 (15.2) |

**Reading the numbers:**

- At the owner's display (2560×1080, 144 Hz) every world stays far above the refresh rate on both backends. The heaviest world, The Abyss on Ultra, runs at 192 fps on WebGPU with a 5.9 ms p95 frame time; on WebGL 2 at 175 fps.
- At 4K (3840×2160) every world stays above 60 fps on Ultra. The heaviest are The Abyss (73 fps WebGPU, 74 fps WebGL 2), Northern Lights and Ember Core (93 fps). Most worlds run above 120 fps at 4K Ultra, so 4K at 120 Hz is reachable on High or with dynamic resolution, not guaranteed on Ultra.
- GPU time dominates at 4K (up to 11.2 ms on Ultra in The Abyss). Per-layer GPU costs were not profiled; the heaviest worlds are the ones with the most full-screen environment layers and particles.
- WebGL 2 is slower at low resolution (more CPU-side draw overhead) and roughly on par at 4K, where the GPU is the limit on both.
- 2560×1440 was not part of this quick matrix; it sits between the two measured resolutions. Run `npm run perf` without `--quick` for low/medium presets and 1440p.
- VR performance in a headset has not been measured (no headset was available); see VR_TESTING.md.
