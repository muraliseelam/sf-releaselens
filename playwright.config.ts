import { defineConfig } from '@playwright/test';

/**
 * End-to-end configuration: real Chromium, the real packaged extension.
 *
 * Deliberately separate from `vitest.config.ts` and from `npm test`. The unit
 * suite runs in ~5 seconds and is what you run on every save; this launches a
 * browser per worker and is what you run before you believe anything.
 */
export default defineConfig({
  testDir: 'e2e',

  /*
   * One worker. Each test launches its own persistent Chromium profile with the
   * extension loaded, and several of them assert on `chrome.storage.local`,
   * which is per-profile. Parallel workers would still be correct, but they
   * would compete for CPU on a machine that is also compiling, and a flaky
   * browser test is worse than a slow one.
   */
  workers: 1,
  fullyParallel: false,

  /*
   * No retries. A retry that turns red into green hides exactly the class of
   * bug this suite exists to catch — a race between the panel and its service
   * worker. If one of these is flaky, that is the finding.
   */
  retries: 0,

  // Generous: the first test in a run pays for the extension's first install.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // Nothing here is committed; see .gitignore and docs/ASSETS.md.
  outputDir: 'e2e-results',

  reporter: process.env['CI'] === undefined ? [['list']] : [['list'], ['github']],

  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  // Fail a CI run that contains a stray `test.only`.
  forbidOnly: process.env['CI'] !== undefined,

  projects: [
    {
      name: 'e2e',
      // The capture run drives the same product but produces artefacts rather
      // than assertions, and takes a minute of deliberate pauses to do it. It
      // has no place in the suite CI gates on. The org project needs a
      // differently-built extension, so it is its own project too.
      testIgnore: ['**/capture.spec.ts', '**/org.spec.ts'],
    },
    {
      // The org-connected path, served from captured Salesforce payloads. Needs
      // `.org-test-extension/`, which `npm run test:e2e:org` builds first.
      name: 'org',
      testMatch: '**/org.spec.ts',
    },
    {
      name: 'capture',
      testMatch: '**/capture.spec.ts',
      // Long, because it is mostly waiting on purpose.
      timeout: 180_000,
    },
  ],
});
