# Visual gap analysis

How the current build of Prismfall looks next to the reference game. The findings for the reference are in [VISUAL_REFERENCE_AUDIT.md](VISUAL_REFERENCE_AUDIT.md). Everything here was judged from recordings of the running game, not from reading code.

## How the build was captured

`node scripts/record-gameplay.ts` plays one continuous Zen run in headless Chrome on the real GPU (RX 9070 XT, WebGPU, 2560×1080, default graphics settings). It records the Chrome screencast at about 85 frames per second and travels through all 13 worlds with in-game transitions, the same way Voyage changes worlds. In each world:

1. **Transition in** from the previous world (the first world starts from the menu).
2. **About 18 seconds of normal play.** The built-in AI places a piece every 0.7 s, so pieces visibly fall first.
3. **Scripted clears:** a single, a double, a triple, a QUAD, a back-to-back QUAD and a combo triple, 3.5 s apart.

The output is one MP4 per world, stills at 120, 450 and 1100 ms after each QUAD, and a frame-pacing log (rAF intervals during normal play). Recordings stay in `reference-capture/ours/` (git-ignored). Contact sheets of our own frames are committed in [docs/visual-audit/](docs/visual-audit/).

Side-by-side images with reference frames are in `reference-capture/compare/` and are **local only**, since they contain frames of the reference game.

Brightness was measured with ffmpeg `signalstats` on frames with the HUD visible. The values are video luma (16 = black, 235 = white). P10 and P90 are the 10th and 90th percentiles of the frame.

Not assessed in this pass:
- **Music reactivity.** The recordings have no sound, and judging it needs a dedicated beat-aligned capture. This is planned for the showcase world.
- **VR.**
- **4K.**

## Summary

The engine side is in good shape. Play runs at a steady 144 fps, and every world already has its own palette, particles, creatures and clear effect. The weaknesses are in art direction:

1. Every world sits in a hazy mid-grey.
2. The board looks like a generic box.
3. All worlds share the same rainbow block colours.
4. Line clears are short, pastel and generic.
5. Creatures and props are small, evenly scattered and far away.
6. Transitions are muddled and freeze for up to 2.6 s.

None of these can be fixed with another effect on top. Each needs a decision about the look, which is what [ART_DIRECTION.md](ART_DIRECTION.md) sets out.

## Measurements

### Brightness and tonal range

| | P10 | Mean | P90 | Reads as |
|---|---|---|---|---|
| **Reference:** abyssal ocean | 16 | 20 | 16 | 90% of the frame is pure black |
| **Reference:** forest | 16 | 27 | 17 | Black, light only on the subject |
| **Reference:** night (balloons) | 16 | 28 | 35 | Black, bright accents |
| **Reference:** dolphins | 16 | 29 | 61 | Black, one bright creature |
| **Reference:** desert | 20 | 120 | 235 | Full range: white sky, dark dunes and board |
| **Reference:** balloons by day | 19 | 97 | 235 | Full range |
| **Reference:** windmills | 134 | 213 | 235 | Overexposed white |
| Future Nights | 16 | 28 | 58 | Dark key, the closest to the reference |
| Celestial Drift | 16 | 28 | 53 | Dark key |
| Ember Foundry | 16 | 29 | 60 | Dark key |
| Luminous Tide | 16 | 41 | 86 | Dark, but a lit haze over the floor |
| Ember Core | 16 | 46 | 94 | Orange mid-tone haze |
| Enchanted Wilderness | 17 | 49 | 72 | Green mid-tone haze |
| The Abyss | 20 | 51 | 65 | Uniform teal mid-tone, no black |
| Northern Lights | 25 | 59 | 96 | Uniform teal mid-tone, no black |
| Moving Sands | 28 | 59 | 100 | Orange haze, no black and no white |
| Ancient Garden | 26 | 63 | 129 | Purple haze |
| Alpine Horizon | 26 | 80 | 140 | Bright but flat, no white |
| Frozen Kingdom | 33 | 97 | 142 | Pale blue, flat |
| Folded Sky | 42 | 136 | 176 | Beige, washed out, no black and no white |

