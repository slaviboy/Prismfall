/**
 * Captures a stage's themed entrance mid-crossfade (acceptance review of transitions).
 *
 * Usage: node scripts/transition-shots.ts --from <stage> --to <stage> [--out dir] [--times 0.6,1.2,2]
 * Requires a running or buildable test bundle (same as content:shots).
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? def) : def;
};
const from = opt('from', 'celestial-drift');
const to = opt('to', 'moving-sands');
const out = resolve(ROOT, opt('out', 'docs/acceptance/transitions'));
const times = opt('times', '0.5,1.1,1.8').split(',').map(Number);
mkdirSync(out, { recursive: true });

type Hooks = { __PRISMFALL__: { shell: { stageManager: { show(id: string, o: unknown): Promise<boolean> } }; updateSection(s: string, p: unknown): void } };
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 680 } });
  await page.goto('http://localhost:4174/');
  await page.getByTestId('boot-start').click();
  await page.getByTestId('main-menu').waitFor();
  await page.evaluate(() => (window as unknown as Hooks).__PRISMFALL__.updateSection('setup', { unlockAll: true }));
  await page.addStyleTag({ content: '.ui-layer { visibility: hidden !important; }' });
  await page.evaluate((id) => (window as unknown as Hooks).__PRISMFALL__.shell.stageManager.show(id, { transition: 0 }), from);
  await page.waitForTimeout(4000);
  // Preload the target so the crossfade starts immediately when shown.
  await page.evaluate((id) => (window as unknown as Hooks & { __PRISMFALL__: { shell: { stageManager: { prepare(id: string): Promise<unknown> } } } }).__PRISMFALL__.shell.stageManager.prepare(id), to);
  const start = Date.now();
  void page.evaluate((id) => (window as unknown as Hooks).__PRISMFALL__.shell.stageManager.show(id, { transition: 2.5 }), to);
  for (const t of times) {
    const wait = start + t * 1000 - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    await page.screenshot({ path: join(out, `${from}-to-${to}-${t.toFixed(1)}s.jpg`), type: 'jpeg', quality: 85 });
  }
  console.log(`saved to ${out}`);
} finally {
  await browser.close();
}
