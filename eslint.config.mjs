import js from '@eslint/js';

export default [
  { ignores: ['**/node_modules/**', '**/coverage/**', '**/dist/**'] },
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
  { rules: { eqeqeq: 'error', curly: 'error' } },
];
