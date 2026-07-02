// Minimal ESLint config focused on catching the "white screen" class of bug:
// references to identifiers/components that aren't imported or defined. These
// pass the bundler (esbuild doesn't do scope analysis) but throw at runtime.
//
//   npm run lint
//
// Scope is deliberately narrow — this is a correctness guard, not a style linter.
import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      // The core guards — an undefined variable or JSX component is a runtime crash
      // (a "white screen"). esbuild doesn't do scope analysis, so these are exactly
      // the bugs the bundler misses.
      'no-undef': 'error',
      'react/jsx-no-undef': 'error',
      // Rules of Hooks — a conditional/early-return hook white-screens the page.
      'react-hooks/rules-of-hooks': 'error',
    },
  },
];
