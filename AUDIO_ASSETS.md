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
| The Lost Kingdom | Under the Ceiba | `music/under-the-ceiba.ts` | 84 | A Dorian | 0.08 | pad, drone, marimba, flute, ocarina, strings, bass, sub, frame, kick, hand, lowHand, rattle, clave, riser, impact |

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
| The Warden's Spire | The Sleepless Watch (default) | `music/sleepless-watch.ts` | 70 | 4/4 | D harmonic minor | Slow dark-fantasy dread: a low saw drone and a hummed choir under evolving low strings, great drums answering in a 3-3-2 swing, a muted brass line over the drops, a far anvil-like bell; long builds, heavy drops. -20.6 LUFS, peak -4.8 dBFS (`e2e/audio-tracks.spec.ts`) |
| The Warden's Spire | Cinder Road | `music/cinder-road.ts` | 96 | 4/4 | E Phrygian | Driving dark march: a pulsing low synth ostinato and sub under hammered drums, low strings and choir on the flat second, answering brass stabs, a climbing horn line over the drops, a beatless ash-fall break. -20.5 LUFS, peak -6.1 dBFS |
| Ashen Vigil | Ninth Sun | `music/ninth-sun.ts` | 96 | 4/4 | B minor | Dark industrial, half-time: a driven kick and a heavy snare on three, a grinding resonant sequenced bass, anvil and clank strikes, rattling hats, a cold arpeggio and a grim gliding lead over a low choir, a beatless middle on the drone. -18.9 LUFS, peak -7.1 dBFS |
| The Lost Kingdom | Under the Ceiba (default) | `music/under-the-ceiba.ts` | 84 | 4/4 | A Dorian | Slow ceremonial procession: deep frame drum and hand drums, warm pads and a low drone, a wooden marimba circling the chords, a breathy flute tune answered by a clay-flute call, strings opening on the drop, a rain-in-the-leaves break. -22.1 LUFS, peak -6.9 dBFS (`e2e/audio-tracks.spec.ts`) |
| The Lost Kingdom | The Long Count | `music/the-long-count.ts` | 102 | 4/4 | E Phrygian | Driving rite: a slit-drum ostinato and interlocking hand drums, a falling marimba figure on the phrygian half step, rattles, seed-pod hats and clave in the builds, flute and clay flute over dark strings. -22.4 LUFS, peak -7.5 dBFS |
| Red Horizon | Iron Meridian (default) | `music/iron-meridian.ts` | 96 | 4/4 | D Phrygian | Heavy half-time industrial: a driven kick and a deep sub, a resonant sawtooth grind ostinato, servo-like metallic percussion ticking off the grid, cold bell figures over dark detuned pads and a choir, a riser build into a weighty drop with a gliding saw lead. -16.8 LUFS, peak -2.4 dBFS (`e2e/audio-tracks.spec.ts`), about 5 LU from the quiet intro to the drop |
| Red Horizon | Ash Protocol | `music/ash-protocol.ts` | 124 | 4/4 | C harmonic minor | Driving electronic body music: four-on-the-floor kicks under a sixteenth-note sequenced bass, snare and clap on the backbeat, clanking racks, filtered square sequences, strings, a terse saw lead in a 24-bar drop and a near-silent cool-down. -15.6 LUFS, peak -2.1 dBFS, 108 s loop |
| The Last Frontier | Long Shadows (default) | `music/long-shadows.ts` | 84 | 4/4 | D Mixolydian | Cinematic Western ballad on a triplet lope (shuffle 0.67): a fingerpicked guitar arpeggio, a harmonica-like gliding lead on the main motif, slide-guitar answers, a root-and-fifth two-beat bass, low toms and timpani on the chord roots, then violins, low horns and a choir for the full statements, with a campfire break and a darker blue-hour bridge. Violins, horns and timpani join the verses only at high intensity. -22.3 LUFS, peak -3.9 dBFS, 9.1 LU between sections (`measureTrack`, `src/audio/lab/trackReport.ts`) |
| The Last Frontier | Iron Horse | `music/iron-horse.ts` | 116 | 4/4 | E Dorian | Steam-train ride: a brushed-snare and shaker chug in sixteenths with the accents on two and four, a walking bass that turns into pumping eighths, boom-chuck guitar, a three-against-four banjo roll, a harmonica-like riff climbing Em–D–A, strings and a fiddle line, big drums and timpani in the drops, and fiddle and harmonica in thirds on the second theme. -22.8 LUFS, peak -5.0 dBFS, 10.8 LU between sections (`measureTrack`) |
| The Veil | Beyond the Mist (default) | `music/beyond-the-mist.ts` | 58 | 4/4 | D Dorian | Slow and wide: a breathing low drone and air pads, a soft piano placing a few notes into a long room, far inharmonic bells, a muffled low drum like distant footfalls, strings gathering, a choir and a gliding sine lead at the height, the harmony opening to the bright fourth chord as the mist lifts; nothing struck on the beat for effect |
| Dark Storm | Black Squall (default) | `music/black-squall.ts` | 68 | 4/4 | C# minor | Dark and wide, written to sit under rain and let thunder through: a low saw drone and a sub, slowly moving filtered air pads, low strings, a muffled heartbeat kick and far toms, a sequenced low pulse like rain on a roof, a cello-like gliding line, a choir in the slow, heavy drop; the mids stay open for the rain and sharp attacks are rare |
| Dark Storm | Eye of the Storm | `music/eye-of-the-storm.ts` | 84 | 4/4 | G harmonic minor | More motion: a filtered sawtooth ostinato in eighths over a deep sub, a half-time kick and a distant heavy snare, low strings and choir in the drops, low brass-like stabs in the build, a gliding lead on the raised seventh, and a bridge (the eye) of drone, bell and ostinato alone before the second wall |
| The Veil | Lanterns in the Fog | `music/lanterns-in-the-fog.ts` | 72 | 4/4 | A minor | More motion: a muted piano ostinato turning like someone walking with a lantern, low strings on minor and suspended chords, a heavy two-steps-and-a-pause drum like something enormous walking far off, a long falling gliding lead answered by glass bells, a choir and a widening e-piano arpeggio in the last section |

