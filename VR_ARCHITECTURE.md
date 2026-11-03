# Prismfall VR architecture

Prismfall supports WebXR `immersive-vr`. Entering VR changes how the game is presented, never the game itself. This document explains how that works. Player settings are covered in VR_SETTINGS.md and testing in VR_TESTING.md.

## Files

| File | Role |
|---|---|
| `src/xr/XRManager.ts` | Session lifecycle, the VR renderer, layout, controllers, menu panel and HUD, haptics, listener pose. Also `xrStore` (availability, presenting, starting) for React. |
| `src/xr/xrInput.ts` | `XRControllerInput`: polls WebXR gamepads into raw `xr:<hand>:<control>` events and sends haptic pulses. |
| `src/xr/vrPanel.ts` | `VRPanel` (menu) and `VRHud` (score panel): canvas textures on planes. |
| `src/xr/xrEmulator.ts` | Test-only IWER setup and helpers (see VR_TESTING.md). |
| `src/ui/vr/VRControls.tsx` | "Play in VR" menu item, the "Playing in VR" page overlay and the status panel in Settings → VR. |
| `src/ui/vr/VRBindings.tsx` | Controller remapping panel. |
| `src/app/GameShell.ts` | Implements `XRHost` (`xrHost()`), hands over the frame loop, reports haptic moments, feeds the audio listener. |
| `src/rendering/renderer/RenderSystem.ts` | `presenter` hook, `boardRoot` (board space) and `boardBursts` (board-space particles). |
| `src/input/inputManager.ts`, `src/input/mappings/bindings.ts` | `setXRBindings`, `handleXR`, `MENU_XR`, `XR_CONTROLS`, `controlLabel`. |
| `src/settings/schema.ts` | `DEFAULT_XR` bindings and the `vr` settings section. |
| `src/rendering/environments/ground.ts`, `src/sdk/types.ts` | `GroundField.surface()` and `setWaterLevel()` (Content SDK 1.2): where a VR viewer stands. |

## The XRHost boundary

`XRManager` never imports the shell. It receives an `XRHost`, a narrow interface that `GameShell.xrHost()` implements:

- `renderSystem()` and `input`: the scene and the input manager.
- `beginExternalFrames()`, `externalFrame(now)`, `endExternalFrames()`: the frame loop hand-over.
- `appState()`, `hud()`, `results()`, `stages()`, `currentStage()`: read-only state for the panel and HUD.
- `startMode()`, `pause()`, `resume()`, `restart()`, `quitToMenu()`, `chooseStage()`: the same commands the page menus use.
- `onHaptic(listener)`: the shell reports `drop`, `lock`, `clear` and `quad` moments.

The shell creates the manager after the render system exists (not in the `?view=debug2d` Canvas 2D view). It runs `detect()` at start-up, again on `navigator.xr`'s `devicechange` event, and when "Check again" is pressed in Settings → VR.

## Data flow while presenting

```
 headset + controllers
        |  XRSession ("immersive-vr")
        v
 three XRManager on the VR renderer (WebGL 2)
        |  per XR frame: viewer pose -> eye cameras, then calls the animation loop
        v
 XRManager loop --- XRControllerInput.poll(inputSources)
        |                 | raw "xr:<hand>:<control>" events
        |                 v
        |           InputManager.handleXR --> gameplay context --> GameSession
        |                                 --> menu context ------> XRManager.handleMenu
        |                                     (MenuNavigator ignores device "xr")
        v
 XRHost.externalFrame(time) = GameShell.frame()
        |  simulation, audio, HUD store
        |  haptic moments -> XRManager.haptic() -> controller pulses
        |  audio listener <- XRManager.listenerPose()
        v
 RenderSystem.render(): board, environment, particles, lights updated
        |  presenter is set, so camera rig and post-processing are skipped
        v
 XRManager.draw(): redraw panel/HUD if changed -> vrRenderer.render(scene, rig camera)
        |                -> measure head pose for layout
        v
 XR framebuffer -> headset
```

## A second renderer for VR

The desktop renderer (WebGPU, or WebGL 2) is left alone. On the first entry, `XRManager.setUp()` creates a dedicated `WebGPURenderer` with `forceWebGL: true` on its own canvas, which is never attached to the page. WebGL 2 is the WebXR path used in three r187. The renderer is kept for later sessions.

