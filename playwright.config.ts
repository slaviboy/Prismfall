import { defineConfig } from '@playwright/test';

/**
 * E2E tests run against a `vite build --mode test` bundle (debug hooks enabled) using the
 * installed Google Chrome so the real GPU (WebGPU / WebGL 2) is available.
 * Set PW_DEV=1 to test against the dev server instead.
 */
const useDev = process.env.PW_DEV === '1';
const port = useDev ? 5173 : 4174;

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/soak.spec.ts', '**/perf.spec.ts'],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${port}/`,
    channel: 'chrome',
    viewport: { width: 1600, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--use-angle=d3d11'],
    },
  },
  projects: [{ name: 'chrome' }],
  webServer: {
    command: useDev ? 'npm run dev' : 'npm run build:test && npx vite preview --mode test --outDir dist-test',
    port,
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
