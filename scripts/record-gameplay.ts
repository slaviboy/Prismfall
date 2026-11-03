/**
 * Records gameplay video of every world for visual review: one continuous Zen run that travels
 * through the worlds with in-game transitions, the AI playing, and scripted 1-4 line clears,
 * a back-to-back QUAD and a combo clear in each world. Frames come from the Chrome screencast of
 * a headless (real GPU) page and are encoded to one MP4 per world; stills at fixed moments after
 * each QUAD are copied from the frames (page screenshots would stall the screencast). Frame pacing
 * (rAF intervals during normal play) is logged per world.
 *
 * Usage: node scripts/record-gameplay.ts [--stages a,b] [--out reference-capture/ours] [--size 2560x1080] [--play 18]
 * Requires a test build (npm run build:test); the preview server is started if needed.
 */
import { chromium, type Page } from '@playwright/test';
import { execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? def) : def;
};
const only = opt('stages', '').split(',').filter(Boolean);
const outDir = resolve(ROOT, opt('out', 'reference-capture/ours'));
const [width, height] = opt('size', '2560x1080').split('x').map(Number) as [number, number];
const playS = Number(opt('play', '18'));

async function ensureServer(): Promise<ChildProcess | null> {
  try {
    if ((await fetch('http://localhost:4174/')).ok) return null;
  } catch {
    /* not running */
  }
  if (!existsSync(join(ROOT, 'dist-test/index.html'))) execSync('npm run build:test', { cwd: ROOT, stdio: 'inherit' });
  const server = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--mode', 'test', '--outDir', 'dist-test'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      if ((await fetch('http://localhost:4174/')).ok) return server;
    } catch {
      /* starting */
    }
  }
  throw new Error('preview server did not start');
}

const shell = (page: Page) => (expr: string, arg: unknown = null) => page.evaluate(({ e, a }) => new Function('s', 'a', `return (${e})(s, a)`)((window as unknown as { __PRISMFALL__: { shell: unknown } }).__PRISMFALL__.shell, a), { e: expr, a: arg });

/**
 * Replaces the board with a played-looking stack: two garbage rows, `n` rows full except the right
 * column, a ragged top row, and an I piece in hold. `combo` / `b2b` prime the clear's bonuses;
 * `empty` just clears the board.
 */
const INJECT = `(s, a) => {
  const e = s.session.engine;
  const snap = e.snapshot();
  const W = e.board.width, H = e.board.height;
  const cells = new Uint8Array(W * H);
  let seed = a.seed;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const fillRow = (y, gap) => {
    let x = 0;
    while (x < W) {
      const run = 2 + Math.floor(rnd() * 3), colour = 1 + Math.floor(rnd() * 7);
      for (let i = 0; i < run && x < W; i++, x++) if (x !== gap) cells[y * W + x] = colour;
    }
  };
  if (a.empty) {
    e.restore({ ...snap, cells, combo: -1, backToBackActive: false });
    return;
  }
  fillRow(0, 2 + Math.floor(rnd() * 5));
  fillRow(1, 1 + Math.floor(rnd() * 6));
  for (let r = 0; r < a.n; r++) fillRow(2 + r, W - 1);
  const top = 2 + a.n;
  for (let x = 0; x < W - 1; x++) if (rnd() < 0.45) cells[top * W + x] = 1 + Math.floor(rnd() * 7);
  e.restore({ ...snap, cells, hold: 'I', holdUsed: false, combo: a.combo, backToBackActive: a.b2b });
}`;

/** Swaps in the held I, stands it up and drops it into the right-hand well. */
const DROP_I = `(s) => {
  const ses = s.session;
  const t = performance.now();
  ['hold', 'rotateCW', 'moveRight', 'moveRight', 'moveRight', 'moveRight', 'moveRight', 'moveRight', 'hardDrop'].forEach((act, i) => {
    ses.handleAction(act, true, t + i * 0.01);
    ses.handleAction(act, false, t + i * 0.01 + 0.005);
  });
}`;

/** Collects rAF intervals so each segment's frame pacing can be reported. */
const PACING_INSTALL = `() => {
  const w = window;
  w.__pace = [];
  let last = 0;
  const tick = (t) => { if (last) w.__pace.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}`;

function pacingReport(d: number[]): string {
  if (d.length === 0) return 'no frames';
  const s = [...d].sort((x, y) => x - y);
  const q = (p: number) => (s[Math.min(s.length - 1, Math.floor(p * s.length))] as number).toFixed(1);
  const mean = d.reduce((x, y) => x + y, 0) / d.length;
  return `fps ${(1000 / mean).toFixed(0)}, frame ms p50 ${q(0.5)} p95 ${q(0.95)} p99 ${q(0.99)} max ${(s[s.length - 1] as number).toFixed(1)}, >25ms ${d.filter((x) => x > 25).length}, >50ms ${d.filter((x) => x > 50).length}`;
}

