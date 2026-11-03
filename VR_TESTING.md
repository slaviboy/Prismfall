# VR testing

This document covers what the automated tests prove about Prismfall's VR mode, how to run them, and what a person still has to check on a real headset. **No real headset has been tested yet.** Everything below the "Real headset checklist" heading is still open.

## What is automated

| Suite | File | Runs on | Covers |
|---|---|---|---|
| Unit | `src/xr/xrInput.test.ts` | Vitest (Node) | Controller polling and naming |
| End-to-end | `e2e/vr.spec.ts` | Playwright + installed Google Chrome + IWER | Detection, session start, frame loop, head tracking, headset view, controller play, VR menu, exit |

### Unit tests (`XRControllerInput`)

1. Trigger, face buttons and stick directions map to `xr:right:trigger`, `xr:right:a`, `xr:right:stick-right`. A partial release (0.45) stays held because of hysteresis; a full release lets go.
2. Left face buttons are named `x` and `y`, every event has `device: 'xr'`, and the left hand uses pad slot 0.
3. On a controller without a thumbstick (two axes), the touchpad counts only while pressed.
4. A controller that disappears releases everything it held.

### The emulator

The end-to-end tests use Meta's Immersive Web Emulation Runtime (IWER). `iwer` is pinned as an exact devDependency (`2.5.0`).

`src/xr/xrEmulator.ts` creates an `XRDevice` with IWER's `metaQuest3` config: a Quest 3 with Touch Plus controllers. It installs the device with `installRuntime({ forceInstall: true })`, which replaces `navigator.xr` even if the browser has its own. It then tilts both controllers 80° towards the floor, so their rays miss the menu panel and the tests can drive the panel with the stick. Helpers `pressButton()` and `pushStick()` hold a control for 140 ms, release it, and wait 80 ms.

The game never loads this module. It is reachable only through the debug hooks: `window.__PRISMFALL__.xrEmulator()` is a dynamic import, defined in `src/main.tsx` inside `if (__PRISMFALL_HOOKS__)`. Vite defines that flag as `true` in dev and test builds and `false` in production builds.

With the emulator installed, the real WebXR code runs unchanged:

- session request and reference space
- three's XR frame loop
- `inputSources` polling, `selectstart` events and haptics calls

### End-to-end tests (`e2e/vr.spec.ts`)

The shared fixture fails every test on any console error or uncaught page error.

1. **Reports no headset without a VR runtime and offers guidance.** Without the emulator:
   - availability settles (not `checking`)
   - there is no "Play in VR" item
   - Settings → VR shows the status panel and the controller bindings, but no "Enter VR" button

   This assumes the test machine has no active VR runtime and headset.
2. **Enters VR mid-game, plays with controllers, and returns with the game intact.**
   - Installs the headset and checks that "Play in VR" appears. Then starts Marathon, lets the built-in AI place four pieces, pauses with Escape and selects "Play in VR" in the pause menu.
   - After entry: `presenting` is true and the page overlay is visible. The piece count is unchanged and the game is still paused. `boardRoot.scale.x` is 1/20.
   - **Head tracking reaches three**: the manager's measured head becomes non-null, which needs eye cameras with poses.
   - **The headset view has real content**: with the page UI and desktop canvas hidden, a screenshot of IWER's view has a luminance standard deviation above 6 and more than 0.1% strongly coloured pixels.
   - B resumes the game. The right trigger rotates the piece, the left stick moves it left, the grip changes the held piece, and A hard-drops one piece.
   - Y pauses, and the VR panel appears.
   - "Exit VR" on the page ends the session. The piece count and score are kept, `boardRoot` scale returns to 1, and the page pause menu is back. After resuming, Space hard-drops another piece, which shows the desktop loop is running again.
3. **The VR menu starts a game and exits VR from the headset.**
   - Enters VR from the main menu and waits for the panel. Moves the highlight with the right stick to Marathon and confirms with the trigger.
   - Plays one piece with A, pauses with Y, moves to "Exit VR" and confirms. The session ends with the game state intact.

## Running the tests

```sh
npx vitest run src/xr/xrInput.test.ts
npx playwright test e2e/vr.spec.ts
```

Playwright builds the test bundle (`npm run build:test`) and serves it with `vite preview` on port 4174, unless a server is already running there. Set `PW_DEV=1` to run against the dev server on port 5173 instead. Tests run in the installed Google Chrome with one worker.

## Emulator quirks the code tolerates

