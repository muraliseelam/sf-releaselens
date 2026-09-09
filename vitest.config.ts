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
      /*
       * Every directory whose code reaches the packaged extension.
       *
       * `src/auth` was missing from this list until 9 September 2026 — it did
       * not exist when the list was written, and adding a directory to the tree
       * does not add it to a list. So the OAuth exchange and the token refresh,
       * the only code here that touches a credential, were the one part of the
       * extension nobody had a number for. Adding anything new to `src/` means
       * adding it here.
       *
       * `main.ts` and `service-worker.ts` are chrome wiring with no logic of
       * their own; everything they call is covered here.
       */
      include: [
        'src/auth/**',
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
       * Set just below what the suite achieves on 9 September 2026:
       * **94.9 lines / 94.6 statements / 91.4 functions / 91.9 branches**.
       *
       * The previous comment here claimed 94.2 / 93.6 / 92.0 / 89.2, which the
       * suite had not produced for some time. A stale figure in a comment is
       * the same defect as a stale permission justification, and it is fixed
       * the same way: by writing what is true on the day, with the day on it.
       *
       * A ratchet, not a target. Raise them when the real numbers rise; never
       * lower one to make a run pass. Raising the floor here is what stops a
       * new file arriving with no tests and nothing noticing.
       */
      thresholds: {
        lines: 94,
        statements: 94,
        functions: 90,
        branches: 91,
      },
    },
  },
});
