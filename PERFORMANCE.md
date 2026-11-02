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
