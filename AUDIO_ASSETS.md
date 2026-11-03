# Audio assets

An honest account of where Prismfall's soundtrack and sound design come from, how they are made, and what is in place for better audio later.

## 1. Summary

- **No recorded audio ships.** There are no audio files under `content/` or `assets/`. Every sound is generated in the browser by code in this repository.
- **Music is original procedural synthesis.** Each track is a TypeScript file written in the project's composition DSL (`content/stages/<id>/music/*.ts`) and played live by a Web Audio synthesizer. No DAW was available. There are no recorded instruments, samples or professionally produced stems.
- **Sound effects are synthesised sample by sample**, separately for each stage's block material, and rendered in a worker when a stage loads. A tonal layer in the music's key is added on top.
- **Ambience is procedural:** filtered noise beds with slow modulation and occasional synthesised events.
- **Recorded music can be dropped in later.** The `FileTrack` format (beat metadata, loop points, sections, adaptive stems with intensity thresholds) and an ffmpeg/Opus encode script (`npm run audio:encode`) exist for that purpose. Neither has been used for shipped content yet.

**Quality can only be judged by listening.** The automated tests measure technical properties: peak headroom, absence of NaN and DC offset, onset and tempo detectability, beat-phase accuracy, band balance, and the loudness order of impacts (`e2e/audio-acceptance.spec.ts`, `src/audio/sound-effects/impactSynth.test.ts`). None of them can say whether the music is good. Synthesised music of this kind will not sound like produced, recorded music.

## 2. Music

### How it is played

`src/audio/sequencer/composition.ts` expands a composition into note events. The expansion is deterministic, with a random generator seeded per track, section and instrument. `CompositionPlayer` (`src/audio/music-director/tracks.ts`) schedules the events ahead of time on the audio clock. Each note is built from native Web Audio nodes by `playNote` in `src/audio/synth/instruments.ts`:

| Instrument kinds | Synthesis |
|---|---|
| `pad`, `strings` | Detuned oscillators through a low-pass filter whose cutoff breathes with a slow LFO, with long envelopes. |
| `choir` | Detuned sawtooth pair through three band-pass formant filters ("ah"). |
| `pluck`, `lead`, `bass` | Oscillators with a filter envelope; `lead` adds a delayed vibrato and, with `glide`, slides between the notes of a phrase. |
| `sub` | Sine oscillator. |
| `bell`, `epiano`, `mallet` | Two-operator FM (carrier/modulator ratio and index). |
| `kick` | Sine with a fast downward pitch sweep. |
| `snare`, `clap`, `hat`, `openhat`, `shaker`, `ride`, `crash`, `tom`, `perc` | Filtered noise bursts and tuned bodies. |
| `riser`, `impact` | Swept noise and a low hit for section transitions. |

Each composition has a convolution reverb whose impulse response is generated procedurally (`impulseResponse` in `src/audio/synth/resources.ts`: decaying noise whose highs fade faster). It also has a dotted-eighth ping-pong delay and kick-triggered sidechain ducking for instruments with `duck`.

The arrangement adapts to play. Game intensity rises with level, combos, recent clears and a high stack (`AudioSystem`). Once per bar, each instrument with a `layer` threshold opens when `min(1, sectionIntensity × 0.65 + gameIntensity × 0.5)` reaches that threshold. Line clears and level-ups trigger a short "stinger" phrase on one instrument, quantised to the next sixteenth and kept in the track's key.

The first fourteen tracks share one five-section form: intro (8 bars), verse (16), build (4; 8 in Anvil Pulse), drop (16) and break (8), looping from the verse (`loopFrom: 1`). The twenty tracks added after them vary the form: a second verse, bridges, two drops, an outro that leads back into the loop, and three to four minutes per pass. Every track loops from its section 1.

Not every track is in 4/4. `beatsPerBar` sets the bar (sixteen steps per four beats): the waltzes and Seeds on the Wind are in 3/4, Magnetic North and Steam Hammer in 5/4, grouped three plus two. The 6/8 tracks (Sirocco, Moon Jellies, Caldera Rite) use `beatsPerBar: 6` with the eighth note as the beat, so their BPM counts eighths and the beat clock and visuals pulse on every eighth, strongest on the two dotted-quarter pulses. `shuffle` delays every off-beat eighth (0.67 is a triplet shuffle; Through the Ferns and Maple Shade use it), and the `ramp` option of `beat`, `arp` and `melody` crescendos or fades a part across its section, which the builds and outros use.