The instrument names describe the intended character, but each one is one of the synth kinds above. For example, `oud`, `koto` (Ancient Garden) and `harp` are `pluck` voices; Folded Sky's `koto` is an `epiano` FM voice; `taiko` and `doum` are `tom`; `cello` and `strings` are `strings`; and `brass` (Ember Core) is a `pluck`. The doc comment of the Enchanted Wilderness file says "A minor with Dorian colour"; its `scale` field is `dorian`.

## 3. Sound effects

Each gameplay sound (`SFX_IDS` in `src/audio/sound-effects/SfxBank.ts`) can combine two layers, which are mixed into one buffer per variant when a stage loads.

**Tonal layer.** The stage's `sfx.preset` (`glass`, `metal`, `crystal`, `organic`, `neon`, `paper`, `stone`, `ice`, `oasis`, `koto`, `gossamer`, `void`) supplies five instrument specs: tick, tone, chord, thud and shimmer. A recipe per sound plays them through the same synthesizer into an `OfflineAudioContext`, transposed to the current composition's key. For example, a single clear is a two-note chord and a quad is an impact plus a six-note chord and a shimmer. Spawn, soft drop and land have no tonal layer.

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

`gossamer` (dark glass bells, a pure glass-harmonica shimmer and a deep thud) is the tonal preset for caves, webs and night worlds.

Each sound has one to six seeded variants, and playback picks one at random, never the same twice in a row (skitter and crawl pick by weight, below). The material set is rendered in a Web Worker (`materialRender.worker.ts`), so a stage change in the middle of a Voyage does not block the main thread. When workers are unavailable, it renders on the main thread.

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
| The Warden's Spire | `obsidian` | `stone` | `volcanic` (level 0.8); the Warden's own hum (a low drone that rises in pitch as it focuses, with a deeper swell when it wakes) plays through the world-drone hook (`WorldSounds.drone`) on the ambience bus |
| The Lost Kingdom | `mineral` | `stone` | `wilderness` (level 0.9: birds and insects in the canopy) |
| Red Horizon | `metal` | `metal` | `foundry` (level 0.7); the machines' footfalls play through `WorldSounds.emit('footstep')` with the metal profile (sentinels near the viewer, the colossi's deep strikes at any range), and the nearest drone's fans, the factory and the nearest colossus hum through the optional world-drone hook |
| Dark Storm | inline wet-crystal profile: a dark crystal contact (240 Hz modes, a few wet bubbles, an airy tail) over a deep sub for locks and drops, a comb resonance at 46 Hz, sparks and a three-second rumble with a falling sub on QUADs (a thunder-like accent), and a low cavity boom with rumble as the world's answer to hard drops | `void` | `storm` (level 0.35: a far rain wash and deep wind roar under the world's live weather, below) |
| The Veil | inline smoked-glass profile: a soft dark-glass contact (low transient, 240 Hz glass modes, faint shards, an airy tail) over a deep sub, a comb resonance and rumble on QUADs, and a distant cavity boom as the world's answer to hard drops | `glass` | `veil` (level 0.75: wind in dead branches over a low rumble; now and then, quietly, a drip into still water, a creak of old timber, a branch giving way, a far two-note call, or slow heavy footfalls a long way off); the hollow's and the strider's footfalls play faintly and positionally through `WorldSounds.emit('footstep')` |