Both renderers draw the same `Scene` object. GPU resources belong to one renderer, so the VR renderer builds its own buffers, textures and pipelines the first time it draws each object. The desktop environment map is a PMREM texture on the other device, so the VR renderer builds the same one (`RoomEnvironment`, sigma 0.04) and swaps it into `scene.environment` while presenting. The desktop map is restored on exit.

At each entry the VR renderer copies the desktop renderer's output colour space, disables the shadow map and enables XR. Tone mapping and exposure are copied every frame (worlds change them). The graphics profile sets the framebuffer scale and fixed foveation at entry, and its particle-density cap is re-applied every frame so a Graphics change during VR can't lift it. The layout is recomputed when the world changes (each world has its own ground height). While presenting, the desktop canvas is not redrawn.

The canvas is sized from the window: at least 640×360, at up to 2× device pixel ratio. Headsets size their layers themselves. Emulators and some runtimes take the layer size from the canvas.

### Output-only MRT

Many materials set `mrtNode = mrt({ emissive: ... })` to feed the desktop bloom pass. Without a renderer-level MRT, that material MRT would replace the colour output. The VR renderer therefore sets:

```ts
const outputOnly = mrt({ '': output });
outputOnly.setBlendMode('', outputOnly.getBlendMode('output'));
renderer.setMRT(outputOnly);
```

The unnamed key routes the material's colour output to the XR target. The `emissive` output has no target there and is dropped. Only the `output` key inherits each material's blending by default. Without the second line, the unnamed key does not inherit it, and additive sprites (the burst particles) render as opaque black quads.

## Frame loop hand-over

1. `enter()` requests the session first, while the click still counts as a user gesture. The requested optional features are `local-floor` and `bounded-floor`.
2. `setUp()` calls `renderer.setAnimationLoop(loop)` **before** `renderer.xr.setSession(session)`. three captures the current animation loop when the session starts and calls it from its own XR frame handler, which updates the head pose and eye cameras first. A loop set after `setSession()` replaces that handler, and head tracking stops without any error. The loop returns early until `presenting` is true.
3. After the session starts, `rs.presenter = () => this.draw()` is set and `host.beginExternalFrames()` cancels the shell's `requestAnimationFrame`. Each XR frame then polls the controllers and calls `host.externalFrame(time)`, which runs `GameShell.frame()`.
4. When the session ends (from the headset, the panel's "Exit VR" or the page's "Exit VR"), `tearDown()` releases held controls and clears the presenter. It restores the board transform, environment map and particle density, removes the rig, panel and HUD, and calls `endExternalFrames()`, which restarts `requestAnimationFrame`.

The shell's frame limiter (Graphics → Frame rate limit) is bypassed while external frames are active, so every XR frame is drawn.

## Layout

World space is treated as metres. The world stays at full scale and the player stands in it. Only board space (`boardRoot`) changes:

| Quantity | Value |
|---|---|
| Player position | `(0, ground, 30)`, with `ground = environment.ctx.ground.surface(0, 30)` (−14 without an environment) |
| Ground | `surface()` is the terrain height, or a declared water surface if that is higher |
| Board scale | `vr.boardScale / 20`: 1 board unit = 5 cm at 100%, so the 20-row playfield is 1 m tall |
| Board position | `(0, eye + vr.boardHeight, 30 − vr.boardDistance)` |
| Board tilt | rotation of `−vr.boardTilt` degrees about X (positive values lean the top away) |
| Seated eye height | `ground + 1.2` m; reference space `local` |
| Standing eye height | `ground +` the measured head height above the floor (1.6 m until measured); reference space `local-floor` |

Runtimes disagree about where the `local` origin is, so the layout follows the measured head. Each `draw()` renders first. Then, if no head is stored and more than three frames have passed since the last anchor, it averages the eye cameras' reference-space positions and calls `applyLayout()`. The rig (camera and controllers) is offset so that this head position lands at x = 0 and z = 30 at the chosen eye height. "Recentre view" in the panel and the reference space's `reset` event (a system recentre) both clear the stored head, so the layout is re-measured a few frames later. Changing any `vr` setting while presenting re-runs `applyLayout()`. The reference space type and graphics profile are applied only at session start.

## Controllers and input

`XRControllerInput.poll()` reads every input source that has a gamepad and a left or right hand, once per XR frame. It uses the `xr-standard` button layout: 0 trigger, 1 squeeze, 3 stick press, 4/5 face buttons. Face buttons are named `a`/`b` on the right and `x`/`y` on the left. The thumbstick is read from axes 2/3. Without a thumbstick, the touchpad on axes 0/1 counts only while it is pressed: near an edge it gives a direction, near the centre it is the stick press (Vive wands have no face buttons, so Pause defaults to Y or the left stick press). Buttons and stick directions use hysteresis (press 0.55, release 0.35). A controller that disappears releases everything it held. Events are `{ device: 'xr', pad: 0 | 1, control: 'xr:<hand>:<control>' }`.

