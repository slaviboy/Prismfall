# Content guide

How to add a world (a stage) to Prismfall without touching engine code. Folded Sky (`content/stages/folded-sky/`) was added this way as a scalability test: every file it needs lives in its own folder, and no file under `src/` was changed for it. This guide uses it as the worked example from start to finish.

For the richest data-only example, read `content/stages/moving-sands/stage.json`: procedural dunes (`terrain`), Blender ruins snapped to the dunes (`gltfScene`), a camel caravan built from a Blender model and rig (`creatureHerd`), a themed line clear (`sandSpiral`) and a themed entrance (`sand`). Moving Sands has no `scatter` layer; for instanced props see Frozen Kingdom, Enchanted Wilderness or Folded Sky itself. Its far background is the one part that is not data-only: the stage module (`content/stages/moving-sands/stage.ts`) registers `sandsNightSky` (a generated night sky: airglow, a Milky Way with dust lanes, coloured twinkling stars, the slow turn of the sky) and `sandsFarDunes` (receding ridgelines of a generated dune sea, scanned kopjes and spindrift), with the dune geometry in plain TypeScript in `duneField.ts`.

Related documents: `BLENDER_PIPELINE.md` (models), `AUDIO_ASSETS.md` (music and sound), `ASSET_LICENSES.md` (origin and licence of every shipped file).

## 1. How stages are found

There is no registration list. `src/stages/registry.ts` discovers content with Vite `import.meta.glob`, so the file set is fixed when Vite builds the module graph:

| Pattern | What it provides |
|---|---|
| `/content/stages/*/stage.json` | core stage manifests |
| `/content/packs/*/pack.json`, `/content/packs/*/stages/*/stage.json` | optional content packs (none ship) |
| `/content/**/stage.ts` | stage modules, loaded lazily the first time the stage is prepared (shown or preloaded) |
| `/content/**/music/*.ts` | composition modules, loaded lazily |
| `/content/**/music/*.json` | file-track metadata (`track.json`) |
| `/content/**/*.{glb,gltf,png,jpg,jpeg,webp,avif,ogg,mp3,wav,flac,m4a,opus}` | asset URLs (hashed in production builds) |
| `/content/**/*.rig.json` | data files (creature rigs) |
| `/content/shared/reactivity/*.json` | shared reactivity profiles |
| `/content/campaigns/*.json` | campaigns (Voyage) |

Every manifest is validated (section 9). Valid stages are sorted by `order`, then by id. Invalid stages are kept with their errors and marked unavailable; they never stop the game from starting.

Paths inside a manifest are relative to the stage folder (`models/desert.glb`, `./music/main.ts`). A path that starts with `/content/` is absolute, which is how stages share files from `content/shared/` or reuse another stage's model (`/content/stages/frozen-kingdom/models/ice.glb`).

Only the file types above can be referenced. In particular, `ctx.assets.json()` serves only `*.rig.json` files; any other JSON outside a `music/` folder is not bundled.

## 2. Folder layout

```
content/
  campaigns/voyage.json            the Voyage campaign
  shared/
    blocks/*.glb                   block designs (blocks.py)
    creatures/*.glb, *.rig.json    rigged creatures (creatures.py)
    flora/flora.glb                instanced props (flora_kit.py)
    reactivity/*.json              reusable binding profiles
  stages/<id>/
    stage.json                     required: the manifest
    stage.ts                       optional: SDK module (custom components, effects, transitions)
    assets.json                    licence metadata for the folder (documentation)
    music/<track>.ts               composition tracks
    music/<track>.track.json       metadata for audio-file tracks
    models/*.glb                   stage models
    previews/thumb.jpg             stage-select artwork
```

Folded Sky contains exactly:

```
content/stages/folded-sky/
  stage.json
  stage.ts
  assets.json
  music/main.ts
  textures/montorfano_band.webp
  textures/montorfano_detail.webp
  previews/thumb.jpg
```

| File | Required | Notes |
|---|---|---|
| `stage.json` | yes | The folder name must equal the manifest `id` (kebab-case). |
| `stage.ts` | no | Only if the stage registers its own components, line-clear effects or transitions. Named by the manifest's `module` field. |
| `music/*.ts` | one per composition track | Referenced from `music.tracks[].src`. |
| `music/*.json` | for file tracks | Referenced from `music.tracks[].meta`; must be inside a `music/` folder to be bundled. |
| `models/*.glb` | if referenced | Any path works as long as the extension is in the asset list; `models/` is the convention. |
| `previews/thumb.jpg` | no | Missing thumbnail = validation warning; the stage select paints a card from the palette instead. |
| `assets.json` | by convention | No code reads it. `ASSET_LICENSES.md` is the inventory that the test suite checks. |

## 3. What content may import

`stage.ts` and `music/*.ts` may import only the public Content SDK (`@prismfall/sdk`) and three.js. `eslint.config.js` enforces this for `content/**/*.ts`:

```js
'no-restricted-imports': ['error', {
  patterns: [{ group: ['../../src/*', '../../../src/*', '**/src/**', '@/*'],
               message: 'Content may only import @prismfall/sdk, three and three/tsl.' }],
}],
```

The rule blocks anything that reaches into `src/`; it does not list allowed modules. three.js entry points are therefore fine: Folded Sky imports node materials from `three/webgpu` and TSL functions from `three/tsl`. `@prismfall/sdk` is an alias for `src/sdk/index.ts`, configured in `vite.config.ts`, `vitest.config.ts` and `tsconfig.app.json`.

The SDK exports:

| Export | Purpose |
|---|---|
| `defineStage`, `SDK_VERSION` | the stage module wrapper and the running SDK version |
| `z` | zod, for component parameter schemas |
| `zColor`, `zVec3`, `colorUniform`, `floatUniform`, `linear`, `seeded`, `scaledCount` | parameter types, TSL uniforms, sRGB-to-linear colour, deterministic random, quality-scaled counts |
| `frameUniforms` | per-frame TSL uniforms (time, music features, clear pulse, danger, fog density, flash limit, screen effects) |
| `frameUniforms.worldEvents` | the accessibility World events setting: 1 full, 0.5 calm, 0 off. Worlds with creatures or sudden events read it (The Veil: calm makes events rarer, further away and gentler and drops the sudden shadow events; off leaves only the fog weather) |
| `frameUniforms.weatherIntensity` | the Storm intensity setting (SDK 1.5): 0.55 subtle, 1 normal, 1.35 heavy, 1.7 extreme. Weather worlds scale rain, wind and lightning with it, never gameplay (Dark Storm) |
| `noBloom`, `additiveFog` | exclude a material from bloom; distance-fade an additive colour |
| `makeRecipeEffect`, `runRecipe`, `BASE_RECIPE`, `ClearRecipe` | line-clear particle recipes |
| `resolveBlockPreset`, `BLOCK_PRESETS` | block surface presets |
| `composition`, `hold`, `arp`, `bassline`, `beat`, `melody`, `stab`, `once` | the music composition DSL |
| types | `ComponentFactory`, `EnvironmentComponent`, `EnvironmentContext`, `EnvFrame`, `LineClearEffect`, `TransitionEffect`, `GroundField`, `WorldSounds`, `StageAssets`, `AudioFeatures`, `FileTrackMeta` and others (`src/sdk/index.ts`) |

### SDK versions

`src/sdk/version.ts` holds `SDK_VERSION = '1.5.0'`. Minor versions add API, major versions break it.

| Version | Added |
|---|---|
| 1.0 | the base API: everything not listed in a later row |
| 1.1 | themed transitions (`TransitionEffect`, `sdk.transitions`), `WorldSounds` (`ctx.sounds.emit('footstep', …)`), `additiveFog` |
| 1.2 | `GroundField.surface(x, z)` and `GroundField.setWaterLevel(y)` (the water component declares its surface so a VR viewer stands on it) |
| 1.3 | `ctx.shakeWorld(strength, seconds)`: a decaying tremor of the world root only (never the board, HUD or camera; off under reduced motion and in VR, scaled by the screen-effects setting), and `frameUniforms.screenEffects` (the screen-effects setting, 0 in VR) for screen-space world effects. Ashen Vigil uses both |
| 1.4 | creature world sounds: `ctx.sounds.emit()` accepts `skitter`, `crawl`, `silk` and `webHum` (see "World sounds" in section 9), and the `WorldSoundName` type |
| 1.5 | Weather (Dark Storm): `ctx.sounds.weather?.(state)` keeps rain and wind beds sounding (call it every frame or so with `rain` 0..1.5, `wind`, `gust` and an optional `surfaces` mix of water, rock, wood and foliage; the beds fade out soon after the calls stop), `ctx.sounds.storm?.(sound)` schedules a thunder `delay` seconds ahead on the audio clock or a lightning crack (`{ kind, x, y, z, distance, energy, delay, seed, strokes, channel, tag }`; `distance` is the apparent distance that shapes the sound and picks the near or distant thunder bus), and `frameUniforms.weatherIntensity` (the Storm intensity setting: 0.55 subtle, 1 normal, 1.35 heavy, 1.7 extreme). Rain, wind, distant thunder, nearby thunder and the crack each have their own bus and volume setting (Settings → Audio → Weather). 1.4 is reserved for parallel work and may land with other additions |