The `glass` profile is the fallback, and it is used whenever the "classic" block style is selected.

### Creature sounds

Four more positional one-shots are synthesised sample by sample in `creatureSynth.ts`, like the impacts but independent of the block material (a claw on stone sounds the same in any world). They are rendered with the material set the first time, in the same worker, and then kept for every later world. A component plays them with `ctx.sounds.emit(id, x, y, z, gain)` (SDK 1.4):

| Id | Sound | Variants |
|---|---|---|
| `skitter` | A small spider's dash: an irregular patter of tiny claw ticks on stone in alternating sets of four legs, which speeds up, may stall and eases off, over the faint brush of the legs. | 6, light to heavy |
| `crawl` | One step of a large spider: two to four legs landing a beat apart, each a lower claw tap over a modal thud with a short low-mid knock, grit under the foot, now and then a leg dragging and, for the heaviest, a sub swell as the body settles. | 6, light to heavy |
| `silk` | A thread under tension: an airy stretch, a stick-slip creak whose rate climbs as the strand tightens (or falls as it slackens), a faint singing of the strand. | 3 |
| `webHum` | A web vibrating: three strands (root, a detuned twin, a fifth or octave) touched softly, ringing as plucked strings that waver as the web sways. Rendered at C3 and transposed onto the root, fifth or lower fourth of the music's key. | 3 |

For `skitter` and `crawl` the gain is also the weight: playback picks among the variants nearest it, so 0.2 is a light, quiet contact and 1 the heaviest and loudest.

Rate limits and range:

- Each world sound has its own rate limit per second, which is also its burst size: footstep 6, skitter 3, crawl 4, silk 2 and webHum 2.
- All world sounds share a limit of 10 per second, and at most 12 sound at once. Requests over any limit are dropped.
- Small sounds carry less far. The panner's reference distance is 16 world units for `skitter` and `silk`, 24 for `webHum`, and 30 for `crawl` and `footstep`.

Levels at gain 1, measured as energy above 150 Hz:

| Sound | Level |
|---|---|
| footstep (The Veil's material) | about −41 dB |
| heavy crawl | −38.5 dB |
| skitter | −43 to −45 dB (peaks −13 to −15 dBFS) |
| web hum | −43 dB |
| silk | −46 dB |

## 4. Ambience

`src/audio/sound-effects/Ambience.ts` defines 24 presets: `ocean`, `foundry`, `space`, `forest`, `wind`, `rain`, `underwater`, `city`, `cathedral`, `arctic`, `horizon`, `desert`, `ice`, `garden`, `cosmos`, `alpine`, `abyss`, `wilderness`, `volcanic`, `aurora`, `neon`, `veil`, `web`, `storm`. Each preset is one to five looping white- or pink-noise layers. The layers are filtered (low-pass, band-pass or high-pass), with an LFO on the gain (swells, gusts) and an optional slow filter sweep. Most presets also schedule sparse synthesised events at random intervals: a far-off caravan bell (desert), a bamboo water knocker or a bird (garden), ice creaks and tinkles (ice), bubbles and a rare deep call (abyss). Presets crossfade when the stage changes.

`web` is the most detailed bed: a cave under a ruin, with webs across the arches.

- **Layers.** Still cave air and a low room tone, wind moaning faintly through two stone arches, and a fine hiss of moving air. The moans are narrow bands that swell, fade almost to nothing and drift in pitch at unrelated rates. The layers read an 11 s pink-noise loop at different rates, so the bed never repeats on the shared 2 s loop.
- **Timing.** Events (`ambienceVoices.ts`) come every 2 to 6.5 s, with a one-in-five chance of a further 7 to 15 s of rest. About a third of them play nothing.
- **Events.** Mostly drips a long way off, sometimes the same drip falling two to four times. Sometimes a small insect's trill or wingbeats passing, a silk creak, a rustle or a pebble shaken loose. Rarely a far skitter, something large crawling far off, or a web humming.
- **Far creatures.** These are the creature one-shots above, low-passed, quieter and mostly heard through the bed's echo. The echo (the preset's `space`) is four feedback delays of 0.14 to 0.35 s that darken on every repeat.
- **Levels.** Rendered offline with `renderAmbience` (also in the audio lab), the bed at level 1 measures −31.6 LUFS integrated, with 3 s short-term loudness from −33.9 to −30.1 and a peak of −15.3 dBFS. The Veil's bed at its shipped level of 0.75 measures −31.7 LUFS. Played alone, each event peaks 7 to 14 LU below the bed's median.

