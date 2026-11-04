# Background visual quality report

Where every world stands after the living-environment work (brief §40.15–§40.16). The judgements come from recordings of the running game with its real soundtrack, from measurements of those recordings, and from the board protection check, not from reading code. Design: [LIVING_ENVIRONMENT_ARCHITECTURE.md](LIVING_ENVIRONMENT_ARCHITECTURE.md). Mappings: [MUSIC_REACTIVE_ENVIRONMENTS.md](MUSIC_REACTIVE_ENVIRONMENTS.md). Reference: [BACKGROUND_VISUAL_REFERENCE.md](BACKGROUND_VISUAL_REFERENCE.md).

## 1. How it was checked

| Check | Method |
|---|---|
| The board and blocks are unchanged | `scripts/playfield-baseline.ts --compare reference-capture/protected/baseline`: the board rendered alone in every world's look, pixel by pixel against the baseline taken before any change; plus the snapshot test of every protected file and manifest field (`npm test`). See [PROTECTED_PLAYFIELD.md](PROTECTED_PLAYFIELD.md). |
| What each world does with its music | `scripts/record-living.ts`: 55 s of uninterrupted play per world, with the built-in AI placing a piece every 0.8 s and clearing lines as it goes.<br>• The world's own track is heard and recorded from the game's master bus.<br>• The track is moved to six bars before its first build, so every clip holds a quieter verse, the build, the drop and usually what follows.<br>• The music director's drives and section are logged at 10 Hz beside the video.<br>• 2560×1080 viewport, Balanced, WebGPU, RX 9070 XT. |
| How closely the background follows the music | `scripts/music_coupling.py`, the measurement used on the reference game. Background regions left and right of the board, at 30 Hz: brightness and motion energy against the audio's loudness and bass, mid and treble envelopes. |
| By eye | Contact sheets of every clip (one frame every 5 s) and two composites of all 23 worlds: `docs/living/recording-verse.jpg` (8 s in, the verse) and `docs/living/recording-drop.jpg` (3 s into the drop). |

The recordings stay in `reference-capture/living/<world>/` (git-ignored): `<world>.mp4` with sound, `drives.json`, `sheet.jpg`, `drop.jpg` and `coupling.json`.

## 2. The board and blocks

**Unchanged.** After all of the living-environment work the board renders pixel-identically to the baseline in 22 worlds. In Luminous Tide it matches within one level, which is the noise floor two captures of the same build show. Every protected file and manifest field is unchanged (`scripts/protectedPlayfield.test.ts`).

## 3. What the recordings covered

Every world's clip passed through a build and a drop, except The Veil. Its 58 BPM track reaches only its build in 55 s; its drop comes later in play. Cues seen in the clips:

- governed accents in every world but The Veil (15–40 a minute in dense sections, none in intros and breaks);
- phrases every four bars;
- section changes;
- peaks in 12 worlds;
- breaks in 4;
- calm cues where a section dropped low.

## 4. Music coupling, measured

What the columns mean:

- **Slow:** the correlation of 4-second brightness with 4-second loudness, the mean of the left and right regions. It answers "does the world follow the music's large shape?". The reference game measured 0.71–0.84 in its developed sections.
- **Beat:** the correlation of the fast part of the motion with bass onsets. The reference game measured about 0: it never pulses on the kick.
- **Fast share:** the share of brightness changes faster than half a second.

