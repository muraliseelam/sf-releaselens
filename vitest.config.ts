import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
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
      exclude: ['src/ui/main.ts', 'src/ui/handlers.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
  },
});
