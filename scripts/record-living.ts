/**
 * Records each world as it lives with its soundtrack (BACKGROUND_VISUAL_QUALITY_REPORT.md): one
 * uninterrupted clip of ordinary play (the built-in AI places a piece about every 0.8 s, so lines
 * clear now and then) with the world's real music, heard and recorded from the game's own master
 * bus. The track is moved to six bars before its first build, so a clip holds a quieter passage,
 * the build, the drop and usually what follows. The music director's drives and cues are logged
 * at 10 Hz beside the video, so every clip says what the music was doing at each moment.
 *
 * Usage: node scripts/record-living.ts [--stages a,b] [--seconds 60] [--out reference-capture/living]
 *   [--size 2560x1080] [--frame 1920] [--port 4174 --dist dist-test] [--background balanced]
 * Writes <out>/<id>/<id>.mp4 (video and the game's audio), drives.json, stills and a contact sheet.
 * Requires ffmpeg and a test build (npm run build:test).
 */
import { chromium, type Page } from '@playwright/test';
import { execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? def) : def;
};
const only = opt('stages', '').split(',').filter(Boolean);
const seconds = Number(opt('seconds', '60'));
const outDir = resolve(ROOT, opt('out', 'reference-capture/living'));
const [width, height] = opt('size', '2560x1080').split('x').map(Number) as [number, number];
const frameWidth = Number(opt('frame', '1920'));
const port = opt('port', '4174');
const dist = opt('dist', 'dist-test');
const background = opt('background', 'balanced');
const BASE = `http://localhost:${port}/`;

async function ensureServer(): Promise<ChildProcess | null> {
  try {
    if ((await fetch(BASE)).ok) return null;
  } catch {
    /* not running */
  }
  if (!existsSync(join(ROOT, dist, 'index.html'))) execSync(dist === 'dist-test' ? 'npm run build:test' : `npx vite build --mode test --outDir ${dist}`, { cwd: ROOT, stdio: 'inherit' });
  const server = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--mode', 'test', '--outDir', dist, '--port', port, '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      if ((await fetch(BASE)).ok) return server;
    } catch {
      /* starting */
    }
  }
  throw new Error('preview server did not start');
}

const shell = (page: Page) => (expr: string, arg: unknown = null) => page.evaluate(({ e, a }) => new Function('s', 'a', `return (${e})(s, a)`)((window as unknown as { __PRISMFALL__: { shell: unknown } }).__PRISMFALL__.shell, a), { e: expr, a: arg });

/** Moves the playing composition to six bars before its first build (or drop); returns the plan. */
const SEEK = `(s) => {
  const p = s.audio.director.current;
  const ctx = s.audio.engine.ctx;
  if (!p || !ctx || !p.sections) return null;
  let beat = 0;
  const starts = p.sections.map((sec) => { const b = beat; beat += sec.beats; return { kind: sec.spec.kind, name: sec.spec.name, start: b, beats: sec.beats }; });
  const target = starts.find((x) => x.kind === 'build') || starts.find((x) => x.kind === 'drop');
  const from = Math.max(0, (target ? target.start : 0) - 6 * p.beatsPerBar);
  const spb = 60 / p.bpm;
  p.origin = ctx.currentTime + 0.2 - from * spb;
  p.scheduledUntilBeat = from;
  return { from, bpm: p.bpm, sections: starts.map((x) => ({ kind: x.kind, name: x.name, startS: (x.start - from) * spb })) };
}`;

/** Taps the master bus (after the limiter: what the player hears) into a MediaRecorder. */
const AUDIO_START = `(s) => {
  const e = s.audio.engine;
  const dest = e.ctx.createMediaStreamDestination();
  e.limiter.connect(dest);
  const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 192000 });
  const chunks = [];
  rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
  rec.start(1000);
  window.__rec = { rec, chunks, dest, started: Date.now() };
  return window.__rec.started;
}`;
const AUDIO_STOP = `async () => {
  const r = window.__rec;
  await new Promise((res) => { r.rec.onstop = res; r.rec.stop(); });
  const blob = new Blob(r.chunks, { type: 'audio/webm' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}`;

/** Logs the music director's drives, section and cues at 10 Hz into window.__drives. */
const DRIVES_START = `(s) => {
  const host = s.renderSystem.environments;
  const t0 = performance.now();
  window.__drives = [];
  window.__cues = [];
  const orig = host.music.update.bind(host.music);
  host.music.update = (...a) => { const cues = orig(...a); for (const c of cues) if (c.kind !== 'downbeat') window.__cues.push({ t: (performance.now() - t0) / 1000, kind: c.kind, strength: Math.round(c.strength * 100) / 100 }); return cues; };
  window.__driveTimer = setInterval(() => {
    const d = host.music.drive;
    window.__drives.push({ t: Math.round((performance.now() - t0) / 100) / 10, section: d.sectionKind, body: d.body, motion: d.motion, detail: d.detail, intensity: d.intensity, tension: d.tension, calm: d.calm, accent: d.accent });
  }, 100);
  return Date.now();
}`;
const DRIVES_STOP = `(s) => { clearInterval(window.__driveTimer); return { drives: window.__drives, cues: window.__cues }; }`;