Two version checks exist:

- `stage.json` `requires.sdk` (default `^1.0.0`) is checked during validation. A mismatch makes the stage unavailable.
- `stage.ts` `sdkVersion` is checked when the module loads. A missing `^` is added, so `'1.1.0'` means `^1.1.0`. A mismatch throws, and the stage fails to load at that moment.

Ranges support `^x.y.z` (same major, not lower), `>=x.y.z`, an exact `x.y.z`, and `*`. Folded Sky's module declares `sdkVersion: '1.1.0'` because it registers a transition, and its manifest sets `requires.sdk` to `^1.1.0` to match. Always set `requires.sdk` to the same minimum as the module, so that an older build lists the stage as unavailable instead of failing when it loads.

## 4. Worked example, step 1: the manifest

Only a few fields are required: `schemaVersion` (1), `id`, `name`, `description`, `palette` (`accent`, `secondary`, `highlight`, `fog`), `lighting` (`key`, `rim`, `ambient`, `accents`), `environment.layers` (at least one) and `music.bpm` (30 to 300). Everything else has a default. Colours are `#rrggbb` strings. The minimal manifest used by the validation tests:

```json
{
  "schemaVersion": 1,
  "id": "test-stage",
  "name": "Test",
  "description": "",
  "palette": { "accent": "#ffffff", "secondary": "#ffffff", "highlight": "#ffffff", "fog": "#000000" },
  "lighting": {
    "key": { "color": "#ffffff", "intensity": 1, "azimuth": 0, "elevation": 30 },
    "rim": { "color": "#ffffff", "intensity": 1 },
    "ambient": { "sky": "#ffffff", "ground": "#000000", "intensity": 1 },
    "accents": []
  },
  "environment": { "layers": [{ "type": "sky" }] },
  "music": { "bpm": 100 }
}
```

The top of Folded Sky's manifest:

```json
{
  "schemaVersion": 1,
  "id": "folded-sky",
  "name": "Folded Sky",
  "description": "A granite summit above two lakes, under a sky folded into sweeping cirrus. Seeds drift on the wind, and cleared lines fold into paper cranes.",
  "order": 70,
  "tags": ["sky", "lakes", "mountains", "content-pack"],
  "module": "stage.ts",
  "palette": { "accent": "#f0e2c8", "secondary": "#7aa6d8", "highlight": "#fffaf0", "fog": "#c8d4e2", "plate": "#0c0f14" },
  "fog": { "color": "#c8d4e2", "density": 0.0008 },
  "backdrop": { "top": "#5f86b8", "bottom": "#4a5040", "glow": "#fff0d8" },
  "blocks": {
    "geometry": "chamfer",
    "material": "washiSheet",
    "palette": { "I": "#4ab0c8", "O": "#f2c14e", "T": "#9a6ac8", "S": "#6ab05a", "Z": "#e85a4a", "J": "#4a7ad8", "L": "#e8904a" }
  },
  "thumbnail": "previews/thumb.jpg"
}
```

### Manifest fields

| Field | Meaning |
|---|---|
| `schemaVersion` | Must be `1` (`STAGE_SCHEMA_VERSION`). `migrateManifest()` is the hook for future structural migrations; today it returns the input unchanged. |
| `id` | Kebab-case, equal to the folder name, unique across all stages and packs. |
| `order` | Sort key in stage lists (default 1000). |
| `module` | Stage-relative path of the SDK module. |
| `palette` | `accent`, `secondary`, `highlight`, `fog`, `plate` (playfield backing, default `#05060f`). Line-clear colours, transitions and the board accent read it. |
| `fog` | Scene fog `{ color, density }` (density 0 to 0.05). Without it the palette fog colour is used at the default density. |
| `backdrop` | Gradient backdrop colours `{ top, bottom, glow }`. |
| `lighting` | The fixed light rig's settings: `key` (colour, intensity, azimuth, elevation), `rim`, `ambient` (sky, ground, intensity), up to two point `accents`, `beatResponse` (default 0.4). |
| `grade` | `exposure`, `saturation`, `contrast`, `tint` [r, g, b], `vignette`, `bloomThreshold`, `bloomRadius`, `toneMapping` (`aces`, `agx`, `neutral`), `envIntensity`. |
| `camera` | `pitch`, `yaw`, `sway`, `targetY`. |
| `blocks` | `geometry` (`soft`, `chamfer`, `faceted`, `pillow`, `framed`, `procedural`, and the procedural `orb` and `tile`), `material` (a name from `BLOCK_PRESETS`, `src/rendering/materials/blockPresets.ts`; unknown names fall back to `prism`), `overrides` (any preset field), `palette` (colours for I, O, T, S, Z, J, L). The named designs players can choose (`BLOCK_DESIGNS`, `src/rendering/materials/blockDesigns.ts`) pair a preset with a shape: the library designs `lumen`, `dichroic`, `ingot`, `ribbon`, `gel`, `rosette`, `marble` and `lantern`, plus every world's own design. |
| `environment.layers` | The world, built in order (section 5). |
| `reactivity` | Shared `profiles` and extra `bindings` (section 6). |
| `effects` | `lineClear` `{ effect, params }` (default `prismBurst`), `transition` `{ effect, params }` (default `warp`), `landing` `{ shape, color }`. |
| `music` | `bpm`, `beatsPerBar` (default 4), `tracks`, `defaultTrack` (section 7). |
| `ambience` | `{ preset, level }` (section 8). |
| `sfx` | `preset`, `material`, `overrides` (section 8). |
| `unlock` | Unlock rule (section 10); default `{ "type": "always" }`. |
| `thumbnail` | Stage-relative image path. |
| `requires` | `sdk` range (default `^1.0.0`) and `components` (list). |
| `placeholder` | Marks unfinished content; validation warns, and release builds (`PRISMFALL_RELEASE=1`) fail the content test. |

A search of `src/` found no code that reads `tags`, `intensity`, `recommendedQuality`, `palette.pieceTint`, `effects.landing` or `requires.components`. The schema accepts these fields and gives them defaults, but they have no effect today.

## 5. Step 2: environment layers

Each layer names a registered component type and passes it parameters:

```json
{
  "id": "paper-scraps",
  "type": "particles",
  "params": { "count": 1600, "center": [0, 6, -40], "size": [160, 40, 80], "color": "#ffffff", "colorB": "#f2c14e", "shape": "petal", "spin": 2.2, "additive": false, "seed": 13, "bloom": 0 },
  "bind": [{ "target": "speed", "feature": "overallEnergy", "amount": 0.4, "category": "particles", "attackMs": 300, "releaseMs": 1500 }],
  "minDetail": "low"
}
```

| Key | Meaning |
|---|---|
| `id` | Optional but recommended. It is used by reactivity scopes, profile `layers` lists and error messages. |
| `type` | A component type: built-in, or registered by the stage module. |
| `params` | Validated against the component's zod schema when the environment is built. |
| `bind` | Reactivity bindings for this layer only (section 6). |
| `minDetail` | Lowest environment-detail setting that builds the layer (`low`, `medium`, `high`, `ultra`; default `low`). |

Layers are built in order. Put `terrain` before anything that stands on the ground (`gltfScene` with `snapToGround`, `scatter`, `creatureHerd`), because the terrain installs the ground-height function they query. When a layer fails to build (an unregistered type, invalid params, a missing file or an exception), it is skipped with a console warning `[stage <id>] …`, and the rest of the world still builds.

