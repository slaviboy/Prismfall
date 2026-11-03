# Manual checks

Automated tests cover rules, input mapping, rendering start-up, audio analysis, persistence and emulated VR; see [FEATURES.md](FEATURES.md). This list covers what only a person playing on the real hardware can judge. Each item gives what "good" looks like.

**Target setup:**
- the owner's PC: RX 9070 XT, Ryzen 7 5800X3D;
- the 2560×1080 display at 144 Hz;
- headphones and speakers;
- the controllers listed below.

Play through `Play.cmd` (production build) unless an item says otherwise.

Useful tools:
- **Settings → Audio → Sound test** plays any world's music, with a "Preview intensity" slider, and every gameplay sound.
- **Settings → Graphics → Performance overlay** shows frame rate, frame time, GPU time and renderer details.
- **Settings → Data → Developer tools** turns on the audio analysis dashboard (F9).

## Game feel

- [ ] **DAS** (Gameplay → Delayed auto shift, default 167 ms): holding a direction starts sliding after the same short pause every time, with no stutter and no double step.
- [ ] **ARR** (default 33 ms; 0 = instant): sliding steps are perfectly even. At 0, the piece reaches the wall on the first DAS frame.
- [ ] **Soft drop** (default 20×; 41 = instant): fast but controllable. A tap moves at least one row. Releasing stops at once.
- [ ] **Hard drop:** the piece lands, locks, and the sound and impact effect play on the same frame as the key press. They never lag behind.
- [ ] **Lock delay** (500 ms, up to 15 move/rotate resets): sliding under an overhang or spinning a T at the floor feels possible but not endless. The piece dims as its lock timer runs out ("Lock timer glow").
- [ ] **Rotation and kicks:** SRS kicks feel familiar. T-spins and I-piece wall kicks behave as expected, and no rotation "teleports" unexpectedly.
- [ ] **Buffering:** rotate, hold or hard drop pressed during the gap between pieces applies the instant the next piece appears. Both "Buffer" toggles are on by default.
- [ ] **DAS charge carry-over:** holding a direction through a lock keeps the next piece sliding immediately.
- [ ] **Input latency:** the response to keys and controller buttons feels instant at 144 Hz. It stays unchanged during big clears, stage transitions and Voyage world changes.
- [ ] **Frame pacing:** with Frame rate limit on "Display refresh", motion is smooth at 144 Hz. Changing the limit never affects game speed.
- [ ] **Calibration:** Settings → Audio → Timing → tap-along calibration gives a stable offset when you tap to the beat, and applying it makes beat visuals land on the beat you hear. Bluetooth headphones need a larger offset. There is **no** input-latency calibration, only this audio-to-visual offset.
- [ ] **Pause and resume:** pausing is instant. The resume countdown (if enabled) is long enough to re-orient, and no input is lost or doubled across a pause.
- [ ] **Focus loss:** alt-tabbing away mid-game pauses it, and no key stays "stuck" on return.
- [ ] **Modes:**
  - Marathon speeds up every 10 lines.
  - Sprint 40 ends on the 40th line with an exact time.
  - Ultra ends at its time limit.
  - Zen never ends: topping out clears the board.
  - Practice options (gravity, lock, preview, hold, drill pieces, undo, reset) do what they say.

## Listening

Use headphones first, then speakers. Play each world for several minutes: in menus, quiet early play, then busy play with combos and quads.

- [ ] **Each world's music** has a recognisable identity matching its look:
  - Luminous Tide "Moonwater" (84 BPM)
  - Moving Sands "Caravan of Embers" (94)
  - Ancient Garden "Lanterns on Still Water" (82)
  - Frozen Kingdom "Glass Meridian" (76)
  - Deep Cosmos "Orbit of Glass" and "Leviathan of Stars" (84)
  - Alpine Horizon "Above the Treeline" (88)
  - The Abyss "Pressure and Light" (72)
  - Enchanted Wilderness "Where the Fireflies Gather" (90)
  - Ember Foundry "Anvil Pulse" (128)
  - Ember Core "Heart of the Mountain" (112)
  - Northern Lights "Curtains of the Sky" (80)
  - Future Nights "Afterglow District" (118)
  - Folded Sky "Paper Wind" (136)
- [ ] **Musical quality:** each track sounds like a coherent piece, not a demo loop. It is still pleasant after 20+ minutes and has no harsh, clicky or detuned notes. The music is synthesised live, so this is the main judgement only a listener can make.
- [ ] **Loops and sections:** the loop point is seamless. Section changes (intro, build, drop, break) are audible but never abrupt.
- [ ] **Adaptive layers** (Audio → Adaptive music):
  - calm play stays spacious;
  - active play adds rhythm;
  - combos and quads bring emphasis or a climax;
  - layers join on musical boundaries, not mid-phrase;
  - turning the setting off gives a steady arrangement.
