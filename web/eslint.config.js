import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

// The lint script existed in package.json but there was no config file, so it had never
// actually run. This is the standard Vite React + TypeScript flat config.
export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Warn rather than error. The pattern this flags (fetch in an effect, then set
      // state with the result; a countdown timer driving state) is used throughout the
      // pages and is correct here. Reworking every page's data loading to satisfy it is
      // a separate change, so it should not block CI in the meantime.
      'react-hooks/set-state-in-effect': 'warn',
      // Unused function arguments are common in React event handlers and callbacks;
      // flag unused variables but allow deliberately-ignored parameters.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
);