None of our worlds reaches white. Ten of thirteen sit in the murky middle: a mean of 40–140, with P90 far below white. The reference either keeps about 90% of the frame black or uses the full range from black to clipped white.

### Frame pacing

These numbers cover normal play only, from rAF intervals in headless Chrome at 2560×1080:

| | Result |
|---|---|
| Typical frame | 6.9–7.0 ms (144 fps) in every world |
| p99 | 7.2–14.0 ms (an occasional single missed vsync) |
| Hitches | **One freeze of 0.7–2.6 s in 12 of 13 worlds, right after the mid-run world change.** Frozen Kingdom 2.6 s, The Abyss 1.8 s, Ancient Garden 1.8 s (two back to back), Ember Foundry 1.5 s (two back to back), Ember Core 1.4 s, Enchanted Wilderness 1.2 s, Moving Sands 1.1 s, Alpine Horizon 1.1 s, Northern Lights 1.0 s, Celestial Drift 0.8 s, Folded Sky 0.7 s, Future Nights 0.7 s. The video confirms each one as a frozen picture (`freezedetect`). The first world loads under the loading screen, so it shows no freeze. |

## Prioritized problems

**P0** problems define the look; they are fixed in the showcase world first. **P1** problems are needed for a professional result. **P2** problems are polish.

### P0-1. Murky mid-tone haze in most worlds

- **What is wrong.** Ten worlds are evenly lit in a 50–140 brightness band, with fog and ambient light filling every shadow. No world has a clipped highlight, and most have no real black. Examples: The Abyss (uniform teal), Northern Lights (teal), Moving Sands (orange-brown), Folded Sky (beige).
- **Why it looks unprofessional.** With no value hierarchy, nothing leads the eye. The board, the creatures and the scenery all compete at the same brightness, and the scene looks like an untextured preview render. Haze is the most common sign of an unfinished real-time scene.
- **Intended result.** Each world commits to one value key:
  - **Dark key:** at least about 80% of the frame near black, with light reserved for a few luminous subjects.
  - **High key:** bright, with highlights clipping to white, and the board interior kept dark so the stack still reads.
- **Required changes.**
  - A per-world grade in the post pipeline: black point, contrast curve, exposure and highlight roll-off, set in the manifest.
  - Fog and ambient light are off or minimal by default.
  - Light comes from emissive subjects and one key light.
  - Bright worlds get a dark board backplate.
- **How to verify.** Re-record with `record-gameplay.ts` and measure:
  - **Dark key:** P10 = 16 and P90 ≤ 45 outside the board.
  - **High key:** P90 ≥ 230, with the board interior mean ≤ 35.

### P0-2. The board reads as a generic box

- **What is wrong.**
  - **Frame:** thick coloured 3D rails ([world-northern-lights.jpg](docs/visual-audit/world-northern-lights.jpg)).
  - **Interior:** a visible grid, and it is translucent, so creatures and scenery show through it. Deer and camels appear inside the well.
  - **Camera:** looks slightly down, so the lower rails splay in perspective.
  - **Ghost:** a dark translucent copy of the piece instead of an outline.
- **Why it looks unprofessional.** The board is the one thing the player looks at constantly. A heavy frame, gridlines and background noise inside the well add clutter exactly where clarity matters, and they make it look like a template puzzle UI.
- **Intended result.**
  - **Frame:** one thin luminous line in the world's accent colour.
  - **Interior:** black or a dark gradient, effectively opaque to the background. No grid by default; the setting remains.
  - **Camera:** straight on, centred, about 83% of the screen height, constant for the whole run.
  - **Ghost:** a crisp white outline of the whole piece.
- **Required changes.**
  - A new frame component: a thin emissive line, with no metal rails.
  - The backplate becomes opaque, with a per-world dark gradient.
  - The grid defaults to off.
  - The camera preset changes to zero tilt.
  - An outline ghost material: the piece silhouette, not per-cell boxes.
- **How to verify.** Look at stills from every world. In the 450 ms stills, no environment object may be visible inside the well. Check the ghost in a tall-stack shot.

### P0-3. Line clears are short, pastel and the same everywhere