- [ ] **Mix balance:** gameplay sounds stay audible over the music without dominating it. Nothing clips or pumps, even during a quad on a loud section. Master, Music, Sound effects, Ambience, Hard drop and landing, World effects and Menu sliders each change only their own part.
- [ ] **Material impacts:** the hard drop sounds like each world's block material:
  - pearl glass (Luminous Tide)
  - sandstone into sand (Moving Sands)
  - wood (Ancient Garden)
  - ice (Frozen Kingdom)
  - cosmic (Deep Cosmos)
  - mineral (Alpine Horizon)
  - water (The Abyss)
  - organic (Enchanted Wilderness)
  - metal (Ember Foundry)
  - obsidian (Ember Core)
  - aurora crystal (Northern Lights)
  - neon (Future Nights)
  - paper (Folded Sky)

  A full-height hard drop is heavier than a short one.
- [ ] **Impact hierarchy:** hard drop > land > lock > soft drop in weight. Landing and line-clear sounds are never confused.
- [ ] **Clears 1–4:** single, double, triple and quad clearly escalate. The quad has the world's own signature answer ("World quad answer" in the sound test). Spins, back-to-back and perfect clears are distinct.
- [ ] **Combo escalation:** combos 1–2, 3–5 and 6+ step up audibly. With "Musical clear accents" on, the accent phrase is in key and on the beat.
- [ ] **Repetition:** with "Sound variation" at its default, fast repeated moves and rotations do not sound machine-gun identical. At 0 they repeat exactly, as intended.
- [ ] **Ambience:** each world's bed fits it (waves, desert wind, garden, ice, cosmos, alpine, abyss, forest, foundry, volcano, aurora, city rain). It is audible in quiet passages and never masks the music. The Ambience slider controls it.
- [ ] **Spatial footsteps** (Audio → Spatial audio): on headphones, walking creatures (camels in Moving Sands, deer and spirits, the whales) are placed where they are seen. "Creature passing (spatial)" in the sound test moves left to right. With the setting off, sounds fall back to plain stereo.
- [ ] **Pause audio:** "Quieter and muffled" ducks smoothly, and "Stop" freezes the music, which resumes in place.
- [ ] **Transitions:** world changes in Voyage crossfade the music on a bar line without a gap or a tempo jolt.
- [ ] **Your own music:** a file added in the Music Room plays, gets a sensible BPM estimate, and drives the world's reactivity in free play.

## Visuals per world (2560×1080, 144 Hz)

For every world, check a fresh board and a **tall stack** (15+ rows) under the default High preset and under Ultra.

- [ ] **Readability:** all seven pieces are distinguishable at a glance in every block theme.
  - The ghost piece is visible but quiet.
  - Hold and next pieces are clear.
  - The HUD never overlaps the board at 21:9.
- [ ] **No over-glow or washed-out blocks:** blocks read as solid, saturated, crisp cubes. There are no bloom halos merging neighbouring blocks, and no pale pastel stacks, especially on tall stacks and right after quads. Block glow defaults to 60 %.
- [ ] **High contrast and symbols** (Accessibility): the colour-blind-safe palette and piece symbols work in every world.
- [ ] **Classic block style** (Graphics → Block style): traditional colours and glass blocks everywhere.
- [ ] **Line clears:** each world's clear effect (frost wave, petal shatter, sand spiral, supernova, bubble ascent and so on) is satisfying and finishes quickly. It never hides where the remaining blocks are.
- [ ] **Transitions:** each world's entrance (frost, petals, sand, stars, bubbles, aurora, embers, digital, paper fold, mist) is smooth and short. Gameplay continues during Voyage transitions.
- [ ] **Creatures and life:**

  | World | What to check |
  |---|---|
  | Moving Sands | Camels made of glowing sand walk naturally, as a lone camel, small groups and distant caravans, then fade into the haze |
  | The Abyss | Fish schools, jellyfish, rays, turtles and the whale |
  | Deep Cosmos | The star whale |
  | Frozen Kingdom | The ice spirits |
  | Enchanted Wilderness | Deer, forest spirit, butterflies and birds |
  | Northern Lights | Reindeer and light birds |
  | Alpine Horizon | Chamois, eagles and birds |
  | Ancient Garden | Koi and cranes |
  | Ember Core | Fire birds |
  | Future Nights | Drones |
  | Folded Sky | Paper cranes |
  | Luminous Tide, Ember Foundry | No creatures: the water and the hall carry these worlds |

  Silhouettes are recognisable, motion is not jittery, and nothing crosses in front of the playfield.
