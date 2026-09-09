import { defineConfig } from 'vitest/config';

/**
 * The vitest configuration Stryker runs against. `npm run mutate`.
 *
 * Separate from `vitest.config.ts` for one reason: two settings that are right
 * for the everyday suite are wrong for a mutation run, and neither can be
 * changed in place without making the everyday suite worse.
 *
 * **`pool` and `fileParallelism` are left to Stryker.** Its runner needs the
 * mutant it activated — a global — to be visible to the code under test, which
 * means one worker and no file parallelism. `vitest.config.ts` pins
 * `pool: 'threads'` to work around a Windows runner timeout, and that pin makes
 * every mutant survive: the tests run in a worker that never sees the active
 * mutant, so nothing ever fails and the score comes out near zero.
 *
 * **No `fsModuleCache`.** Caching transformed modules across runs is worth a
 * few seconds in the everyday suite; in a mutation run it is a way for a
 * previous mutant's transform to be reused.
 *
 * **No coverage.** Stryker collects its own, and v8 coverage instrumentation on
 * top of Stryker's instrumentation is a way to spend minutes measuring nothing.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/org/**', '**/node_modules/**'],
    environment: 'node',

    /*
     * Safe here, and worth about 45% of the wall clock: Stryker instruments
     * each source file once and switches mutants at runtime through an
     * environment variable, so every mutant shares one transform. The cache
     * cannot serve a stale one.
     */
    fsModuleCache: true,
  },
});
