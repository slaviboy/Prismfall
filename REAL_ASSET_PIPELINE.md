# Real asset pipeline

How real-world imagery and scanned models get into Prismfall's worlds. The rule from the visual brief is "real model first, particle enhancement second": anything that should read as a real place, rock, tree or creature comes from photography or photogrammetry. Procedural geometry is kept only for things that are procedural by nature (water, aurora, particles, the board).

Every external asset is CC0 or another licence that allows this use. Each is recorded in [ASSET_LICENSES.md](ASSET_LICENSES.md) (checked by `src/stages/assetLicenses.test.ts`) and described in [assets/ASSET_CATALOG.md](assets/ASSET_CATALOG.md). Original downloads are kept in `assets/external/` as sources of record. The exception is the full-resolution HDRs, which are too large for the repository; their URLs and MD5s are in each `source.json`. Nothing is fetched at runtime.

## Photographic horizons (panoramas)

Source: [Poly Haven](https://polyhaven.com) HDRIs (CC0). Each world that uses one shows a real landscape as its horizon, or as its whole surroundings, through the `panorama` option of the `sky` component.

```sh
node scripts/fetch-panorama.ts <id> <stage> --elevation -32,40 --detail --center 0.62 --azimuth 70 [--keep-hdr]
```

What the script does:

1. **Original download.** It downloads Poly Haven's tonemapped 8k JPG into `assets/external/polyhaven/<id>/`, checks the MD5 and writes `source.json`.
2. **Band.** It crops the elevations the game shows into `content/stages/<stage>/textures/<id>_band.webp`. This covers the full 360 degrees at about 23 px per degree, as the fallback for VR and wide views. It also prints the band's top colour, which the sky gradient above it should continue from.
3. **Detail (`--detail`).**
   - It downloads the full-resolution HDR (20k where offered, else 16k).
   - It crops the directions the camera can see (`--center` ± `--azimuth` degrees), at 45–57 px per degree, under the 8192 px texture limit.
   - It tone-maps the crop with `scripts/panorama_match.py`, which uses numpy (development only). That script fits one curve on luminance quantiles of the full-resolution crop against Poly Haven's tonemapped JPG and applies it to all three channels. A single curve keeps neutral tones neutral, and fitting at full resolution keeps highlights from clipping.
   - The result is `<id>_detail.webp`, and the script prints its `uRange` for the manifest.

Manifest example (Frozen Kingdom):

```json
"panorama": {
  "src": "textures/lago_disola_band.webp", "elevation": [-6, 40], "offset": 0.70, "fade": 8, "occlude": 500,
  "detail": { "src": "textures/lago_disola_detail.webp", "uRange": [0.5056, 0.8944] }
}
```

Panorama options:

- **`offset`:** turns the panorama, as the fraction of a full turn that faces the board.
- **`occlude`:** the photo's land pixels write depth at that distance, so 3D sky effects (the aurora) pass behind real mountains.
- **`dusk`** (a sky option): darkens the photo and fades in stars as a bindable value rises. Stars are masked to the photo's sky.
- **Detail on low settings:** the detail texture costs about 170 MB of video memory, and low detail settings skip it.

In use:

| World | Panorama | Visible elevations | Detail |
|---|---|---|---|
| Frozen Kingdom | Lago d'Isola (Andreas Mischok) | -6..40, a 3D lake in front | 20k |
| Moving Sands | Rogland Clear Night (Greg Zaal) | -6..40, 3D dunes in front | 16k |
| Alpine Horizon | Alps Field (Andreas Mischok) | -32..40, the whole surroundings | 20k |
| Ancient Garden | Ninomaru Teien (Greg Zaal) | -32..40, the whole surroundings | 16k |
| Enchanted Wilderness | Misty Pines (Greg Zaal) | -32..40, the whole surroundings | 16k |
| Folded Sky | Montorfano (Andreas Mischok) | -32..40, the whole surroundings | 16k |

## Space imagery

Deep Cosmos is built from real astronomical imagery, prepared offline with `scripts/space_assets.py` (numpy and Pillow, development only):

```sh
python scripts/space_assets.py sky assets/external/eso/eso0932a/eso0932a.tif content/stages/celestial-drift/textures/milky_way.webp --center 22,14 --roll -30
python scripts/space_assets.py planet assets/external/nasa/PIA07782/PIA07782.jpg content/stages/celestial-drift/textures/gas_giant_map.webp
```

- **Sky:** ESO's all-sky Milky Way panorama (CC BY 4.0, ESO/S. Brunier) is only 17 px per degree, which would show stars as soft blobs on screen. The script keeps the photo's diffuse galaxy (glow, dust lanes, star clouds) but replaces the detected point stars with a smoothed background. It then turns the sky so the galactic centre and a tilted band sit where the composition wants them. In game the `sky` component's `panorama` with `kind: "space"` covers the whole sphere and draws crisp procedural stars on top at screen resolution, denser where the photo is bright.
- **Planet:** Cassini's cylindrical Jupiter map (NASA/JPL/Space Science Institute, public domain) becomes the surface of the `planet` component (`map`, graded cooler with `mapSaturation` and `mapTint`). The script fills the map's flat polar filler. The shader adds polar haze, limb darkening, a warm terminator and an atmosphere halo computed from the light path.
- **Rings:** generated, not an image: `ringProfile.ts` builds the radial profile from Saturn's published ring radii (C, B and A rings, the Cassini Division, the Encke and Keeler gaps, the F ring) with ringlet noise. The rings shadow the planet, take the planet's shadow, and glow where sunlight passes through them.

## Photoscanned models

Source: Poly Haven models (CC0), decimated for real time.

```sh
npm run assets:scans                 # every entry in assets/external/scans.json
node scripts/fetch-polyhaven.ts <id> # download one model with its source record
```

The pipeline is `scripts/process-external.ts`, followed by `assets/blender/scripts/import_external.py` run in Blender. It does the following:

- decimates to a triangle target;
- sets the origin at the bottom centre;
- wires the AO, and alpha cut-outs where present;
- caps textures at 1024 px;
- renders a contact sheet;
- writes a GLB, then optimises it with gltf-transform (meshopt, WebP) into `content/shared/scans/`.

Section 12 of [BLENDER_PIPELINE.md](BLENDER_PIPELINE.md) has the details. The first set is two Namaqualand cliffs, two boulders, a loose-rock set, two quiver trees, a dead quiver trunk, a rock face and two moon rocks. They are used as asteroids in Celestial Drift and as boulders and trees in Moving Sands.

Scans are placed with the `model` component. It keeps their PBR materials and offers `exposure`/`tint` (to dim real assets at night), ground snapping, `recenter`, a slow `spin`, skeletal `animation`, and the surface-particle render modes (see [PARTICLE_SURFACE_RENDERING.md](PARTICLE_SURFACE_RENDERING.md)).

## What is not available automatically

Realistic rigged animals (a camel, fish, birds) and photogrammetry of landmarks (the pyramids) are not offered under a free licence with direct download. The good ones are on Sketchfab, which needs an account login, or are paid; CGTrader and RenderHub camels cost about $10–50. The Smithsonian's CC0 3D collection blocks automated access.

When such a file is added to `assets/external/<name>/`, the integration path already exists: the `model` component loads it with its skeleton and animation, and the surface particles follow its real surface and bones. Script-built pyramids were tried and removed because they read as game assets.

### Sketchfab models

Sketchfab hosts realistic rigged animals under CC BY, but downloads need a free account. With the owner's personal API token (Sketchfab, Settings, Password & API) in `SKETCHFAB_TOKEN`, `scripts/fetch-sketchfab.ts` downloads through Sketchfab's official download API:

```sh
SKETCHFAB_TOKEN=... node scripts/fetch-sketchfab.ts <uid> <name>
```

- It refuses licences other than CC0, CC BY and CC BY-SA.
- It records the author, page, licence and file MD5 in `assets/external/sketchfab/<name>/source.json`.
- It packs the glTF into a GLB with its skeleton and clips, optimises it into `content/shared/creatures/<name>.glb`, and prints the clip names and the ASSET_LICENSES.md row.

The token is sent only to api.sketchfab.com and never stored.

The `model` component's `walk` option moves an instance along a path, facing the way it goes, following the ground, and assembling from or dispersing into its particles at the ends. With `render: "particles"` and the model's walk clip, this gives a herd or caravan drawn entirely from particles on the animals' real surfaces.

Chosen candidates (CC BY):
- **Camel:** "Camel" by eb78 (`99af7daa5baf450ea7b809937937e6d5`; clips Idle_01, Idle_02, WalkCycle; 17,880 vertices).
- **Elk:** "Realistic Animated Elk 3D Model" by WildMesh 3D (`787834f9caa2474d9f1814b807c072d7`; 53 clips; 4,003 vertices). Its author notes rigging flaws in this free version.