- [ ] **Music reactivity:** bass, treble and beats produce distinguishable, intentional responses, never random flashing. Quiet passages still look alive. Reactivity presets and the strength sliders change the response live.
- [ ] **Reduced motion and Reduce flashing:** camera motion and shake stop, transitions thin out, and no bright full-screen flashes remain.
- [ ] **Quality presets:** Low to Ultra changes detail without changing the art direction. Dynamic resolution and FSR 1 at lower render scales look acceptable on the 2560×1080 display.
- [ ] **WebGL 2** (Graphics → Graphics API → WebGL 2, then reload): every world still looks correct.

## Controllers

Test each controller over USB and, where possible, Bluetooth. Check Settings → Controller for the detected name and family, then play a full Marathon.

- [ ] **DualShock 4 (USB):** detected as "DualShock 4", with PlayStation glyphs (Cross, Circle, Square, Triangle). Every default binding works.
- [ ] **DualShock 4 (Bluetooth):** same as USB. If the browser reports a non-standard layout, the mapping wizard fixes it, and the mapping survives a reconnect.
- [ ] **DualSense (USB and Bluetooth):** detected as "DualSense", PlayStation glyphs, all buttons correct.
- [ ] **Xbox controller:** detected as "Xbox Controller", Xbox glyphs (A, B, X, Y, LB, RB, View, Menu).
- [ ] **Generic or other pad:** works with generic names. Non-standard layouts can be mapped with "Map buttons" and play correctly afterwards.
- [ ] **Button tester:** every press lights the right control in "Test buttons".
- [ ] **Sticks:** no drift at the default dead zone (22 %), with clean left, right and down, and no accidental soft drop while moving. Stick sensitivity and trigger threshold behave as described.
- [ ] **Rumble:** "Test rumble" vibrates. Hard drops, clears and danger rumble during play at a comfortable level, the Rumble strength slider scales it, and turning rumble off stops it.
- [ ] **Steam Input / DS4Windows duplicates:** when one physical pad shows up twice, "Ignore this controller" or "Use only this controller" stops double inputs.
- [ ] **Disconnect:** pulling the cable or switching the pad off mid-game pauses the game with a toast. Reconnecting resumes control without stuck buttons.
- [ ] **Menus by pad only:** every screen, including settings tabs (L1/R1) and the world select, can be used without the keyboard. "Swap confirm and back" works.

## VR on a real headset

VR has been tested only under emulation (IWER, emulated Quest 3). Nothing about real-headset comfort, performance or controller layouts has been verified. Follow the full checklist in [VR_TESTING.md](VR_TESTING.md). In short:

- [ ] Entering VR, both eyes render correctly and head tracking is stable.
- [ ] The board sits comfortably when seated.
- [ ] Every control works with the real controllers.
- [ ] The VR menus are usable with rays and sticks.
- [ ] The HUD is readable at its default distance and size.
- [ ] Music and spatial footsteps are correct.
- [ ] Exiting VR returns to the paused desktop game intact.
- [ ] Frame timing stays stable in every world under the Performance, Balanced and Quality VR graphics settings.

## Performance at the owner's display

Methods and measured results are in [PERFORMANCE.md](PERFORMANCE.md), including the perf matrix and the soak test. By hand:

- [ ] With the performance overlay on, every world holds 144 fps at 2560×1080 on the High preset, through tall stacks, quads, combos and transitions, with no periodic hitches.
- [ ] A long session (an hour or more, several worlds) shows no creeping frame time and no growing memory in the overlay, and the browser stays responsive afterwards.
- [ ] Entering a new world for the first time causes no visible stall during play. Voyage preloads the next world.
- [ ] Recovery from a GPU reset (driver update, sleep and wake) works: the game pauses, the renderer rebuilds, and play resumes.

## Saves

- [ ] Settings and progress survive closing and reopening `Play.cmd`.
- [ ] **Profile separation:**
  - the `Play.cmd` window (its own Chrome profile on port 4173) does **not** share saves with a normal Chrome window, `npm run dev` (5173) or the e2e build (4174);
  - this is expected, and Settings → Data says so.
- [ ] **Export / import:** a file exported in one place restores settings, progress, lifetime stats and high scores in another. Replays and added music files are not included.
- [ ] Importing a non-Prismfall file shows "That file is not a Prismfall save" and changes nothing.
- [ ] "Erase progress" and "Restore all settings" ask for confirmation and do only what they say.