- **What is wrong.** From the 10 fps strip ([clear-sequence-abyss.jpg](docs/visual-audit/clear-sequence-abyss.jpg)):
  - The cleared rows turn a soft pastel glow, not white, for about 0.2 s.
  - The stack has dropped by about 0.3 s.
  - Then only ambient particles drift.
  - Every world adds the same accent-coloured ring around the board.
  - A "wave" column of light starts as a bright bar outside the left rail and crawls faintly across ([clear-wave-streak.jpg](docs/visual-audit/clear-wave-streak.jpg)). It reads as a rendering glitch. It comes from the `wave` recipe in [lineClearEffects.ts](src/rendering/fx/lineClearEffects.ts).
  - The callout ("Quad +800") is small and static.
  - The remaining stack does not react.
- **Why it looks unprofessional.**
  - The biggest moment in the game is over before it registers.
  - Pastel bloom looks washed out.
  - A shared ring makes every world feel the same.
  - The stray bar looks like a bug.
- **Intended result.** A designed sequence of about 1 s, the same structure in every world with world-specific materials and particles:
  1. The cells go crisp **white-hot** within a frame and hold for about 250 ms.
  2. A burst of world-shaped particles (dust, sparks, bubbles, petals) comes out of the cells.
  3. The rows dissolve, and the stack above drops with an ease.
  4. The remaining stack **recolours in a ripple** outward from the cleared rows.
  5. A large typographic callout slides in and holds about 1.5 s.

  Size scales with the clear (single to QUAD, B2B, perfect clear). There is no generic ring, except perhaps a distinct one reserved for perfect clears.
- **Required changes.**
  - Restructure the clear into timed phases in the FeedbackDirector: flash, burst, dissolve, drop, ripple.
  - Add a stack-recolour uniform to the block material.
  - Remove the wave column and the default ring.
  - Rebuild the callout component: large type, slide-in, motion blur.
  - Particle recipes per world.
- **How to verify.** Take a 15 fps filmstrip of the QUAD from the recorder and check each phase's timing against the list above. The flash frame's cleared cells must measure near white (luma ≥ 220), not pastel.

### P0-4. Blocks look the same in every world

- **What is wrong.**
  - All 13 worlds use the same seven-colour rainbow (red, orange, yellow, green, cyan, blue, purple) on similar glossy cubes. The per-world textures are barely readable at play size.
  - Ancient Garden's blocks are dark and desaturated and nearly disappear into the board ([world-ancient-garden.jpg](docs/visual-audit/world-ancient-garden.jpg)).
  - The gap between cells is narrow, so blocks merge into slabs.
- **Why it looks unprofessional.** The blocks are on screen 100% of the time. If they don't change, the world doesn't feel like a different place, and the generic rainbow is the most "default puzzle game" signal there is.
- **Intended result.**
  - **Identity:** each world has a block material (for example glass with a light core, carved stone, frosted ice, an emissive pattern) and a palette drawn from the world.
  - **Readability:** pieces stay distinguishable by hue and brightness, and the classic colours remain an accessibility option.
  - **Gap:** a clear dark gap around every cell.
  - **Taste:** solid, saturated, crisp, never washed out ([CLAUDE.md](CLAUDE.md) visual taste).
- **Required changes.**
  - A layered BlockMaterial in TSL: body, edge bevel, gap, inner core or pattern, and emissive amount.
  - A per-world palette in the manifest, with a distinguishability check in the content tests (minimum colour distance between piece types).
- **How to verify.**
  - A tall-stack screenshot per world.
  - The piece colour-distance test passes.
  - A side-by-side of two worlds shows clearly different blocks.

### P1-1. Environments are evenly scattered props instead of a composition

- **What is wrong.**
  - Trees, crystals, jellyfish, spikes and cherry trees are spread evenly over the whole view like wallpaper (The Abyss, Northern Lights, Ancient Garden, Folded Sky).
  - The models are simple low-poly shapes with flat lighting.
  - There is no foreground framing, no hero element, and nothing near the camera.
  - The aurora in Northern Lights is a uniform band of vertical stripes across the full width.