### Which track plays

A world's default track (`defaultTrack`) plays in the menus, in world previews, in the sound test and in Voyage. In free play with "Each world's own, taking turns" (the default free-play music, `setup.music: 'stage'`), a world's tracks take turns: the first game in a world in a session plays its default track, and each later game there plays the next track in manifest order, wrapping around (`TrackRotation`, `src/audio/music-director/trackRotation.ts`; in memory only, keyed by stage id). Returning to the menus goes back to the default track. "Shuffle all" and a chosen track work as before and do not move a world's turn on.

### Tracks per stage

Read from each `music/*.ts` file. "Swing" delays off-beat sixteenths (0 to 0.5).

| Stage | Track | File | BPM | Key and scale | Swing | Instruments (composition names) |
|---|---|---|---|---|---|---|
| Luminous Tide | Moonwater | `music/main.ts` | 84 | D Dorian | 0.14 | pad, keys, arp, kalimba, bass, kick, clap, shaker, hat, bell, riser, impact |
| Frozen Kingdom | Glass Meridian | `music/main.ts` | 76 | E Lydian | 0.04 | pad, strings, choir, glass, celesta, keys, sub, tick, snap, kick, shimmer, riser, impact |
| Moving Sands | Caravan of Embers | `music/main.ts` | 94 | D Phrygian dominant | 0.10 | drone, strings, choir, oud, harp, lead, sub, doum, tek, frame, shaker, riser, impact |
| Ancient Garden | Lanterns on Still Water | `music/main.ts` | 82 | D in scale | 0.08 | pad, strings, koto, kotoHigh, flute, bell, sub, taiko, block, rim, shaker, riser, impact |
| Celestial Drift | Leviathan of Stars (default) | `music/leviathan.ts` | 84 | C minor | 0.02 | drone, pad, choir, seq, lead, bell, sub, kick, snare, hat, riser, impact |
| Celestial Drift | Orbit of Glass | `music/main.ts` | 92 | A Lydian | 0.06 | strings, choir, glass, arp, keys, sub, kick, snare, shaker, riser, impact |
| Alpine Horizon | Above the Treeline | `music/main.ts` | 88 | G major | 0.03 | pad, strings, cello, keys, horn, harp, sub, frame, shaker, timpani, riser, impact |
| The Abyss | Pressure and Light | `music/main.ts` | 72 | F# Dorian | 0.06 | deep, pad, drops, liquid, glass, lead, sub, pulse, click, shaker, riser, impact |
| Enchanted Wilderness | Where the Fireflies Gather | `music/main.ts` | 90 | A Dorian | 0.07 | pad, strings, keys, marimba, flute, chime, sub, drum, tap, shaker, riser, impact |
| Ember Foundry | Anvil Pulse | `music/main.ts` | 128 | E Phrygian | 0 | kick, clap, hat, openhat, ride, clank, acid, sub, lead, pad, clang, riser, impact |
| Ember Core | Heart of the Mountain | `music/main.ts` | 112 | D Phrygian | 0 | drone, strings, choir, bass, brass, lead, sub, kick, taiko, tom, snare, hat, riser, impact |
| Northern Lights | Curtains of the Sky | `music/main.ts` | 80 | B major | 0.03 | pad, warm, strings, seq, keys, lead, sparkle, sub, kick, snap, tick, riser, impact |
| Future Nights | Afterglow District | `music/main.ts` | 118 | F minor | 0.05 | pad, stabs, arp, lead, bass, sub, kick, clap, hat, openhat, perc, riser, impact |
| Folded Sky | Paper Wind | `music/main.ts` | 136 | E yo scale | 0.12 | pad, koto, pluck, flute, bass, kick, snare, hat, shaker, riser, impact |
| Tradewind Cove | Trade Winds | `music/trade-winds.ts` | 90 | E major | 0.12 | pad, guitar, uke, marimba, pan, flute, bass, sub, kick, rim, shaker, conga, lowConga, strings, riser, impact |