| World | Slow | Beat | Fast share | Reading |
|---|---|---|---|---|
| Alpine Horizon | **+0.93** | 0.00 | 0.00 | The photographed valley's light follows the song's sections, slowly |
| Future Nights | **+0.87** | +0.02 | 0.00 | The river light and traffic follow the sections |
| The Lost Kingdom | **+0.83** | +0.04 | 0.03 | Sun shafts, ruins' glow and haze follow the sections |
| The Web | **+0.82** | +0.20 | 0.52 | Follows the sections strongly. The silk twinkle (treble) follows hits a little; the fast share comes from the spiders' set pieces |
| Northern Lights | +0.56 | +0.02 | 0.00 | The drop's aurora surge is the clearest single moment of any world |
| Folded Sky | +0.52 | 0.00 | 0.00 | |
| Ancient Garden | +0.44 | 0.00 | 0.00 | |
| Enchanted Wilderness | +0.35 | −0.04 | 0.02 | |
| Dark Storm | +0.31 | −0.02 | 0.18 | Lightning makes the fast share; it is never timed to hits |
| Deep Cosmos | +0.22 | −0.02 | 0.00 | |
| Ember Foundry | +0.21 | −0.03 | 0.21 | Welding and spark flicker make the fast share |
| Ember Core | +0.16 | −0.01 | 0.01 | |
| Moving Sands | +0.09 | 0.00 | 0.01 | |
| Luminous Tide | +0.06 | −0.01 | 0.02 | |
| The Warden's Spire | +0.06 | −0.01 | 0.03 | |
| Red Horizon | +0.01 | −0.03 | 0.09 | |
| The Abyss | −0.02 | +0.02 | 0.01 | |
| Ashen Vigil | −0.14 | −0.01 | 0.01 | |
| Frozen Kingdom | −0.18 | +0.04 | 0.00 | Day turns to dusk with progress (see below) |
| The Veil | −0.28 | −0.01 | 0.00 | No drop in the clip; the fog thickens over the run |
| Dead Acre | −0.38 | +0.01 | 0.02 | The night deepens with progress |
| Tradewind Cove | −0.49 | +0.03 | 0.04 | The afternoon light changes with progress |
| The Last Frontier | −0.71 | +0.04 | 0.00 | The golden hour turns to sunset with progress |

What the numbers say:

1. **Nothing strobes.** In every world but The Web the background's fast motion has no correlation with drum hits (|r| ≤ 0.05), as in the reference game.
2. **Four worlds follow the music's large shape as strongly as the reference does** (r 0.82–0.93), and five more moderately (0.31–0.56).
3. **Where the number is low or negative, two different things are going on:**
   - **The world moves the other way on purpose.** Several worlds change their time of day with the run's progress. Frozen Kingdom, The Last Frontier, Tradewind Cove and Dead Acre all darken over the clip while the music builds into its drop. The run's progress and the song's build rise together in a 55-second clip, so the measurement sees the scripted darkening against the music. Logging confirmed it for Frozen Kingdom: its sky region darkened 8 % over the clip while the intensity drive rose from 0.21 to 0.69, and the music reaction lifts it by only about 3 %.
   - **The reactive elements are small.** In Moving Sands, Luminous Tide, The Abyss and Deep Cosmos the reactive parts (particles, glints, glow, distant creatures) are a small share of a large, mostly dark region, so they barely move its mean brightness. They do move, and the drives log shows them following the sections, but the method cannot see it.
4. **The method has limits.** One clip per world, AI play, and audio that includes the game's own sound effects. A stronger test would hold progress fixed (`shell.previewProgress`) and record longer.

## 5. By eye, world by world

**Convincing places.** Real photography or scans, a composed foreground, midground and background, and continuous motion.

| World | Verdict |
|---|---|
| The Lost Kingdom | The strongest world. Pyramid and palace from scans, a waterfall, sun shafts, macaws and quetzals crossing. Its music coupling is among the strongest. |
| The Last Frontier | A built town, horses and riders, a train and golden dust. The time of day dominates the light over a clip. |
| Tradewind Cove | A bright lagoon with palms in the wind, gulls and dolphins. The surf is a flat band. |
| Ancient Garden | A photographed garden with drifting petals and sun shafts. Calm and legible. |
| Frozen Kingdom | The photographed lake, crystal snowflakes, a wolf, a snowy owl; its aurora night comes with progress. |
| Enchanted Wilderness | Misty pines, deer and fireflies. The fireflies are faint over the brightest fog. |
| Future Nights | The photographed skyline, river reflections, traffic. Follows the music strongly. |
| Folded Sky | A granite summit with a murmuration that wheels and startles. |
| Alpine Horizon | A beautiful valley, but nearly still apart from pollen and small eagles. Its strong coupling is the light breathing over the photo, not motion. |
| Red Horizon, The Warden's Spire, Ashen Vigil | Dramatic dusk worlds with real horizons. Their machines, tower and detonations read at play size. |
| The Veil, Dead Acre, The Web | Strong atmosphere. Creatures are silhouettes in fog, which suits them. |
| Northern Lights | The aurora and its reflection are striking, and the drop surge reads clearly. The ridges and spruce are procedural silhouettes. |

