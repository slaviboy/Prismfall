# Visual reference audit

Benchmark: Tetris Effect: Connected (owned by the project owner, installed locally). The aim is to match its presentation quality with original content — no assets, music, models, shaders or stage designs are copied or extracted.

## Status and sources

| Source | Status |
|---|---|
| Running the installed game myself | **Not possible in this environment.** This session has no desktop-control or live screen tools, and the game needs real-time play, which tool round trips (seconds each) cannot provide. Earlier milestones never inspected the game either; REFERENCE_NOTES.md marks every item "Not observed". |
| Screen recordings of the game | **Pending.** `scripts\record-screen.cmd <name> <seconds>` records the primary display (fullscreen games included) into `reference-capture\` (git-ignored). Verified working at 2560×1080, ~60 fps. Recordings are needed for everything about motion. |
| Screenshots supplied by the owner (2026-11-03) | **Analysed below.** Three gameplay frames: a deep-blue ocean stage with a particle whale (`ref-01`), a saturated multi-colour stage during the Zone mechanic (`ref-02`), a space stage above a planet horizon with particle birds (`ref-03`). Stored locally in `reference-capture\user-screens\` (not committed). |

Everything below comes from those three still frames. Statements about timing, animation, particle motion and music response are deliberately absent until recordings exist.

## Observations from the screenshots

### Composition and camera

- The playfield is dead centre and occupies roughly the middle third of the frame height-wise (about 45–55% of the image height). The camera looks straight at it: no visible tilt, no perspective distortion of the well.
- The board is framed by large environmental shapes: a particle whale arcing over the top-left (`ref-01`), symmetric creature formations left and right (`ref-03`), a nebula mass on one side (`ref-02`). The environment is composed *around* the board like a vignette, not scattered.
- A thin circular arc (the score/level meter ring) sits around the board, tying it into the scene geometrically.
- In `ref-03` the horizon line meets the bottom of the board; the bright sun sits just right of the board at that line. Strong, simple horizontal structure.

### Contrast and value structure

- The dominant value is near-black. Roughly 50–70% of each frame is very dark negative space; luminous elements are placed against it. This is the single biggest reason everything glows without washing out.
- Brightness is concentrated in small elements (particles, creature highlights, board rim, HUD text) with large dark gaps between them. Bloom is strong but only bright things bloom.
- The board interior is the darkest, calmest region in every frame, so the pieces always read.

### Colour

- Each stage is close to monochrome (`ref-01` and `ref-03`: cyan/blue only). Accent colours are rare and small (a magenta T piece, a white sun).
- **Piece colours are tinted to the stage palette** rather than the standard seven guideline colours: in `ref-01` blues, violets and magentas; in `ref-03` almost everything is icy blue; in `ref-02` the stack runs as a vertical gradient from violet at the top to cyan at the bottom.
- Even the saturated `ref-02` keeps the board interior dark navy and limits the rainbow to the edges of the frame.

### Playfield and blocks

- The well is a thin luminous outline (`ref-01`, `ref-03`), or a bright glowing rim during Zone (`ref-02`). There is no heavy 3D box or opaque wall; the environment shows faintly through a dark, slightly transparent back panel.
- Blocks are rounded "chiclet" cubes: generous corner radius, a dark or translucent body, a bright edge or inner square highlight. They read as glass or light, not as painted solid cubes.
- `ref-03` blocks look frosted: soft top-lit gradient, slight translucency, no texture noise.
- The active piece is shown as a bright outline / hollow shape in `ref-02`; the ghost piece is a faint outline (`ref-01`).
- The settled stack carries fine sparkle particles drifting over it (`ref-01`), so even the stack feels alive without changing its shape.
- Next and hold previews are tiny and understated (top corners of the well).

### Particles and creatures

- Particles come in families with clear roles:
  - tiny elongated streaks (krill or fish) organised into one coherent vortex around the board (`ref-01`);
  - large soft glow orbs with bokeh-like falloff, few in number, giving depth (`ref-01`, `ref-02`);
  - distant star fields: small, dim, many (`ref-03`).
- Creatures are made of dense particle point clouds with brighter structural lines (spine, fins, wing edges). Silhouettes are large, recognisable and readable at a glance. They are big relative to the board (the whale spans half the frame).
- Particle size varies strongly with depth: near particles are large and soft, far ones are pin-points. This is the main depth cue in `ref-01`.

### HUD and typography

- A clean white geometric sans; small uppercase labels with larger figures beneath. Text sits directly beside the board, left and right, aligned to the board edges.
- Event callouts (`TETRIS`, `BACK to BACK`) appear beside the board in heavier type, stacked, then fade.
- No panels or boxes behind HUD text; legibility comes from the dark scene behind it.

## Needs recordings (not yet observed)

Each of these needs a short clip (20–60 s) of real play. Ideally one or two different stages for each:

1. Ordinary play with a few pieces falling: camera, ambient motion, how calm the scene is.
2. Pieces landing and locking: impact flash, sound-synced effects.
3. A single, a double/triple and a four-line clear: clear animation timing and scale.
4. A combo chain and a back-to-back.
5. Zone (or any special event).
6. Stage-specific effects and how they ramp up within a stage.
7. Music response: what pulses on the beat and what doesn't.
8. A stage transition in Journey mode.

## Preliminary implications for Prismfall (principles, not designs)

These come from the screenshots only and are refined in VISUAL_GAP_ANALYSIS.md once our own build has been captured the same way:

- Build scenes around a dark value floor with small luminous elements, instead of evenly lit, hazy mid-tone environments.
- Tint piece colours to each world's palette (keeping the seven pieces distinguishable), instead of fixed rainbow colours on every world.
- Lighter, more transparent board framing; the board interior is the calmest, darkest area.
- Rounded glass or light-like blocks with clean edges, not noisy surface textures.
- Compose large creature and particle formations around the board; organise particles into coherent flows with depth-dependent size.
- Typography beside the board without boxes; callouts as typographic events.
