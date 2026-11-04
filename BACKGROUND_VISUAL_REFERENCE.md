# Background visual reference

What makes the reference game's worlds feel alive around the well, and the techniques Prismfall takes from it. Brief §40.2. The reference is Tetris Effect: Connected, installed locally and owned by the project owner. Nothing here is copied: no assets, music, models, shaders or stage designs. Only the observed behaviour is translated into Prismfall's own systems ([LIVING_ENVIRONMENT_ARCHITECTURE.md](LIVING_ENVIRONMENT_ARCHITECTURE.md)).

## 1. Sessions

| Session | What |
|---|---|
| 2026-11-04, played in the installed game | Launched through Steam and driven with keyboard input: menus, Effect Modes → Relax → Quick Play (one stage, no game over, 30-line goal), constant speed level 1. |
| Who played | A small screen-reading bot (scratchpad tooling, not in the repo). It read the well from the screen at 20 Hz, recognised the falling piece and placed it with a standard height and holes heuristic. Keys were sent only while the game window was in the foreground. |
| Recorded | Screen at 2560×1080, 60 fps (Desktop Duplication), with the system audio (WASAPI loopback), about 12 minutes:<br>• **The Deep**: a whole run, lines 0 → 30 and the stage finale (clips of 55, 120 + 80, 150 and 75 s).<br>• **Spirit Canyon**: its 240-second opening (the bot could not read that stage's dark-gradient blocks, so no lines were cleared and the stage stayed in its first section). |
| Also used | The owner's 16-minute recording from 2026-11-03 (seven stages, real play, no audio), studied in [VISUAL_REFERENCE_AUDIT.md](VISUAL_REFERENCE_AUDIT.md). |
| Stored | `reference-capture/te-clips/` only (git-ignored, local study material, never committed). |

Not covered: the Zone mechanic, VR, and stages other than these with sound.

## 2. Measurements

The background was measured outside the well: a region left of it (x 0–880) and one right of it (x 1800–2560), at 30 Hz. For each frame the script took the mean brightness and the motion energy (the mean absolute difference from the previous frame). Audio envelopes came from the same moments: bass under 150 Hz, mid 400–2000 Hz, treble over 5 kHz, and the full mix.

| Clip | Slow coupling: 4 s brightness ~ 4 s loudness (r) | Beat coupling: fast motion ~ bass onsets (r) | Variance at < 0.5 s / 0.5–4 s / > 4 s | Band that leads, lag |
|---|---|---|---|---|
| The Deep, opening (near black) | 0.12–0.16 | −0.01 | 36–49 % / 30–43 % / 21 % | treble, +370–430 ms |
| The Deep, after 5 lines | 0.06–0.19 | −0.03 | 17–20 % / 51–53 % / 29–30 % | treble, +330–430 ms |
| The Deep, lines 16–25 | 0.26–0.42 | −0.03–0.00 | 6 % / 39–51 % / 43–56 % | mid, +230–300 ms |
| The Deep, finale | **0.71–0.84** | −0.02 | 6 % / 39–40 % / 54–55 % | mid, ±100–300 ms |
| Spirit Canyon, opening | **0.74–0.81** | −0.01 | 8–11 % / 59–61 % / 30–31 % | bass, +170–300 ms |

Large background events were counted as motion peaks more than 4 standard deviations above the mean. They came every 5 to 20 seconds, and nearly all of them followed an audio onset of 2 to 27 dB within 200 ms.

What the numbers say:

1. **The world follows the music's large shape, not its drum hits.** Brightness and motion follow loudness strongly on the scale of sections (up to r = 0.84). Frame-to-frame motion has no correlation at all with bass onsets: nothing pulses with the kick.
2. **Motion is slow.** Once a stage has developed, 85–94 % of its brightness changes happen over half a second or longer.
3. **The visuals trail the music by a fifth to half a second.** The best correlations sit at +200 to +500 ms, the signature of smoothed envelopes with slow attacks rather than instant reactions.
4. **Each stage, and each section, listens to a different band.** The Deep's sparse opening twinkles with the treble; its developed middle moves with the mids; Spirit Canyon's embers follow the bass.
5. **Big moments are rare and discrete.** They come every 5 to 20 seconds, on strong musical onsets or on line clears, never on a fixed cycle.

## 3. Observations

### Layers that move at different speeds

- **Slow, continuous layer.** Fine particle dust, drifting embers, a dark moon that turns very slowly behind the well, and particle sheets that slide across the frame over tens of seconds. It never stops, even in the near-black opening of The Deep.
- **Midground formations.** Schools of small particle fish, and streams and ribbons of points, cross in 5–15 seconds. They are built from thousands of points on recognisable forms.
- **Large set pieces.** Particle mantas and whales sweep past close to the camera, often filling a whole side of the frame. A line clear calls them in at once: a pair of mantas appeared beside the well on the frame after a clear.
- **Fine detail.** Twinkles and sparks on the treble, light shafts flickering down through the top of the well.

### How the music is used

- **The stage reveals itself as the song and the lines progress.** The Deep opens nearly black. After a few lines, fish formations appear. Then come light shafts, then the large creatures, then a lit crescent on the moon, and at the finale a dense school swirling around the well while a giant whale passes overhead. The camera pulls back as the stage ends.
- **Intensity is shown by density, scale and brightness.** Busier sections bring more particles, larger and closer creatures and a brighter frame. No object grows and shrinks on the beat.
- **Quiet passages stay alive.** The slow layer keeps drifting; only the density and the events thin out.
- **Line clears and strong onsets are cue points.** A clear can call a creature in at once, and a big hit can coincide with a burst of cubes or particles around the well.

### Composition

- Light is reserved for a few subjects on a near-black frame (The Deep, Spirit Canyon). Bright stages, from the owner's recording, keep the well's interior dark instead.
- Set pieces frame the well left and right and come close to the camera; the playfield itself stays clear.
- Many recognisable forms are made of points on a solid shape (fish, mantas, whales, feathers). They read as creatures because the underlying form is right, not because of detail.

## 4. Techniques for Prismfall

Every row is implemented in the living-environment system ([LIVING_ENVIRONMENT_ARCHITECTURE.md](LIVING_ENVIRONMENT_ARCHITECTURE.md), [MUSIC_REACTIVE_ENVIRONMENTS.md](MUSIC_REACTIVE_ENVIRONMENTS.md)).

| Observation | Prismfall technique |
|---|---|
| Section-scale coupling is the backbone | The Environment Music Director publishes slow drives: `intensity` (about 3 s), `swell` (about 4 s), `tension` and `release` (seconds). Each world drives its large elements from these. |
| No beat strobing | There is no global beat pulse in the world. `beat` fires only on selected beats (downbeats, accented beats, busy sections) with a soft envelope, and `accent` is governed: at least a beat apart, at most a few per second, softened with Reduce flashing. |
| Visuals trail by 0.2–0.5 s | The drives have distinct time constants: `body` (bass) has a 250 ms attack and a 1.4 s release, `motion` (mids) 120/600 ms, and `detail` (treble) 30/250 ms with a slew limit. |
| A different band per stage | Each world's `living.json` reaction profile chooses which drive moves which layer. |
| Rare, discrete big moments | The Environment Event Director runs music cues (`drop`, `build`, `peak`, `phrase`, `calm`, `accent`) and ambient timers (random intervals within bounds, groups that never repeat the same event twice in a row, varied strength), all quantised to the music, with cooldowns and the Background intensity event-frequency setting. |
| Clears call creatures in | Existing call-ins (`clear>=N`, `combo`, `b2b`), plus the new `pulse` (a target swells and settles) and `wave` (a music front through the world) actions. |
| Quiet passages stay alive | Every world animates continuously without music; the `calm` drive brings out quiet-time details (fireflies, distant birds) instead of freezing the scene. |
| Reveal over the run | Existing `game.progress` bindings and `reveal`, kept and extended by section states. |
| Density, scale and brightness show intensity | The `intensity` drive is mapped to particle density and brightness, creature activity and set-piece visibility, never to object size on the beat. |
