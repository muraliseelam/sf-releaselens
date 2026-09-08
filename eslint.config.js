import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

/** Globals available in an extension page, a service worker, and Node 22. */
const WEB_GLOBALS = {
  chrome: 'readonly',
  fetch: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  Headers: 'readonly',
  RequestInit: 'readonly',
  RequestInfo: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  btoa: 'readonly',
  atob: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  document: 'readonly',
  window: 'readonly',
  navigator: 'readonly',
  URL: 'readonly',
  Blob: 'readonly',
};

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '*.tsbuildinfo'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
      globals: WEB_GLOBALS,
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs['recommended-type-checked'].rules,

      // Project non-negotiables, enforced rather than reviewed by hand.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      // A `default` clause is an intentional fallback here, not an oversight:
      // deploy statuses come from Salesforce and may gain new values.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CatchClause[param=null]',
          message: 'Bare `catch {}` swallows errors. Bind the error and handle or rethrow it.',
        },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // The two sanctioned network call sites. See the no-restricted-globals
    // comment above: everywhere else reaches the org through OrgConnection.
    files: ['src/data/fetchConnection.ts', 'src/auth/oauth.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    // The build script and the benchmark are Node, not a browser or a worker.
    files: ['scripts/**/*.mjs', 'bench/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
      },
    },
  },
  {
    // Playwright's config and the e2e suite run in Node, and the page/worker
    // callbacks they send into the browser use the browser's globals. Both
    // sets are legitimate here, in a way they are not in src/.
    files: ['playwright.config.ts', 'e2e/**/*.ts'],
    languageOptions: {
      globals: {
        ...WEB_GLOBALS,
        process: 'readonly',
        Buffer: 'readonly',
        createImageBitmap: 'readonly',
        performance: 'readonly',
        PerformanceNavigationTiming: 'readonly',
      },
    },
    rules: {
      // The suite reaches into `chrome.*` responses and storage payloads that
      // are `unknown` by construction; narrowing them by assertion at the
      // point of use is the honest shape.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    languageOptions: {
      globals: {
        ...WEB_GLOBALS,
        // Property tests read FC_RUNS to widen a hunt, and clone fixtures so a
        // mutation in one case cannot reach the next.
        process: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      // Tests deliberately construct malformed payloads to prove the validator
      // rejects them, and deliberately narrow `unknown` responses by assertion.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `expect(handlers.dispatch)` passes a method reference on purpose; the
      // rule guards against losing `this`, which a vitest spy never uses.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
];
