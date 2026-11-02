# Reference Notes

This document covers brief §2, the reference-game investigation.

## 0. Method and limitations

| Item | Status |
|---|---|
| Reference game location (per user) | `F:\SteamLibrary\steamapps\common\Tetris Effect Connected` |
| Launched / played / navigated | **No.** This development session has no desktop-control or screen-capture tools, so the game could not be operated. |
| Game files read or extracted | **No.** Nothing was opened, copied or extracted from the installation. The brief forbids extracting music and SFX, and Prismfall is independently designed. |
| Screenshots / clips captured | **None.** No reference screenshots exist in this repository. |

Every row in the checklists below that mentions the reference game is marked **Not observed**.

The **Prismfall design** column records the decision this project made and where it came from:

- **Genre convention** — widely documented rules shared by modern guideline-style tetromino games (SRS, 7-bag, lock delay, etc.).
- **Brief** — a requirement from `prompt.md`.
- **Original** — an independent design choice.

Prismfall deliberately does **not** recreate any specific commercial game. It has its own title, stages, music, UI, art and naming: the campaign is "Voyage" and the four-line clear is called "QUAD". Only the genre's gameplay rules are shared, because they are the gameplay the brief asks for.

---

## A. Gameplay

| Topic | Reference | Prismfall design (source) |
|---|---|---|
| Board dimensions | Not observed | 10 columns × 20 visible rows, plus 20 hidden buffer rows (configurable, minimum 4) (genre convention) |
| Piece spawning | Not observed | **Columns (0-indexed):** J/L/S/T/Z spawn in a 3×3 box with its left edge at column 3; I spans columns 3–6; O occupies columns 4–5.<br>**Rows:** pieces appear in rows 21–22, counted from the bottom, then drop one row at once if that space is free (genre convention). |
| Movement | Not observed | 1-cell taps, then DAS (default 167 ms) and ARR (default 33 ms; 0 = instant). The most recently pressed direction wins. Optional DAS-cut delay (genre convention + brief §4) |
| Rotation | Not observed | SRS: four states with the standard JLSTZ and I kick tables; O never kicks. An optional 180° rotation uses an SRS+-style table and is off by default (genre convention) |
| Gravity | Not observed | Guideline curve: seconds per row = (0.8 − (level − 1) × 0.007)^(level − 1). It is precomputed as integer fixed-point values, so results are deterministic. Gravity is capped at 20G (genre convention) |
| Locking | Not observed | **Delay:** 500 ms lock delay, with up to 15 move/rotate resets.<br>**Resets:** the counter resets when the piece reaches a new lowest row; the timer only runs while the piece is grounded.<br>**Variants:** step-reset and infinite (genre convention, configurable) |
| Soft drop | Not observed | Gravity × soft-drop factor (×5 to ×40, or instant); 1 point per row (genre convention) |
| Hard drop | Not observed | Instant drop and lock; 2 points per row (genre convention) |
| Hold | Not observed | Once per piece. The held piece returns to its spawn orientation. Holding with an empty slot takes the next piece. Initial hold (pressed during entry delay) is buffered (genre convention) |
| Next previews | Not observed | The engine keeps ≥ 6 pieces queued; 0–6 are shown, set by the user (brief §9) |
| Ghost piece | Not observed | On by default with adjustable opacity; drawn in a distinct translucent outline style (genre convention + brief) |
| Line clears | Not observed | Any set of full rows clears and the rows above collapse. The animation is purely visual: the logic board updates immediately, or after the mode's line-clear delay (brief §4) |
| Scoring | Not observed | **Line clears:** single 100, double 300, triple 500, QUAD 800.<br>**T-spins:** mini 100/200/400; full 400/800/1200/1600.<br>**Bonuses:** back-to-back ×1.5; combo 50 × n × level; perfect-clear bonus.<br>All values are a configurable table (genre convention) |
| Combos | Not observed | The counter goes up on each consecutive clearing lock and resets on a lock without a clear (genre convention) |
| Level progression | Not observed | Fixed goal of 10 lines per level, configurable per mode (genre convention) |
| Game over | Not observed | **Block-out:** the spawn position is blocked.<br>**Lock-out:** a piece locks entirely above the visible field.<br>**Zen:** a top-out softly clears the board instead (genre convention + original) |
| Pause / resume | Not observed | Pausing freezes simulation time. Keys held during the pause are ignored until released; an optional 3-2-1 countdown plays on resume (original) |
| Stage transitions | Not observed | Voyage legs switch environment and music at a musical bar boundary while play continues (original) |

## B. User interface

