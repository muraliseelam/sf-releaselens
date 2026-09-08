import { defineConfig } from 'vitest/config';

/**
 * The live-org contract suite, kept in its own config so nothing else can pull
 * it in.
 *
 * `npm test`, `npm run check` and CI all use `vitest.config.ts`, whose include
 * is `test/**\/*.test.ts` — these files end in `.org.test.ts` and are excluded
 * there explicitly. Org access is never a prerequisite for a green build.
 */
export default defineConfig({
  test: {
    include: ['test/org/**/*.org.test.ts'],
    environment: 'node',
    pool: 'threads',
    // One org at a time. These make real API calls against somebody's real
    // orgs, and parallelism buys seconds while risking a rate limit.
    fileParallelism: false,
    // The CLI hands out a token per org, and a refresh is a dozen round trips.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
