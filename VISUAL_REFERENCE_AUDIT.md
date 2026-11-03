# Visual reference audit

Benchmark: Tetris Effect: Connected, installed locally and owned by the project owner. The goal is to reach (and exceed) its presentation quality with **original** content: nothing here is copied, extracted or traced — no assets, music, models, shaders or stage designs. Controls and gameplay rules are out of scope; this audit is about the rendered experience.

## Sources

| Source | Notes |
|---|---|
| 16-minute screen recording, 2026-11-03 | The owner played while the screen was recorded at 2560×1080, 60 fps (`scripts\record-screen.cmd`-style ddagrab capture, GPU-encoded). Seven stages: an abyssal ocean stage, a desert, a dark forest, a dolphin ocean stage, a bright windmill stage, a night stage and a hot-air-balloon stage that goes from day to night. Includes four-line clears, back-to-backs and results screens. |
| Frames and filmstrips extracted from it | Overview sheets (one frame per 20 s), 16 full-resolution key frames, and 15 fps filmstrips around three line clears. |
| Brightness timeline | Mean luminance sampled 10× per second over the whole recording; spikes mark clears and flashes. |
| A short run driven by simulated keys | Menus and the first minute of the abyssal stage, captured frame by frame. |

All of it is stored only in `reference-capture\` (git-ignored, never committed or reused as assets).

Not covered yet: the Zone mechanic, a mid-run stage transition inside Journey mode, and VR.

## Findings

### 1. Stages reveal themselves over time

Every stage starts almost empty and builds up as lines are cleared and the music progresses. The abyssal stage stays nearly black for its first ~100 s (only small creature formations appear); its large creatures arrive later. The balloon stage starts in daylight and ends at night with lit balloons. The reveal is part of the experience — but it also hides a stage's full look until you have played into it. (Prismfall will add a way to skip straight to a world's full visual state for review.)

### 2. Value structure: either very dark or deliberately overexposed — never murky

Mean luminance per stage (0–255), from the timeline:

| Stage | Mean luminance |
|---|---|
| Abyssal ocean, forest, dolphins, night | 18–23 (near black) |
| Hot-air balloons (day → night) | 85–100 → 50 |
| Desert | 120 |
| Windmills | 210 (white, overexposed) |

Dark stages put small luminous elements on black. Bright stages blow the sky out to white with heavy bloom and keep the **board interior dark** (a deep blue or grey gradient backplate) so the stack still reads. No stage sits in a hazy, evenly lit middle grey.

### 3. The playfield is minimal and constant

- One thin line frames the well, coloured per stage (cyan, gold, pink, pale yellow). No walls, no box, no bevelled frame.
- The interior is black or a dark gradient; the environment barely shows through.
- The layout never moves: the well is centred and fills ~83% of the screen height; speed level and lines sit to its left, time, score and high score to its right, in a bold white sans with no panels; the next queue is small at the top right.
- The camera is straight-on, with only a hint of perspective on the blocks' side faces near the edges.

### 4. Blocks carry each stage's material identity

| Stage | Block look |
|---|---|
| Abyssal ocean | Translucent "jelly" cubes, saturated blue body, bright cyan fresnel rim |
| Dolphins | Glossy liquid-glass cubes with sharp specular highlights and bubbles drifting over them |
| Desert | Sculpted pillow blocks with deep embossed bevels, warm gold, like carved sandstone |
| Forest | Green blocks with diagonal stripes |
| Night | Glowing LED-dot cells (red, green, yellow, cyan) |
| Balloons at night | Neon glass cubes with bright emissive cores (cyan, orange, magenta) |
| Windmills | Orange cells with a flower or cog pattern |

Constant across all of them: a clear dark gap between every block (each cell reads as its own object), a white outline ghost of the whole piece, and piece colours chosen from the stage palette while staying distinguishable.

### 5. Line clears are a short, layered event

From the filmstrips (15 fps):

1. The instant the clear registers, the cleared rows turn **solid white-hot** (about 0.25–0.3 s).
2. A dense burst of fine particles sprays out of them, mostly downward and outward past the frame; on the night stage the rows become a sheet of embers.
3. The callout ("TETRIS", "BACK-TO-BACK") slides in from the left with motion blur and holds for about 2 s.
4. The white rows dissolve into dust, and the stack above drops.
5. Afterwards the remaining stack **recolours in a ripple** over about half a second (blue to magenta and cyan on the abyssal stage), so the board itself changes with the clear.

A hard drop leaves a **vertical beam of light** above the piece that fades in about 0.3 s.

### 6. Creatures and set pieces are large and frame the board

- Creatures are built from particles on recognisable forms: white luminous particle camels walking across the dunes, a glossy dolphin with particle shimmer along its body, schools of small fish formations.
- Set pieces are detailed 3D models at large scale: hot-air balloons with neon rim lines and sparkle-filled envelopes, windmills.
- They are placed left and right of the board and at the frame edges, close to the camera, rather than scattered in the distance.

### 7. Particles have a job

Each stage uses a few particle families with a clear role: ring-shaped bubbles (dolphins), gold glints and drifting sand (desert), embers (night), star fields (space, balloons at night), fine dust inside the well. Sizes vary with depth; near particles are big and soft.

### 8. Environments are rendered, not just decorated

The desert is real terrain: rolling dunes with a strong glitter-like sand sparkle and a bloom-white sky. The balloon stage has a lit landscape below and detailed balloons above. Atmosphere comes from light and value, not fog.

### 9. Motion

The recording runs at 60 fps; motion in the extracted sequences is even (no visible hitches). Board events are fast and snappy (flash, burst, drop within half a second), while the environment moves slowly and continuously. A per-frame pacing measurement of the reference was not done (the capture is limited to 60 fps and the display runs at 144 Hz).

## Implications for Prismfall (principles, not designs)

1. Give each world a decisive value key: near black, or bright with a dark board interior. Remove the murky mid-tone haze.
2. Replace the heavy 3D board frame with a single thin luminous line in the world's accent colour, over a black or dark-gradient interior.
3. Make block materials per world much more distinctive (glass, jelly, carved stone, emissive cores, patterned cells), always with a visible gap between cells. Draw piece colours from the world palette.
4. Rebuild line clears as a sequence: white-hot rows, then a particle burst, then dissolve and drop, then a stack recolour ripple; hard-drop light beams; sliding typographic callouts.
5. Scale creatures and set pieces up and compose them around the board, built from dense particles on solid recognisable forms.
6. Build a progressive reveal into each world, plus a **preview switch that shows a world at full intensity immediately**.
7. Keep the HUD typographic and fixed: no panels, bold white type beside the board.