| Topic | Reference | Prismfall design |
|---|---|---|
| Title screen | Not observed | Logo over a live 3D attract environment; "Press Enter / Click", which also unlocks audio (original) |
| Main menu | Not observed | Play, Voyage, High Scores, Music Room, Settings, Credits (original) |
| Game HUD | Not observed | 3D hold and next pods sit beside the board. A DOM text overlay shows score, level, lines, time, combo and B2B. Callouts appear near the board (original) |
| Score / next / hold display | Not observed | See above; HUD customizable (scale, opacity, element visibility, next count, mirroring) |
| Level indicators | Not observed | Level number, a lines-to-next-level ring, and a level-up callout plus environment shift (original) |
| Pause menu | Not observed | Resume, Restart, Settings, Quit to menu (original) |
| Results screen | Not observed | Score or time, detailed stats, rank in the high-score table, replay, retry (original) |
| Stage selection | Not observed | Built automatically from the stage manifests: artwork, live environment preview, music preview, lock state, completion info (brief §22G) |
| Settings organization | Not observed | Tabs: Gameplay, Controls, Controller, Graphics, Audio, Camera, Interface, Accessibility, Data, plus a hidden Developer tab (brief §11) |
| Controller configuration | Not observed | Pad list, per-pad profile, remapping, dead zones, thresholds, rumble, live button test (brief §11F) |

## C. Settings

The brief asks for a feature-parity checklist between the reference's visible settings and this project. **No reference setting was observed**, so no parity is claimed.

The table below lists every setting category from the brief, with Prismfall's implementation. The live status of each item is tracked in FEATURES.md.

| Category | Reference | Prismfall |
|---|---|---|
| Graphics quality | Not observed | Low / Medium / High / Ultra / Custom presets, plus "Recommended" |
| Resolution / display | Not observed | Render scale (0.5–2.0), FSR1 upscaling, dynamic resolution. Display resolution and render resolution are shown separately. The browser can't change the monitor's resolution, and the settings screen explains this. |
| Fullscreen | Not observed | Fullscreen API toggle |
| Sound / music / SFX volume | Not observed | Master, music, SFX, ambience, mute, audio enable |
| Camera / zoom | Not observed | Zoom, zoom sensitivity, distance, FOV, shake, movement intensity |
| Keyboard controls | Not observed | Full remapping: capture, conflict handling, defaults |
| Controller settings | Not observed | Profiles, remapping, dead zones, sensitivity, rumble, test page |
| Gameplay preferences | Not observed | Next count, hold, ghost, grid, DAS/ARR/soft-drop factor/DAS-cut delay, 180°, buffering |
| HUD visibility | Not observed | Per-element toggles, scale, opacity |
| Accessibility | Not observed | Reduced motion, flash reduction, high contrast, piece glyphs, background dimming, visual audio cues |

## D. Visual feedback

| Event | Reference | Prismfall design (original) |
|---|---|---|
| Spawn | Not observed | Quick materialize (≤ 80 ms) with a soft glint at the spawn position |
| Move | Not observed | Instant; faint afterimage trail |
| Rotate | Not observed | Instant logical rotation; ≤ 60 ms cosmetic settle (disabled by reduced motion) |
| Landing | Not observed | Impact flash, dust particles, landing SFX, optional rumble |
| Line clear | Not observed | Stage-specific particle effect. Intensity rises with lines, spin, B2B, combo and perfect clear |
| Multiple lines | Not observed | Each extra line adds stronger effects and environment response; a QUAD triggers a shockwave |
| Combo | Not observed | Escalating callout, rising-pitch SFX, extra particles |
| Major scoring event | Not observed | Bloom surge, shockwave, camera push, score emphasis |
| Level transition | Not observed | Music section and intensity step, lighting and frame colour shift, LEVEL callout |
| Music intensity | Not observed | Audio Features API drives reactive bindings defined per stage (brief §24) |
| Pause / resume | Not observed | Music ducks under a low-pass filter; the world slows and dims; optional countdown on resume |
| Game over | Not observed | The board fades out under a dissolve; the music resolves; then the results screen |

## E. Reference deliverables

- **Reference screenshots:** none (see §0).
- **Reference checklist:** this document. The implementation checklist is FEATURES.md.

## F. Experience qualities targeted (from the brief, expressed generically)

1. **Immersive 3D worlds** that feel like distinct places, not recoloured backgrounds.
2. **Music as the driving force:** curated beat grids plus real spectral analysis, never a simple volume pulse.
3. **Satisfying feedback** that scales with achievement, without ever obscuring the playfield.
4. **Precise, responsive controls:** 1 ms deterministic simulation and timestamped inputs.
5. **Rich configuration and comfort options.**