Added tracks (each world's default track is still the one above):

| Stage | Track | File | BPM | Meter | Key and scale | Groove and character |
|---|---|---|---|---|---|---|
| Frozen Kingdom | Hoarfrost Waltz | `music/hoarfrost-waltz.ts` | 138 | 3/4 | C# harmonic minor | Ballroom waltz: music box, oom-pah-pah pizzicato and waltz bass, violin-like lead, choir, timpani |
| Frozen Kingdom | Diamond Dust | `music/diamond-dust.ts` | 132 | 4/4 | G minor | Future-garage 2-step (swing 0.16): deep bass, minor-ninth e-piano stabs, chopped choir, random high bells |
| Moving Sands | Sirocco | `music/sirocco.ts` | 168 (eighths) | 6/8 | A harmonic minor | Galloping hand-drum storm: darbuka, doum, riq, oud ostinato, qanun runs, reed lead, choir |
| Moving Sands | Salt Road | `music/salt-road.ts` | 122 | 4/4 | B Phrygian | Desert deep house: four-on-the-floor, rolling bass, oud hook, hand drums, ney-like flute, beatless mirage break |
| The Abyss | Silver Schools | `music/silver-schools.ts` | 114 | 4/4 | Eb minor | Dub techno: delayed minor-ninth stabs, soft kick, round sub, 3-against-4 bubbles, gliding lure lead |
| The Abyss | Moon Jellies | `music/moon-jellies.ts` | 120 (eighths) | 6/8 | G# Phrygian | Slow sway: sine pads, deep drum on each dotted beat, sonar pings, water swishes, gliding call, choir |
| Northern Lights | Solar Wind | `music/solar-wind.ts` | 134 | 4/4 | Ab major | Uplifting trance: off-beat bass, gated saw arpeggios, long choir breakdown, supersaw drop, soaring lead |
| Northern Lights | Magnetic North | `music/magnetic-north.ts` | 100 | 5/4 | F# Lydian | Broken 3+2 groove, e-piano ostinato that shifts against the bar, wide strings, glass bells, gliding lead |
| Future Nights | Chrome Rain | `music/chrome-rain.ts` | 174 | 4/4 | B Dorian | Liquid drum and bass: beatless rain intro, two-step break with ghost snares, reese bass and sub, e-piano ninths |
| Future Nights | Neon Boulevard | `music/neon-boulevard.ts` | 104 | 4/4 | A minor | Synthwave: root-and-octave eighth bass, big snare, sixteenth arpeggios, brass stabs, tom fills, saw lead |
| Ember Core | Tectonic | `music/tectonic.ts` | 150 | 4/4 | C# Phrygian | Heavy half-time: distorted kick, snare on three, huge sub, growling resonant bass, war toms, choir |
| Ember Core | Caldera Rite | `music/caldera-rite.ts` | 144 (eighths) | 6/8 | Bb harmonic minor | Fire ritual: taiko and tuned toms, chanting choir, brass stabs, horn line over a dark drone |
| Ancient Garden | Hanami Drums | `music/hanami-drums.ts` | 116 | 4/4 | F yo scale | Festival drum procession: big and high taiko, shamisen-like riff, bamboo-flute melody, cymbal bursts |
| Ancient Garden | Maple Shade | `music/maple-shade.ts` | 70 | 4/4 | C in scale | Lo-fi (swing 0.22, shuffle 0.45): dusty drums, rounded bass, e-piano sevenths, koto riff, shakuhachi-like flute |
| Alpine Horizon | Thermals | `music/thermals.ts` | 146 | 4/4 | Eb major | Orchestral chase: galloping cello, sixteenth spiccato, timpani and snare, dotted horn calls, choir |
| Enchanted Wilderness | Through the Ferns | `music/through-the-ferns.ts` | 110 | 4/4 | Bb Lydian | Triplet shuffle (shuffle 0.67): swung marimba, bouncing bass, brushes, flute, pizzicato, woodblocks |
| Luminous Tide | Phosphor Bay | `music/phosphor-bay.ts` | 124 | 4/4 | F major | Bossa: nylon-like comping on sevenths, root-and-fifth bass, rim clave, flute, vibraphone, strings |
| Ember Foundry | Steam Hammer | `music/steam-hammer.ts` | 112 | 5/4 | G Phrygian | Lurching 3+2 machine groove: driven kick, hammer strikes, resonant sequenced bass, tuned clanks, steam |
| Celestial Drift | Hidden Sun | `music/hidden-sun.ts` | 64 | 4/4 | Bb minor | Vast and slow: heartbeat kick, deep sub, wide drones, sixteenth pulse sequence, star bells, gliding lead |
| Folded Sky | Seeds on the Wind | `music/seeds-on-the-wind.ts` | 102 | 3/4 | Ab major pentatonic | Airy: kalimba and music-box arpeggios over quartal chords, whistled melody, light drums |
| Dead Acre | Fog Line (default) | `music/fog-line.ts` | 64 | 4/4 | C# Phrygian | Slow dread: a double-thump heartbeat on a deep sub, a low breathing saw drone, string and choir swells on chords with a flat second against the root, a detuned glass bell, a clock-like tick; the heartbeat thickens and a falling half-step lead sounds at the climax. -20.8 LUFS, peak -3.8 dBFS (`e2e/audio-tracks.spec.ts`) |
| Dead Acre | Last Lamp | `music/last-lamp.ts` | 96 | 4/4 | F harmonic minor | Driving nocturne: muffled eighth-note bass, a low filtered arpeggio, a cracked bell tolling on downbeats, war-drum toms and choir at the climaxes, a long beatless break with only drone and bell. -20.5 LUFS, peak -5.1 dBFS |
| Tradewind Cove | Spindrift | `music/spindrift.ts` | 112 | 4/4 | A Mixolydian | Breezy island dance: soft four-on-the-floor, log-drum toms, off-beat chord plucks, marimba hook, whistled lead, kalimba, beatless lagoon break |
| Ashen Vigil | Witness (default) | `music/witness.ts` | 66 | 4/4 | D minor | Slow elegy: a low drone and a tolling inharmonic bell, strings and a cello-like gliding line over a distant heartbeat kick, low war drums like far thunder, a choir and a solo lament over metallic strikes at the climax, then drone and bell alone. -21.3 LUFS, peak -7.0 dBFS (`e2e/audio-tracks.spec.ts`); a deliberately even arc (1.3 LU between sections) |
| Ashen Vigil | Ninth Sun | `music/ninth-sun.ts` | 96 | 4/4 | B minor | Dark industrial, half-time: a driven kick and a heavy snare on three, a grinding resonant sequenced bass, anvil and clank strikes, rattling hats, a cold arpeggio and a grim gliding lead over a low choir, a beatless middle on the drone. -18.9 LUFS, peak -7.1 dBFS |

The instrument names describe the intended character, but each one is one of the synth kinds above. For example, `oud`, `koto` (Ancient Garden) and `harp` are `pluck` voices; Folded Sky's `koto` is an `epiano` FM voice; `taiko` and `doum` are `tom`; `cello` and `strings` are `strings`; and `brass` (Ember Core) is a `pluck`. The doc comment of the Enchanted Wilderness file says "A minor with Dorian colour"; its `scale` field is `dorian`.

## 3. Sound effects

Each gameplay sound (`SFX_IDS` in `src/audio/sound-effects/SfxBank.ts`) can combine two layers, which are mixed into one buffer per variant when a stage loads.

**Tonal layer.** The stage's `sfx.preset` (`glass`, `metal`, `crystal`, `organic`, `neon`, `paper`, `stone`, `ice`, `oasis`, `koto`, `void`) supplies five instrument specs: tick, tone, chord, thud and shimmer. A recipe per sound plays them through the same synthesizer into an `OfflineAudioContext`, transposed to the current composition's key. For example, a single clear is a two-note chord and a quad is an impact plus a six-note chord and a shimmer. Spawn, soft drop and land have no tonal layer.

**Material layer.** The stage's `sfx.material` names a `MaterialAudioProfile` (`src/audio/sound-effects/materialAudio.ts`) or defines one inline. `renderImpact` (`impactSynth.ts`) synthesises a hit sample by sample into `Float32Array`s from these layers:

| Layer | How it is made |
|---|---|
| transient | Band-passed noise burst of a few milliseconds, plus an optional single-sample click. |
| body | Modal synthesis: a sum of exponentially decaying sines at `baseHz × ratio`. Harder hits excite the upper modes more, the pitch sags slightly after the hit, and optional low-passed noise adds crunch for dense materials. |
| resonance | A band resonance, a hollow cavity, or a feedback comb (metallic or electronic ring) excited by a short burst. |
| scatter | Granular particles after the hit, of one kind: `sand`, `dust`, `pebbles`, `shards`, `chimes`, `bubbles`, `crackle`, `leaves` or `sparks`. Count, frequency range, delay, time spread and stereo width are set per material. |
| tail | Filtered noise: `hiss`, `air`, `rumble` or a wobbling `shimmer`. |
| reverb | A small Schroeder reverb (combs and all-passes); it is applied only when the tail layer is part of the sound. |
| sub | A low sine thump with a downward pitch sweep. |

Each render is high-passed at 22 Hz to remove DC, faded out at the end and scaled under a −1.5 dBFS peak ceiling. `MATERIAL_JOBS` (`materialJobs.ts`) defines how strongly each sound strikes the material and which layers it uses, so the impacts stay distinct:

- soft drop is a few short grains, land is transient + body + sub, and lock is transient + body;
- hard drop strikes at 0.72 strength with every layer, and a full-height hard drop at 1.0;
- clears 1 to 4 add layers as they grow;
- `signature` is the world's own answer to a four-line clear (the profile's `signature` override), and `impactResponse` is the environment's answer to a hard drop (the `response` override);
- `footstep` is used for creature footfalls, played positionally.

