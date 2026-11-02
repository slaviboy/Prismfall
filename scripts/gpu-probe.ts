/**
 * Diagnostic: reports the GPU adapter Chrome exposes to WebGPU and WebGL 2, headless and headed.
 * Usage: node scripts/gpu-probe.ts
 */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';

// WebGPU requires a secure context: serve a blank page from http://localhost.
const server = createServer((_req, res) => res.end('<!doctype html><title>probe</title>')).listen(4199);

const ARGS = ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'];

for (const headless of [true, false]) {
  const browser = await chromium.launch({ channel: 'chrome', headless, args: ARGS });
  const page = await browser.newPage();
  await page.goto('http://localhost:4199/');
  const info = await page.evaluate(async () => {
    const out: Record<string, unknown> = { webgpu: !!navigator.gpu };
    if (navigator.gpu) {
      const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (a) {
        out.vendor = a.info.vendor;
        out.architecture = a.info.architecture;
        out.description = a.info.description;
        out.fallback = (a.info as unknown as { isFallbackAdapter?: boolean }).isFallbackAdapter ?? false;
        out.timestampQuery = a.features.has('timestamp-query');
      } else out.adapter = null;
    }
    const gl = document.createElement('canvas').getContext('webgl2');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    out.webgl2 = gl && dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl ? 'masked' : 'unavailable';
    return out;
  });
  console.log(headless ? 'headless:' : 'headed:  ', JSON.stringify(info));
  await browser.close();
}
server.close();