/** Copies the first frame at or after each mark + offset out of the frame folder as a still. */
function stills(frameDir: string, stamps: number[], marks: { name: string; t: number }[], outDir: string): void {
  for (const m of marks) {
    for (const ms of [120, 450, 1100]) {
      const i = stamps.findIndex((t) => t >= m.t + ms / 1000);
      if (i >= 0) copyFileSync(join(frameDir, `${String(i).padStart(6, '0')}.jpg`), join(outDir, `${m.name}-${ms}ms.jpg`));
    }
  }
}

function encode(frameDir: string, stamps: number[], out: string): void {
  if (stamps.length < 2) return;
  const lines: string[] = [];
  for (let i = 0; i < stamps.length; i++) {
    const dur = i + 1 < stamps.length ? (stamps[i + 1] as number) - (stamps[i] as number) : 1 / 30;
    lines.push(`file '${String(i).padStart(6, '0')}.jpg'`, `duration ${Math.max(0.001, dur).toFixed(4)}`);
  }
  lines.push(`file '${String(stamps.length - 1).padStart(6, '0')}.jpg'`);
  writeFileSync(join(frameDir, 'list.txt'), lines.join('\n'));
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(frameDir, 'list.txt'), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', out]);
}

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
  await page.goto('http://localhost:4174/');
  await page.getByTestId('boot-start').click();
  await page.getByTestId('main-menu').waitFor();
  await page.evaluate(() => (window as unknown as { __PRISMFALL__: { updateSection(s: string, p: unknown): void } }).__PRISMFALL__.updateSection('setup', { unlockAll: true }));
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
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  await page.evaluate(`(${PACING_INSTALL})()`);

  const segments: { id: string; dir: string; stamps: number[]; marks: { name: string; t: number }[] }[] = [];
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k] as string;
    const dir = join(outDir, id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'frames'), { recursive: true });
    if (k === 0) {
      await run(`(s, id) => s.startGame({ modeId: 'zen', variantId: 'still', stageId: id })`, id);
      for (let i = 0; i < 80 && (await run('(s) => s.session && s.session.status')) !== 'running'; i++) await page.waitForTimeout(250);
    }
    stamps = [];
    frameDir = join(dir, 'frames');
    const marks: { name: string; t: number }[] = [];
    segments.push({ id, dir, stamps, marks });
    if (k > 0) {
      // Mid-run world change, as Voyage does it.
      await run(`(s, id) => s.stageManager.show(id, { transition: 2.4 })`, id);
    }
    await run(INJECT, { seed: 0, empty: true });

    // Normal play: the piece falls for a moment before the AI places it.
    // Pacing is measured over this phase only (no loading, no still captures).
    await page.waitForTimeout(1000);
    await page.evaluate('window.__pace = []');
    const playEnd = Date.now() + playS * 1000;
    while (Date.now() < playEnd) {
      await page.waitForTimeout(700);
      await run('(s) => s.aiStep()');
    }
    const pace = (await page.evaluate('window.__pace')) as number[];

    // Scripted clears: single, double, triple, QUAD, back-to-back QUAD, combo triple.
    const clears = [
      { n: 1, combo: -1, b2b: false, still: '' },
      { n: 2, combo: -1, b2b: false, still: '' },
      { n: 3, combo: -1, b2b: false, still: '' },
      { n: 4, combo: -1, b2b: false, still: 'quad' },
      { n: 4, combo: -1, b2b: true, still: 'b2b' },
      { n: 3, combo: 4, b2b: false, still: '' },
    ];
    for (let c = 0; c < clears.length; c++) {
      const clear = clears[c] as (typeof clears)[number];
      await run(INJECT, { seed: 100 * k + c, ...clear });
      await page.waitForTimeout(900);
      if (clear.still) marks.push({ name: clear.still, t: Date.now() / 1000 });
      await run(DROP_I);
      await page.waitForTimeout(2600);
    }
    const line = `${id}: ${stamps.length} video frames; ${pacingReport(pace)}`;
    report.push(line);
    console.log(line);
  }
  frameDir = '';
  await cdp.send('Page.stopScreencast');
  await run('(s) => s.quitToMenu()');

  for (const seg of segments) {
    stills(join(seg.dir, 'frames'), seg.stamps, seg.marks, seg.dir);
    encode(join(seg.dir, 'frames'), seg.stamps, join(seg.dir, `${seg.id}.mp4`));
    rmSync(join(seg.dir, 'frames'), { recursive: true, force: true });
    console.log(`encoded ${seg.id}`);
  }
  writeFileSync(join(outDir, 'pacing.txt'), `${width}x${height}, headless Chrome (real GPU)\n${report.join('\n')}\n`);
} finally {
  await browser.close();
  server?.kill();
}