**Not yet at the standard of the brief.** These still look sparse or synthetic at the start of a run:

| World | What is missing |
|---|---|
| Luminous Tide | The first world in the Voyage. Early in a run it is a black sky, a moon and a glitter path: no coastline, no clouds, no life except plankton and passing dolphins. It needs a real moonlit-sea horizon (photo or scan) and midground life. |
| Ember Core | A dark red haze in which little is recognisable. The volcano and lava plain are procedural. It needs real volcanic terrain (scans or a photographed horizon), and the eruption needs to read at a distance. |
| Deep Cosmos | Mostly black at the start: the giant, a few asteroids, stars. It fills in with progress, but the first minute is thin. |
| The Abyss | Dark blue with faint jellyfish and fish streaks until progress reveals the large animals. Its peak call-in (a vortex of glowing fish around the board) is the most reference-like moment of any world, but it arrives late. |
| Dark Storm | Near black between lightning flashes, by design. Between flashes the loch and land are hard to read. |
| Moving Sands, Ember Foundry | They work, but look procedural: smooth dunes with sparse glitter, and a stylised hall with neon light beams. |

## 6. Against the acceptance criteria (§40.16)

| # | Criterion | Status |
|---|---|---|
| 1, 2 | Board and the seven pieces unchanged | Met: pixel-identical; protected files unchanged |
| 3, 4 | High-quality assets, convincing realism | Met for 16 worlds; not met for the seven above |
| 5, 6 | Real depth, natural movement | Met in the photo, scan and model worlds; thinner in the dark procedural ones |
| 7 | Music meaningfully influences the environment | Met: measured in 9 worlds, logged in all |
| 8 | Bass, mids and treble have different effects | Met: separate drives and time scales in every profile |
| 9 | Builds and transitions create coordinated events | Met: every world's profile has drop, build, peak or section events; seen in the clips |
| 10 | Every world has its own mapping | Met: 23 profiles |
| 11 | Movement continues in quiet passages | Met: ambient layers always run; there are calm cues and ambient timers |
| 12 | Smooth animation | Met for motion continuity: reactive rates are now phase-continuous, so changes of speed no longer jump. Frame times (p95, p99) per world are in BACKGROUND_PERFORMANCE_REPORT.md; hitches were not measured separately in these clips |
| 13 | No cheap flashing or pulsing | Met: beat coupling ≈ 0 everywhere but The Web (0.20, silk twinkle) |
| 14 | The board stays the focus | Met: the clear zone is kept, and creature passes (axial, and the new lateral ones, which no world uses yet) stay outside the widened board rectangle |
| 15 | Stable performance | Met: before and after are equal within noise (BACKGROUND_PERFORMANCE_REPORT.md) |
| 16 | Desktop and VR tested independently | Desktop: met. VR: emulation (IWER) only; no real headset |

## 7. Next steps

1. **The owner's listening pass.** Amounts in `living.json` were tuned against measured drives, not by ear. The developer dashboard (F9) shows every `music.*` binding live.
2. **Art for the seven sparse worlds**, starting with Luminous Tide (first in the Voyage), then Ember Core.
3. **A cleaner coupling measurement:** longer clips at fixed progress, without game sound effects in the audio.
4. **A real VR headset** (VR_TESTING.md).