const server = await ensureServer();
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'],
});
mkdirSync(outDir, { recursive: true });
const report: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [error] ${m.text().slice(0, 300)}`);
  });
  await page.goto(BASE);
  await page.getByTestId('boot-start').click();
  await page.getByTestId('main-menu').waitFor();
  await page.evaluate((bg) => {
    const h = (window as unknown as { __PRISMFALL__: { updateSection(s: string, p: unknown): void } }).__PRISMFALL__;
    h.updateSection('setup', { unlockAll: true, music: 'stage' });
    h.updateSection('audio', { enabled: true, muted: false, master: 0.8, music: 0.8 });
    h.updateSection('background', { preset: bg });
  }, background);
  const run = shell(page);
  const all = (await run('(s) => s.stageManager.stages().map((x) => x.id)')) as string[];
  const ids = only.length > 0 ? only.filter((id) => all.includes(id)) : all;
  const cdp = await page.context().newCDPSession(page);
  let frameDir = '';
  let stamps: number[] = [];
  cdp.on('Page.screencastFrame', (f) => {
    if (frameDir) {
      writeFileSync(join(frameDir, `${String(stamps.length).padStart(6, '0')}.jpg`), Buffer.from(f.data, 'base64'));
      stamps.push(f.metadata.timestamp ?? Date.now() / 1000);
    }
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  });

  for (const id of ids) {
    const dir = join(outDir, id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'frames'), { recursive: true });
    await run(`(s, id) => s.startGame({ modeId: 'zen', variantId: 'still', stageId: id })`, id);
    for (let i = 0; i < 120 && (await run('(s) => s.session && s.session.status')) !== 'running'; i++) await page.waitForTimeout(250);
    await page.waitForTimeout(3500);
    const plan = await run(SEEK);
    await page.waitForTimeout(1200);
    // Video, audio and drives start together (each start is stamped for alignment).
    stamps = [];
    frameDir = join(dir, 'frames');
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 84, maxWidth: frameWidth, maxHeight: Math.round((frameWidth * height) / width), everyNthFrame: 1 });
    const audioStart = (await run(AUDIO_START)) as number;
    const driveStart = (await run(DRIVES_START)) as number;
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      await page.waitForTimeout(800);
      await run('(s) => s.aiStep()');
    }
    const log = (await run(DRIVES_STOP)) as { drives: unknown[]; cues: { t: number; kind: string }[] };
    const audioB64 = (await page.evaluate(`(${AUDIO_STOP})()`)) as string;
    await cdp.send('Page.stopScreencast');
    frameDir = '';
    writeFileSync(join(dir, 'audio.webm'), Buffer.from(audioB64, 'base64'));
    writeFileSync(join(dir, 'drives.json'), `${JSON.stringify({ plan, audioStart, driveStart, videoStart: stamps[0] ? stamps[0] * 1000 : null, ...log }, null, 1)}\n`);
    await run('(s) => s.quitToMenu()');
    await page.waitForTimeout(800);

    // Encode the frames at their real timing, then mux the audio aligned to the first frame.
    const lines: string[] = [];
    for (let i = 0; i < stamps.length; i++) {
      const dur = i + 1 < stamps.length ? (stamps[i + 1] as number) - (stamps[i] as number) : 1 / 30;
      lines.push(`file '${String(i).padStart(6, '0')}.jpg'`, `duration ${Math.max(0.001, dur).toFixed(4)}`);
    }
    lines.push(`file '${String(Math.max(0, stamps.length - 1)).padStart(6, '0')}.jpg'`);
    writeFileSync(join(dir, 'frames', 'list.txt'), lines.join('\n'));
    const video = join(dir, 'video.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames', 'list.txt'), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', video]);
    const offset = stamps[0] ? Math.max(0, stamps[0] * 1000 - audioStart) / 1000 : 0;
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-ss', offset.toFixed(3), '-i', join(dir, 'audio.webm'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', join(dir, `${id}.mp4`)]);
    // A contact sheet (one frame every 5 s) and stills at the first drop and peak cues.
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', 'fps=1/5,scale=640:-1,tile=4x3', '-frames:v', '1', join(dir, 'sheet.jpg')]);
    for (const cue of log.cues.filter((c) => c.kind === 'drop' || c.kind === 'peak').slice(0, 2)) {
      const at = Math.max(0, cue.t + (driveStart - (stamps[0] ? stamps[0] * 1000 : driveStart)) / 1000 + 1.5);
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(2), '-i', video, '-frames:v', '1', join(dir, `${cue.kind}.jpg`)]);
    }
    rmSync(join(dir, 'frames'), { recursive: true, force: true });
    rmSync(video, { force: true });
    const kinds = [...new Set(log.cues.map((c) => c.kind))].join(',');
    const line = `${id}: ${stamps.length} frames, cues ${kinds}, sections ${(plan as { sections: { kind: string; startS: number }[] } | null)?.sections.filter((x) => x.startS > -5 && x.startS < seconds).map((x) => `${x.kind}@${x.startS.toFixed(0)}s`).join(' ') ?? '?'}`;
    report.push(line);
    console.log(line);
  }
  writeFileSync(join(outDir, 'recordings.txt'), `${width}x${height} (frames ${frameWidth} wide), ${seconds} s per world, background ${background}\n${report.join('\n')}\n`);
} finally {
  await browser.close();
  server?.kill();
}