Each sound has one to four seeded variants, and playback picks one at random, never the same twice in a row. The material set is rendered in a Web Worker (`materialRender.worker.ts`), so a stage change in the middle of a Voyage does not block the main thread. When workers are unavailable, it renders on the main thread.

Built-in materials and the stages that use them, with each stage's ambience and tonal preset (from the manifests):

| Stage | `sfx.material` | `sfx.preset` | `ambience.preset` |
|---|---|---|---|
| Luminous Tide | `pearl` | `glass` | `ocean` |
| Frozen Kingdom | `ice` | `ice` | `ice` |
| Moving Sands | `sandstone` | `oasis` | `desert` |
| Ancient Garden | `wood` | `koto` | `garden` |
| Celestial Drift | `cosmic` | `void` | `cosmos` |
| Alpine Horizon | `mineral` | `stone` | `alpine` |
| The Abyss | `water` | `void` | `abyss` |
| Enchanted Wilderness | `organic` | `organic` | `wilderness` |
| Ember Foundry | `metal` | `metal` | `foundry` |
| Ember Core | `obsidian` | `metal` | `volcanic` |
| Northern Lights | `aurora` | `crystal` | `aurora` |
| Future Nights | `neon` | `neon` | `neon` |
| Folded Sky | `paper` | `paper` | `alpine` (level 0.9) |
| Tradewind Cove | `pearl` | `organic` | `ocean` (level 0.9) |
| Ashen Vigil | `obsidian` | `stone` | `volcanic` (level 0.7: a low rumble with distant impacts) |

