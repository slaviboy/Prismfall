# Reference-game study tools

Tools for studying the installed reference game on this machine. They were used for [BACKGROUND_VISUAL_REFERENCE.md](../../BACKGROUND_VISUAL_REFERENCE.md). The recordings they make are local study material and go to `reference-capture/` only (git-ignored, never committed or reused as assets).

| File | What it does |
|---|---|
| `TeTools.cs` | Compiled at run time by PowerShell 7 (`Add-Type`). It has three parts:<br>• **WASAPI loopback recorder**: records what the default output device plays to a WAV file, padding silence so time stays aligned.<br>• **Keyboard input by scan code**: `SequenceFor` sends each key only while the named process owns the foreground window, so keys can never land in another program.<br>• **Window focus and a foreground-checked click.** |
| `te.ps1` | Small front end: `-Cmd audio`, `keys`, `focus`, `shot`. |
| `record.ps1` | Records the screen (ffmpeg `ddagrab`) and the system audio together, optionally while `bot.py` plays. Desktop Duplication drops when the game reloads, so the video is taken in segments with their wall-clock starts. |
| `bot.py` | Plays for observation. It reads the well from the screen at 20 Hz (cropped and averaged to one pixel per cell), recognises the falling piece by its shape and places it with a height and holes heuristic. Its cell thresholds suit bright, saturated blocks; stages whose blocks darken towards the bottom need other thresholds (arguments 6 and 7). |
| `analyze.py` | Background motion and brightness against the audio for the recorded segments (the study's measurements). For Prismfall's own clips, use `scripts/music_coupling.py`. |

Typical session (PowerShell, with the game running):

```powershell
$t = 'scripts/reference'
Add-Type -Path "$t/TeTools.cs"
[TeTools.Keys]::Focus('TetrisEffect-Win64-Shipping')
& "$t/record.ps1" -Name deep-run -Seconds 180 -GamePid (Get-Process TetrisEffect-Win64-Shipping).Id -Play
```

Paths in `record.ps1` and `analyze.py` point to `F:/Projects/Web/TetrisEffect/reference-capture/te-clips`.
