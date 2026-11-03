# VR settings and controls

This guide covers how to start VR in Prismfall, what each setting in **Settings → VR** does, and how the controller buttons work. The VR tab is also available from the pause menu's Settings. How VR works internally is described in VR_ARCHITECTURE.md.

## Starting VR

You need a browser with WebXR and a headset it can reach:

- **PC VR**: a current Chrome or Edge on the PC, with the headset connected through Quest Link, Air Link or SteamVR. Open the game from `localhost` on that PC.
- **Standalone headset**: the headset's own browser, opening the game over HTTPS.

WebXR only works on a secure page. `localhost` on the PC counts as secure. Any other device, including the headset's browser, needs the game served over HTTPS behind real access control. See [DEPLOYMENT.md](DEPLOYMENT.md).

When a headset is ready, **Play in VR** appears in the main menu and the pause menu, and **Enter VR** appears at the top of Settings → VR. Select either one, then put the headset on. While you play in VR, the page shows "Playing in VR" with an **Exit VR** button.

To leave VR, use **Exit VR** on the headset panel (main menu, pause menu or results), use **Exit VR** on the page, or end the session from the headset's system menu. The game continues where you left it. Entering or leaving VR never pauses, resumes or restarts a game.

The status line at the top of the VR tab explains what is missing:

| Status | Meaning |
|---|---|
| Checking for a VR headset… | Detection is still running. |
| A VR headset is ready. | You can enter VR. |
| This browser supports VR, but no headset is connected… | WebXR is present but no runtime or headset answered. Connect one and press **Check again**. |
| This browser has no WebXR support… | Use a current Chrome or Edge on the PC, or the headset's browser. |
| VR needs a secure page… | The page is not on `localhost` or HTTPS. |

## Playfield

| Setting | Range | Default | What it does |
|---|---|---|---|
| Play position | Seated, Standing | Seated | **Seated** puts your eyes 1.2 m above the world's ground, wherever you sit. **Standing** uses your real height above your floor. Choose this before entering VR. |
| Distance | 0.50–3.00 m | 1.10 m | How far the playfield floats in front of your eyes. |
| Height | −0.60 to +0.60 m | −0.08 m | Playfield centre above (+) or below (−) eye level. |
| Size | 50–200% | 100% | At 100% the playfield is about 1 m tall (one cell is 5 cm). The menu panel scales with it. |
| Tilt | −30° to +30° | 6° | Leans the top of the playfield away from you. Negative values lean it towards you. |

You stand in the world at full scale. Only the playfield, menu panel and score panel are sized for reading. The layout centres on your head a few frames after VR starts. **Recentre view** in the headset menu, or your headset's own recentre gesture, measures your head again and moves the playfield back in front of you. Changes to these settings while in VR take effect immediately.

## Score panel

| Setting | Range | Default | What it does |
|---|---|---|---|
| Panel distance | −0.30 to +0.50 m | 0.04 m | How far the score panel (score, level, lines, time, combo) sits in front of the playfield. |
| Panel size | 50–200% | 100% | Size of the score panel. |

## Comfort and quality

| Setting | Range | Default | What it does |
|---|---|---|---|
| VR graphics | Performance, Balanced, Quality | Balanced | Rendering profile, see below. Applied the next time you enter VR. |
| Dim the world | 0–80% | 0% (off) | Draws a dark sphere around your head just beyond the playfield (Distance + 1.5 m). Everything outside it is darkened; the playfield, panels and controllers are not. |
| Controller vibration | on, off | on | Pulses on hard drops, locks and clears. |
| Vibration strength | 0–100% | 60% | Scales every pulse. Shown when vibration is on. |
| Pointer rays | on, off | on | Shows a 3 m line from each controller. Pointing at the menu still works with the rays hidden. |

The tab's **Restore defaults** button at the bottom resets every setting above. Controller buttons have their own reset, described below.

### Graphics profiles

| Profile | Framebuffer scale | Fixed foveation | Particle cap |
|---|---|---|---|
| Performance | 0.8 | 1.0 (strongest) | 50% |
| Balanced | 1.0 | 0.5 | 80% |
| Quality | 1.2 | 0.2 | 100% |

