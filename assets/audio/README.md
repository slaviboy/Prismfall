# Audio masters

Lossless masters for recorded or rendered music live here. Nothing in this folder ships. The
game loads the encoded files that `npm run audio:encode` writes into `content/stages/<id>/music/`.

```
assets/audio/
  music/<stage-id>/<track-id>/
    main.wav           full mix (the base layer, always playing)
    stems/<name>.wav   optional adaptive layers, same length and start as main.wav
    track.json         timing and layering metadata (see below)
  sfx/<stage-id>/      optional recorded effects (overrides for procedural ones)
  ambience/<stage-id>/ optional recorded ambience beds
```

## track.json

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

- `offset` is the time in seconds from the file start to the first downbeat. The beat clock,
  bar-aligned transitions and music-reactive visuals depend on it.
- Each stem fades in once the game's music intensity reaches its `layer`. Quiet play keeps
  only the base mix. Combos, big clears and danger bring in the higher layers.
- All stems must share the main mix's length and timing reference. The player starts every
  stem on the same audio-clock instant.

## Encoding

```
npm run audio:encode            # every stage
npm run audio:encode -- <id>    # one stage
```

The encoder needs ffmpeg on PATH, or set `FFMPEG_PATH`. It does the following:

- Normalises the main mix to about -16 LUFS, with a -1.5 dBTP limiter.
- Applies the same gain to every stem, so the layers sum the way they were mixed.
- Writes Ogg Opus at 160 kbps, plus `<track>.track.json` with resolved stem paths.

## Adding the result to a stage

Reference the encoded track in `stage.json`:

```json
"music": {
  "tracks": [{ "id": "my-track", "title": "My Track", "kind": "file", "src": "music/my-track.ogg", "meta": "music/my-track.track.json" }],
  "defaultTrack": "my-track"
}
```

Record the source, author and licence of every file in the stage's `assets.json`.
