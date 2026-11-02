import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'dist-test', 'node_modules', 'test-results', 'playwright-report', 'assets/blender/**', 'perf-results'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    // Content modules may only depend on the public Content SDK and three.js.
    files: ['content/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['../../src/*', '../../../src/*', '**/src/**', '@/*'], message: 'Content may only import @prismfall/sdk, three and three/tsl.' }],
      }],
    },
  },
  {
    files: ['scripts/**/*.ts', 'e2e/**/*.ts', '*.config.ts', '*.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
);
