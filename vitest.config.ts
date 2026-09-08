import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    /**
     * The live-org contract suite runs only through `npm run test:org`, which
     * uses `vitest.org.config.ts`. Excluded here rather than merely un-included
     * so that a green `npm run check` never depends on somebody having a
     * Salesforce org authenticated.
     */
    exclude: ['test/org/**', '**/node_modules/**'],
    environment: 'node',

    /**
     * Worker threads rather than the default forked processes.
     *
     * Four of the twenty test files opt into jsdom, and the default `forks`
     * pool spawns a full Node process per file and talks to it over an RPC
     * channel. On Windows that handshake is what produces
     * "[vitest-pool-runner]: Timeout waiting for worker to respond" on a loaded
     * machine — the tests themselves pass, but the runner gives up on a worker
     * and exits non-zero. Threads share the process and have no such handshake.
     */
    pool: 'threads',

    /**
     * Persists transformed modules under `node_modules/.vitest-cache` (already
     * ignored, and invalidated whenever dependencies are reinstalled).
     */
    fsModuleCache: true,

    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // `main.ts` and `service-worker.ts` are chrome wiring with no logic of
      // their own; everything they call is covered here.
      include: [
        'src/core/**',
        'src/data/**',
        'src/background/router.ts',
        'src/background/messages.ts',
        'src/ui/**',
      ],
      // `sidepanel.html` is swept up by `src/ui/**` and the coverage provider
      // then tries to parse it as a module, printing a parse error before
      // excluding it anyway. Excluding it here keeps the CI log honest.
      exclude: ['src/ui/main.ts', 'src/ui/handlers.ts', 'src/**/*.html'],
      /**
       * Set just below what the suite actually achieves today
       * (94.2 lines / 93.6 statements / 92.0 functions / 89.2 branches), so
       * coverage cannot silently regress while leaving a little room for an
       * honest refactor. These are a ratchet, not a target: raise them when the
       * real numbers rise, and never lower them to make a run pass.
       */
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 88,
        branches: 85,
      },
    },
  },
});
