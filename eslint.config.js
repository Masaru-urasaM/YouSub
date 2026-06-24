// ESLint 9 flat config — YouSub (vanilla JS ESM, MV3 browser extension; no build step).
// Scope: surface likely-bugs via @eslint/js recommended; per-area globals so legitimate
// runtime/test identifiers are not flagged as undefined. Style is owned by Prettier.
import js from '@eslint/js';
import globals from 'globals';

export default [
  // Global ignores (must be a standalone object to apply repo-wide).
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'dist/**',
      'build/**',
      '**/*.zip',
      // Bundled third-party polyfill — not our code to lint.
      'src/shared/libs/**',
      // Scratch/junk scheduled for removal in Phase 73.
      'tmp/**',
    ],
  },

  js.configs.recommended,

  // Extension source: content scripts + background service worker.
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        ...globals.webextensions,
      },
    },
  },

  // Build / packaging tooling runs under Node.
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // Jest tests run in jsdom: Node + jest + browser globals; the chrome mock
  // assigns global.chrome / global.browser, so allow writing those.
  {
    files: ['tests/**/*.{js,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.jest,
        ...globals.browser,
        chrome: 'writable',
        browser: 'writable',
      },
    },
  },

  // Project-wide rule tuning. Keep no-unused-vars as a warning during the
  // Milestone 7 triage so `npm run lint` (errors only) stays actionable.
  {
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