The Folded Sky environment is two layers: a `sky` with a photographic `panorama` (Poly Haven's Montorfano, plus a high-resolution `detail` crop of the directions the camera sees; see REAL_ASSET_PIPELINE.md) and `particles` (seeds drifting on the wind). Its module still registers its own `paperCranes` flock component, a working example of a stage-registered component, although the world no longer places it.

Scatter and gltfScene layers recolour Blender materials by name (`BLENDER_PIPELINE.md`, section 7). For example, a grove of stone lanterns and cherry trees from the shared flora kit:

```json
"materials": [
  { "match": "^stone", "preset": "stone", "color": "#e8dfd0", "roughness": 0.95 },
  { "match": "^lanternGlow", "preset": "emissive", "color": "#f4e4c8", "emissive": "#ffb46a", "emissiveIntensity": 0.6, "musicGlow": 0.8 },
  { "match": "^blossom", "preset": "foliage", "color": "#f2a8b8" },
  { "match": "^bark", "preset": "stone", "color": "#8a6a50" }
]
```

### Built-in components

Registered by `src/rendering/environments/builtins.ts`. The parameter names below come from each component's zod schema; every parameter has a default unless marked required. "Reactive targets" are the uniform names that bindings can drive.

| Type | Purpose | Parameters | Reactive targets |
|---|---|---|---|
| `sky` | Gradient sky dome with hashed stars, drifting fBm nebula, an optional sun or moon disc, and an optional photographic panorama (a landscape horizon, or an all-sky space photo). | `top`, `horizon`, `bottom`, `mid`, `midHeight`, `horizonGlow`, `horizonWidth`, `stars`, `starSize`, `nebula`, `nebulaA`, `nebulaB`, `nebulaScale`, `nebulaDrift`, `disc` {`direction`, `color`, `size`, `halo`, `intensity`}, `milkyWay`, `panorama` {`src`, `elevation`, `offset`, `exposure`, `fade`, `occlude`, `detail`, `kind`: `landscape` or `space`}, `dusk`, `bloom` | `glow`, `stars`, `nebula`, `disc`, `dusk` |
| `particles` | Ambient GPU particle volume (dust, plankton, snow, pollen, rain, embers) with drift, wrap-around, turbulence and twinkle in the shader. | `count`, `center`, `size`, `color`, `colorB`, `minSize`, `maxSize`, `velocity`, `turbulence`, `twinkle`, `brightness`, `shape` (`soft`, `star`, `spark`, `snow`, `bubble`, `streak`, `petal`), `angle`, `spin`, `additive`, `density`, `seed`, `bloom` | `brightness`, `speed`, `size`, `turbulence`, `density` |
| `water` | Displaced ocean surface: fresnel sky reflection, moon glint, glowing crests, ripples on line clears. Declares its height as the water level (SDK 1.2). | `y`, `size`, `deep`, `shallow`, `skyTop`, `skyHorizon`, `glow`, `glowStrength`, `amplitude`, `wavelength`, `speed`, `moonDirection`, `moonColor`, `rippleColor`, `chop`, `chopScale`, `reflection`, `surf` (bioluminescent surf, off unless given: breaking stretches of the main swell's crest flash cold blue, the break runs along the crest and the foam behind it fades; {`color`, `strength`, `density`, `period`, `stretch`, `range`, `clearance`, `viewZ`, `clearGlow`, `bloom`, `seed`}) | `amplitude`, `glow`, `speed`, `surf` (with `surf`) |
| `beams` | Light pillars in an arc that flash in a beat-synchronised sequence. | `count`, `radius`, `y`, `z`, `arc`, `height`, `width`, `color`, `base`, `pulse`, `sequence`, `tilt`, `seed` | `intensity` |
| `planet` | Planet with a real surface map (or procedural bands), a soft warm terminator, an atmosphere halo lit by the light path, and optional rings: simple bands, or Saturn's measured structure with ring and planet shadows and back-lit scattering. The sun can move with a bindable `phase`. | `position`, `radius`, `map`, `mapSaturation`, `mapTint`, `mapExposure`, `colorA`, `colorB`, `bands`, `atmosphere`, `atmosphereStrength`, `lightDirection`, `lightDirectionEnd`, `night`, `rotationSpeed`, `tilt`, `incline`, `ring` {`inner`, `outer`, `color`, `opacity`, `profile`: `bands` or `saturn`, `tilt`, `seed`} | `atmosphere`, `phase` |
| `rings` | Tunnel of glowing rings receding behind the board; a light pulse travels outward each beat. | `count`, `radius`, `growth`, `spacing`, `startZ`, `thickness`, `color`, `colorB`, `base`, `pulse`, `speed`, `segments` | `intensity` |
| `gltfScene` | A stage GLB placed in the world: materials remapped by name, named parts rotated or driven as beat-synced pistons, top-level objects optionally snapped to the ground. | `src` (required), `position`, `rotation`, `scale`, `materials`, `vertexAO`, `rotate` [{`match`, `axis`, `speed`, `alternate`, `beatSync`}], `pistons` [{`match`, `axis`, `distance`, `beats`, `stagger`}], `animationSpeed`, `castShadow`, `include`, `snapToGround`, `sink`, `snapRules` [{`match`, `mode` (`lowest`, `center`, `highest`, `fixed`), `sink`, `y`}] | `emissive` |
| `lava` | Flowing molten surface: crusted fractal noise with hot seams. | `position`, `rotation`, `width`, `depth`, `crust`, `hot`, `white`, `heat`, `scale`, `flow` | `heat` |
| `emitter` | Particle bursts from fixed points on every beat, every bar, at a rate, or on line clears. | `positions` (required), `trigger` (`beat`, `bar`, `rate`, `clear`), `rate`, `count`, `shape` (burst shapes: `soft`, `spark`, `shard`, `petal`, `bubble`, `square`, `ring`, `star`), `color`, `colorB`, `intensity`, `size`, `speed`, `direction`, `spread`, `gravity`, `drag`, `life`, `swirl` | `amount` |
| `eruption` | A living Strombolian eruption at a volcano's summit. Bursts at irregular intervals (never on the beat; swelled by long intense music sections, set off by QUADs and perfect clears) throw lava bombs on ballistic arcs that cool from yellow-white to deep red, trail a short streak, land on the terrain and roll down. A bent-over ash plume is lit orange from below by the crater. Large bursts may be followed by a rare, brief branching discharge in the ash, which lights only the ash around it; none at all with flash reduction (or `dim`). List it after the `terrain` layer: it reads the summit's heights. | `vent` (required, x, z), `rimY`, `crater`, `viewer`, `fog`, `bursts` {`interval`, `bombs`, `height`, `gravity`, `spread`, `trail`, `size`, `hot`, `warm`, `cool`, `brightness`, `music`, `clears`}, `plume` {`height`, `length`, `wind`, `width`, `puffs`, `rise`, `lit`, `ambient`, `opacity`, `litHeight`}, `glow` {`color`, `strength`, `size`}, `lightning` {`enabled`, `chance`, `cooldown`, `color`, `glow`, `brightness`, `reducedFlash` (`off`, `dim`)}, `bloom`, `seed` | `glow`, `plume` |
| `clouds` | Large soft billboards for nebulae, haze, steam or murk. | `count`, `center`, `spread`, `size`, `color`, `colorB`, `opacity`, `drift`, `additive`, `seed` | `opacity` |
| `creatureHerd` | Rigged Blender creatures drawn as surface particles, solid meshes or both. Groups walk paths in caravans or herds, assemble and dissolve at the path ends, raise dust and emit footstep sounds. | `model` (required), `rig` (required), `representation` (`particles`, `mesh`, `both`), `groups` (1 to 16; each has `path` {`line` from/to, `loop` center/radius/clockwise, `polyline` points/closed}, `members`, `formation` (`caravan`, `herd`), `spacing`, `speed`, `scale`, `scaleJitter`, `delay`, `start`, `rest`, `stopEvery`, `stopFor`, `fade`, `followGround`), `particles` {`perCreature`, `size`, `color`, `colorB`, `brightness`, `jitter`, `bloom`, `additive`, `scatter`, `wind`, `lodDistance`}, `mesh` {`color`, `roughness`, `rim`, `rimStrength`}, `dust` {`enabled`, `color`, `amount`, `size`}, `seed` | `brightness`, `size`, `jitter`, `pace` |
| `model` | A GLB (Blender export, scan or licensed model) with its own materials, skeletal or morph animation, and optionally particles sampled from its real surface; instances can walk paths. Particle sizes and distances are world units at any instance scale. | `src` (required), `include`, `recenter`, `instances` [{`position`, `yaw`, `scale`, `snapToGround`, `spin`, `walk` {`to`, `via`, `closed`, `smooth`, `speed`, `phase`, `fade`, `stops` [{`at`, `for`, `clip`}], `ease`, `tilt`, `bank`}}], `animation` {`clip`, `speed`, `vary`, `inPlace` (remove root motion), `stride` (the clip's ground speed: legs then follow the distance walked)}, `flex` [{`match`, `axis`, `degrees`, `period`, `phase`, `offset`}] (procedural bone swing), `render` (`solid`, `surface`, `particles`, `dissolve`), `particles` {`count`, `exclude`, `size`, `brightness`, `tint`, `colorMix`, `blend`, `jitter`, `spread`, `wind`, `bloom`, `shading`, `light`, `saturation`, `seed`}, `dissolve` {`period`, `onBigClears`}, `materials`, `exposure`, `tint`, `castShadow` | none |
| `model` (glow, reveal) | The same component: particles that glow and move, and creatures that arrive with the run. Shed points trail by the path velocity and curl noise (stateless in the shader); bass slowly breathes the glow and treble adds sparkle; reduced motion sheds less. | `particles.style` (`surface`, `glow`: luminous moving points for dark worlds, `glowEdges`: own colours plus a glowing overlay for bright ones), `particles.glow` {`color`, `textureMix`, `core`, `edge`, `twinkle`, `sparkle`, `drift`, `flow`, `flowRate`, `shed`, `shedLife`, `shedSpread`, `breathe`, `shimmer`, `overlay`, `size`, `brightness`}, `reveal` {`from`, `to` (game progress over which it arrives), `unlock`, `hold` (a QUAD or perfect clear calls it in once progress passed `unlock`)} | `brightness` (particles) |
| `glowSchool` | Glowing fish as soft streaks of light (additive, stateless in the shader): a school swimming a loop, or a vortex circling in the view plane around a centre (a climax ring around the board). Can arrive with game progress like `model`'s `reveal`. | `count`, `motion` {`kind` `school`: `center`, `radius`, `speed`, `spread`, `clockwise`; `kind` `vortex`: `center`, `radius` [inner, outer], `squash`, `depth`, `speed`}, `length`, `width`, `color`, `colorB`, `brightness`, `twinkle`, `bloom`, `reveal` {`from`, `to`, `unlock`, `hold`}, `seed` | `brightness` |
| `terrain` | Large procedural terrain built once on the CPU. It provides the stage's ground height; the shader adds wind ripples, glints, slope rock and snow. | `height` {`base`, `seed`, `layers`, `floor`, `clearing` {`center`, `radius`, `falloff`, `depth`}}, `mesh` {`apex`, `near`, `far`, `rows`, `cols`, `spread`}, `colors` {`low`, `high`, `rock`, `snow`, `snowLine`, `sparkle`}, `ripples` {`strength`, `wavelength`, `direction`, `speed`, `fadeDistance`}, `sparkle`, `roughness`, `rockSlope`, `glow` {`color`, `strength`}, `heatHaze`, `lava` {`strength`, `y`, `color`, `hot`, `speed`}, `caustics` {`strength`, `scale`, `speed`, `color`} | `glow`, `ripple`, `sparkle` |
| `scatter` | Instanced Blender props (trees, rocks, crystals, kelp, lanterns, asteroids) over the ground or in a volume, clustered into groves, kept off the playfield, with wind sway. | `src` (default `/content/shared/flora/flora.glb`), `items` (required; each `mesh`, `weight`, `scale`, `tintJitter`, `tint`), `count`, `area` (`band`, `rect`, `ring`, `volume`), `exclude`, `clustering`, `clusterScale`, `materials`, `vertexAO`, `sway` {`amount`, `speed`}, `sink`, `alignToSlope`, `spin`, `seed` | `sway`, `emissive` |
| `swarm` | Procedurally animated flocks and schools. | `kind` (required: `bird`, `eagle`, `fish`, `koi`, `jellyfish`, `ray`, `turtle`, `butterfly`, `whale`), `motion` (required: `orbit` center/radius/speed, `wander` center/size/speed, `cross` from/to/speed/rest), `count`, `flocks`, `spread`, `size`, `color`, `colorB`, `glow`, `tempo`, `seed` | `glow`, `tempo` |
| `jellyfish` | Translucent pulsing jellyfish: lathe bells (fresnel rim, canals, four gonads, glowing margin) that contract and climb on each pulse, frilled oral arms and hair-thin trailing tentacles, all animated on the GPU. Homes are mirrored left and right and kept outside the cone around the board, without overlapping on screen. | `count`, `size`, `area` {`center`, `size`, `clearance`, `viewZ`}, `bell`, `rim`, `glow`, `gonad`, `pulseRate`, `pulse`, `tentacles`, `tentacleLength`, `armLength`, `rise`, `cycle`, `wander`, `brightness`, `glowStrength`, `bloom`, `seed` | `glow`, `brightness` |
| `fishSchool` | Schools of instanced silver 3D fish (lofted body, forked tail, fins) with countershading, flank flashes and a swimming body wave; each school follows a smooth loop and flows through its turns. | `schools` (required, 1 to 4; each `center` (required), `radius`, `speed`, `share`, `clockwise`, `start`), `count`, `shape`, `length`, `back`, `flank`, `belly`, `deep`, `surface`, `light`, `flash`, `flashColor`, `shimmer`, `bank`, `beat`, `bloom`, `seed` | `flash`, `tempo` |
| `fireflies` | Fireflies drifting slowly low among the trees, flashing in real species patterns: patrollers give one J-shaped flash every five to seven seconds, synchronous fireflies flash in bursts of short pulses that roll across the swarm as a loose wave, a few rest on the ferns. Placed by view angle and distance outside the clear zone; sized for distance (a two-pixel floor, far ones dim like point sources) with depth of field for near ones. Flash reduction softens the flashes; one sprite draw call. | `count`, `area` {`azimuth`, `elevation`, `distance`, `eye`, `clearance`}, `lantern`, `color`, `core`, `brightness`, `synchrony`, `burstPeriod`, `burstFlashes`, `burstGap`, `flashPeriod`, `activity`, `perched`, `wander`, `speed`, `aperture`, `focus`, `halo`, `mist`, `bloom`, `seed` | `activity`, `brightness` |
| `dragonflies` | Red darter dragonflies: a lofted body (touching compound eyes, thorax with sutures, ten-segment abdomen, folded legs) and four transparent wings with analytic venation, pterostigma, amber base and a thin-film sheen, lit to match the photograph. Each keeps a beat outside the clear cone: hover, turn, dart on a minimum-jerk path, hover again; some hovers become glides on still wings. Wingbeats are drawn as blurred copies over the stroke. Two draw calls. | `count`, `area` {`center`, `size`, `clearance`, `viewZ`, `edge`}, `beat`, `length`, `abdomen`, `thorax`, `eye`, `venation`, `stigma`, `amber`, `iridescence`, `sky`, `ground`, `sun` {`direction`, `color`, `intensity`}, `ambient`, `slot`, `dart`, `glide`, `wingbeat`, `blur`, `bloom`, `seed` | none |
| `meteors` | Rare, randomly timed meteors (a Poisson process, a little more often in intense sections, never on the beat): thin fast streaks with a bright head and a wake that fades within a fraction of a second, moving away from their radiant. Bright ones can be green (fast) or orange (slow); occasional showers come from one radiant; rare fireballs fragment and leave a faint green train that drifts for a few seconds (none with flash reduction). Paths stay either side of the board's clear zone, in view, and above a photo's skyline; scenery hides them through the depth buffer. | `interval`, `intensityBoost`, `fireballs`, `showers` {`enabled`, `every`, `duration`, `rate`}, `distance`, `azimuth`, `elevation`, `view` {`azimuth`, `elevation`}, `skyline` ([azimuth, elevation] points), `margin`, `avoid` [{`direction`, `radius`}], `length`, `speed`, `colors` {`green`, `orange`}, `brightness`, `bloom`, `seed` | `rate`, `brightness` |
| `birdFlock` | Birds in the sky, placed by azimuth, elevation and distance from the viewer and kept out of the clear zone around the board; one instanced draw call. `murmuration`: a starling flock simulated as boids on the CPU (`src/rendering/environments/flocking/boids.ts`, 30 Hz fixed step): each bird follows its 7 nearest neighbours, the flock wheels over a soft roost, a peregrine stoops on it now and then and escape waves sweep across it, and spontaneous turns spread from its edge; birds bank from their lateral acceleration and beat their wings by speed and climb, gliding when calm. `soaring`: raptors (broad wings, seven fingered primaries, fanned tail) circling in drifting thermals, banking with the turn, flapping in rare bouts, lit by the photo's sun with backlit flight feathers. | `kind` (required: `murmuration`, `soaring`), `eye`, `clear`, `visibility`, `hazeColor`, `seed`. Murmuration: `roost` (required: `at` {`azimuth`, `elevation`, `distance`}, `size`), `count`, `speed`, `minSpeed`, `maxSpeed`, `neighbours`, `separation`, `weights` {`separation`, `alignment`, `cohesion`, `cruise`, `level`, `roost`, `bounds`, `avoid`, `flee`, `evade`, `wander`}, `maxAccel`, `wingspan`, `color`, `flapRate`, `glide`, `falcon` {`every`, `speed`, `radius`, `above`, `wingspan`}, `minPixels`. Soaring: `birds` (required, 1 to 8; each `at` (required), `radius`, `speed`, `climb`, `drift`, `clockwise`, `start`, `wingspan`), `plumage`, `coverts`, `nape`, `flight`, `under`, `underFlight`, `sun` {`azimuth`, `elevation`}, `sunColor`, `sunIntensity`, `sky`, `ground`, `ambient`, `translucency`, `flapEvery` | murmuration: `tempo`, `agitation` |
| `aurora` | Aurora curtains with travelling folds and fine vertical rays. | `ribbons`, `distance`, `base`, `height`, `width`, `low`, `high`, `alt` {`low`, `high`, `share`}, `intensity`, `speed`, `seed` | `intensity`, `speed` |
| `galaxy` | Distant particle spiral galaxy with differential rotation. | `count`, `position`, `tilt`, `radius`, `arms`, `twist`, `thickness`, `core`, `arm`, `dust`, `brightness`, `spin`, `size`, `seed` | `brightness`, `spin` |
| `city` | Instanced night-city skyline on a street grid with procedural windows, neon strips, rooftop beacons and abstract holographic billboards. | `count`, `near`, `far`, `spread`, `grid`, `street`, `height`, `width`, `skyline`, `ground`, `exclude`, `facade`, `windows`, `neon`, `windowDensity`, `windowBrightness`, `floorHeight`, `windowWidth`, `neonShare`, `billboards`, `seed` | `windows`, `neon` |
| `traffic` | Night traffic: headlight and tail-light pairs in platoons, each lane slowing and speeding up as a whole with brake lights; lamps are directional (headlights towards you, tail lights going away). Three kinds of road, combinable: every street of a `city` layer's grid (with street lights on both kerbs), an elevated `expressway` along the waterfront (deck, piers, median lamps), and `roads` seen across water in a panorama: arcs at a constant distance and elevation, so the lamps sit on the photo's far bank, with an optional exposure `trail`. Optional glossy reflection streaks in the wet street. Lamps inside the clear cone around the board fade out. | `city` (copy the skyline layer's `count`, `near`, `far`, `spread`, `grid`, `street`, `height`, `width`, `skyline`, `ground`, `exclude`, `seed`; omit for none), `roads` (each `radius`, `from`, `to` (azimuths), `elevation`, `lanes`, `laneWidth`, `speed`, `gap`, `brightness`, `trail`), `range`, `viewer`, `eyeY`, `clearance`, `laneOffset`, `platoon`, `spacing`, `gap`, `speed`, `stopAndGo`, `headlight`, `halogen`, `tail`, `brightness`, `size`, `streetlights` {`spacing`, `height`, `sodium`, `led`, `sodiumShare`, `brightness`}, `expressway` {`center`, `halfLength`, `height`, `lanes`, `laneWidth`, `speed`, `gap`, `pierSpacing`, `lampSpacing`, `color`}, `reflections` {`strength`, `spread`}, `wetY`, `bloom`, `seed` | `brightness`, `lamps` |
| `aircraft` | Distant airliners crossing the night sky on routes kept outside the clear cone: red and green wingtip navigation lights and a white tail light (each seen only from its side), a red beacon about once a second, double-flash wingtip strobes (softened with flash reduction), and a landing light on approach. 3D towers hide them; with `skyline` (a panorama's skyline elevation per azimuth, measured from its detail crop) they also pass behind the photo's buildings. Keep routes nearer than the sky's `occlude` distance. | `routes` (1 to 6; each `from` and `to` as [azimuth°, elevation°, distance] from the viewer, `duration`, `period`, `landing`, `offset`), `skyline` {`uRange`, `offset`, `elevations`}, `viewer`, `jitter`, `wingspan`, `length`, `red`, `green`, `white`, `brightness`, `fog`, `bloom`, `seed` | `brightness` |
| `matte` | An invisible depth-only ring around the viewer that ends 3D geometry (a water plane) at a clean line in front of a panorama, covering gaps in the sky's `occlude` mask. Shown only while its world is mostly on screen. | `center`, `radius`, `y` | |

Terrain height layers (`terrain.params.height.layers[]`, `src/rendering/environments/terrain/heightfield.ts`) all take `amplitude`, `offset` and an optional distance `band` {`near`, `ramp`, `far`}:

| `type` | Extra parameters |
|---|---|
| `dunes` | `wavelength`, `direction`, `crest`, `warp`, `variation` |
| `ridged` | `scale`, `octaves`, `sharpness` |
| `fbm` | `scale`, `octaves` |
| `cone` | `center` (required), `radius`, `crater`, `roughness` |
| `terraces` | `scale`, `steps`, `threshold` |

The `particles` and `terrain` components also expose `presence` (and `terrain` exposes `music`). Their own code sets these values every frame, so do not bind them.

## 6. Step 3: reactivity

A binding drives one reactive uniform from an audio feature or a game signal (`bindingSchema` in `src/stages/schema.ts`):

| Field | Default | Meaning |
|---|---|---|
| `layer` | `*` | Which layers: a layer id, `type:<componentType>`, or `*` for every layer that exposes `target`. |
| `target` | (required) | A name from the component's reactive targets. |
| `feature` | (required) | `subBass`, `bass`, `lowMid`, `mid`, `highMid`, `treble`, `overallEnergy`, `waveformRms`, `spectralFlux`, `spectralCentroid`, `transientIntensity`, `beatPulse`, `barPulse`, `beatPhase`, `barPhase`, `sectionIntensity`, `anticipation`, `game.danger`, `game.clearPulse`, `game.combo`, `game.level`, `game.progress` |
| `amount` | 0.5 | Strength. |
| `mode` | `mul` | `mul`: base × (1 + amount × envelope). `add`: base + amount × envelope. |
| `curve` | `smooth` | `linear`, `smooth`, `pow2`, `sqrt` (applied to the feature value clamped to 0..1). |
| `attackMs`, `releaseMs` | 40, 260 | Envelope time constants, frame-rate independent. |
| `category` | `environment` | `particles`, `environment` or `lighting`: which user response slider scales the binding. |
| `min`, `max` | (none) | Clamp the driven value. |

Bindings come from three places (`StageEnvironment.wireBindings`):

1. A layer's own `bind` list. The binding's `layer` is replaced by the layer's id, or by `type:<type>` when the layer has no id. A layer without an id therefore binds every layer of the same type in the stage, so give layers ids.
2. `reactivity.profiles`: shared profiles from `content/shared/reactivity/<name>.json`, given by name or as `{ "name", "layers", "amount" }`. `layers` limits the profile to those layer ids, and `amount` (0 to 4, default 1) scales every binding in it.
3. `reactivity.bindings`: extra bindings with their own `layer` selector.

Several bindings on one uniform combine: `mul` factors multiply, `add` terms sum, and then `min`/`max` apply. Audio features are scaled by the player's reactivity settings (strength, preset, bass, treble and beat sensitivity, category response). `game.*` signals are not scaled.

Folded Sky uses a layer `bind` (its seeds' `speed` from `overallEnergy`) and one scoped profile:

```json
"reactivity": { "profiles": [{ "name": "flux-turbulence", "layers": ["seeds"] }], "bindings": [] }
```

Shared profiles:

| Profile | Description (from the file) |
|---|---|
| `bass-breath` | Water amplitude, sky glow and planet atmosphere rise and settle with the bass. |
| `beat-lights` | Water glow, rings and beams flash on the beat grid. |
| `flux-turbulence` | Particles turn more turbulent when the spectrum changes. |
| `mid-architecture` | Low mids heat lava and thicken clouds; mids warm emissive gltfScene materials. |
| `section-swell` | Beams and rings grow through builds and drops; sky glow follows anticipation. |
| `transient-strike` | gltfScene emissive and beams flare on transients. |
| `treble-sparkle` | Particle brightness and sky stars glint with the treble. |

A profile file is `{ "description": "…", "bindings": [ … ] }` with at least one binding. For example, `flux-turbulence.json`:

```json
{
  "description": "Spectral change stirs the air: particles turn more turbulent when the music moves.",
  "bindings": [
    { "layer": "type:particles", "target": "turbulence", "feature": "spectralFlux", "amount": 0.6, "category": "particles" }
  ]
}
```

## 7. Step 4: music

`music` lists the stage's tracks. The track named by `defaultTrack` (or the first one) is the world's main track: it plays in the menus, in world previews, in the sound test and in Voyage. In free play with each world's own music, a world's tracks take turns: the first game in the world plays the main track, and each later game plays the next track in this list, wrapping around.

```json
"music": {
  "bpm": 136,
  "beatsPerBar": 4,
  "tracks": [{ "id": "folded-sky-paper-wind", "title": "Paper Wind", "kind": "composition", "src": "music/main.ts" }],
  "defaultTrack": "folded-sky-paper-wind"
}
```

A track has `id`, `title`, `kind` (`composition` or `file`), `src`, optional `meta` (file tracks) and `artist` (default `Prismfall`). Keep `music.bpm` equal to the default track's tempo. It is the fallback tempo when the composition cannot be loaded. Give any other track whose tempo differs its own `bpm`, which the Music Room and world selection show. `content.test.ts` checks that each composition's `id` and `bpm` match its entry.

### Composition tracks

A composition module default-exports `composition({ … })` (`src/audio/sequencer/composition.ts`). The synthesizer in `src/audio/synth/instruments.ts` plays it live; nothing is pre-rendered. Abridged from `content/stages/folded-sky/music/main.ts`:

```ts
import { arp, bassline, beat, composition, hold, melody, once } from '@prismfall/sdk';

export default composition({
  id: 'folded-sky-paper-wind',
  title: 'Paper Wind',
  bpm: 136,
  beatsPerBar: 4,
  key: 'E',
  scale: 'yoScale',
  swing: 0.12,
  space: { decay: 3.2, wet: 0.3, damping: 0.5 },
  stinger: 'koto',
  instruments: {
    pad: { kind: 'pad', wave: 'triangle', voices: 3, detune: 8, cutoff: 1800, attack: 1.4, release: 3, gain: 0.26, reverb: 0.6 },
    koto: { kind: 'epiano', ratio: 3, index: 1.8, decay: 0.9, gain: 0.28, reverb: 0.4, delay: 0.3, pan: -0.2 },
    bass: { kind: 'bass', wave: 'sawtooth', cutoff: 700, envAmount: 2, decay: 0.2, gain: 0.32, duck: 0.35 },
    kick: { kind: 'kick', tone: 125, decay: 0.28, gain: 0.6 },
    hat: { kind: 'hat', gain: 0.18, layer: 0.3 },
    // …
  },
  sections: [
    {
      name: 'cranes',
      kind: 'verse',
      bars: 16,
      intensity: 0.45,
      chords: ['i', 'iv', 'iii', 'v', 'i', 'iv', 'ii', 'v'],
      parts: {
        pad: hold({ octave: 3, voicing: 'open', vel: 0.4, every: 2 }),
        bass: bassline('x..x....x.x.....', { octave: 1 }),
        kick: beat('x.........x.....'),
        hat: beat('x.x.x.x.x.x.x.x.', { vel: 0.5 }),
      },
    },
    // intro, build, drop and break sections …
  ],
  loopFrom: 1,
});
```

| Field | Meaning |
|---|---|
| `key`, `scale` | Root note (`C` … `B`, with `#` or `b`) and one of `major`, `minor`, `dorian`, `phrygian`, `lydian`, `mixolydian`, `harmonicMinor`, `phrygianDominant`, `pentatonicMinor`, `pentatonicMajor`, `inScale`, `yoScale`. |
| `beatsPerBar` | Beats per bar; a bar has four steps per beat. 3 and 5 give 3/4 and 5/4. For 6/8, use 6 with the eighth note as the beat (count `bpm` in eighths), so the beat clock pulses on every eighth. |
| `swing` | 0 to 0.5; delays every off-beat sixteenth. |
| `shuffle` | Optional eighth-note swing in steps: delays every off-beat eighth. 0.67 is a triplet shuffle; add `swing` 0.33 so the other sixteenths follow the triplet grid. |
| `space` | Reverb `{ decay, wet, damping }` (default 3.2, 0.32, 0.5). |
| `stinger` | Instrument for gameplay flourishes (clears, level-ups), quantised to the next sixteenth. Without it the first `bell`, `pluck`, `mallet` or `epiano` instrument is used. |
| `instruments` | Named instruments. `kind` is one of `pad`, `strings`, `choir`, `pluck`, `lead`, `bass`, `sub`, `bell`, `epiano`, `mallet`, `kick`, `snare`, `clap`, `hat`, `openhat`, `ride`, `shaker`, `tom`, `perc`, `crash`, `riser`, `impact`. Common options are `gain`, `pan`, `reverb` and `delay` sends, `layer` and `duck`. Synth options (`wave`, `cutoff`, `resonance`, `attack`, `decay`, `sustain`, `release`, `detune`, `voices`, `ratio`, `index`, `envAmount`, `drive`, `tone`) are interpreted per kind. `glide` (seconds, lead instruments) slides each note of a phrase from the previous pitch; notes that start together or more than 2 s apart don't glide. |
| `layer` | Intensity threshold 0..1. Once per bar, an instrument opens when `min(1, sectionIntensity × 0.65 + gameIntensity × 0.5)` reaches its threshold. A small hysteresis stops it flickering. 0 means always on. |
| `duck` | Sidechain amount: the instrument dips on every kick. |
| `sections` | `name`, `kind` (`intro`, `verse`, `build`, `drop`, `break`, `bridge`, `outro`), `bars`, `intensity` (the composed baseline), `chords` (Roman numerals, one per bar, cycled), `parts` (instrument name to a generator or an array of generators). |
| `loopFrom` | Section index the music returns to after the last section. |

Chords are diatonic Roman numerals with optional suffixes `7`, `9`, `sus2`, `sus4`, `add9`. Case is ignored, because chord quality comes from the scale.

| Generator | Writes |
|---|---|
| `hold({ octave, voicing, vel, every })` | The bar's chord held for the bar, or for `every` bars (pads, strings). `voicing`: `close`, `open`, `spread`. |
| `arp({ rate, octave, span, order, gate, vel, accent, startBar, ramp })` | Arpeggio of the bar's chord. `order`: `up`, `down`, `updown`, `random`, `pendulum`; `rate` is in sixteenths. |
| `bassline(pattern, { octave, fifths, octaves, gate, vel })` | Chord roots on a rhythm, with a chance of fifths and octave jumps. |
| `beat(pattern, { vel, prob, fillLastBar, ramp })` | Drum pattern repeated over the section; `prob` thins unaccented hits deterministically. |
| `melody(phrase, { octave, vel, gate, bars, ramp })` | Scale degrees with durations in sixteenths: `"1:4 3:2 5:2 -:4 6':4"`. `'` raises an octave, `,` lowers one, `-` is a rest, `\|` is ignored. The phrase repeats to fill the section. |
| `stab(pattern, { octave, voicing, gate, vel })` | Chord stabs on a rhythm. |
| `once({ step, dur, vel, note })` | One event at the section start (risers, impacts, crashes). |

`ramp: [from, to]` scales the velocity of `arp`, `beat` and `melody` linearly across the section, for crescendos in builds and fades in outros. Patterns use one character per sixteenth: `x` hit, `X` accent, `o` ghost, `.` rest. Spaces and `|` are ignored. Expansion is deterministic: each part has a random generator seeded from the track id, section name and instrument.

### File tracks

For recorded or produced music, use `kind: "file"` with an audio file and a `track.json`. Both must be inside the stage's `music/` folder: JSON is only bundled from `music/` folders.

```json
{ "id": "my-track", "title": "My Track", "kind": "file", "src": "music/my-track.ogg", "meta": "music/my-track.track.json" }
```

`track.json` follows `FileTrackMeta` (`src/audio/music-director/tracks.ts`): `title`, `bpm`, optional `beatsPerBar`, `offset` (seconds to the first downbeat), `loop` `{ startBar, endBar }`, `sections` `[{ name, kind, startBar, intensity }]` and `stems` `[{ src, layer, gain, name }]`. Stems play sample-locked with the main file. Each fades in around its `layer` threshold as the game's music intensity rises (over about ±0.08 around the threshold). A missing stem file is skipped with a warning. `npm run audio:encode` produces both files from WAV masters; see `assets/audio/README.md` and `AUDIO_ASSETS.md`. No stage ships a file track today.

## 8. Step 5: ambience and block sounds

```json
"ambience": { "preset": "garden", "level": 0.8 },
"sfx": { "preset": "paper", "material": "paper" }
```

| Field | Values |
|---|---|
| `ambience.preset` | `ocean`, `foundry`, `space`, `forest`, `wind`, `rain`, `underwater`, `city`, `cathedral`, `arctic`, `horizon`, `desert`, `ice`, `garden`, `cosmos`, `alpine`, `abyss`, `wilderness`, `volcanic`, `aurora`, `neon`, `veil`, `web`, `storm` (`src/audio/sound-effects/Ambience.ts`). Each preset is filtered noise layers with slow LFOs, plus occasional synthesised events. An unknown name plays silence. |
| `sfx.preset` | The tonal family for gameplay sounds: `glass`, `metal`, `crystal`, `organic`, `neon`, `paper`, `stone`, `ice`, `oasis`, `koto`, `gossamer`, `void` (`SFX_PRESETS` in `SfxBank.ts`). Unknown names fail `npm run content:validate`. |
| `sfx.material` | The block impact sound: a built-in `MaterialAudioProfile` name (`glass`, `pearl`, `metal`, `sandstone`, `ice`, `wood`, `cosmic`, `mineral`, `water`, `organic`, `obsidian`, `aurora`, `neon`, `paper`) or an inline profile. Unknown names fail `npm run content:validate`; an invalid inline profile falls back to `glass` at runtime. |
| `sfx.overrides` | A map from sound id (`SFX_IDS` in `SfxBank.ts`, e.g. `lock`, `hardDrop`, `clear4`) to a stage audio file. The file replaces the generated sound for that id (no variations). Validation checks that the files exist; unknown ids are skipped with a console warning. |

An inline profile overrides any of the synthesis layers (`materialAudioSchema` in `src/audio/sound-effects/materialAudio.ts`): `gain`, `transient`, `body` (modal `modes` as ratio, decay, gain), `resonance` (`band`, `cavity`, `comb`), `scatter` (`sand`, `dust`, `pebbles`, `shards`, `chimes`, `bubbles`, `crackle`, `leaves`, `sparks`), `tail` (`hiss`, `air`, `rumble`, `shimmer`), `reverb` and `sub`. Two optional partial overrides add more: `signature` is layered on four-line clears, and `response` is the environment's answer to a hard drop. The built-in `paper` profile written inline:

```json
"sfx": {
  "preset": "paper",
  "material": {
    "transient": { "level": 0.35, "freq": 2600, "ms": 5 },
    "body": { "level": 0.5, "baseHz": 200, "modes": [{ "ratio": 1, "decay": 0.08, "gain": 1 }, { "ratio": 2.4, "decay": 0.05, "gain": 0.4 }], "drop": 0.02, "noise": 0.4, "noiseCutoff": 3500, "noiseDecay": 0.06 },
    "scatter": { "kind": "leaves", "level": 0.2, "count": 6, "lo": 2500, "hi": 7000, "spread": 0.2 },
    "sub": { "level": 0.25, "from": 110, "to": 60, "decay": 0.12 }
  }
}
```

## 9. Step 6: custom components, effects and transitions (`stage.ts`)

A stage module default-exports `defineStage({ sdkVersion, register(sdk) })`. `register` receives the global registries: `sdk.components`, `sdk.lineClearEffects` and `sdk.transitions`. The module is loaded once, the first time the stage is prepared, and is never unloaded. Folded Sky registers all three kinds (abridged from `content/stages/folded-sky/stage.ts`):

```ts
import { BufferAttribute, BufferGeometry, Color, DoubleSide, InstancedBufferAttribute, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, cos, float, instancedBufferAttribute, sin, vec3, vec4 } from 'three/tsl';
import { defineStage, floatUniform, makeRecipeEffect, seeded, z, zColor, zVec3, type ComponentFactory, type TransitionEffect } from '@prismfall/sdk';

const craneSchema = z.object({
  count: z.number().int().min(1).max(600).default(80),
  center: zVec3.default([0, 30, -160]),
  radius: zVec3.default([180, 30, 80]),
  size: z.tuple([z.number(), z.number()]).default([3, 5]),
  colors: z.array(zColor).min(1).default(['#f4efe6', '#e85a4a', '#4a7ad8', '#f2c14e']),
  speed: z.number().default(0.05),
  seed: z.number().default(3),
});

const paperCranes: ComponentFactory<z.infer<typeof craneSchema>> = {
  type: 'paperCranes',
  version: 1,
  description: 'A flock of folded-paper cranes drifting on slow orbits, wings beating.',
  schema: craneSchema,
  create(ctx, p) {
    const u = { presence: floatUniform(1), speed: floatUniform(1) };
    // … instanced geometry; the TSL position node animates every crane on the GPU …
    const material = new MeshStandardNodeMaterial();
    const mesh = new Mesh(geometry, material);
    return {
      object: mesh,
      reactive: { speed: u.speed },          // bindable as "target": "speed"
      setPresence(v) { u.presence.value = v; },
      dispose() { geometry.dispose(); material.dispose(); },
    };
  },
};

const foldIntoCranes = makeRecipeEffect('foldIntoCranes', { shape: 'petal', perCell: 6, motion: 'rise', /* … */ }, 'Rows fold into paper scraps that rise like cranes.');

const paperFold: TransitionEffect = {
  id: 'paperFold',
  description: 'Sheets of coloured paper tumble in from above.',
  play(ctx) {
    const n = ctx.bursts.budget(500 * ctx.intensityScale * (ctx.reducedMotion ? 0.35 : 1));
    // … ctx.bursts.emit({ x, y, z, vx, vy, vz, r, g, b, size, life, delay, drag, swirl, shape: 'petal' }, ctx.time) …
  },
};

export default defineStage({
  sdkVersion: '1.1.0',
  register(sdk) {
    sdk.components.register(paperCranes as unknown as ComponentFactory);
    sdk.lineClearEffects.register(foldIntoCranes);
    sdk.transitions.register(paperFold);
  },
});
```

The manifest then uses these names like built-ins: `"type": "paperCranes"`, `"effects": { "lineClear": { "effect": "foldIntoCranes" }, "transition": { "effect": "paperFold" } }`.

Things to know:

- **Components.** `create(ctx, params)` may be async. `ctx` provides `scene`, `quality` (detail, particle density, reflections, reduced motion), `uniforms` (`frameUniforms`), `assets` (`url`, `loadGLTF`/`release`, `json`), `bursts`, `palette`, `ground` and `sounds`. The returned component has `object` and `dispose()`. Optional members are `reactive`, `update(frame)`, `onBeat(beat)`, `onGameEvent(event)` (clear, levelUp, hardDrop, lock, danger, gameOver) and `setPresence(0..1)` for crossfades. Scale costs with `ctx.quality`, never gameplay.
- **World sounds.** `ctx.sounds.emit(id, x, y, z, gain?)` plays a one-shot at a world position, panned for the listener (HRTF when Spatial audio is on).
  - **Ids.** `footstep` is a footfall made from the world's block material. Since SDK 1.4 there are also:
    - `skitter`: a small spider's dash. Emit one per dash, not one per leg.
    - `crawl`: one step of a large spider. Emit one each time a set of legs lands, about every half gait cycle.
    - `silk`: a thread stretching or creaking.
    - `webHum`: a web vibrating, played in the music's key.
  - **Gain.** The gain is the loudness; distance attenuation comes on top. For `skitter` and `crawl` it is also the weight: 0.2 sounds like a lighter, smaller animal and 1 the heaviest.
  - **Rate limits.** Each sound has its own limit per second: footstep 6, skitter 3, crawl 4, silk 2 and webHum 2. All of them share a limit of 10 per second, and at most 12 sound at once. Requests over a limit are dropped, so emit only what should be heard, and keep skitters occasional.
  - **SDK version.** A stage that uses the 1.4 sounds sets `requires.sdk` to `^1.4.0`.
  - See "Creature sounds" in `AUDIO_ASSETS.md`.
- **World drones.** `ctx.sounds.drone?.(id, level, hz, brightness, pan)` keeps a sustained world voice (a hum or drone, on the ambience bus) sounding while you call it every frame or so; it fades out by itself soon after the calls stop. The Warden's Spire uses it for the Warden's hum. It is optional on `WorldSounds`, so call it with `?.`.
- **Registry keys are global.** A later registration with the same key replaces the earlier one for every stage, so a module that registers `sky` would replace the built-in sky for every stage loaded after it. Use names of your own.
- **Validation cannot run the module.** For a stage with a `module`, the validator accepts any layer type, and the content test accepts any line-clear effect name and skips parameter checks for module-provided layers. If the module does not actually register a type, the layer is skipped with a warning when the stage builds.
- **Materials.** There is no material registry. Block surfaces come from `blocks.material` (a `BLOCK_PRESETS` name) plus `blocks.overrides`. Blender scenery is recoloured with `materials` rules in `gltfScene` and `scatter`. A custom component builds its own TSL node materials, as `paperCranes` does with `MeshStandardNodeMaterial`. Use `noBloom(material)` to keep a material out of the emissive bloom target, and `additiveFog(color)` for additive materials.
- **Line-clear effects** implement `trigger(ctx, clear, params)`. `makeRecipeEffect(id, partialRecipe, description)` builds one from the recipe system below.
- **Transitions** implement `play(ctx, params)`. They run once when a world crossfades in (only for crossfades longer than 0.6 s) and use fire-and-forget burst particles. Respect `ctx.intensityScale`, `ctx.reducedMotion` and `ctx.bursts.budget()`. An unknown transition name fails `npm run content:validate` (unless the stage has a module, which may register it).

### Weather worlds (Dark Storm)

`content/stages/dark-storm/` is the worked example of a weather world: everything is drawn and timed by its own module, and its sound goes through the SDK 1.5 weather and storm sounds.

- **One clock, one source of truth.** `director.ts` (pure TypeScript, seeded, unit-tested) runs the storm: four states (calm, active, intense, distant) with weighted transitions biased by the music's section intensity and the game's progress, levels that ease over seconds, Poisson strikes with clusters and lulls at four intensity levels, return strokes, QUAD accents and cloud flickers. A flash governor caps flash onsets at three in any second, and at one smooth flash every 2.5 s with Reduce flashing; World events calm and reduced motion halve the lightning and keep it at least a kilometre away, off keeps only small distant flashes. `tickStorm` (`shared.ts`) advances it once per frame from whichever component updates first.
- **Sound from the same event.** When a strike starts, the same data (position, distance, energy, strokes, seed) drives the bolt, the light and the sound: a nearby strike's crack goes out with the flash (`ctx.sounds.storm({ kind: 'crack', delay: leader })`), and its thunder `thunderDelay(distance)` seconds later (the apparent distance at 343 m/s, compressed to at most 15 s). The audio system schedules both on the audio clock (`AudioBufferSourceNode.start(when)`), never with JS timers.
- **World-only light.** Flashes light the world through its own `lightsNode` (a hemisphere whose sky colour carries the lit cloud deck, three point lights at the brightest flashes, a shadow-casting directional light pointed at the strongest), set on its `MeshStandardNodeMaterial`s with `setupEnvironment()` returning null; the board is never lit by them. Shaders that light themselves (clouds, rain, haze, reflections) read the same flash data from uniform arrays.
- **Review handle.** The lightning mesh carries `userData.storm` (`director`, `log`, `active`, `force(level, azimuth, distance)`), which capture scripts find with `scene.traverse` to force a strike for a screenshot; game code never uses it.

### Built-in line-clear recipes

`effects.lineClear.effect` names a recipe from `src/rendering/fx/lineClearEffects.ts`. `effects.lineClear.params` overrides any recipe field: `shape`, `perCell`, `speed`, `motion`, `spread`, `gravity`, `drag`, `life`, `size`, `color` (`piece`, `accent`, `white`, `mix`, `highlight`), `brightness`, `swirl`, `streak`, `wave`, `secondary`. Particle shapes are `soft`, `spark`, `shard`, `petal`, `bubble`, `square`, `ring` and `star`.

| Recipe | Shape and motion | Notes |
|---|---|---|
| `prismBurst` | shard, radial | The base recipe (default effect). |
| `tideSpray` | soft, sweep | Secondary rising bubbles. |
| `igniteQuench` | spark, up | Secondary slow rising smoke in the accent colour. |
| `supernova` | star, implode | Pulls in, then bursts. |
| `petalShatter` | petal, radial | Strong swirl. |
| `glitchSlice` | square, sweep | Short-lived, no gravity. |
| `bubbleAscent` | bubble, rise | No row streak. |
| `crumbleDust` | soft, down | Secondary falling shards. |
| `frostShatter` | shard, radial | Secondary rising stars. |
| `bloomSeeds` | petal, up | Secondary floating seeds. |
| `fadeToLight` | soft, rise | White, gentle. |
| `frostWave` | shard, radial | Board-wide wave on multi-line clears; secondary stars. |
| `sandSpiral` | soft, spiral | Board-wide wave; secondary sand blown out into the world. |

### Built-in transitions

From `src/rendering/fx/transitions.ts`. Every transition except `warp` accepts `params.colors` (an array of `#rrggbb`) to replace its default colours, which mix fixed colours with the stage palette.

| Transition | Description |
|---|---|
| `warp` | Light streaks rush past toward the viewer (default; adds an accent shockwave). |
| `sand` | Golden sand and dust sweep in on the wind. |
| `frost` | Ice crystals grow around the playfield, then snow drifts across. |
| `stars` | Stars expand into view from the depths. |
| `petals` | Blossom petals drift in on a breeze. |
| `leaves` | Leaves and glowing spores swirl past. |
| `bubbles` | Bubbles rise and rippling light reveals the deep. |
| `aurora` | Ribbons of aurora light flow across the sky. |
| `embers` | Embers and ash rise from below. |
| `digital` | Neon pixels and rain streak across the city. |
| `mist` | Soft mist rolls through and clears. |

## 10. Step 7: unlocking and the Voyage campaign

`unlock` (`src/stages/progression.ts`) decides whether a stage is playable outside Voyage. The "unlock all" setting overrides it.

| Rule | Unlocked when |
|---|---|
| `{ "type": "always" }` | always (Folded Sky, Luminous Tide, Ancient Garden, Frozen Kingdom, Moving Sands) |
| `{ "type": "voyageLeg", "leg": "<stage-id>" }` | that leg has been completed in Voyage, or the stage's own progress record is marked unlocked |
| `{ "type": "stageCompleted", "stage": "<stage-id>" }` | that stage is recorded as completed |
| `{ "type": "score", "mode": "<mode-id>", "score": n }` | the best score in that mode (`marathon`, `sprint`, `ultra`, `zen`, …) reaches `n` |

Locked stages appear in the stage select with a hint (`unlockHint`).

The Voyage is `content/campaigns/voyage.json`: four areas of three legs. Each leg is `{ "stage", "lines", "level" }` at Standard difficulty, and `difficulties.relaxed` / `standard` / `intense` scale lines (`linesScale`) and shift the speed level (`levelOffset`). A stage id is also its leg id and may appear only once. Every leg must name an available stage. If one does not, `getCampaign` returns no campaign, and the Voyage screen shows "The Voyage campaign could not be loaded: …" with the errors instead of the areas. Folded Sky is not part of the campaign. To add a world to Voyage, add a leg:

```json
{ "stage": "folded-sky", "lines": 14, "level": 7 }
```

## 11. Step 8: licence metadata

Record the origin of every file in the stage folder in `assets.json`. Folded Sky's:

```json
{
  "files": [
    { "path": "stage.ts", "license": "Original work for Prismfall", "author": "Prismfall", "source": "authored", "purpose": "SDK module: paper cranes, fold-into-cranes clear, paper-fold transition" },
    { "path": "music/main.ts", "license": "Original work for Prismfall", "author": "Prismfall", "source": "authored", "purpose": "Paper Wind composition" },
    { "path": "previews/thumb.jpg", "license": "Original work for Prismfall", "author": "Prismfall", "source": "generated by npm run content:thumbnails", "purpose": "world artwork" }
  ]
}
```

No code reads `assets.json`. The enforced inventory is `ASSET_LICENSES.md`: `src/stages/assetLicenses.test.ts` fails when a `.glb`, `.png`, `.webp`, `.jpg`, `.ogg`, `.opus`, `.wav` or `.mp3` file under `content/` is not listed there by its repo-relative path. Add a row for each new file.

## 12. Step 9: thumbnail and screenshots

```
npm run content:thumbnails -- --stages folded-sky
npm run content:shots -- --stages folded-sky
```

Both scripts drive Google Chrome (Playwright, `channel: 'chrome'`, WebGPU and the real GPU) against the test build on `http://localhost:4174`. If nothing answers on that port, they start `vite preview --mode test` themselves. If `dist-test/index.html` does not exist they run `npm run build:test` first. An existing `dist-test` is reused as it is, so run `npm run build:test` after changing content.

- `content:thumbnails` (`scripts/thumbnails.ts`) shows each stage without UI at 960×540, waits `--settle` seconds (default 4) and writes `previews/thumb.jpg` (JPEG quality 84). If `thumbnail` is not already `previews/thumb.jpg`, it sets it and rewrites `stage.json` with two-space indentation. Without `--stages a,b` it renders every available stage.
- `content:shots` (`scripts/stage-shots.ts`) writes acceptance captures to `docs/acceptance/<id>/`: `world-<W>x<H>.jpg` and `world-<W>x<H>-b.jpg` four seconds later (no UI), then `play-<W>x<H>.jpg` and `play-<W>x<H>-b.jpg` from a Zen (Still) game driven by the built-in AI. Options: `--out <dir>`, `--settle <s>` (default 5), `--sizes 2560x1080,1920x1080` (default `2560x1080`) and `--world-only`.

`node scripts/transition-shots.ts --from <stage> --to <stage>` captures a themed entrance mid-crossfade.

## 13. Step 10: validation

```
npm run content:validate
```

This runs `vitest run src/stages/content.test.ts`. `npm run build` runs it first through `prebuild`. The test checks that:

- at least one stage is discovered, and every stage validates with no errors;
- every line-clear effect is built in, or the stage has a module;
- every layer that uses a built-in component has params that parse against that component's schema;
- every shared reactivity profile matches the profile schema;
- the Voyage campaign is valid and every leg names an available stage;
- with `PRISMFALL_RELEASE=1`, no stage is marked `placeholder`.

The full suite (`npm test`) also runs `src/stages/assetLicenses.test.ts`.

`npm run content:validate` also rejects unknown transition, ambience preset, SFX preset and sound material names for shipped stages. What it does not check: `creatureHerd` `model` and `rig` paths (only a layer's `params.src` is checked); layers provided by stage modules; and file-track stems. Check these in game, and watch the console for `[stage <id>]` and `[audio]` warnings.

### When a stage is unavailable

`validateManifest` (`src/stages/validate.ts`) and `discoverStages` mark a stage unavailable, with one message per problem, when:

| Condition | Message (abridged) |
|---|---|
| the manifest fails the schema | `<path>: <zod message>` |
| `id` differs from the folder name | `id "…" must match its folder name "…"` |
| `requires.sdk` does not match `SDK_VERSION` | `needs Content SDK …, this build provides 1.2.0` |
| `module` file missing | `module "…" not found` |
| unknown layer type and no `module` | `unknown environment component "…" (no stage module registers it)` |
| a layer's `params.src` file missing | `layer "…": asset "…" not found` |
| a track's `src` or `meta` missing | `music track "…": "…" not found` |
| unknown reactivity profile, or a profile scope naming a missing layer id | `reactivity profile "…" not found …`, `… no layer with id "…"` |
| `defaultTrack` is not one of the tracks | `defaultTrack "…" is not one of the tracks` |
| an `sfx.overrides` file missing | `sfx override "…": "…" not found` |
| two stages share an id | `duplicate stage id "…"` |
| pack stage without a valid `pack.json`, or the pack's `engine` range does not match engine `1.0.0` | `content pack has no pack.json`, `pack requires engine …` |

A missing thumbnail and `placeholder: true` only produce warnings.

Unavailable stages are listed at the end of world selection as "Unavailable (reason)" and can't be chosen; the Music Room leaves them out. Settings → Developer → Content lists every discovered stage with its folder, its errors and warnings, and a summary such as "13 stages found, 12 available, 1 unavailable". The console also logs `[stages] "<id>" unavailable: <errors>`. If an unavailable stage is a Voyage leg, the whole campaign is rejected too (section 10).

A stage can also pass validation and still fail to load: its module may target an incompatible SDK or throw. In that case `StageManager.show` returns false, logs `[stages] failed to load "<id>"` and keeps `lastError`, and the game does not crash.

## 14. Content packs

Stages can also ship as a pack: `content/packs/<pack>/pack.json` (`{ "id", "name", "version", "engine" }`, where `engine` is a semver range, default `*`) with stages in `content/packs/<pack>/stages/<id>/`. Pack stages follow the same rules. In addition, an invalid or missing `pack.json`, or an `engine` range that `1.0.0` does not satisfy, makes every stage in the pack unavailable. No pack ships today.

## 15. Checklist for a new world

1. Create `content/stages/<id>/stage.json` with the required fields; `id` equals the folder name.
2. Build the environment from built-in layers; add `terrain` first if anything stands on the ground.
3. Add bindings, or reference shared profiles scoped to your layer ids.
4. Write `music/main.ts` with the composition DSL and list it in `music.tracks`.
5. Choose `ambience`, `sfx.preset` and `sfx.material`.
6. If you need something new, write `stage.ts`, set `module`, and set `requires.sdk` to the SDK version the module needs.
7. Choose `effects.lineClear`, `effects.transition` and `unlock`; optionally add a Voyage leg.
8. Write `assets.json` and add every binary file to `ASSET_LICENSES.md`.
9. Run `npm run content:validate`, then `npm run build:test` and `npm run content:thumbnails -- --stages <id>`.
10. Review `npm run content:shots -- --stages <id>` on a tall stack as well as an empty board.
