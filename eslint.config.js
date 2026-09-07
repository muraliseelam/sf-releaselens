import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

/** Globals available in an extension page, a service worker, and Node 22. */
const WEB_GLOBALS = {
  chrome: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  document: 'readonly',
  window: 'readonly',
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
    // The build script and the benchmark are Node, not a browser or a worker.
    files: ['scripts/**/*.mjs', 'bench/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  {
    files: ['test/**/*.ts'],
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