`InputManager.handleXR()` routes these through the same context system as the keyboard and gamepad:

- **Gameplay context**: the `xr` bindings (defaults in `DEFAULT_XR`, remappable).
- **Menu context**: the fixed `MENU_XR` navigation plus the bindable Confirm and Back. `MENU_XR` uses either stick for up, down, left and right, and the grips for tab left and right; the VR panel does not use the tab actions.

`MenuNavigator` ignores `xr` events, so the page menus never react to controllers. The VR panel owns menu input (`XRManager.handleMenu`):

- Stick up and down move the highlight. Confirm activates the highlighted item.
- Back resumes the game when it is paused.
- Left and right on the "World" item cycle through the unlocked stages.
- Pulling the trigger on a controller fires three's `selectstart`. Ray-casting that controller against the panel activates the row it points at.
- A trigger that is also bound to Confirm fires both paths. `activate()` ignores a second activation within 250 ms.
- The last controller to pull its trigger owns hover. The other controller's ray only highlights a row while the pointing controller is off the panel.

## Menu panel and HUD

Both are `MeshBasicNodeMaterial` planes with a `CanvasTexture`. They are transparent, do not write depth, ignore fog and tone mapping, and are children of `boardRoot`, so they scale and move with the playfield.

- **Panel**: 12×11 board units (0.60 × 0.55 m at 100%), 96 px per unit, 0.14 m in front of the playfield centre. It shows the main menu (Marathon, Zen, Voyage, World, Recentre view, Exit VR), the pause menu (Resume, Restart, Recentre view, Quit to menu, Exit VR) or the results (Play again, Menu, Exit VR). It is hidden during unpaused play and on the loading screen. It is redrawn only when its content or highlight changes.
- **HUD**: 6×9 board units, 80 px per unit, left of the playfield. It sits `vr.hudOffset` metres in front of it at `vr.hudScale`. It shows score, level, lines, time, and the combo or latest callout, only on the game screen. It is redrawn only when the text changes.

## Haptics

`GameShell.frame()` maps engine events to haptic kinds: hard drop → `drop`, lock → `lock`, line clear → `clear`, or `quad` for four or more lines. `XRManager.haptic()` scales each pulse by Vibration strength and sends it to both controllers. `XRControllerInput.pulse()` uses `hapticActuators[0].pulse()`, falling back to `vibrationActuator.playEffect('dual-rumble')`. Menu activations send a short pulse to the right controller. Pulse values are listed in VR_SETTINGS.md.

## Spatial audio

Each frame, `GameShell.frame()` asks `XRManager.listenerPose()` for the world position and facing of the rig's camera (which three updates with the head pose on every render, so it includes the player's place in the world) and passes them to `AudioSystem.setListener()`. Outside VR the desktop camera is used. The listener's up vector stays world up. Music and analysis are the same engine as on the desktop. World sounds (creatures, ambience) use the existing panners, which are HRTF when Audio → Spatial audio is on.

## Game state

Entering or leaving VR never pauses, resumes or restarts anything. A game paused from the page menu is still paused in the headset. The only changes are presentational:

- the `boardRoot` transform (saved and restored)
- `scene.environment`
- the rig in the scene
- particle density, restored to Graphics → Particle density on exit
- the `presenter` hook and which loop drives frames

## Emulator shim

IWER (and the WebXR polyfill) hand out an `XRWebGLLayer` whose `framebuffer` is `null`. The spec reserves the default framebuffer for inline sessions. three's WebGL state cache throws on a `null` draw-buffer key. `patchDefaultFramebufferLayer()` detects that case after `setSession()` and wraps the backend's `state.drawBuffers` to skip `null`. Real headsets supply a real framebuffer and never take this path.

## Limits

- No hand tracking. Only gamepad-backed controllers produce input.
- No WebXR quad or cylinder layers. The panel and HUD are ordinary meshes in the projection view.
- No multiview-specific work.
- Post-processing (bloom, anti-aliasing passes, depth of field, motion blur, upscaling) is desktop-only. The VR renderer is created with `antialias: true`.
- Shadows are off in VR.
- No real headset has been tested yet (see VR_TESTING.md).
