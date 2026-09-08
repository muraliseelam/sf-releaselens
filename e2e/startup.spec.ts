/**
 * How long the panel takes to become useful, measured in a real browser.
 *
 * The side panel is opened and closed dozens of times a day, so its cost is not
 * "how fast does it render 10,000 components" — the benchmark answers that — it
 * is "how long between clicking the icon and being able to read the dashboard".
 * That number includes Chrome starting the extension page, the service worker
 * waking if Chrome evicted it, one message round trip, validating the stored
 * snapshot and the first paint. None of it is measurable outside a browser.
 *
 * The ceilings are set from measured reality with wide headroom, because CI
 * machines are slower and noisier than a laptop. They exist to catch a
 * regression of the kind that doubles the number, not to police a few
 * milliseconds.
 */

import { expect, test } from './fixtures.js';

/** Repeats, so one unlucky sample cannot decide the result. */
const SAMPLES = 5;

/**
 * Warm: the service worker is already running, which is the common case when a
 * user closes and reopens the panel while working.
 */
const WARM_CEILING_MS = 1_500;

/**
 * Cold: Chrome evicted the worker, so the first message has to start it. This
 * is what a user gets on the first open after a while away.
 */
const COLD_CEILING_MS = 4_000;

function median(samples: readonly number[]): number {
  return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
}

test.describe('time to interactive', () => {
  test('the panel is readable quickly with the worker already running', async ({ panel }, info) => {
    const samples: number[] = [];

    for (let attempt = 0; attempt < SAMPLES; attempt += 1) {
      const started = Date.now();
      await panel.reloadPanel();
      // Interactive means the dashboard is on screen with real numbers in it,
      // not merely that the document loaded.
      await expect(panel.page.locator('.summary__headline')).toContainText('releases tracked');
      samples.push(Date.now() - started);
    }

    const result = median(samples);
    info.annotations.push({
      type: 'time-to-interactive (warm)',
      description: `${result} ms median of ${SAMPLES} (${samples.join(', ')})`,
    });

    expect(result).toBeLessThan(WARM_CEILING_MS);
  });

  test('the panel is readable after Chrome has evicted the service worker', async ({
    panel,
  }, info) => {
    const scratch = await panel.context.newPage();
    const session = await panel.context.newCDPSession(scratch);
    await session.send('ServiceWorker.enable');
    await session.send('ServiceWorker.stopAllWorkers');
    await session.detach();
    await scratch.close();

    const started = Date.now();
    await panel.reloadPanel();
    await expect(panel.page.locator('.summary__headline')).toContainText('releases tracked');
    const elapsed = Date.now() - started;

    info.annotations.push({
      type: 'time-to-interactive (cold worker)',
      description: `${elapsed} ms`,
    });

    expect(elapsed).toBeLessThan(COLD_CEILING_MS);
  });

  test('reports what the browser itself measured, for the record', async ({ panel }, info) => {
    await panel.reloadPanel();

    /*
     * Chrome's own navigation timing, which excludes the harness overhead the
     * wall-clock numbers above include. Recorded rather than asserted: it
     * measures the document, not the point at which the panel had data, and
     * asserting on it would be asserting on the wrong thing.
     */
    const timing = await panel.page.evaluate(() => {
      const [entry] = performance.getEntriesByType(
        'navigation',
      ) as PerformanceNavigationTiming[];
      if (entry === undefined) return null;
      return {
        domInteractive: Math.round(entry.domInteractive),
        domContentLoaded: Math.round(entry.domContentLoadedEventEnd),
        loadEvent: Math.round(entry.loadEventEnd),
      };
    });

    expect(timing).not.toBeNull();
    info.annotations.push({
      type: 'navigation timing',
      description: JSON.stringify(timing),
    });

    // The document itself must be interactive promptly; everything after that
    // is the message round trip, covered above.
    expect(timing!.domInteractive).toBeLessThan(WARM_CEILING_MS);
  });
});
