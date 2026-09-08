/**
 * The things a mock cannot have an opinion about.
 *
 * Every test in `panel.spec.ts` could in principle be faked by a good enough
 * stub. These cannot: an MV3 service worker being evicted mid-session, two
 * panels writing to the same storage area, a download actually reaching disk.
 * They are the reason this suite exists.
 */

import type { BrowserContext } from '@playwright/test';

import { expect, readDownload, readStorage, SNAPSHOT_KEY, test } from './fixtures.js';

test.describe('service worker lifecycle', () => {
  /**
   * Chrome evicts an idle MV3 worker after about 30 seconds and restarts it on
   * the next message. Everything in the worker is therefore lost between any
   * two messages, which is why it holds no state — but "holds no state" is a
   * claim about our code that only a real eviction can test.
   */
  test('the panel keeps working after the worker is evicted', async ({ panel }) => {
    await panel.page.locator('#tab-approvals').click();
    await panel.page.locator('.card__actions .textarea').fill('Before the eviction.');
    await panel.page.locator('.card__buttons .button--primary').click();
    await expect(panel.page.locator('#approvals-feedback')).toContainText('Decision recorded');

    await stopServiceWorkers(panel.context);

    // Reload triggers a fresh message, which must restart the worker and be
    // answered from storage rather than from anything the old worker held.
    await panel.reloadPanel();

    await expect(panel.page.locator('.summary__headline')).toContainText('5 releases tracked');
    await panel.page.locator('#tab-approvals').click();
    await expect(
      panel.page.locator('.queue').filter({ hasText: 'Recently decided' }),
    ).toContainText('Before the eviction.');
  });

  test('an eviction between two messages does not lose a write', async ({ panel }) => {
    await panel.page.locator('#tab-approvals').click();
    await panel.page.locator('.card__actions .textarea').fill('Survives a cold worker.');

    await stopServiceWorkers(panel.context);

    // No reload: the open page now talks to a worker that is not running. The
    // message must wake it and be answered.
    await panel.page.locator('.card__buttons .button--primary').click();

    await expect(panel.page.locator('#approvals-feedback')).toContainText('Decision recorded');
    const stored = await readStorage<{ approvals: { decision?: { comment?: string } }[] }>(
      panel.context,
      SNAPSHOT_KEY,
    );
    expect((stored?.approvals ?? []).map((a) => a.decision?.comment)).toContain(
      'Survives a cold worker.',
    );
  });
});

test.describe('two panels at once', () => {
  /**
   * A user with two Chrome windows has two panels reading one storage area.
   * The service worker is the single writer and broadcasts `snapshot.changed`;
   * the second panel re-reads rather than merging. None of that machinery is
   * exercised by a single-page test.
   */
  test('a decision in one panel reaches the other', async ({ panel }) => {
    const second = await panel.openSecondPanel();
    await second.locator('#tab-approvals').click();
    await expect(second.locator('#tab-approvals .tab__badge')).toHaveText('1');

    await panel.page.locator('#tab-approvals').click();
    await panel.page.locator('.card__actions .textarea').fill('Decided in the other window.');
    await panel.page.locator('.card__buttons .button--primary').click();
    await expect(panel.page.locator('#approvals-feedback')).toContainText('Decision recorded');

    // The second panel was told, and re-read without being touched.
    await expect(second.locator('#tab-approvals .tab__badge')).toHaveCount(0);
    await expect(second.locator('.queue').filter({ hasText: 'Recently decided' })).toContainText(
      'Decided in the other window.',
    );
  });

  test('the second decision on one approval is refused, not silently lost', async ({ panel }) => {
    const second = await panel.openSecondPanel();
    await second.locator('#tab-approvals').click();

    await panel.page.locator('#tab-approvals').click();
    await panel.page.locator('.card__actions .textarea').fill('First writer wins.');
    await panel.page.locator('.card__buttons .button--primary').click();
    await expect(panel.page.locator('#approvals-feedback')).toContainText('Decision recorded');

    // The second panel has just been refreshed by the broadcast, so its stale
    // card is gone — which is itself the protection. Prove the worker refuses
    // the stale write even when it is sent anyway.
    const outcome = await second.evaluate(async () => {
      const response: { ok: boolean; error?: { code: string; message: string } } =
        await chrome.runtime.sendMessage({
          type: 'approval.decide',
          approvalId: 'apr-billing-uat',
          outcome: 'approved',
          comment: 'second writer',
        });
      if (response.ok) return { code: 'accepted', message: '' };
      return response.error ?? { code: 'unknown', message: '' };
    });

    // Refused with a reason that names the conflict, not a lost write and not
    // a silent overwrite of the first decision.
    expect(outcome.code).toBe('INVALID_APPROVAL_TRANSITION');
    expect(outcome.message).toContain('already approved');
  });
});

