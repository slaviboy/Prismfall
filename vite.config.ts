import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const sdkEntry = fileURLToPath(new URL('./src/sdk/index.ts', import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: './',
  resolve: {
    alias: { '@prismfall/sdk': sdkEntry },
  },
  define: {
    // Debug hooks (window.__PRISMFALL__) exist only in dev and test builds.
    __PRISMFALL_HOOKS__: JSON.stringify(mode !== 'production'),
  },
  server: { host: 'localhost', port: 5173, strictPort: true },
  preview: { host: 'localhost', port: mode === 'test' ? 4174 : 4173, strictPort: true },
  build: {
    target: 'es2023',
    sourcemap: mode !== 'production',
    chunkSizeWarningLimit: 2500,
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
}));