| Quirk | Handling |
|---|---|
| IWER moves the XR canvas into a fixed, full-page container (z-index 999) over the page. | Page clicks during a session use `locator.dispatchEvent('click')` instead of a real click. |
| `XRWebGLLayer.framebuffer` is `null` (the canvas's default framebuffer). three's WebGL state cache throws on it. | `patchDefaultFramebufferLayer()` in `XRManager.ts` skips draw-buffer setup for `null`. Real headsets never take this path. |
| The layer size is the canvas's drawing-buffer size. | The VR canvas is sized from the window before the session starts: at least 640×360, at up to 2× device pixel ratio. |
| The view is a single mono eye by default. IWER's default vertical field of view is 90° (π/2), drawn across the whole window, so the playfield covers only part of the image. | The screenshot thresholds are loose: they check only for contrast and some coloured pixels. |
| The headset stays at IWER's default position (1.6 m above its origin) for the whole test. | The layout anchors to whatever head pose is reported, so the tests do not depend on it. |

## Bugs the emulated tests caught

| Bug | Symptom | Fix | Guard |
|---|---|---|---|
| Animation loop installed after `xr.setSession()` | three's XR frame handler was replaced, so head pose and eye cameras never updated | Install the loop first (see VR_ARCHITECTURE.md) | `xr.head !== null` poll |
| Material MRT without a renderer MRT | The `emissive` output replaced the colour output in the headset | Renderer MRT `mrt({ '': output })` | Headset-view screenshot |
| Unnamed MRT key without material blending | Additive particle sprites drew as opaque black quads | Copy the `output` key's blend mode to `''` | Headset-view screenshot (coarse) |
| 2×2 render target | The emulator took the layer size from a canvas that had not been sized | Size the VR canvas from the window | Headset-view screenshot (contrast) |

## What emulation cannot prove

The emulator runs the real code paths, but not the following:

- real optics or stereo
- real tracking
- frame timing on headset hardware
- controller ergonomics and haptic feel
- any runtime other than IWER's

## Real headset checklist

Nobody has verified any of the following on real hardware yet. Check each item on at least one standalone headset (Quest browser) and one PC VR setup (Chrome or Edge with Link, Air Link or SteamVR). Record the headset, browser and version.

**Starting and leaving**
- [ ] "Play in VR" appears only when the headset is ready. "Check again" picks up a headset connected after the page loaded.
- [ ] Entering from the main menu, from the pause menu, and from Settings → VR all work. A failed start shows the warning toast.
- [ ] Entering mid-game keeps the exact game state. Leaving from the headset panel, the page button and the headset system menu each restore the desktop view, with no input stuck held.
- [ ] Entering and leaving several times in one page session works (the VR renderer is reused).

**Comfort and tracking**
- [ ] Head tracking is smooth, with no judder or swimming. Nothing moves the view except your head.
- [ ] A 20-minute session causes no discomfort at the default settings.
- [ ] **Recentre view** and the headset's own recentre both put the playfield back in front of you.

**Scale and layout**
- [ ] Seated: eye height and playfield placement feel natural in a chair. Standing: the floor matches the world's ground (check a stage with water too).
- [ ] At 100% size, 1.10 m distance and 6° tilt, the whole playfield is visible without turning your head.
- [ ] Changing distance, height, size, tilt and both panel settings during VR updates the layout at once.
- [ ] Switching worlds in the headset menu leaves you standing on the new world's ground.

**Legibility**
- [ ] Menu panel text, score panel text, next and hold pieces, and the ghost piece are readable at the defaults, and at 50% size and 3 m distance.

**Controllers**
- [ ] The default mapping works on Quest Touch, Valve Index, HTC Vive wands and Windows Mixed Reality controllers. On Vive and WMR (no A/B/X/Y), Pause is the left stick press or touchpad centre press; confirm it, and that the panel's Resume works with the trigger.
- [ ] Vive touchpad directions trigger only when pressed. No drift or chatter with a resting thumb on any controller.
- [ ] Point-and-pull selects exactly once, with either hand. The pointing hand owns the highlight.
- [ ] Remapped buttons take effect immediately, including when changed on the page during a session.

**Haptics**
- [ ] Drop, lock, clear and four-line pulses feel distinct and not tiring at 60%.
- [ ] 0% strength is silent. With vibration off, gameplay and menu pulses stop.

**Performance**
- [ ] Frame rate holds the headset's refresh rate on each profile (Performance, Balanced, Quality) during heavy line clears, on a busy world. Note which profile each headset needs.
- [ ] Foveation is visible on Performance and not distracting on Balanced.

**Audio**
- [ ] Music stays in sync. Creature and ambience sounds come from the right direction and distance as you turn your head (headphones).

**Status messages**
- [ ] On an insecure origin the status says so. Over HTTPS from the headset browser, VR starts (see DEPLOYMENT.md).