test.describe('rescuing a corrupt snapshot', () => {
  /**
   * This path used to be broken in a way no unit test caught, because the bug
   * was that a download never happened — and jsdom has no downloads. Now it is
   * checked where downloads are real.
   */
  test.beforeEach(async ({ panel }) => {
    const worker = await panel.worker();
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        'sf-releaselens.snapshot.v1': { schemaVersion: 42, rescueMe: true },
      });
    });
    await panel.reloadPanel();
  });

  test('offers rescue before reset, and the rescue actually downloads', async ({ panel }) => {
    await expect(panel.page.locator('#load-error')).toContainText('schema version 42');
    const labels = await panel.page.locator('.notice__actions .button').allTextContents();
    // Export must come before the destructive option.
    expect(labels).toEqual(['Retry', 'Export raw data', 'Reset to demo data']);

    const [download] = await Promise.all([
      panel.page.waitForEvent('download'),
      panel.page.locator('#error-export-raw').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/^sf-releaselens-raw-.*\.json$/);
    const text = await readDownload(download);
    // Byte-for-byte what was stored, not a validated re-serialisation.
    expect(JSON.parse(text)).toEqual({ schemaVersion: 42, rescueMe: true });
  });

  test('never resets the stored data on its own', async ({ panel }) => {
    await expect(panel.page.locator('#load-error')).toBeVisible();

    const stored = await readStorage<{ schemaVersion: number }>(panel.context, SNAPSHOT_KEY);
    expect(stored).toEqual({ schemaVersion: 42, rescueMe: true });
  });

  test('recovers when the user chooses to reset', async ({ panel }) => {
    await panel.page.locator('#error-reset').click();

    await expect(panel.page.locator('.summary__headline')).toHaveText(
      '5 releases tracked · 2 need attention',
    );
  });
});

