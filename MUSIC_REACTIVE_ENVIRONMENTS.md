# Music-reactive environments

How each world answers its music (brief §40.5–§40.9). Every world has its own reaction profile in `content/stages/<id>/living.json`, read by the one Environment Music Director (LIVING_ENVIRONMENT_ARCHITECTURE.md). This page is generated from those files and from the drive measurements of each world's default track (`node scripts/living-report.ts` after `node scripts/living-survey.ts`); do not edit the per-world sections by hand.

## How the profiles were tuned

- **The measurements.** Each world's default track was rendered offline by the game's own synthesiser, analysed by the game's DSP with the composition's real beat grid and sections, and fed to the director at 60 Hz (`src/audio/lab/driveReport.ts`). The tables give the mean / 90th percentile of the main drives over the first pass, and per section.
- **The amounts.** Amounts are multipliers on top of the authored look. A `mul` amount of 0.3 on a drive averaging 0.5 adds about 15 % on average and 20–25 % at the drive's peaks.
- **Shared rules for every world.**
  - The bass drives (`body`, `swell`) go on the largest, slowest elements, the mids (`motion`) on medium ones, and the treble (`detail`, `shimmer`) on fine particles and small lights.
  - The song's structure (`intensity`, `tension`) goes on density and activity.
  - Drops and peaks get the world's big moments (pulses, a wave, a creature or a set piece).
  - Ambient timers keep visitors coming in quiet play.
- **Never on the beat.** Nothing pulses global light on the beat.
- **On top of the old bindings.** The worlds' earlier `stage.json` bindings (raw bass, treble and game signals) are kept: the profiles add to them.

Drives: `body` sub-bass+bass · `swell` slow bass/loudness · `motion` mids · `detail` treble · `shimmer` treble rising · `intensity` section · `tension` builds · `calm` quiet passages · `accent` governed onsets.

## Luminous Tide (`luminous-tide`)

Ocean at twilight: the bass raises the swell, the mids light the surf and the sea glow, the treble lights the plankton, builds gather the sea haze and drops roll a glitter front out to sea.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | ocean.amplitude | body | ×0.35 |
| Large (bass, slow) | ocean.speed | swell | ×0.14 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Medium (mids) | ocean.surf | motion | ×0.35 |
| Medium (mids) | ocean.glow | motion | ×0.2 |
| Medium (mids) | plankton.turbulence | flux | ×0.4 |
| Fine (treble) | plankton.brightness | detail | ×0.45 |
| Fine (treble) | sky.stars | detail | ×0.2 |
| Song structure | sea-haze.opacity | tension | ×0.3 |
| Song structure | plankton.brightness | intensity | ×0.3 |
| Song structure | plankton.density | calm | ×-0.35 |
| Song structure | sky.glow | intensity | ×0.2 |
| Song structure | sky.exposure | intensity | ×0.14 |

| When | What | Limits |
|---|---|---|
| music drop | a wave through the world (0.5) | cooldown 45 s |
| music build | sea-haze.opacity swells ×0.4 | cooldown 40 s |
| music peak | meteors burst {"count":1} | cooldown 60 s |
| every 60–120 s | dolphins pass | cooldown 20 s |