- **Framebuffer scale** multiplies the headset's recommended resolution.
- **Fixed foveation** lowers resolution towards the edges of the lenses, where the runtime supports it.
- **Particle cap** limits particle density while in VR. Your Graphics → Particle density is used if it is lower, and is restored when you leave.

Performance suits standalone headsets. Quality renders sharper for PC VR. Bloom and the other post-processing effects are desktop-only, and shadows are off in VR. Graphics → Frame rate limit applies to the desktop view only; the headset sets the frame rate in VR.

### Vibration

| Moment | Controllers | Intensity (× strength) | Length |
|---|---|---|---|
| Hard drop | both | 0.45 | 40 ms |
| Piece lock | both | 0.15 | 18 ms |
| Line clear (1–3 lines) | both | 0.55 | 90 ms |
| Four lines | both | 0.90 | 220 ms |
| Menu selection | right | 0.25 | 30 ms |

The menu selection pulse follows both the Controller vibration switch and Vibration strength.

### Comfort notes

- The camera never moves on its own in VR. Only your head moves the view. Screen shake, camera motion, motion blur and depth of field are not used in the headset.
- You never travel through the world. The view jumps only when VR starts, when you recentre, or when you change a playfield setting.
- Seated is the default. If the playfield feels too high, too low or too close, adjust Height and Distance rather than moving your chair.
- If the surroundings are distracting, raise **Dim the world**.

## Controller buttons

These defaults work on any controller that follows the WebXR `xr-standard` layout (Quest Touch, Valve Index, HTC Vive, Windows Mixed Reality). On the left controller, the two face buttons are called X and Y. On controllers without a thumbstick, the touchpad acts as a stick only while it is pressed in near an edge; a press in the middle counts as the stick press. Vive wands and Windows Mixed Reality controllers have no A/B/X/Y buttons, which is why Pause also sits on the left stick press.

| Action | Default controls |
|---|---|
| Move left / right | Left or right stick left / right |
| Soft drop | Left or right stick down |
| Hard drop | Right A, right stick up |
| Rotate clockwise | Right trigger |
| Rotate counter-clockwise | Left trigger |
| Rotate 180° | none (also needs Gameplay → 180° rotation) |
| Hold | Right grip, left grip |
| Pause | Left Y, left stick press (touchpad centre on Vive) |
| Practice: Undo | Left X |
| Confirm (menus) | Right trigger, right A |
| Back (menus) | Right B, left Y |

Gameplay actions and menu actions are separate, so one button can do both. For example, the right trigger rotates during play and confirms in menus.

### The headset menu

The menu panel floats in front of the playfield when you are in a menu, paused, or on the results screen:

- **Point and pull the trigger** on either controller to choose the row you point at. The controller you last pulled the trigger on controls the highlight.
- **Either stick up or down** moves the highlight. **Confirm** (right trigger or A) chooses it.
- **Back** (B or Y) resumes a paused game.
- On the **World** row, **stick left or right** changes the world.

Stick navigation and point-and-pull are fixed. Only Confirm and Back can be remapped.

### Remapping

Controllers only report buttons inside a VR session, so there is no "press a button" capture. Instead, each action has one or two rows. Each row cycles through **None** and every control name: trigger, grip, A/B or X/Y, stick press, and the four stick directions on each hand. Vive and Windows Mixed Reality controllers have no A/B/X/Y buttons.

- Click a row, or use its arrows or left and right, to step through the list. The second row appears once the first has a control.
- If you pick a control that another action in the same group (gameplay, or menus) already uses, the two swap: the other action gets the control your row had before. If your row was empty, the control is taken from the other action instead.
- Every step is applied immediately. Stepping past a control that is in use swaps it too, so check the other rows when you finish.
- Pause, Confirm and Back must keep at least one control. Setting their last one to None, or a choice that would take it away from them, is refused with a message.
- Practice: Reset Board has no VR binding.
- **Restore default buttons** puts back the table above.