The `glass` profile is the fallback, and it is used whenever the "classic" block style is selected.

## 4. Ambience

`src/audio/sound-effects/Ambience.ts` defines 21 presets: `ocean`, `foundry`, `space`, `forest`, `wind`, `rain`, `underwater`, `city`, `cathedral`, `arctic`, `horizon`, `desert`, `ice`, `garden`, `cosmos`, `alpine`, `abyss`, `wilderness`, `volcanic`, `aurora`, `neon`. Each preset is one to three looping white- or pink-noise layers. The layers are filtered (low-pass, band-pass or high-pass), with an LFO on the gain (swells, gusts) and an optional slow filter sweep. Most presets also schedule sparse synthesised events at random intervals: a far-off caravan bell (desert), a bamboo water knocker or a bird (garden), ice creaks and tinkles (ice), bubbles and a rare deep call (abyss). Presets crossfade when the stage changes.

## 5. Ready for recorded music: FileTrack and the encode pipeline

These parts exist so that recorded or professionally produced music can replace or supplement the compositions without code changes.

**`FileTrack` (`FileTrackPlayer` in `src/audio/music-director/tracks.ts`).** A stage track with `kind: "file"` plays an encoded audio file using metadata from a `track.json` next to it:

```json
{
  "title": "Caravan of Embers",
  "bpm": 94,
  "beatsPerBar": 4,
  "offset": 0.12,
  "loop": { "startBar": 8, "endBar": 72 },
  "sections": [
    { "name": "intro", "kind": "intro", "startBar": 0, "intensity": 0.2 },
    { "name": "drop", "kind": "drop", "startBar": 24, "intensity": 0.85 }
  ],
  "stems": [
    { "name": "percussion", "layer": 0.35 },
    { "name": "melody", "layer": 0.5 },
    { "name": "intensity", "layer": 0.8, "gain": 0.9 }
  ]
}
```

