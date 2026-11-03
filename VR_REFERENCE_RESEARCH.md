# VR reference research: Moon Rider

Moon Rider (`supermedium/moonrider`) is an open-source WebXR rhythm game that runs in the browser. These notes come from an earlier review of its repository, done before Prismfall's VR mode was built. The repository was not fetched again while writing this file. Only findings from that review are listed. Anything it did not verify is marked as not verified.

## Findings

| Area | What the review found |
|---|---|
| Stack | Built on A-Frame, bundled with webpack 4. |
| Licence | MIT. |
| Code organisation | Components are registered automatically. |
| Global state | Global state through `aframe-state-component`. |
| Controllers | A-Frame's `tracked-controls`, with profiles for `oculus-touch`, `vive` and `windows-motion`, plus a generic fallback. |
| Haptics | Short pulses, about 100 ms at force 0.075. |
| Beat sync | Reads the song's current time, with a lookahead of 3500 ms or 2000 ms depending on the mode. |
| Map data | Beat Saber v2 map data. |
| Object reuse | Object pooling, with "park" positions for inactive entities. |
| Tests | No automated tests documented. |

### Not verified in that review

- How the WebXR session and reference spaces are requested and handled.
- How the menus are built and navigated in VR.

Nothing in Prismfall relies on assumptions about these two areas.

## What Prismfall took and what it did differently

No Moon Rider code was copied. Prismfall's VR code is its own TypeScript.

### Architecture: no A-Frame

Prismfall uses three.js directly. VR sits behind `XRManager` and the narrow `XRHost` interface (see VR_ARCHITECTURE.md). The reason is to keep one renderer stack: the game already renders with three's `WebGPURenderer` and TSL node materials. VR draws the same scene graph with a second `WebGPURenderer` in WebGL 2 mode. Every material, particle system and environment component is shared with the desktop. Adopting A-Frame would have put a second framework on top of the existing three.js code.

### Ideas adopted

| Idea from Moon Rider | How it appears in Prismfall |
|---|---|
| Short, low-intensity haptic pulses | Pulses last 18–220 ms and are scaled by a strength setting (default 60%). A piece lock is a 0.15 × strength tick, a hard drop 0.45 × strength for 40 ms, and only a four-line clear reaches 0.9 × strength for 220 ms. Players can turn vibration off. |
| Pooled, pre-allocated objects instead of create/destroy | The particle systems were already fixed-capacity GPU ring buffers, with unused particles "parked" in the past at start-up: 32,768 world-space, and 16,384 board-space so they travel with the playfield in VR. The VR code follows the same habit: reused `Ray` and `Matrix4` scratch objects, and panel and HUD canvases redrawn only when their content changes. |
| Timing driven by the audio clock, not frame time | Already present before VR. The audio engine maps the audio clock to `performance.now()` (`getOutputTimestamp` when available, smoothed), and the music director schedules on the audio clock with lookahead. VR shares the same audio system, so music and its visuals behave as on the desktop. |
| A generic controller fallback | There are no per-controller tables. `XRControllerInput` reads the WebXR `xr-standard` gamepad layout, which Quest Touch, Index, Vive and WMR controllers report. Controllers without a thumbstick use their touchpad, counted only while pressed. |

### Differences

| Topic | Moon Rider (as reviewed) | Prismfall |
|---|---|---|
| Automated tests | None documented | Unit tests for controller polling. Playwright end-to-end tests against an emulated Quest 3 (IWER) that enter VR mid-game, play with controllers, check head tracking and the headset image, and exit with the game intact (VR_TESTING.md). |
| Controller mapping | `tracked-controls` profiles with a generic fallback; remapping was not covered by the review | Remappable bindings (`xr:<hand>:<control>`) in Settings → VR. Gameplay and menu contexts are separate. Conflicting choices swap. |
| Play space | Not covered by the review | A metre-scale playfield (1 m tall at 100%) in a full-scale world. Seated and standing layouts are anchored to the measured head position, with a recentre option. Distance, height, size and tilt are adjustable. |
| Rendering | A-Frame | three.js directly. WebGPU or WebGL 2 on the desktop, a dedicated WebGL 2 renderer for VR, with the same scene and materials. |