Measured on "Moonwater" (84 BPM, first 149 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| tidefall | intro | 0.20 | 0.50 / 0.75 | 0.59 / 0.97 | 0.51 / 0.77 | 0.25 / 0.31 | 0.00 / 0.00 | 0.87 / 1.00 | 28.9 |
| drift | verse | 0.45 | 0.60 / 0.76 | 0.53 / 0.69 | 0.55 / 0.74 | 0.43 / 0.45 | 0.10 / 0.47 | 0.51 / 0.71 | 45.9 |
| swell | build | 0.65 | 0.69 / 0.86 | 0.57 / 0.69 | 0.57 / 0.73 | 0.54 / 0.59 | 0.70 / 0.82 | 0.29 / 0.43 | 57.7 |
| moonrise | drop | 0.85 | 0.59 / 0.72 | 0.51 / 0.68 | 0.53 / 0.74 | 0.69 / 0.71 | 0.00 / 0.00 | 0.01 / 0.03 | 64.3 |
| still water | break | 0.30 | 0.31 / 0.50 | 0.51 / 0.67 | 0.33 / 0.63 | 0.35 / 0.57 | 0.00 / 0.00 | 0.71 / 0.84 | 2.6 |
| **whole track** | | | 0.54 / 0.73 | 0.53 / 0.70 | 0.50 / 0.73 | 0.48 / 0.70 | 0.08 / 0.57 | 0.43 / 0.84 | 43.2 |

## Frozen Kingdom (`frozen-kingdom`)

Ice: the bass breathes slowly through the frozen lake and the snowfield, the treble glints in the snow crystals, accents shake loose a few bright flakes, and strong sections lift the aurora.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | lake.glow | swell | ×0.308 |
| Large (bass, slow) | snowfield.light | body | ×0.14 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Medium (mids) | snowfall.speed | energy | ×0.2 |
| Medium (mids) | dusk-aurora.speed | motion | ×0.2 |
| Fine (treble) | snowfield.sparkle | shimmer | ×0.8 |
| Fine (treble) | sky.stars | detail | ×0.25 |
| Fine (treble) | snowfall.brightness | detail | ×0.3 |
| Song structure | snowfall.turbulence | intensity | ×0.5 |
| Song structure | snowfall.density | intensity | ×0.25 |
| Song structure | dusk-aurora.intensity | intensity | ×0.45 |
| Song structure | snowfall.brightness | intensity | ×0.3 |
| Song structure | snowfall.density | calm | ×-0.35 |
| Song structure | sky.glow | intensity | ×0.2 |
| Song structure | sky.exposure | intensity | ×0.14 |
| Song structure | snowfield.light | intensity | ×0.12 |

| When | What | Limits |
|---|---|---|
| music drop | dusk-aurora.intensity swells ×0.9 | cooldown 40 s |
| music drop | a wave through the world (0.45) | cooldown 45 s |
| music build | snowfall.turbulence swells ×0.8 | cooldown 40 s |
| music accent | snowfall.brightness swells ×0.6 | chance 0.3, cooldown 5 s |
| every 55–110 s | snowy-owl pass | group visitors, cooldown 20 s |
| every 55–110 s | elk show {"seconds":2.5,"hold":20} | group visitors, cooldown 20 s |

Measured on "Glass Meridian" (76 BPM, first 164 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| still air | intro | 0.15 | 0.49 / 0.74 | 0.62 / 0.93 | 0.42 / 0.74 | 0.18 / 0.23 | 0.00 / 0.00 | 0.98 / 1.00 | 0 |
| frost lines | verse | 0.42 | 0.58 / 0.75 | 0.51 / 0.65 | 0.43 / 0.77 | 0.38 / 0.41 | 0.10 / 0.48 | 0.61 / 0.75 | 20.2 |
| gathering | build | 0.62 | 0.22 / 0.50 | 0.55 / 0.66 | 0.50 / 0.79 | 0.46 / 0.49 | 0.71 / 0.84 | 0.46 / 0.57 | 38 |
| aurora | drop | 0.82 | 0.57 / 0.71 | 0.53 / 0.67 | 0.43 / 0.73 | 0.64 / 0.66 | 0.00 / 0.00 | 0.04 / 0.15 | 39.2 |
| thaw | break | 0.25 | 0.34 / 0.58 | 0.54 / 0.66 | 0.29 / 0.69 | 0.31 / 0.51 | 0.00 / 0.00 | 0.77 / 0.91 | 0 |
| **whole track** | | | 0.50 / 0.73 | 0.54 / 0.68 | 0.41 / 0.75 | 0.42 / 0.65 | 0.09 / 0.58 | 0.51 / 0.99 | 21.2 |

## Moving Sands (`moving-sands`)

Desert: the bass lifts the dune ripples and the blowing sand, the mids pace the caravan, the treble glitters in the sand, percussive accents throw short sand bursts and builds raise the wind.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | dunes.ripple | body | ×0.35 |
| Large (bass, slow) | blowing-sand.turbulence | body | ×0.49 |
| Large (bass, slow) | sky.glow | swell | ×0.168 |
| Medium (mids) | camel-caravan.pace | motion | ×0.25 |
| Medium (mids) | camel-caravan.brightness | motion | ×0.2 |
| Fine (treble) | blowing-sand.brightness | detail | ×0.4 |
| Fine (treble) | dunes.sparkle | shimmer | ×0.7 |
| Song structure | blowing-sand.density | intensity | ×0.35 |
| Song structure | dunes.light | tension | ×0.15 |
| Song structure | blowing-sand.brightness | intensity | ×0.3 |
| Song structure | blowing-sand.density | calm | ×-0.35 |
| Song structure | dunes.light | intensity | ×0.12 |

| When | What | Limits |
|---|---|---|
| music accent | blowing-sand.brightness swells ×0.5 | chance 0.35, cooldown 4 s |
| music build | blowing-sand.turbulence swells ×0.9 | cooldown 40 s |
| music drop | a wave through the world (0.5) | cooldown 40 s |
| music peak | meteors burst {"count":2} | cooldown 60 s |
| every 40–90 s | meteors burst {"count":1} | cooldown 20 s |

Measured on "Caravan of Embers" (94 BPM, first 133 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| mirage | intro | 0.20 | 0.66 / 0.95 | 0.60 / 0.93 | 0.50 / 0.83 | 0.24 / 0.30 | 0.00 / 0.00 | 0.88 / 1.00 | 26.4 |
| caravan | verse | 0.45 | 0.56 / 0.72 | 0.52 / 0.65 | 0.53 / 0.75 | 0.44 / 0.47 | 0.09 / 0.46 | 0.48 / 0.69 | 49.9 |
| rising wind | build | 0.65 | 0.49 / 0.78 | 0.56 / 0.68 | 0.59 / 0.74 | 0.50 / 0.54 | 0.68 / 0.80 | 0.37 / 0.42 | 41.1 |
| dune sea | drop | 0.85 | 0.56 / 0.66 | 0.55 / 0.68 | 0.54 / 0.70 | 0.66 / 0.68 | 0.00 / 0.00 | 0.03 / 0.11 | 41.1 |
| oasis | break | 0.30 | 0.42 / 0.71 | 0.47 / 0.63 | 0.20 / 0.41 | 0.35 / 0.57 | 0.00 / 0.00 | 0.70 / 0.83 | 0 |
| **whole track** | | | 0.55 / 0.78 | 0.54 / 0.68 | 0.48 / 0.73 | 0.47 / 0.67 | 0.08 / 0.56 | 0.43 / 0.83 | 35.3 |

## The Last Frontier (`last-frontier`)

Wild West: the bass drifts the dust, the mids stir the motes in the low sun, the treble catches them, phrases bring riders past and now and then the donkey speaks up.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | dust.drift | body | ×0.35 |
| Medium (mids) | motes-town.turbulence | motion | ×0.3 |
| Fine (treble) | motes-town.brightness | detail | ×0.35 |
| Fine (treble) | motes-right.brightness | detail | ×0.35 |
| Song structure | riders.pace | intensity | ×0.15 |
| Song structure | motes-right.brightness | intensity | ×0.3 |
| Song structure | motes-right.density | calm | ×-0.35 |
| Song structure | motes-town.brightness | intensity | ×0.3 |
| Song structure | motes-town.density | calm | ×-0.35 |

| When | What | Limits |
|---|---|---|
| music phrase | stallion pass | chance 0.3, cooldown 40 s |
| music drop | a wave through the world (0.4) | cooldown 45 s |
| every 60–120 s | stallion pass | group frontier, cooldown 20 s |
| every 60–120 s | donkey clip {"clip":"H_Neigh","speed":1} | group frontier, cooldown 20 s |

Measured on "Long Shadows" (84 BPM, first 240 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| golden hour | intro | 0.18 | 0.55 / 0.99 | 0.64 / 0.91 | 0.56 / 0.76 | 0.21 / 0.25 | 0.00 / 0.00 | 0.94 / 1.00 | 5.3 |
| main street | verse | 0.38 | 0.54 / 0.65 | 0.49 / 0.67 | 0.53 / 0.75 | 0.36 / 0.39 | 0.00 / 0.00 | 0.67 / 0.85 | 28.9 |
| riders on the ridge | verse | 0.50 | 0.58 / 0.67 | 0.53 / 0.68 | 0.52 / 0.72 | 0.44 / 0.46 | 0.19 / 0.67 | 0.49 / 0.59 | 23.6 |
| dust rising | build | 0.66 | 0.63 / 0.71 | 0.57 / 0.68 | 0.49 / 0.72 | 0.50 / 0.57 | 0.70 / 0.82 | 0.38 / 0.48 | 36.7 |
| the long ride | drop | 0.86 | 0.56 / 0.65 | 0.52 / 0.68 | 0.49 / 0.71 | 0.65 / 0.66 | 0.00 / 0.00 | 0.02 / 0.06 | 31.5 |
| campfire | break | 0.24 | 0.46 / 0.63 | 0.49 / 0.69 | 0.44 / 0.66 | 0.33 / 0.53 | 0.00 / 0.00 | 0.73 / 0.86 | 2.6 |
| blue hour | bridge | 0.42 | 0.54 / 0.63 | 0.55 / 0.68 | 0.48 / 0.70 | 0.38 / 0.40 | 0.19 / 0.67 | 0.62 / 0.76 | 7.9 |
| night rider | build | 0.70 | 0.69 / 0.74 | 0.54 / 0.66 | 0.54 / 0.77 | 0.54 / 0.62 | 0.70 / 0.82 | 0.33 / 0.57 | 47.2 |
| last light | drop | 0.92 | 0.55 / 0.66 | 0.52 / 0.67 | 0.49 / 0.70 | 0.68 / 0.70 | 0.00 / 0.00 | 0.01 / 0.02 | 31.5 |
| lanterns lit | outro | 0.30 | 0.39 / 0.71 | 0.45 / 0.66 | 0.29 / 0.51 | 0.41 / 0.64 | 0.00 / 0.00 | 0.60 / 0.77 | 0 |
| **whole track** | | | 0.55 / 0.68 | 0.53 / 0.70 | 0.49 / 0.71 | 0.49 / 0.68 | 0.10 / 0.61 | 0.40 / 0.88 | 22.5 |

## Tradewind Cove (`tradewind-cove`)

Tradewind Cove: the bass works the chop in the lagoon, the mids move the palms, sections lift the sky, and gulls and dolphins come by.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | cove.chop | body | ×0.35 |
| Large (bass, slow) | sky.glow | swell | ×0.14 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Medium (mids) | palms.wind | motion | ×0.3 |
| Song structure | sky.glow | intensity | ×0.2 |
| Song structure | sky.exposure | intensity | ×0.14 |

| When | What | Limits |
|---|---|---|
| music drop | a wave through the world (0.4) | cooldown 45 s |
| every 50–100 s | seagull pass | group visitors, cooldown 20 s |
| every 50–100 s | dolphins show {"seconds":2,"hold":20} | group visitors, cooldown 20 s |

Measured on "Trade Winds" (90 BPM, first 267 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| first light on the water | intro | 0.20 | 0.56 / 0.99 | 0.64 / 0.94 | 0.51 / 0.69 | 0.22 / 0.26 | 0.00 / 0.00 | 0.92 / 1.00 | 2.8 |
| tradewind | verse | 0.42 | 0.58 / 0.69 | 0.49 / 0.72 | 0.46 / 0.67 | 0.41 / 0.44 | 0.00 / 0.00 | 0.56 / 0.76 | 39.4 |
| outrigger | verse | 0.52 | 0.58 / 0.69 | 0.52 / 0.73 | 0.51 / 0.75 | 0.48 / 0.49 | 0.00 / 0.00 | 0.37 / 0.45 | 46.4 |
| reef shadow | bridge | 0.38 | 0.47 / 0.60 | 0.52 / 0.67 | 0.35 / 0.60 | 0.38 / 0.45 | 0.19 / 0.66 | 0.58 / 0.67 | 5.6 |
| gathering swell | build | 0.60 | 0.68 / 0.78 | 0.58 / 0.68 | 0.46 / 0.67 | 0.49 / 0.56 | 0.69 / 0.81 | 0.42 / 0.64 | 62 |
| open water | drop | 0.80 | 0.56 / 0.64 | 0.54 / 0.66 | 0.51 / 0.72 | 0.68 / 0.70 | 0.00 / 0.00 | 0.02 / 0.10 | 74.5 |
| siesta | break | 0.28 | 0.49 / 0.66 | 0.49 / 0.67 | 0.27 / 0.51 | 0.37 / 0.58 | 0.19 / 0.66 | 0.68 / 0.80 | 5.6 |
| long tide | drop | 0.78 | 0.58 / 0.67 | 0.53 / 0.68 | 0.50 / 0.73 | 0.65 / 0.70 | 0.00 / 0.00 | 0.10 / 0.46 | 80.2 |
| sundown drift | outro | 0.32 | 0.51 / 0.73 | 0.47 / 0.72 | 0.31 / 0.54 | 0.38 / 0.59 | 0.00 / 0.00 | 0.66 / 0.74 | 0 |
| **whole track** | | | 0.56 / 0.70 | 0.53 / 0.71 | 0.45 / 0.70 | 0.48 / 0.70 | 0.06 / 0.15 | 0.41 / 0.80 | 42.1 |

## Ancient Garden (`ancient-garden`)

Japan wood: the bass moves the light, the mids stir the petals, the treble catches them, phrases send a breeze through the blossom and section changes shift the sun shafts.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | sky.glow | body | ×0.112 |
| Large (bass, slow) | sun-shafts.intensity | swell | ×0.35 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Medium (mids) | sun-shafts.intensity | motion | ×0.12 |
| Medium (mids) | petals.turbulence | motion | ×0.4 |
| Medium (mids) | petals.speed | energy | ×0.25 |
| Fine (treble) | petals.brightness | detail | ×0.35 |
| Song structure | petals.density | intensity | ×0.3 |
| Song structure | petals.brightness | intensity | ×0.3 |
| Song structure | petals.density | calm | ×-0.35 |
| Song structure | sky.glow | intensity | ×0.2 |
| Song structure | sky.exposure | intensity | ×0.14 |

| When | What | Limits |
|---|---|---|
| music section | sun-shafts.intensity swells ×0.6 | cooldown 30 s |
| music phrase | petals.turbulence swells ×0.6 | chance 0.5, cooldown 14 s |
| music drop | a wave through the world (0.4) | cooldown 45 s |
| every 45–90 s | crane pass | cooldown 20 s |

Measured on "Lanterns on Still Water" (82 BPM, first 152 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| mist on the pond | intro | 0.15 | 0.50 / 0.75 | 0.65 / 0.94 | 0.37 / 0.63 | 0.18 / 0.23 | 0.00 / 0.00 | 0.98 / 1.00 | 0 |
| garden path | verse | 0.42 | 0.57 / 0.76 | 0.49 / 0.72 | 0.44 / 0.67 | 0.36 / 0.39 | 0.10 / 0.47 | 0.65 / 0.81 | 11.5 |
| wind rises | build | 0.62 | 0.61 / 0.83 | 0.55 / 0.69 | 0.60 / 0.79 | 0.44 / 0.49 | 0.69 / 0.82 | 0.51 / 0.60 | 20.5 |
| blossom storm | drop | 0.84 | 0.56 / 0.65 | 0.51 / 0.69 | 0.43 / 0.71 | 0.60 / 0.62 | 0.00 / 0.00 | 0.12 / 0.21 | 9 |
| still water | break | 0.25 | 0.29 / 0.50 | 0.51 / 0.69 | 0.24 / 0.51 | 0.29 / 0.47 | 0.00 / 0.00 | 0.80 / 0.93 | 0 |
| **whole track** | | | 0.52 / 0.71 | 0.53 / 0.73 | 0.41 / 0.69 | 0.40 / 0.61 | 0.08 / 0.57 | 0.55 / 0.98 | 7.9 |

## The Lost Kingdom (`lost-kingdom`)

Maya: the bass thickens the jungle haze, the mids sway the vines and undergrowth, the treble lights pollen, sections move the sun shafts, and drops wake the old glow in the ruins.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | haze.density | body | ×0.168 |
| Large (bass, slow) | waterfall.flow | swell | ×0.14 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Medium (mids) | undergrowth.wind | motion | ×0.3 |
| Medium (mids) | lianas.sway | motion | ×0.3 |
| Medium (mids) | leaves.turbulence | flux | ×0.3 |
| Fine (treble) | pollen.brightness | detail | ×0.4 |
| Song structure | shafts.intensity | intensity | ×0.3 |
| Song structure | ruins.glow | tension | ×0.3 |
| Song structure | leaves.brightness | intensity | ×0.3 |
| Song structure | leaves.density | calm | ×-0.35 |
| Song structure | pollen.brightness | intensity | ×0.3 |
| Song structure | pollen.density | calm | ×-0.35 |
| Song structure | sky.glow | intensity | ×0.2 |
| Song structure | sky.exposure | intensity | ×0.14 |

| When | What | Limits |
|---|---|---|
| music drop | ruins.glow swells ×0.8 | cooldown 40 s |
| music drop | a wave through the world (0.4) | cooldown 45 s |
| every 45–90 s | quetzals pass | group fauna, cooldown 20 s |
| every 45–90 s | macaws burst {"strength":0.5} | group fauna, cooldown 20 s |

Measured on "Under the Ceiba" (84 BPM, first 217 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| mist on the plaza | intro | 0.18 | 0.51 / 0.73 | 0.63 / 0.92 | 0.44 / 0.66 | 0.19 / 0.23 | 0.00 / 0.00 | 0.97 / 1.00 | 0 |
| procession | verse | 0.40 | 0.56 / 0.79 | 0.50 / 0.71 | 0.45 / 0.73 | 0.39 / 0.42 | 0.00 / 0.00 | 0.59 / 0.80 | 36.7 |
| the steps | verse | 0.52 | 0.62 / 0.72 | 0.48 / 0.69 | 0.44 / 0.70 | 0.48 / 0.50 | 0.00 / 0.00 | 0.38 / 0.47 | 44.6 |
| roots in the stone | bridge | 0.34 | 0.34 / 0.56 | 0.53 / 0.67 | 0.29 / 0.59 | 0.30 / 0.30 | 0.19 / 0.67 | 0.77 / 0.83 | 0 |
| gathering | build | 0.62 | 0.73 / 0.86 | 0.46 / 0.64 | 0.49 / 0.75 | 0.44 / 0.55 | 0.70 / 0.82 | 0.55 / 0.78 | 31.5 |
| the summit | drop | 0.80 | 0.60 / 0.71 | 0.50 / 0.73 | 0.42 / 0.68 | 0.62 / 0.64 | 0.00 / 0.00 | 0.07 / 0.09 | 34.1 |
| rain in the leaves | break | 0.26 | 0.18 / 0.32 | 0.44 / 0.67 | 0.24 / 0.61 | 0.23 / 0.33 | 0.00 / 0.00 | 0.89 / 0.99 | 5.3 |
| **whole track** | | | 0.52 / 0.74 | 0.51 / 0.72 | 0.40 / 0.68 | 0.41 / 0.62 | 0.06 / 0.07 | 0.53 / 0.96 | 26.5 |

## Deep Cosmos (`celestial-drift`)

Dark space: the bass swells the giant's atmosphere, the mids drift the nebula, the treble lights the stars and dust, phrases send faint waves of light through space and sections change the haze.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | giant.atmosphere | body | ×0.35 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Medium (mids) | nebula-haze.opacity | motion | ×0.2 |
| Medium (mids) | sky.nebula | motion | ×0.15 |
| Medium (mids) | star-dust.speed | energy | ×0.2 |
| Fine (treble) | sky.stars | detail | ×0.35 |
| Fine (treble) | star-dust.brightness | detail | ×0.4 |
| Song structure | leviathan.brightness | intensity | ×0.25 |
| Song structure | star-dust.brightness | intensity | ×0.3 |
| Song structure | star-dust.density | calm | ×-0.35 |
| Song structure | sky.glow | intensity | ×0.2 |
| Song structure | sky.exposure | intensity | ×0.14 |

| When | What | Limits |
|---|---|---|
| music phrase | a wave through the world (0.3) | chance 0.6, cooldown 16 s |
| music drop | a wave through the world (0.55) | cooldown 40 s |
| music drop | giant.atmosphere swells ×0.6 | cooldown 40 s |
| music section | nebula-haze.opacity swells ×0.4 | cooldown 30 s |
| every 70–140 s | leviathan-pass pass | cooldown 20 s |

Measured on "Leviathan of Stars" (84 BPM, first 149 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| event horizon | intro | 0.15 | 0.63 / 0.96 | 0.61 / 0.90 | 0.31 / 0.67 | 0.18 / 0.24 | 0.00 / 0.00 | 0.97 / 1.00 | 0 |
| drift | verse | 0.40 | 0.54 / 0.75 | 0.52 / 0.68 | 0.47 / 0.69 | 0.40 / 0.42 | 0.10 / 0.47 | 0.58 / 0.78 | 36.7 |
| gravity well | build | 0.65 | 0.57 / 0.79 | 0.52 / 0.69 | 0.58 / 0.72 | 0.46 / 0.49 | 0.61 / 0.80 | 0.48 / 0.52 | 42 |
| leviathan | drop | 0.85 | 0.55 / 0.67 | 0.54 / 0.65 | 0.45 / 0.65 | 0.66 / 0.69 | 0.00 / 0.00 | 0.03 / 0.13 | 43.3 |
| starfall | break | 0.25 | 0.39 / 0.73 | 0.42 / 0.66 | 0.20 / 0.56 | 0.31 / 0.52 | 0.00 / 0.00 | 0.77 / 0.92 | 0 |
| **whole track** | | | 0.54 / 0.76 | 0.52 / 0.69 | 0.41 / 0.67 | 0.44 / 0.67 | 0.08 / 0.45 | 0.49 / 0.97 | 27.9 |

## Alpine Horizon (`alpine-horizon`)

Mountains: the bass lifts the sky light slowly, the mids stir the meadow pollen, the treble catches it, sections change the light and visitors come and go: an eagle, the does.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | sky.glow | swell | ×0.14 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Medium (mids) | pollen.turbulence | motion | ×0.35 |
| Medium (mids) | pollen.speed | energy | ×0.2 |
| Fine (treble) | pollen.brightness | detail | ×0.35 |
| Song structure | pollen.density | intensity | ×0.3 |
| Song structure | eagles.pace | intensity | ×0.2 |
| Song structure | pollen.brightness | intensity | ×0.3 |
| Song structure | pollen.density | calm | ×-0.35 |
| Song structure | sky.glow | intensity | ×0.2 |
| Song structure | sky.exposure | intensity | ×0.14 |

| When | What | Limits |
|---|---|---|
| music section | sky.glow swells ×0.25 | cooldown 40 s |
| music drop | a wave through the world (0.4) | cooldown 45 s |
| every 50–100 s | eagles pass | group visitors, cooldown 20 s |
| every 50–100 s | does show {"seconds":2.5,"hold":20} | group visitors, cooldown 20 s |

Measured on "Above the Treeline" (88 BPM, first 142 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| first light | intro | 0.15 | 0.48 / 0.75 | 0.60 / 0.95 | 0.45 / 0.71 | 0.18 / 0.22 | 0.00 / 0.00 | 0.99 / 1.00 | 0 |
| valley | verse | 0.42 | 0.57 / 0.68 | 0.54 / 0.68 | 0.45 / 0.70 | 0.34 / 0.36 | 0.10 / 0.47 | 0.70 / 0.89 | 0 |
| ascent | build | 0.65 | 0.77 / 0.83 | 0.48 / 0.62 | 0.51 / 0.77 | 0.45 / 0.50 | 0.69 / 0.81 | 0.50 / 0.64 | 0 |
| summit | drop | 0.85 | 0.48 / 0.68 | 0.54 / 0.65 | 0.48 / 0.72 | 0.61 / 0.63 | 0.00 / 0.00 | 0.11 / 0.19 | 9.6 |
| high meadow | break | 0.25 | 0.33 / 0.67 | 0.47 / 0.65 | 0.24 / 0.60 | 0.30 / 0.51 | 0.00 / 0.00 | 0.77 / 0.92 | 0 |
| **whole track** | | | 0.50 / 0.74 | 0.53 / 0.68 | 0.43 / 0.70 | 0.40 / 0.62 | 0.08 / 0.56 | 0.56 / 0.99 | 3 |

## The Abyss (`the-abyss`)

The deep: the bass breathes in the light shafts and the seafloor, the mids pulse the jellies and glowing schools, the treble lights the plankton, and at the music's peak a vortex of glowing fish rings the board.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | light-shafts.intensity | swell | ×0.42 |
| Large (bass, slow) | seafloor.glow | body | ×0.21 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Medium (mids) | jellyfish.glow | motion | ×0.3 |
| Medium (mids) | glow-fish-left.brightness | motion | ×0.25 |
| Medium (mids) | glow-fish-right.brightness | motion | ×0.25 |
| Medium (mids) | marine-snow.turbulence | flux | ×0.3 |
| Fine (treble) | plankton.brightness | detail | ×0.45 |
| Fine (treble) | marine-snow.brightness | detail | ×0.25 |
| Song structure | blue-whale.pace | intensity | ×0.15 |
| Song structure | marine-snow.brightness | intensity | ×0.3 |
| Song structure | marine-snow.density | calm | ×-0.35 |
| Song structure | plankton.brightness | intensity | ×0.3 |
| Song structure | plankton.density | calm | ×-0.35 |
| Song structure | sky.glow | intensity | ×0.2 |
| Song structure | sky.exposure | intensity | ×0.14 |
| Song structure | seafloor.light | intensity | ×0.12 |

| When | What | Limits |
|---|---|---|
| music drop | a wave through the world (0.45) | cooldown 45 s |
| music peak | climax-vortex reveal {"hold":14} | cooldown 90 s |
| music section | light-shafts.intensity swells ×0.5 | cooldown 30 s |
| every 60–120 s | great-white pass | group deep, cooldown 20 s |
| every 60–120 s | eagle-rays show {"seconds":2.5,"hold":18} | group deep, cooldown 20 s |

Measured on "Pressure and Light" (72 BPM, first 173 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| descent | intro | 0.15 | 0.53 / 0.77 | 0.53 / 0.84 | 0.25 / 0.69 | 0.17 / 0.22 | 0.00 / 0.00 | 0.99 / 1.00 | 0 |
| reef | verse | 0.42 | 0.57 / 0.77 | 0.53 / 0.74 | 0.25 / 0.55 | 0.35 / 0.37 | 0.10 / 0.49 | 0.68 / 0.83 | 1.1 |
| current | build | 0.62 | 0.52 / 0.82 | 0.55 / 0.66 | 0.53 / 0.72 | 0.42 / 0.46 | 0.72 / 0.85 | 0.54 / 0.61 | 4.5 |
| bioluminescence | drop | 0.82 | 0.53 / 0.70 | 0.53 / 0.67 | 0.35 / 0.58 | 0.58 / 0.59 | 0.00 / 0.00 | 0.17 / 0.20 | 3.4 |
| stillness | break | 0.22 | 0.28 / 0.44 | 0.41 / 0.69 | 0.28 / 0.71 | 0.28 / 0.47 | 0.00 / 0.00 | 0.82 / 0.97 | 0 |
| **whole track** | | | 0.50 / 0.73 | 0.51 / 0.73 | 0.31 / 0.64 | 0.39 / 0.59 | 0.09 / 0.59 | 0.58 / 0.99 | 1.7 |

## Enchanted Wilderness (`enchanted-wilderness`)

Forest: the bass moves the mist gently, the mids stir the spores, the treble lights the fireflies, which grow busier in quiet passages, and sections shift the forest light.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | forest-mist.opacity | body | ×0.21 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Medium (mids) | spores.turbulence | motion | ×0.35 |
| Fine (treble) | spores.brightness | detail | ×0.35 |
| Fine (treble) | fireflies.brightness | detail | ×0.35 |
| Song structure | fireflies.activity | calm | ×0.4 |
| Song structure | sky.glow | intensity | ×0.12 |
| Song structure | spores.brightness | intensity | ×0.3 |
| Song structure | spores.density | calm | ×-0.35 |
| Song structure | sky.exposure | intensity | ×0.14 |

| When | What | Limits |
|---|---|---|
| music section | sky.glow swells ×0.2 | cooldown 40 s |
| music drop | a wave through the world (0.35) | cooldown 45 s |
| every 50–100 s | owl pass | group visitors, cooldown 20 s |
| every 50–100 s | red-deer burst {"strength":0.5} | group visitors, cooldown 20 s |

Measured on "Where the Fireflies Gather" (90 BPM, first 139 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| dusk canopy | intro | 0.15 | 0.54 / 0.76 | 0.62 / 0.95 | 0.42 / 0.70 | 0.18 / 0.23 | 0.00 / 0.00 | 0.98 / 1.00 | 0 |
| deep woods | verse | 0.42 | 0.52 / 0.80 | 0.53 / 0.66 | 0.43 / 0.77 | 0.37 / 0.41 | 0.10 / 0.46 | 0.63 / 0.82 | 19.7 |
| gathering light | build | 0.62 | 0.59 / 0.86 | 0.51 / 0.63 | 0.51 / 0.79 | 0.47 / 0.52 | 0.69 / 0.81 | 0.46 / 0.57 | 45 |
| firefly bloom | drop | 0.84 | 0.53 / 0.77 | 0.55 / 0.67 | 0.44 / 0.75 | 0.64 / 0.66 | 0.00 / 0.00 | 0.04 / 0.12 | 30.9 |
| moss and starlight | break | 0.24 | 0.28 / 0.64 | 0.49 / 0.64 | 0.20 / 0.59 | 0.31 / 0.53 | 0.00 / 0.00 | 0.77 / 0.93 | 0 |
| **whole track** | | | 0.49 / 0.77 | 0.54 / 0.68 | 0.41 / 0.74 | 0.42 / 0.65 | 0.08 / 0.56 | 0.51 / 0.98 | 19 |

## Ember Foundry (`ember-foundry`)

Machine hall: the bass heats the molten channel, the mids light the hall, the treble throws sparks, sections set the machines working harder, and now and then the arms strike on a downbeat.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | molten-channel.heat | body | ×0.42 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Medium (mids) | hall.emissive | motion | ×0.3 |
| Fine (treble) | anvil-sparks.amount | detail | ×0.4 |
| Fine (treble) | embers.brightness | detail | ×0.4 |
| Song structure | smoke.opacity | intensity | ×0.2 |
| Song structure | robot-arms.pace | intensity | ×0.3 |
| Song structure | embers.brightness | intensity | ×0.3 |
| Song structure | embers.density | calm | ×-0.35 |
| Song structure | sky.glow | intensity | ×0.2 |
| Song structure | sky.exposure | intensity | ×0.14 |

| When | What | Limits |
|---|---|---|
| music downbeat | robot-arms clip {"clip":"Take 001","speed":2,"fade":0.3,"stagger":0.12} | chance 0.25, cooldown 6 s |
| music drop | hall.emissive swells ×0.6 | cooldown 30 s |
| music drop | a wave through the world (0.4) | cooldown 45 s |

Measured on "Anvil Pulse" (128 BPM, first 105 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| ignition | intro | 0.30 | 0.79 / 0.91 | 0.60 / 0.69 | 0.55 / 0.69 | 0.31 / 0.42 | 0.00 / 0.00 | 0.83 / 1.00 | 68.1 |
| press | verse | 0.55 | 0.67 / 0.71 | 0.59 / 0.75 | 0.69 / 0.82 | 0.55 / 0.58 | 0.09 / 0.41 | 0.25 / 0.48 | 68 |
| heat | build | 0.75 | 0.69 / 0.78 | 0.61 / 0.70 | 0.65 / 0.76 | 0.65 / 0.68 | 0.73 / 0.89 | 0.07 / 0.19 | 68 |
| molten | drop | 0.95 | 0.65 / 0.70 | 0.54 / 0.65 | 0.59 / 0.73 | 0.77 / 0.79 | 0.01 / 0.00 | 0.00 / 0.00 | 64 |
| cooling | break | 0.40 | 0.36 / 0.65 | 0.47 / 0.67 | 0.27 / 0.65 | 0.50 / 0.72 | 0.00 / 0.00 | 0.61 / 0.70 | 44 |
| **whole track** | | | 0.64 / 0.77 | 0.56 / 0.69 | 0.57 / 0.77 | 0.58 / 0.77 | 0.13 / 0.67 | 0.28 / 0.72 | 63.4 |

## Ember Core (`ember-core`)

Volcanic: the bass drives the lava glow and the crater, the mids stir the ash, the treble lights sparks and embers, builds thicken the heat haze and drops stoke the eruption.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | lava-fields.glow | body | ×0.42 |
| Large (bass, slow) | crater-glow.opacity | body | ×0.35 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Medium (mids) | ash.turbulence | motion | ×0.3 |
| Medium (mids) | embers.speed | energy | ×0.25 |
| Fine (treble) | embers.brightness | detail | ×0.45 |
| Song structure | heat-smoke.opacity | tension | ×0.3 |
| Song structure | eruption.amount | intensity | ×0.4 |
| Song structure | ash.brightness | intensity | ×0.3 |
| Song structure | ash.density | calm | ×-0.35 |
| Song structure | embers.brightness | intensity | ×0.3 |
| Song structure | embers.density | calm | ×-0.35 |
| Song structure | sky.glow | intensity | ×0.2 |
| Song structure | sky.exposure | intensity | ×0.14 |
| Song structure | lava-fields.light | intensity | ×0.12 |

| When | What | Limits |
|---|---|---|
| music build | crater-glow.opacity swells ×0.5 | cooldown 40 s |
| music drop | eruption.amount swells ×1 | cooldown 30 s |
| music drop | a wave through the world (0.5) | cooldown 45 s |
| music peak | fire-streaks burst {"count":3} | cooldown 45 s |
| every 30–60 s | fire-streaks burst {"count":1} | cooldown 20 s |

Measured on "Heart of the Mountain" (112 BPM, first 111 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| deep fire | intro | 0.20 | 0.68 / 0.94 | 0.64 / 0.89 | 0.34 / 0.64 | 0.26 / 0.33 | 0.00 / 0.00 | 0.85 / 1.00 | 45.5 |
| magma | verse | 0.45 | 0.61 / 0.70 | 0.50 / 0.61 | 0.49 / 0.71 | 0.45 / 0.48 | 0.09 / 0.43 | 0.47 / 0.66 | 56 |
| pressure | build | 0.68 | 0.37 / 0.56 | 0.56 / 0.68 | 0.51 / 0.79 | 0.48 / 0.52 | 0.67 / 0.78 | 0.40 / 0.44 | 28 |
| eruption | drop | 0.90 | 0.63 / 0.72 | 0.53 / 0.65 | 0.58 / 0.76 | 0.72 / 0.74 | 0.00 / 0.00 | 0.03 / 0.11 | 56 |
| cooling | break | 0.28 | 0.39 / 0.66 | 0.39 / 0.66 | 0.14 / 0.30 | 0.28 / 0.48 | 0.00 / 0.00 | 0.84 / 0.98 | 0 |
| **whole track** | | | 0.57 / 0.73 | 0.52 / 0.68 | 0.44 / 0.73 | 0.48 / 0.74 | 0.08 / 0.53 | 0.45 / 0.96 | 43.6 |

## Northern Lights (`northern-lights`)

Aurora: the bass moves the main curtains, the mids light the far aurora and the sky, the treble lights the stars and snow, phrases send light along the curtains and drops flare the far bands.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | aurora-main.intensity | swell | ×0.42 |
| Large (bass, slow) | aurora-main.speed | body | ×0.35 |
| Large (bass, slow) | mirror-lake.glow | swell | ×0.21 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Medium (mids) | aurora-far.intensity | motion | ×0.25 |
| Medium (mids) | sky.glow | motion | ×0.12 |
| Fine (treble) | sky.stars | detail | ×0.35 |
| Fine (treble) | snow.brightness | detail | ×0.3 |
| Song structure | snow.brightness | intensity | ×0.3 |
| Song structure | snow.density | calm | ×-0.35 |
| Song structure | sky.glow | intensity | ×0.2 |
| Song structure | sky.exposure | intensity | ×0.14 |
| Song structure | tundra.light | intensity | ×0.12 |

| When | What | Limits |
|---|---|---|
| music phrase | aurora-main.intensity swells ×0.5 | chance 0.5, cooldown 20 s |
| music drop | aurora-far.intensity swells ×0.8 | cooldown 40 s |
| music drop | a wave through the world (0.45) | cooldown 45 s |
| every 30–70 s | meteors burst {"count":1} | cooldown 20 s |

Measured on "Curtains of the Sky" (80 BPM, first 156 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| polar night | intro | 0.15 | 0.41 / 0.71 | 0.61 / 0.95 | 0.36 / 0.60 | 0.18 / 0.22 | 0.00 / 0.00 | 0.99 / 1.00 | 0 |
| first glow | verse | 0.40 | 0.46 / 0.85 | 0.53 / 0.67 | 0.37 / 0.71 | 0.36 / 0.38 | 0.10 / 0.48 | 0.66 / 0.85 | 16.3 |
| rising curtains | build | 0.62 | 0.26 / 0.66 | 0.49 / 0.61 | 0.54 / 0.82 | 0.45 / 0.49 | 0.70 / 0.83 | 0.49 / 0.60 | 45 |
| corona | drop | 0.82 | 0.64 / 0.79 | 0.55 / 0.67 | 0.47 / 0.72 | 0.65 / 0.67 | 0.00 / 0.00 | 0.03 / 0.11 | 41.3 |
| after light | break | 0.22 | 0.27 / 0.64 | 0.49 / 0.66 | 0.19 / 0.50 | 0.29 / 0.52 | 0.00 / 0.00 | 0.81 / 0.98 | 0 |
| **whole track** | | | 0.47 / 0.77 | 0.54 / 0.68 | 0.39 / 0.71 | 0.42 / 0.66 | 0.09 / 0.58 | 0.53 / 1.00 | 21.2 |

## Future Nights (`future-nights`)

Neon city: the bass lights the river, the mids move the traffic, the treble lights the aircraft and the rain, and some downbeats send a soft wash of light over the water.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | river.glow | body | ×0.35 |
| Large (bass, slow) | river.amplitude | swell | ×0.21 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Medium (mids) | traffic.brightness | motion | ×0.25 |
| Medium (mids) | traffic.lamps | motion | ×0.15 |
| Fine (treble) | aircraft.brightness | detail | ×0.35 |
| Fine (treble) | rain.brightness | detail | ×0.35 |
| Beat | splashes.brightness | accent | ×0.5 |
| Song structure | rain.brightness | intensity | ×0.3 |
| Song structure | rain.density | calm | ×-0.35 |
| Song structure | splashes.brightness | intensity | ×0.3 |
| Song structure | splashes.density | calm | ×-0.35 |
| Song structure | sky.glow | intensity | ×0.2 |
| Song structure | sky.exposure | intensity | ×0.14 |

| When | What | Limits |
|---|---|---|
| music downbeat | river.glow swells ×0.3 | chance 0.3, cooldown 4 s |
| music section | sky.glow swells ×0.25 | cooldown 30 s |
| music drop | a wave through the world (0.5) | cooldown 45 s |

Measured on "Afterglow District" (118 BPM, first 106 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| rain on glass | intro | 0.20 | 0.65 / 0.95 | 0.65 / 0.97 | 0.63 / 0.83 | 0.23 / 0.29 | 0.00 / 0.00 | 0.90 / 1.00 | 18.4 |
| streetlights | verse | 0.45 | 0.66 / 0.70 | 0.53 / 0.63 | 0.60 / 0.79 | 0.49 / 0.53 | 0.09 / 0.42 | 0.38 / 0.73 | 83 |
| overpass | build | 0.68 | 0.70 / 0.84 | 0.58 / 0.70 | 0.52 / 0.72 | 0.58 / 0.61 | 0.66 / 0.78 | 0.20 / 0.27 | 66.4 |
| neon rush | drop | 0.90 | 0.59 / 0.65 | 0.53 / 0.61 | 0.62 / 0.78 | 0.75 / 0.77 | 0.00 / 0.00 | 0.01 / 0.02 | 79.3 |
| last train | break | 0.28 | 0.45 / 0.73 | 0.47 / 0.64 | 0.39 / 0.65 | 0.41 / 0.67 | 0.00 / 0.00 | 0.63 / 0.75 | 7.4 |
| **whole track** | | | 0.61 / 0.74 | 0.54 / 0.66 | 0.57 / 0.78 | 0.53 / 0.77 | 0.08 / 0.52 | 0.37 / 0.83 | 59 |

## Dead Acre (`dead-acre`)

Dead Acre: the bass rolls the ground fog, the mids make the yard lamps hum brighter, sections quicken the horde, and bats come and go.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | ground-fog.density | swell | ×0.168 |
| Large (bass, slow) | ground-fog.drift | body | ×0.28 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Medium (mids) | lamps.glow | motion | ×0.25 |
| Song structure | horde.tempo | intensity | ×0.15 |
| Song structure | sky.glow | intensity | ×0.2 |
| Song structure | sky.exposure | intensity | ×0.14 |

| When | What | Limits |
|---|---|---|
| music drop | a wave through the world (0.3) | cooldown 45 s |
| every 60–120 s | bats pass | cooldown 20 s |

Measured on "Fog Line" (64 BPM, first 180 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| mist | intro | 0.12 | 0.73 / 0.94 | 0.69 / 0.91 | 0.21 / 0.58 | 0.17 / 0.23 | 0.00 / 0.00 | 0.98 / 1.00 | 12 |
| the field | verse | 0.34 | 0.49 / 0.65 | 0.44 / 0.61 | 0.24 / 0.58 | 0.31 / 0.33 | 0.00 / 0.00 | 0.77 / 0.90 | 16 |
| shapes in the grey | verse | 0.48 | 0.52 / 0.65 | 0.47 / 0.62 | 0.42 / 0.63 | 0.43 / 0.45 | 0.20 / 0.70 | 0.51 / 0.67 | 32 |
| closer | build | 0.70 | 0.53 / 0.66 | 0.53 / 0.65 | 0.47 / 0.66 | 0.53 / 0.56 | 0.74 / 0.89 | 0.31 / 0.46 | 32 |
| lights out | drop | 0.92 | 0.57 / 0.68 | 0.48 / 0.59 | 0.48 / 0.65 | 0.69 / 0.72 | 0.01 / 0.00 | 0.03 / 0.12 | 44 |
| silence | break | 0.20 | 0.43 / 0.65 | 0.29 / 0.57 | 0.10 / 0.27 | 0.36 / 0.64 | 0.41 / 0.80 | 0.69 / 0.91 | 16 |
| they are here | drop | 0.88 | 0.60 / 0.71 | 0.55 / 0.75 | 0.55 / 0.71 | 0.63 / 0.70 | 0.00 / 0.00 | 0.17 / 0.75 | 46 |
| fog returns | outro | 0.30 | 0.48 / 0.70 | 0.38 / 0.66 | 0.27 / 0.47 | 0.43 / 0.64 | 0.00 / 0.00 | 0.61 / 0.70 | 28 |
| **whole track** | | | 0.55 / 0.71 | 0.48 / 0.67 | 0.37 / 0.64 | 0.47 / 0.71 | 0.13 / 0.65 | 0.46 / 0.92 | 30.3 |

## The Veil (`the-veil`)

The Veil: the bass moves the fog slowly, the mids light the distant mist, the treble stirs the fine drift, and at the music's peaks something large shows itself out in the fog.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | atmosphere.density | swell | ×0.168 |
| Large (bass, slow) | atmosphere.drift | body | ×0.28 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Medium (mids) | mist.glow | motion | ×0.25 |
| Medium (mids) | atmosphere.lights | motion | ×0.2 |
| Fine (treble) | atmosphere.fineDrift | detail | ×0.25 |
| Song structure | sky.glow | intensity | ×0.2 |
| Song structure | sky.exposure | intensity | ×0.14 |

| When | What | Limits |
|---|---|---|
| music peak | atmosphere show {"kinds":["silhouette"]} | cooldown 90 s |
| every 70–150 s | atmosphere show {"kinds":["swarm"]} | group veil, cooldown 20 s |
| every 70–150 s | atmosphere show {"kinds":["bankRoll"]} | group veil, cooldown 20 s |

Class overrides: `atmosphere.fineDrift` → motion.

Measured on "Beyond the Mist" (58 BPM, first 300 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| still water | intro | 0.10 | 0.53 / 0.95 | 0.46 / 0.90 | 0.08 / 0.37 | 0.15 / 0.21 | 0.00 / 0.00 | 1.00 / 1.00 | 0 |
| the drowned wood | verse | 0.30 | 0.52 / 0.73 | 0.53 / 0.73 | 0.14 / 0.46 | 0.28 / 0.30 | 0.00 / 0.00 | 0.82 / 0.94 | 0 |
| shapes in the far fog | verse | 0.48 | 0.51 / 0.72 | 0.54 / 0.69 | 0.33 / 0.53 | 0.39 / 0.42 | 0.10 / 0.51 | 0.58 / 0.62 | 0 |
| something moves | build | 0.68 | 0.56 / 0.71 | 0.53 / 0.68 | 0.29 / 0.48 | 0.50 / 0.52 | 0.88 / 1.00 | 0.35 / 0.50 | 1.8 |
| the veil lifts | drop | 0.86 | 0.49 / 0.69 | 0.55 / 0.68 | 0.37 / 0.57 | 0.60 / 0.62 | 0.00 / 0.00 | 0.11 / 0.17 | 0 |
| it passes | break | 0.22 | 0.49 / 0.67 | 0.42 / 0.70 | 0.04 / 0.12 | 0.27 / 0.43 | 0.00 / 0.00 | 0.84 / 0.98 | 0 |
| deeper in | verse | 0.56 | 0.48 / 0.57 | 0.70 / 0.78 | 0.38 / 0.63 | 0.27 / 0.30 | 0.00 / 0.00 | 0.90 / 0.92 | 0 |
| **whole track** | | | 0.51 / 0.71 | 0.52 / 0.71 | 0.23 / 0.52 | 0.39 / 0.61 | 0.12 / 0.70 | 0.58 / 1.00 | 0.2 |

## Ashen Vigil (`ashen-vigil`)

Ashen Vigil: the bass breathes through the fire-lit sky, builds thicken the smoke, the treble shifts the falling ash, and very rarely a distant sun is born.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | sky.glow | swell | ×0.168 |
| Large (bass, slow) | sky.fire | body | ×0.28 |
| Fine (treble) | ash.opacity | detail | ×0.15 |
| Song structure | smoke-layers.opacity | tension | ×0.2 |

| When | What | Limits |
|---|---|---|
| every 150–300 s | detonations burst | cooldown 20 s |

Measured on "Witness" (66 BPM, first 211 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| dusk | intro | 0.15 | 0.55 / 0.96 | 0.57 / 0.79 | 0.02 / 0.02 | 0.18 / 0.23 | 0.00 / 0.00 | 0.98 / 1.00 | 0 |
| the plain | verse | 0.36 | 0.49 / 0.64 | 0.51 / 0.66 | 0.35 / 0.59 | 0.34 / 0.37 | 0.00 / 0.00 | 0.70 / 0.86 | 22 |
| first light | verse | 0.50 | 0.53 / 0.68 | 0.52 / 0.63 | 0.31 / 0.51 | 0.42 / 0.45 | 0.14 / 0.60 | 0.52 / 0.63 | 19.3 |
| ascent | build | 0.70 | 0.51 / 0.63 | 0.56 / 0.69 | 0.45 / 0.74 | 0.49 / 0.53 | 0.73 / 0.88 | 0.37 / 0.46 | 0 |
| witness | drop | 0.88 | 0.52 / 0.63 | 0.53 / 0.66 | 0.42 / 0.64 | 0.64 / 0.66 | 0.00 / 0.00 | 0.05 / 0.19 | 22 |
| ash | break | 0.24 | 0.46 / 0.68 | 0.40 / 0.62 | 0.01 / 0.07 | 0.30 / 0.52 | 0.00 / 0.00 | 0.77 / 0.94 | 0 |
| vigil | outro | 0.30 | 0.45 / 0.64 | 0.58 / 0.76 | 0.38 / 0.54 | 0.30 / 0.33 | 0.00 / 0.00 | 0.80 / 0.88 | 8.2 |
| **whole track** | | | 0.51 / 0.67 | 0.52 / 0.67 | 0.29 / 0.58 | 0.40 / 0.65 | 0.08 / 0.45 | 0.56 / 0.98 | 13.7 |

## The Warden's Spire (`wardens-spire`)

The tower: the bass drives the heat in the land and the sky's glow, sections set the sentinels' pace, builds gather the storm and drops roll a front of heat across the land.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | land.heat | body | ×0.35 |
| Large (bass, slow) | sky.glow | swell | ×0.21 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Song structure | sentinels.pace | intensity | ×0.2 |
| Song structure | sky.glow | intensity | ×0.2 |
| Song structure | sky.exposure | intensity | ×0.14 |

| When | What | Limits |
|---|---|---|
| music peak | storm burst | cooldown 40 s |
| music drop | a wave through the world (0.45) | cooldown 45 s |
| every 40–90 s | storm burst | cooldown 20 s |

Measured on "The Sleepless Watch" (70 BPM, first 165 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| ash on the wind | intro | 0.14 | 0.68 / 0.96 | 0.71 / 0.95 | 0.31 / 0.59 | 0.18 / 0.25 | 0.00 / 0.00 | 0.96 / 1.00 | 13.1 |
| the vigil | verse | 0.34 | 0.50 / 0.67 | 0.48 / 0.63 | 0.29 / 0.53 | 0.33 / 0.36 | 0.00 / 0.00 | 0.72 / 0.86 | 21.9 |
| the turning rings | verse | 0.50 | 0.48 / 0.67 | 0.49 / 0.62 | 0.33 / 0.56 | 0.42 / 0.46 | 0.20 / 0.69 | 0.52 / 0.65 | 19.7 |
| the gaze turns | build | 0.72 | 0.56 / 0.71 | 0.52 / 0.67 | 0.45 / 0.64 | 0.53 / 0.58 | 0.72 / 0.86 | 0.31 / 0.49 | 26.2 |
| the warden wakes | drop | 0.95 | 0.55 / 0.70 | 0.48 / 0.60 | 0.44 / 0.67 | 0.68 / 0.72 | 0.01 / 0.00 | 0.03 / 0.13 | 21.9 |
| embers | break | 0.22 | 0.42 / 0.57 | 0.26 / 0.54 | 0.15 / 0.36 | 0.37 / 0.62 | 0.40 / 0.79 | 0.66 / 0.90 | 8.7 |
| the black citadel | drop | 0.90 | 0.58 / 0.71 | 0.53 / 0.72 | 0.51 / 0.72 | 0.61 / 0.69 | 0.01 / 0.00 | 0.20 / 0.78 | 28.4 |
| the long dark | outro | 0.30 | 0.47 / 0.65 | 0.39 / 0.65 | 0.20 / 0.42 | 0.41 / 0.63 | 0.00 / 0.00 | 0.62 / 0.77 | 13.1 |
| **whole track** | | | 0.53 / 0.71 | 0.49 / 0.66 | 0.36 / 0.62 | 0.47 / 0.69 | 0.13 / 0.65 | 0.46 / 0.90 | 20.4 |

## Red Horizon (`red-horizon`)

Machine war: the bass sets the walkers' stride, the mids the patrols, the treble the sparks and embers, sections raise the distant explosions and drops make the machines take notice.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | walkers.pace | body | ×0.28 |
| Large (bass, slow) | sky.glow | swell | ×0.168 |
| Medium (mids) | machines.pace | motion | ×0.25 |
| Medium (mids) | ash.turbulence | motion | ×0.3 |
| Fine (treble) | embers.brightness | detail | ×0.45 |
| Song structure | explosions.rate | intensity | ×0.4 |
| Song structure | ash.brightness | intensity | ×0.3 |
| Song structure | ash.density | calm | ×-0.35 |
| Song structure | embers.brightness | intensity | ×0.3 |
| Song structure | embers.density | calm | ×-0.35 |

| When | What | Limits |
|---|---|---|
| music drop | machines burst | cooldown 30 s |
| music drop | a wave through the world (0.4) | cooldown 45 s |

Class overrides: `explosions.rate` → events, `smoke.rate` → atmosphere.

Measured on "Iron Meridian" (96 BPM, first 140 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| cold start | intro | 0.25 | 0.64 / 0.97 | 0.63 / 0.95 | 0.32 / 0.77 | 0.23 / 0.28 | 0.00 / 0.00 | 0.90 / 1.00 | 0 |
| patrol | verse | 0.50 | 0.62 / 0.73 | 0.52 / 0.67 | 0.53 / 0.79 | 0.48 / 0.51 | 0.09 / 0.45 | 0.41 / 0.69 | 66 |
| assembly | build | 0.72 | 0.60 / 0.71 | 0.48 / 0.62 | 0.56 / 0.79 | 0.59 / 0.62 | 0.80 / 0.99 | 0.15 / 0.30 | 60 |
| red horizon | drop | 0.95 | 0.64 / 0.79 | 0.52 / 0.67 | 0.51 / 0.75 | 0.74 / 0.76 | 0.00 / 0.00 | 0.01 / 0.02 | 61.5 |
| smoke | break | 0.35 | 0.53 / 0.71 | 0.47 / 0.64 | 0.20 / 0.45 | 0.42 / 0.64 | 0.00 / 0.00 | 0.63 / 0.70 | 0 |
| **whole track** | | | 0.61 / 0.77 | 0.52 / 0.68 | 0.45 / 0.76 | 0.52 / 0.75 | 0.14 / 0.72 | 0.36 / 0.85 | 45 |

## Folded Sky (`folded-sky`)

Folded Sky: the mids agitate the murmuration, sections quicken it, the treble lights the seeds, phrases now and then turn the whole flock, and a gull glides by.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | sky.glow | swell | ×0.14 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Medium (mids) | murmuration.agitation | motion | ×0.4 |
| Medium (mids) | seeds.turbulence | flux | ×0.3 |
| Fine (treble) | seeds.brightness | detail | ×0.35 |
| Song structure | murmuration.tempo | intensity | ×0.2 |
| Song structure | seeds.brightness | intensity | ×0.3 |
| Song structure | seeds.density | calm | ×-0.35 |
| Song structure | sky.glow | intensity | ×0.2 |
| Song structure | sky.exposure | intensity | ×0.14 |

| When | What | Limits |
|---|---|---|
| music phrase | murmuration burst {"falcon":false,"turns":1} | chance 0.35, cooldown 25 s |
| music drop | a wave through the world (0.4) | cooldown 45 s |
| every 50–100 s | gull pass | cooldown 20 s |

Measured on "Paper Wind" (136 BPM, first 92 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| unfold | intro | 0.20 | 0.56 / 0.72 | 0.70 / 0.95 | 0.50 / 0.72 | 0.19 / 0.25 | 0.00 / 0.00 | 0.96 / 1.00 | 0 |
| cranes | verse | 0.45 | 0.66 / 0.83 | 0.48 / 0.61 | 0.60 / 0.82 | 0.48 / 0.52 | 0.08 / 0.40 | 0.43 / 0.82 | 89.3 |
| updraft | build | 0.65 | 0.23 / 0.40 | 0.61 / 0.74 | 0.73 / 0.82 | 0.55 / 0.57 | 0.65 / 0.76 | 0.25 / 0.29 | 85.1 |
| thousand cranes | drop | 0.88 | 0.66 / 0.77 | 0.50 / 0.64 | 0.54 / 0.75 | 0.74 / 0.77 | 0.00 / 0.00 | 0.02 / 0.08 | 91.4 |
| settle | break | 0.25 | 0.25 / 0.42 | 0.54 / 0.66 | 0.21 / 0.45 | 0.39 / 0.69 | 0.00 / 0.00 | 0.66 / 0.88 | 0 |
| **whole track** | | | 0.55 / 0.77 | 0.54 / 0.70 | 0.52 / 0.78 | 0.51 / 0.77 | 0.08 / 0.50 | 0.41 / 0.93 | 62.1 |

## The Web (`the-web`)

The Web: the bass thickens the mist, the mids breathe through the webs, the treble lights the drifting silk dust, and section changes stir the spiders.

| Role | Layer target | Drive | Amount |
|---|---|---|---|
| Large (bass, slow) | mist.density | body | ×0.21 |
| Large (bass, slow) | sky.exposure | swell | ×0.04 |
| Medium (mids) | webs.breathe | motion | ×0.3 |
| Medium (mids) | dust.turbulence | flux | ×0.3 |
| Fine (treble) | dust.brightness | detail | ×0.4 |
| Song structure | dust.brightness | intensity | ×0.3 |
| Song structure | dust.density | calm | ×-0.35 |
| Song structure | sky.glow | intensity | ×0.2 |
| Song structure | sky.exposure | intensity | ×0.14 |

| When | What | Limits |
|---|---|---|
| music section | spiders show {"kinds":["tremble"]} | chance 0.5, cooldown 45 s |
| music drop | a wave through the world (0.35) | cooldown 45 s |
| every 50–110 s | bats pass | cooldown 20 s |

Class overrides: `webs.breathe` → motion.

Measured on "Silk and Shadow" (58 BPM, first 281 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| moonlight through the rose window | intro | 0.10 | 0.57 / 0.99 | 0.53 / 0.89 | 0.25 / 0.63 | 0.16 / 0.21 | 0.00 / 0.00 | 1.00 / 1.00 | 0 |
| the first threads | verse | 0.30 | 0.46 / 0.68 | 0.54 / 0.73 | 0.35 / 0.65 | 0.29 / 0.32 | 0.00 / 0.00 | 0.81 / 0.93 | 0 |
| across the nave | verse | 0.46 | 0.45 / 0.68 | 0.53 / 0.68 | 0.31 / 0.60 | 0.37 / 0.39 | 0.21 / 0.71 | 0.63 / 0.76 | 0 |
| something stirs above | build | 0.66 | 0.50 / 0.70 | 0.54 / 0.67 | 0.43 / 0.62 | 0.47 / 0.51 | 0.76 / 0.93 | 0.43 / 0.59 | 3.6 |
| the weaver wakes | drop | 0.84 | 0.50 / 0.64 | 0.50 / 0.69 | 0.34 / 0.59 | 0.60 / 0.62 | 0.00 / 0.00 | 0.12 / 0.22 | 8.5 |
| hanging still | break | 0.20 | 0.47 / 0.70 | 0.25 / 0.66 | 0.16 / 0.54 | 0.27 / 0.48 | 0.00 / 0.00 | 0.83 / 0.99 | 0 |
| deeper into the dark | bridge | 0.56 | 0.48 / 0.71 | 0.57 / 0.83 | 0.41 / 0.64 | 0.42 / 0.45 | 0.21 / 0.71 | 0.55 / 0.87 | 0 |
| crowned in silk | drop | 0.92 | 0.51 / 0.66 | 0.52 / 0.67 | 0.36 / 0.59 | 0.64 / 0.68 | 0.00 / 0.00 | 0.07 / 0.33 | 18.1 |
| back into shadow | outro | 0.26 | 0.38 / 0.65 | 0.42 / 0.61 | 0.23 / 0.54 | 0.35 / 0.59 | 0.00 / 0.00 | 0.69 / 0.85 | 0 |
| **whole track** | | | 0.48 / 0.69 | 0.50 / 0.71 | 0.33 / 0.61 | 0.41 / 0.64 | 0.10 / 0.56 | 0.54 / 0.99 | 3.8 |

## Dark Storm (`dark-storm`)

Dark Storm: the storm follows the song's sections in its own director; peaks add a strike, and rare distant flickers answer strong accents.

| When | What | Limits |
|---|---|---|
| music peak | lightning burst {"level":3} | cooldown 30 s |
| music accent | lightning burst {"level":1} | chance 0.15, cooldown 14 s |

Measured on "Black Squall" (68 BPM, first 300 s):

| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |
|---|---|---|---|---|---|---|---|---|---|
| the sky closes | intro | 0.12 | 0.57 / 0.97 | 0.51 / 0.90 | 0.05 / 0.17 | 0.17 / 0.22 | 0.00 / 0.00 | 0.99 / 1.00 | 2.1 |
| first rain | verse | 0.30 | 0.51 / 0.73 | 0.53 / 0.74 | 0.11 / 0.42 | 0.28 / 0.30 | 0.00 / 0.00 | 0.82 / 0.94 | 7.4 |
| the front arrives | verse | 0.46 | 0.52 / 0.71 | 0.51 / 0.68 | 0.34 / 0.52 | 0.39 / 0.42 | 0.10 / 0.49 | 0.58 / 0.63 | 6.4 |
| pressure falls | build | 0.70 | 0.57 / 0.71 | 0.54 / 0.68 | 0.34 / 0.54 | 0.51 / 0.56 | 0.86 / 1.00 | 0.33 / 0.52 | 8.5 |
| the storm breaks | drop | 0.88 | 0.53 / 0.72 | 0.55 / 0.68 | 0.34 / 0.54 | 0.64 / 0.66 | 0.00 / 0.00 | 0.04 / 0.11 | 14.9 |
| between flashes | break | 0.20 | 0.45 / 0.67 | 0.44 / 0.76 | 0.04 / 0.12 | 0.28 / 0.49 | 0.00 / 0.00 | 0.83 / 1.00 | 0 |
| the long night | verse | 0.56 | 0.50 / 0.69 | 0.53 / 0.68 | 0.35 / 0.52 | 0.44 / 0.48 | 0.00 / 0.00 | 0.48 / 0.66 | 6.5 |
| **whole track** | | | 0.52 / 0.73 | 0.52 / 0.72 | 0.24 / 0.50 | 0.41 / 0.64 | 0.10 / 0.61 | 0.55 / 0.99 | 7.4 |

## Worlds named in the brief that do not exist yet

The brief also names Tempest, The Simulation and The Arcane Academy. None of them exists in this build, so there is no profile for them. When one is built, it gets a `living.json` like the ones above; the brief's mappings for them are the starting point:

- **Tempest:** bass on the storm clouds, mids on the wind, treble on the rain and the electrical details, major sections calling distant lightning.
- **The Simulation:** bass on the large digital structures, mids on the data streams, treble on fine digital particles, beats on selected streams, transitions calling anomalies.
- **The Arcane Academy:** bass on the large magical structures, mids on the floating objects, treble on magical particles, sections on the magical light and distant lightning.