- **Why it looks unprofessional.** Uniform scatter looks procedural and cheap. Without layered depth (foreground, midground, background), the scene is a flat backdrop.
- **Intended result.**
  - **Foreground:** framing elements left and right, close to the camera.
  - **Midground:** one hero set piece or creature.
  - **Background:** a simple silhouette and sky.
  - Detail is concentrated where the eye goes. The aurora is a set of luminous, moving ribbons with depth.
  - Celestial Drift's large ringed planet near the board is the closest we have to this ([world-celestial-drift.jpg](docs/visual-audit/world-celestial-drift.jpg)).
- **Required changes.**
  - Per-world composition with fewer scattered props.
  - Hero models from Blender.
  - Foreground layers.
  - A real aurora component.
- **How to verify.** Stills at 2560×1080 and 1920×1080. The eye should land on the board, then the hero. Squint test: three clear value layers.

### P1-2. Creatures are too small and too far away

- **What is wrong.** The reindeer (Northern Lights), deer (Alpine Horizon, Enchanted Wilderness), camels (Moving Sands) and jellyfish (The Abyss) each cover less than about 5% of the screen height. They sit in the far midground, sometimes behind the HUD or inside the translucent well.
- **Why it looks unprofessional.** The creatures are a signature feature, but at this size they read as noise, and their particle construction can't be seen.
- **Intended result.** The hero creatures are large: 25–60% of the screen height, passing beside the board, close to the camera, built from dense particles on a solid, recognisable form.
- **Required changes.**
  - Creature scale and paths per world.
  - Particle density.
  - Silhouette lighting so the form reads against the dark key.
- **How to verify.** Stills: measure each hero creature's screen height.

### P1-3. Freeze of up to 2.6 s on every mid-run world change

- **What is wrong.** See the measurements: 12 of 13 world changes freeze the picture for 0.7–2.6 s, most likely from compiling the new world's materials on its first frame.
- **Why it looks unprofessional.** A freeze in the middle of play is the most noticeable flaw a player can feel, and it lands at the moment that should feel magical.
- **Intended result.** No frame over 50 ms during a transition.
- **Required changes.**
  - Compile the incoming world's materials before it becomes visible (`compileAsync` on the prepared scene, plus a warm-up render), and confirm whether that is where the time goes.
  - Make sure block-design changes don't trigger first-use pipelines.
  - Extend the recorder's pacing window to cover the transition.
- **How to verify.** In the `record-gameplay.ts` pacing log, max frame < 50 ms in every world, including the transition. `freezedetect` finds nothing over 0.2 s.

### P1-4. Transitions are a muddled double exposure

- **What is wrong.** From Ember Core to Northern Lights ([transition-ember-core-to-northern-lights.jpg](docs/visual-audit/transition-ember-core-to-northern-lights.jpg)):
  - The new green sky appears first over the old lava ground.
  - Then comes the freeze.
  - A clump of green particles enters from the top-left.
  - For about 2 s, red lava spikes stand on teal snow.
  - The board frame switches colour instantly.
- **Why it looks unprofessional.** Two half-worlds blending look like a loading bug, not a journey.
- **Intended result.** A designed passage on a downbeat. The old world falls away to dark, or the new world sweeps in as a coherent front, and the new world builds up from dark (its reveal). The frame colour eases with it.
- **Required changes.** Transition phases (out, dark beat, reveal), driven by the world's reveal level rather than a scene crossfade.
- **How to verify.** A 3 fps filmstrip of each transition: no frame shows parts of both worlds at full strength.

### P1-5. The HUD is tiny and has stray labels

- **What is wrong.**
  - The labels ("Score", "Level", "Lines") are about 10 px at 1080p, and the numbers are small.
  - "Combo ×n" and "Back-to-back ×n" copies float beside the next queue, apart from the main callout.
- **Why it looks unprofessional.** Weak type hierarchy looks unfinished, and stray floating labels look like debugging output.
- **Intended result.**
  - Bold, large, fixed typography beside the board with a clear hierarchy (label smaller, value large).
  - One callout channel.
- **Required changes.** HUD layout and type scale, and removal of the secondary labels.
- **How to verify.** Screenshots at 1080p, 1440p and 4K. The values are legible at a glance from about 1 m.

