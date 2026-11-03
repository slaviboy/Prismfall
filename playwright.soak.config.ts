import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Long-running stability test: the AI plays for SOAK_MINUTES (default 30) per backend while heap,
 * GPU resource counts and frame times are sampled. Results go to perf-results/soak-*.json.
 *   npm run test:soak                       both backends, 30 minutes each
 *   SOAK_MINUTES=5 npm run test:soak -- --project=webgl2
 */
const minutes = Number(process.env.SOAK_MINUTES ?? 30);
const launchArgs = [...(base.use?.launchOptions?.args ?? []), '--enable-precise-memory-info'];

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: ['**/soak.spec.ts'],
  timeout: (minutes * 60 + 300) * 1000,
  reporter: [['list']],
  use: { ...base.use, launchOptions: { args: launchArgs } },
  projects: [
    { name: 'webgpu', use: { baseURL: `${String(base.use?.baseURL)}` } },
    { name: 'webgl2', use: { baseURL: `${String(base.use?.baseURL)}` }, metadata: { query: '?backend=webgl2' } },
  ],
});
