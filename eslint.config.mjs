import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      '**/node_modules/**', '**/coverage/**', '**/dist/**',
      'test-results/**', 'playwright-report/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'tests/*.test.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        process: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
      },
    },
  },
  {
    // Shared packages run in both browsers and Node: only common globals.
    files: ['packages/**/*.js'],
    languageOptions: { globals: { ...globals['shared-node-browser'] } },
  },
  {
    files: ['apps/web/**/*.{js,jsx}'],
    languageOptions: {
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['apps/web/vite.config.js', 'playwright.config.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Playwright specs run in Node; page.evaluate callbacks run in the browser.
    files: ['tests/e2e/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  { rules: { eqeqeq: 'error', curly: 'error' } },
];