### P1-6. Hard drops have no light trail

- **What is wrong.** A hard drop makes a small spark puff. Nothing connects where the piece was to where it lands.
- **Why it looks unprofessional.** The most frequent action feels weightless.
- **Intended result.** A vertical light trail from the piece's start to its landing position, in the world's colour, fading over about 300 ms, plus a crisp landing accent.
- **Required changes.** A trail effect in the FeedbackDirector, using the hard-drop event's distance and cells.
- **How to verify.** A filmstrip of the hard drops during normal play.

### P2-1. Hold and next pieces sit on busy backgrounds

- **What is wrong.** The 3D preview pieces are lit by the world and sit over scenery (cherry trees, city windows), which reduces legibility in bright worlds.
- **Intended result.** Previews on the dark key, or with a consistent emissive edge, so they read the same in every world.
- **How to verify.** Look at the preview area in stills from Folded Sky and Alpine Horizon.

### P2-2. Ambient particles are uniform specks

- **What is wrong.** Most worlds' ambient particles are similar small specks at similar sizes. Exceptions with good character: the abyss bubbles and the Ember Core embers.
- **Intended result.** Each world has two or three particle families with a clear job, sizes that vary with depth, and large soft particles near the camera.
- **How to verify.** Stills and short clips per world.

### P2-3. Visual artefacts seen in passing

- **Luminous Tide:** the water shows large white smeared highlight blobs on the right side ([world-luminous-tide.jpg](docs/visual-audit/world-luminous-tide.jpg)), and a glowing ring on the floor that doesn't relate to anything.
- **Ember Foundry:** red diagonal lines cross behind the board and compete with the stack.

## World by world

| World | Verdict |
|---|---|
| Luminous Tide | Dark sky and moon work. The lit floor ring, smeared water highlights and thin pillars feel disconnected. |
| Frozen Kingdom | Pale, flat blue. No black, no highlight. Small evenly scattered crystals and trees. |
| Moving Sands | Orange haze over everything. The camels are too small. The reference desert's full range (white sky, dark dunes) is missing. |
| Ancient Garden | Purple haze. Blob cherry trees. Dark, desaturated blocks that are hard to read. |
| Celestial Drift | The best composition: the large planet near the board and a dark key. The planet surface and rings are flat, and the particle whale is small. |
| Alpine Horizon | Bright but flat, like a mobile-game landscape. No highlight clipping, small deer. |
| The Abyss | Uniform teal with no black, wallpaper jellyfish. The bubble particles are good. |
| Enchanted Wilderness | Big tree silhouettes and god rays give some depth. Green haze, small deer. |
| Ember Foundry | A strong dark key. The machinery hardly reads, and the diagonal laser lines are busy. |
| Ember Core | Lava-crack floor texture on a flat plane, orange haze. The embers are good. |
| Northern Lights | The aurora is a flat striped band, the ground is uniform teal, the reindeer are tiny. |
| Future Nights | The best value structure (dark with neon). The city reads as a flat grid of windows. |
| Folded Sky | Washed-out beige with no contrast. The origami birds are a nice idea but scattered evenly. |

## What already works

- **Smoothness during play:** a steady 144 fps with p99 ≤ 14 ms in every world.
- **Structure:** every world has its own palette, clear particles and creature system, so the structure for distinct worlds exists. It needs art direction, not new plumbing.
- **Dark keys:** Future Nights, Celestial Drift and Ember Foundry show the dark key is achievable in our renderer.
- **Tooling:** the recorder makes the implement → record → compare loop repeatable. Use `--stages <id>` to iterate on one world.

## Next steps

1. Write [ART_DIRECTION.md](ART_DIRECTION.md): the value keys, the board, block materials, the clear sequence, composition, creatures, particles, transitions and the HUD, as rules every world follows.
2. Add the world preview switch: show a world at full intensity immediately, skipping the reveal.
3. Rebuild one showcase world to that standard, fixing P0-1 to P0-4 there first, plus the shared board, clear, HUD and drop-trail work. Record before and after with `record-gameplay.ts`.
4. Stop for the owner's approval before propagating to the other worlds.
