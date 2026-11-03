/**
 * Audio asset pipeline: encodes WAV masters into web-ready Ogg Opus next to each stage.
 *
 *   assets/audio/music/<stage-id>/<track>/main.wav (+ stems/<name>.wav) + track.json
 *     → content/stages/<stage-id>/music/<track>.ogg, <track>-<stem>.ogg, <track>.track.json
 *
 * Music is loudness-normalised to about -16 LUFS, then peak-limited at -1.5 dBFS on a 4x oversampled
 * signal, which approximates a -1.5 dBTP true-peak ceiling (Opus encoding can still overshoot by a
 * fraction of a dB). Stems keep the main mix's gain so they sum correctly. Masters stay in assets/ (lossless, not shipped). Requires ffmpeg on
 * PATH (or FFMPEG_PATH).
 *
 * Usage: npm run audio:encode [-- <stage-id>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const only = process.argv.slice(2).find((a) => !a.startsWith('--'));
const MUSIC = join(ROOT, 'assets/audio/music');

interface TrackJson {
  title: string;
  bpm: number;
  beatsPerBar?: number;
  offset?: number;
  loop?: { startBar: number; endBar: number };
  sections?: { name: string; kind: string; startBar: number; intensity: number }[];
  stems?: { name: string; layer: number; gain?: number }[];
}

function ffmpeg(args: string[]): string {
  return execFileSync(FFMPEG, ['-hide_banner', '-y', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Measures integrated loudness (LUFS) of a file with ffmpeg's loudnorm analysis pass. */
function measureLufs(file: string): number {
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const out = String((err as { stderr?: string }).stderr ?? '');
    const m = /"input_i"\s*:\s*"(-?[\d.]+)"/.exec(out);
    if (m) return Number(m[1]);
  }
  return -16;
}

function encode(src: string, dst: string, gainDb: number): void {
  ffmpeg(['-i', src, '-af', `volume=${gainDb.toFixed(2)}dB,aresample=192000,alimiter=limit=0.84:level=false,aresample=48000`, '-c:a', 'libopus', '-b:a', '160k', '-vbr', 'on', dst]);
  console.log(`  ${dst.replace(ROOT, '.')}: ${(statSync(dst).size / 1024).toFixed(0)} KiB`);
}

if (!existsSync(MUSIC)) {
  console.log('No masters in assets/audio/music yet (see assets/audio/README.md).');
  process.exit(0);
}
try {
  ffmpeg(['-version']);
} catch {
  console.error('ffmpeg not found. Install it or set FFMPEG_PATH.');
  process.exit(1);
}

for (const stage of readdirSync(MUSIC)) {
  if (only && stage !== only) continue;
  const stageDir = join(MUSIC, stage);
  if (!statSync(stageDir).isDirectory()) continue;
  for (const track of readdirSync(stageDir)) {
    const dir = join(stageDir, track);
    const metaPath = join(dir, 'track.json');
    const main = join(dir, 'main.wav');
    if (!existsSync(metaPath) || !existsSync(main)) continue;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as TrackJson;
    const out = join(ROOT, 'content/stages', stage, 'music');
    mkdirSync(out, { recursive: true });
    console.log(`▸ ${stage}/${track}`);
    // One gain for the whole set so stems keep their balance against the main mix.
    const gainDb = -16 - measureLufs(main);
    encode(main, join(out, `${track}.ogg`), gainDb);
    const stems: { src: string; layer: number; gain: number; name: string }[] = [];
    for (const s of meta.stems ?? []) {
      const wav = join(dir, 'stems', `${s.name}.wav`);
      if (!existsSync(wav)) {
        console.warn(`  missing stem ${s.name}.wav`);
        continue;
      }
      encode(wav, join(out, `${track}-${s.name}.ogg`), gainDb);
      stems.push({ src: `music/${track}-${s.name}.ogg`, layer: s.layer, gain: s.gain ?? 1, name: s.name });
    }
    const { stems: _ignored, ...rest } = meta;
    void _ignored;
    writeFileSync(join(out, `${track}.track.json`), `${JSON.stringify({ ...rest, stems }, null, 2)}\n`);
  }
}