(This is the example from `assets/audio/README.md`, shown before encoding; the encoder adds each stem's `src`.)

- `offset` places beat 0 on the first downbeat. The beat clock, bar-quantised transitions and the music-reactive visuals all depend on it.
- `loop` loops on bar boundaries, so the beat clock stays aligned after every repeat.
- `sections` tell the game where builds, drops and breaks are, as compositions do.
- `stems` are decoded and started on the same audio-clock instant at the same file position as the main mix, so they stay sample-locked. Each stem's gain follows a smooth step from silent at `layer − 0.08` to full at `layer + 0.08` of the game's music intensity. Quiet play hears only the base mix; combos, big clears and danger bring in the higher layers.

**Encoding (`npm run audio:encode`, `scripts/encode-audio.ts`).** Lossless masters go in `assets/audio/music/<stage-id>/<track>/`: `main.wav`, optional `stems/<name>.wav` and `track.json`. The script then:

1. measures the main mix's integrated loudness with ffmpeg's `loudnorm` analysis;
2. applies one gain to the main mix and every stem, which brings the main mix to about −16 LUFS and keeps the stems' balance against it;
3. limits peaks with `alimiter` (limit 0.84, about −1.5 dBFS) on a 4× oversampled signal, which approximates a true-peak ceiling;
4. encodes Ogg Opus at 160 kbps VBR to `content/stages/<id>/music/<track>.ogg` and `<track>-<stem>.ogg`;
5. writes `<track>.track.json` with the resolved stem paths.

`npm run audio:encode -- <stage-id>` encodes one stage. The script needs ffmpeg on `PATH` or in `FFMPEG_PATH`. The masters stay in `assets/` and are not shipped. Then reference the result in `stage.json` (`CONTENT_GUIDE.md`, section 7) and list the new files in `ASSET_LICENSES.md`.

Limitations to know before relying on this path:

- `assets/audio/music/` does not exist yet, so the encoder currently exits with "No masters in assets/audio/music yet".
- The limiter runs at 4× the sample rate to catch most inter-sample peaks; Opus encoding can still overshoot slightly, so this is close to, not guaranteed, −1.5 dBTP.
- File tracks have no stinger instrument, so clears and level-ups get no musical answer from the music, though the sound effects still play.
- The tonal layer of the sound effects is transposed to the composition's key. With a file track it falls back to C.
- `assets/audio/README.md` describes `sfx/<stage-id>/` and `ambience/<stage-id>/` folders for recorded effects and ambience. No code reads those folders. Recorded effects instead go in the stage folder and are named in the manifest's `sfx.overrides` map, which replaces the generated sound for each listed id.

Players can also add their own music files in the Music Room. These are stored in the browser (IndexedDB), analysed for tempo, offset and sections, and played as file tracks. Nothing from this path is shipped.

## 6. Sound test

Settings → Audio → Sound test (`AudioTest` in `src/ui/settings/audioPanels.tsx`) auditions everything above without starting a game:

- **World**: choose any available stage. Its music, ambience, tonal preset and block material load; the visuals stay as they are. A status line shows the material in use and the current music section.
- **Play world music** and **Stop music**.
- **Preview intensity** (10 % to 100 %): sets the music intensity, so you can hear layers join as the arrangement builds.
- One button per gameplay sound:
  - Piece: Spawn, Move, Rotate right, Rotate left, Soft drop, Hold.
  - Impacts: Land, Lock, Hard drop, Hard drop (full height), World response.
  - Clears: Single, Double, Triple, Quad, World quad answer, Spin, Back-to-back, Perfect clear.
  - Combos: Combo 1–2, Combo 3–5, Combo 6+.
  - Moments: Level up, Goal reached, World unlocked, Danger, Game over, Pause, Resume.
- **Creature passing (spatial)**: eight positional footsteps moving from left to right in front of the listener.

The Music Room plays every unlocked world's tracks, not only each world's default track.
