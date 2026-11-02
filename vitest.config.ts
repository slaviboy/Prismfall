import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@prismfall/sdk': fileURLToPath(new URL('./src/sdk/index.ts', import.meta.url)) },
  },
  define: { __PRISMFALL_HOOKS__: 'true' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'content/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 30000,
  },
});