test.describe('diagnostics', () => {
  /**
   * The unit tests prove the report is built from counts. This proves the
   * button in the panel produces that report, in a real browser, as a real
   * download — and that what lands on disk carries no org data.
   */
  test('downloads a report with versions and counts and no org data', async ({ panel }) => {
    const [download] = await Promise.all([
      panel.page.waitForEvent('download'),
      panel.page.locator('#org-diagnostics').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/^sf-releaselens-diagnostics-.*\.json$/);
    const text = await readDownload(download);
    const report = JSON.parse(text) as {
      report: string;
      environment: { extensionVersion: string; browserMajorVersion: string; platform: string };
      org: { connected: boolean; loginHost: string; instanceHostPattern: string };
      snapshot: { present: boolean; counts: Record<string, number> };
      storage: { key: string }[];
    };

    expect(report.report).toBe('sf-releaselens-diagnostics');
    // Facts only a real browser can supply.
    expect(report.environment.browserMajorVersion).toMatch(/^\d+$/);
    expect(report.environment.platform).not.toBe('unknown');
    expect(report.environment.extensionVersion).toMatch(/^\d+\.\d+\.\d+$/);

    // The demo dataset, described in counts.
    expect(report.snapshot.present).toBe(true);
    expect(report.snapshot.counts['releases']).toBe(5);
    expect(report.snapshot.counts['items']).toBe(57);
    expect(report.org.connected).toBe(false);
    expect(report.storage.map((entry) => entry.key)).toEqual(['sf-releaselens.snapshot.v1']);

    // And none of the names the demo dataset is full of.
    for (const forbidden of [
      'Payment Retry Hotfix',
      'PaymentGatewayAdapter',
      'Sam Okafor',
      'salesforce.com',
      'rel-billing-q3',
    ]) {
      expect(text, `${forbidden} leaked into the diagnostics`).not.toContain(forbidden);
    }
  });

  test('works when the snapshot is too corrupt to load, which is when it is needed', async ({
    panel,
  }) => {
    const worker = await panel.worker();
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ 'sf-releaselens.snapshot.v1': { schemaVersion: 42 } });
    });
    await panel.reloadPanel();
    await expect(panel.page.locator('#load-error')).toBeVisible();

    const [download] = await Promise.all([
      panel.page.waitForEvent('download'),
      panel.page.locator('#org-diagnostics').click(),
    ]);
    const report = JSON.parse(await readDownload(download)) as {
      snapshot: { present: boolean };
      storage: { key: string; bytes: number }[];
    };

    // The snapshot could not be loaded — which is the finding, not a failure.
    expect(report.snapshot.present).toBe(false);
    expect(report.storage[0]?.key).toBe('sf-releaselens.snapshot.v1');
  });
});

test.describe('storage boundaries', () => {
  test('writes nothing to session storage while no org is connected', async ({ panel }) => {
    const worker = await panel.worker();
    await panel.page.locator('#tab-approvals').click();
    await panel.page.locator('.card__buttons .button--primary').click();
    await expect(panel.page.locator('#approvals-feedback')).toBeVisible();

    // Session storage is where the refresh token would live. Local mode must
    // not put anything there at all.
    expect(await worker.evaluate(() => chrome.storage.session.get(null))).toEqual({});
  });

  test('keeps only the keys it documents in local storage', async ({ panel }) => {
    const worker = await panel.worker();
    await panel.page.locator('#tab-approvals').click();
    await panel.page.locator('.card__buttons .button--primary').click();
    await expect(panel.page.locator('#approvals-feedback')).toBeVisible();

    const keys = Object.keys(
      await worker.evaluate((): Promise<object> => chrome.storage.local.get(null)),
    ).sort();

    // An undocumented key is either a leak or a forgotten migration. Both are
    // worth failing over. Update SECURITY.md's table if this list changes.
    expect(keys).toEqual(['sf-releaselens.snapshot.v1']);
  });

  test('"Start empty" clears the snapshot rather than hiding it', async ({ panel }) => {
    await panel.page.locator('#demo-start-empty').click();
    await expect(panel.page.locator('.summary__headline')).toContainText('0 releases tracked');

    const stored = await readStorage<{ releases: unknown[]; items: unknown[] }>(
      panel.context,
      SNAPSHOT_KEY,
    );
    expect(stored?.releases).toEqual([]);
    expect(stored?.items).toEqual([]);
  });
});

/**
 * Evicts every running extension service worker, the way Chrome does when the
 * worker goes idle. There is no Playwright API for this, so it goes through
 * CDP against a throwaway page.
 *
 * Stop, never unregister. `ServiceWorker.unregister` on an extension scope does
 * not merely evict the worker, it takes the extension down for the rest of the
 * browser session — every later `chrome-extension://` navigation fails with
 * ERR_ABORTED. Eviction is what Chrome actually does, and what we want to
 * survive.
 */
async function stopServiceWorkers(context: BrowserContext): Promise<void> {
  if (context.serviceWorkers().length === 0) return;

  const scratch = await context.newPage();
  const session = await context.newCDPSession(scratch);
  await session.send('ServiceWorker.enable');
  await session.send('ServiceWorker.stopAllWorkers');
  await session.detach();
  await scratch.close();
}