### Weather and storms (Dark Storm, SDK 1.5)

A weather world's rain, wind, thunder and lightning cracks come from `src/audio/weather/` (`StormAudio`), driven by the world through `ctx.sounds.weather` and `ctx.sounds.storm`. Nothing is sampled; every sound is synthesised in a worker (`stormRender.worker.ts`, main-thread fallback) by `stormSynth.ts`:

- **Thunder.** A virtual lightning channel is laid out around the listener at the strike's apparent distance: a tortuous walk from the ground up into the cloud, then kilometres of channel spreading through the cloud, with branches. Every few metres of channel emits an N-wave (a pressure pulse 1.5 to 8 ms long, lengthening with distance), louder where the channel lies broadside to the listener; they arrive one after another by distance, so the nearest part of the channel gives the clap and the far reaches the roll. The pulses are filtered in four distance bands (air absorbs the highs with distance), a low rumble body follows the density of arrivals and rolls slowly, a nearby clap gets a deep falling boom, the land returns three to five late dull echoes, a dark reverberation lets it decay, and distant thunder arrives with a soft onset and more low-pass. Return strokes re-excite the nearest channel; about one in four thunders has a second channel (a double peal). Every thunder has its own seed and channel; renders take 90 to 260 ms in the worker (measured in Chrome, below).
- **Lightning crack.** A sharp snap, a tear of several hundred tiny bright sparks over 70 to 180 ms, and a quickly dying bright hiss with a short reverb: high and electrical, unlike the thunder. A few are pre-rendered so a crack sounds with its flash; each use is replaced by a new one.
- **Rain.** Long stereo noise loops (white, pink and brown, 9 to 13 s, crossfaded seams) through moving filters: the roar of heavy rain, a fine hiss, the low wash of rain on wet ground and far rain across the glen; plus seamless droplet loops synthesised drop by drop for water (impact clicks and small bubbles ringing up in pitch), rock (short ticks), wood (hollow knocks) and heather (soft patter), mixed by the world's `surfaces`. Levels follow the world's rain intensity with a slow random drift per layer, so the bed never sits still; it never stops while the world sends weather, and fades out about a second after it stops.
- **Wind.** A band of noise that rises with the gusts, a low distant roar, a thin whistle only in strong gusts and the hiss of rain blown sideways.

**Buses and settings.** `AudioEngine` has five weather buses (rain, wind, near thunder, distant thunder, crack) into a weather bus under the master. A thunder is sent to the near and distant thunder buses in proportion to its apparent distance (all near below 0.7 km, all distant beyond 3.3 km). Settings → Audio → Weather has Storm intensity (Subtle, Normal, Heavy, Extreme: environment only) and a volume for each bus, so thunder can be turned down independently of the rain (`weather` settings section). Big, near thunder ducks the music by up to about 4 dB as it arrives, scheduled on the music's duck gain at the thunder's start time.

**Timing.** `StormAudio.schedule` starts each thunder with `AudioBufferSourceNode.start(requested + delay)` on the audio clock; the world computes the delay from the strike's apparent distance (Dark Storm: world metres × 2.2 at 343 m/s, compressed to at most 15 s) and adds the 60 ms stepped leader before the flash. Each sound is logged in `audio.storm.log` with its requested, scheduled and actual start times. Measured in Chrome with forced strikes (`audio.storm.log` and the output meter): a level-4 strike 250 m away scheduled its crack 60 ms after the request (the flash) and its thunder 1.581 s after it; the meter showed the crack 0.06 s after the strike and the thunder's peak at 1.63 s. Twelve thunders between 0.55 and 7.2 km apparent distance (delays 1.6 to 11.3 s) all started at their scheduled time (0.0 ms late), with renders of 92 to 255 ms.

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
- **Spiders in the dark (spatial)**: three skitters on the left, a large spider's seven steps from right to left behind the board, a silk creak overhead and a web hum, through the same rate limits as in a world.

The Music Room plays every unlocked world's tracks, not only each world's default track.
