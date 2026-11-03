# Art direction

The rules every world follows. They come from the reference audit, the gap analysis and the owner's reviews: realistic, calm and professional, never gimmicky.

## 1. Real first

- **Real places, rocks, trees and creatures** come from photography (panoramas) or photogrammetry (scans); see [REAL_ASSET_PIPELINE.md](REAL_ASSET_PIPELINE.md).
- **Procedural geometry** is used only for what is procedural by nature: water, sky gradients, aurora, weather, particles and the board.
- **Script-built stand-ins** for real objects (pyramids, animals, mountains) are not shipped when they read as game assets.

## 2. One decisive value key per world

- **Dark key:** a near-black frame, with light reserved for a few subjects (aurora, moon glitter, lava, city windows).
- **Bright key:** a photographic daylight scene.
- **The board's interior stays dark in both,** so the stack reads.
- **No evenly lit mid-grey haze.** Fog is only atmospheric perspective; its colour matches the horizon.

## 3. Sharpness

- **Photographic horizons** use detail bands at 45–57 px per degree, which is at least the screen's density at 2560 px ultrawide and 4K.
- **No background depth of field by default.** Bloom is restrained, and highlights do not halo.

## 4. The playfield is still

- **The camera does not move during play:** no shake, push-ins, sway or beat zoom (all opt-in in settings).
- **No flicker:** the board's lights, frame and bloom never pulse with the beat or with clears.
- **Clear zone:** nothing in the world may sit inside about 20 degrees around the board, so the HUD and next queue stay readable.

## 5. Composition

- **Layers:** a background (photo, sky or silhouettes), a midground subject (a lake, a volcano, a planet), and foreground framing at the edges where it helps.
- **Detail where the eye goes,** not scattered evenly.
- **Reflections** (planar water) carry the world into the lower half of the frame wherever there is water.

## 6. Motion and life

- **Slow and continuous:** clouds, aurora folds, drifting particles and creatures move slowly.
- **Board events are fast and crisp.**
- **Worlds evolve with progress:** for example, Frozen Kingdom goes from day to dusk to an aurora night over the run. The progression is bound to `game.progress`, and `shell.previewProgress` shows the end state for review.
- **Music shapes the world gently,** through section intensity and flux. Lightning or flashes are never timed to every beat.

## 7. Particles have a job

- **Each world uses a few particle families with a purpose:** snow, sand, embers, plankton, petals, rain.
- **Particle shapes** (the particle snowflakes) and model-surface particles follow real geometry or real crystal structure, never arbitrary clouds.

## 8. Blocks and HUD

- **Blocks are solid, saturated, crisp cubes with clear gaps,** without strong self-glow or washed-out pastels.
- **The HUD is typographic:** large, bold, legible over bright skies, with no stray labels; combo and back-to-back sit with the other stats.

## Review loop

1. Implement.
2. Run the world with `content:shots`, `content:record`, or a forced-progression capture.
3. Look at full-size crops.
4. Compare against the reference findings and this document.
5. Fix, then commit only what passes.
