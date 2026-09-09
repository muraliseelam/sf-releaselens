/**
 * The org-connected panel, driven by payloads a real Salesforce org returned.
 *
 * Every response served here comes from `test/fixtures/org/*.json`, captured
 * from live orgs by `scripts/capture-org-fixtures.mjs` and scrubbed of
 * content — but not of shape. So the transport parses what Salesforce actually
 * sends, the mapper maps it, `chrome.storage` stores it and the real UI renders
 * it, all inside Chrome. Nothing about the response is invented.
 *
 * ## Two deliberate seams, and why
 *
 * **The extension under test has its host permission pre-granted.** Chrome's
 * optional-permission prompt is browser chrome, not page content: Playwright
 * cannot click it in any mode, and a `--load-extension` extension is not
 * written to the profile so the grant cannot be seeded there either. Without
 * it, `currentDataSource` throws and the org path is unreachable — the surface
 * most likely to be wrong would be tested only in jsdom. See
 * `scripts/build-org-test-extension.mjs`; it changes the manifest and nothing
 * else, and `panel.spec.ts` asserts the *shipped* manifest still requests no
 * host permission at all.
 *
 * **The OAuth session is seeded rather than performed.** `launchWebAuthFlow`
 * opens a Salesforce login window that only a human can complete. The refresh
 * token is written straight into `chrome.storage.session`, which is exactly the
 * state a completed sign-in leaves behind, and the token exchange that follows
 * is served from a route like every other request.
 */

import { expect, orgTest as test, ORG_HOST, LOGIN_HOST } from './org-fixtures.js';

test.describe("the manifest's host patterns, as Chrome resolves them", () => {
  /**
   * Whether `https://*.my.salesforce.com/*` reaches a scratch org is a question
   * about Chrome's match-pattern rules, not about this code — so it is put to
   * Chrome. `chrome.permissions.contains` answers with the browser's own
   * matcher against the granted patterns, which in this build are exactly the
   * manifest's `optional_host_permissions` moved to `host_permissions`.
   *
   * The scratch case is the one that mattered: three scratch orgs existed that
   * the compatibility run had never touched, and "the pattern probably covers
   * it" was not good enough to build on.
   */
  const covered = [
    ['a scratch org', 'https://acme.scratch.my.salesforce.com/*'],
    ['a sandbox', 'https://acme--uat.sandbox.my.salesforce.com/*'],
    ['a developer org', 'https://acme.develop.my.salesforce.com/*'],
    ['a My Domain org', 'https://acme.my.salesforce.com/*'],
    ['the production login endpoint', 'https://login.salesforce.com/*'],
    ['the sandbox login endpoint', 'https://test.salesforce.com/*'],
  ] as const;

  for (const [what, origin] of covered) {
    test(`reaches ${what}`, async ({ orgPanel }) => {
      const worker = await orgPanel.worker();

      expect(
        await worker.evaluate(
          (target: string) => chrome.permissions.contains({ origins: [target] }),
          origin,
        ),
        `${origin} is not reachable by the manifest's host patterns`,
      ).toBe(true);
    });
  }

  const notCovered = [
    ['a Visualforce/Experience host', 'https://acme.my.force.com/*'],
    ['anything outside Salesforce', 'https://example.com/*'],
  ] as const;

  for (const [what, origin] of notCovered) {
    test(`does not reach ${what}`, async ({ orgPanel }) => {
      const worker = await orgPanel.worker();

      // The other half of the claim. A permission set that reached these would
      // be asking for more than the product needs.
      expect(
        await worker.evaluate(
          (target: string) => chrome.permissions.contains({ origins: [target] }),
          origin,
        ),
      ).toBe(false);
    });
  }
});

test.describe('a refresh against real Salesforce payloads', () => {
  test('shows the org, not local data, once connected', async ({ orgPanel }) => {
    await expect(orgPanel.page.locator('.orgbar__name')).toHaveText('fixture-org.my.salesforce.com');
    await expect(orgPanel.page.locator('.orgbar__meta')).toContainText('never refreshed');
    // The demo banner belongs to local mode and must be gone; what is on
    // screen instead is the org's own "never read" notice, which is correct.
    await expect(orgPanel.page.locator('.notice--info')).toContainText(
      'This org has never been read',
    );
    await expect(orgPanel.page.locator('.notice--info')).not.toContainText('Demo data');
  });

  test('enables Refresh, and nothing has been read until it is pressed', async ({ orgPanel }) => {
    const refresh = orgPanel.page.locator('#org-refresh');

    await expect(refresh).toBeEnabled();
    // No polling, no timer, no background fetch: the claim, checked where the
    // network is real.
    expect(orgPanel.requests.filter((url) => url.startsWith(ORG_HOST))).toEqual([]);
  });

  test('maps real deploy records into releases named by their deploy id', async ({ orgPanel }) => {
    await orgPanel.refresh();

    const rows = orgPanel.page.locator('.list .row');
    await expect(rows.first()).toBeVisible();
    // The capture lists the ten most recent; Salesforce has no release name, so
    // each one shows its deploy id.
    await expect(orgPanel.page.locator('.summary__headline')).toContainText('10 releases tracked');
    await expect(rows.first()).toContainText('0Af');
  });

  test('reads component details from the Metadata API endpoint', async ({ orgPanel }) => {
    await orgPanel.refresh();

    const metadataCalls = orgPanel.requests.filter((url) => url.includes('/metadata/deployRequest/'));
    const toolingDetailCalls = orgPanel.requests.filter((url) =>
      url.includes('/tooling/sobjects/DeployRequest/'),
    );

    expect(metadataCalls.length).toBeGreaterThan(0);
    // Every one of them asks for the details explicitly. Without this the
    // arrays come back empty and every release has no components.
    expect(metadataCalls.every((url) => url.includes('includeDetails=true'))).toBe(true);
    expect(toolingDetailCalls).toEqual([]);
  });

  test('renders the components a real deploy contained', async ({ orgPanel }) => {
    await orgPanel.refresh();
    await orgPanel.page.locator('#tab-inspector').click();

    const caption = await orgPanel.page.locator('.caption').textContent();
    // The defect this whole session started from: this was zero.
    expect(caption).not.toContain('0 of 0 components');
    await expect(orgPanel.page.locator('.list--compact .row').first()).toBeVisible();
  });

  test('says dependency data is unavailable for every org-sourced component', async ({
    orgPanel,
  }) => {
    await orgPanel.refresh();
    await orgPanel.page.locator('#tab-inspector').click();
    await orgPanel.page.locator('.list--compact .row').first().click();

    const detail = orgPanel.page.locator('.detail');
    await expect(detail.locator('.notice--warn')).toHaveCount(2);
    await expect(detail).toContainText('Dependency data is not available');
    await expect(detail).not.toContainText('No dependencies recorded');
  });

  test('attributes components to whoever ran the deploy', async ({ orgPanel }) => {
    await orgPanel.refresh();
    await orgPanel.page.locator('#tab-inspector').click();
    await orgPanel.page.locator('.list--compact .row').first().click();

    // A component carries no author; the deploy does. Before that was threaded
    // through, every org-sourced component read "unknown". Asserted on the
    // "Last modified" field alone — the pane also says "Coverage unknown",
    // which is a different and correct unknown.
    const lastModified = orgPanel.page.locator('.detail .fields dd').nth(5);
    await expect(lastModified).toContainText('Alex Fixture');
    await expect(lastModified).not.toContainText('unknown');
  });

  test('applies a local name overlay, and never invents a name without one', async ({
    orgPanel,
  }) => {
    await orgPanel.refresh();
    const deployId = (await orgPanel.page.locator('.row__title').first().textContent())!.trim();

    await orgPanel.setOverlay({
      [deployId]: { name: 'Q3 Billing', version: '2026.09.1', riskLevel: 'high' },
    });
    await orgPanel.refresh();

    await expect(orgPanel.page.locator('.list .row').first()).toContainText('Q3 Billing');
    await expect(orgPanel.page.locator('.list .row').first()).toContainText('2026.09.1');
    // Every other release still shows its id, because no name was invented.
    await expect(orgPanel.page.locator('.list .row').nth(1)).toContainText('0Af');
  });

  test('banners staleness once the cached read is old enough', async ({ orgPanel }) => {
    await orgPanel.refresh();
    await expect(orgPanel.page.locator('.orgbar__meta')).toContainText('refreshed');

    // Age the refresh audit entry past the staleness threshold, which is what
    // the passage of time would do.
    await orgPanel.ageLastRefresh(45);

    await expect(orgPanel.page.locator('.notice--warn').first()).toContainText(
      /out of date|stale/i,
    );
  });

  test('records that coverage was unavailable, when the org will not answer', async ({
    orgPanel,
  }) => {
    await orgPanel.useFixture('no-coverage-support');
    await orgPanel.refresh();

    // The releases still arrive — the whole point of degrading rather than
    // failing — and the reason is on the record. The count is whatever that org
    // had when it was captured, so it is asserted as "some", not as a number
    // that a re-capture would invalidate.
    await expect(orgPanel.page.locator('.list .row').first()).toBeVisible();
    const audit = await orgPanel.readAuditDetail();
    expect(audit).toContain('Coverage is unavailable in this org');
    expect(audit).toContain('INVALID_TYPE');
  });

  test('shows a check-only run as validated, and never as scheduled', async ({ orgPanel }) => {
    await orgPanel.useFixture('mixed-history');
    await orgPanel.refresh();

    const validated = orgPanel.page.locator('.list .row').filter({ hasText: 'Validated, not deployed' });

    // The capture carries one real check-only deploy from a live org.
    await expect(validated).toHaveCount(1);
    await expect(validated).toContainText('Check-only');
    // "Scheduled" is still in the chip legend; no release row may claim it.
    await expect(
      orgPanel.page.locator('.list .row').filter({ hasText: 'Scheduled' }),
    ).toHaveCount(0);
  });

  test('says in the inspector that a validated release deployed nothing', async ({ orgPanel }) => {
    await orgPanel.useFixture('mixed-history');
    await orgPanel.refresh();

    await orgPanel.page.locator('.list .row').filter({ hasText: 'Check-only' }).first().click();
    await expect(orgPanel.page.locator('[aria-label="Metadata inspector"]')).toBeVisible();
    await orgPanel.page.locator('.list--compact .row').first().click();

    const detail = orgPanel.page.locator('.detail .fields');
    await expect(detail).toContainText('Deployed?');
    await expect(detail).toContainText('No — check-only validation');
  });

  test('says how many of how many deployments are shown, and offers more', async ({ orgPanel }) => {
    await orgPanel.useFixture('mixed-history');
    await orgPanel.refresh();

    // The capture holds the ten most recent of twelve. Two are missing, and
    // silence about that was the defect.
    await expect(orgPanel.page.locator('.summary')).toContainText('Showing 10 of 12 deployments');
    const more = orgPanel.page.locator('#dashboard-load-more');
    await expect(more).toHaveText('Load 2 more');
    await expect(more).toHaveAttribute('title', /API call/);
  });

  test('renders an org with no deploy history as empty, not as an error', async ({ orgPanel }) => {
    await orgPanel.useFixture('namespaced-empty');
    await orgPanel.refresh();

    await expect(orgPanel.page.locator('.summary__headline')).toContainText('0 releases tracked');
    await expect(orgPanel.page.locator('.notice--error')).toHaveCount(0);
    await expect(orgPanel.page.locator('.loading')).toHaveCount(0);
    // The empty state, not a blank panel.
    await expect(orgPanel.page.locator('.empty')).toBeVisible();
  });

  test('refuses clearly when the org has retired the pinned API version', async ({ orgPanel }) => {
    await orgPanel.retirePinnedApiVersion();
    await orgPanel.page.locator('#org-refresh').click();

    const error = orgPanel.page.locator('.notice--error').first();
    await expect(error).toContainText('no longer offers');
    await expect(error).toContainText('needs updating');
  });

  test('keeps the token out of storage that survives the browser', async ({ orgPanel }) => {
    await orgPanel.refresh();

    const worker = await orgPanel.worker();
    const local = await worker.evaluate((): Promise<object> => chrome.storage.local.get(null));
    const serialised = JSON.stringify(local);

    // The refresh token lives in session storage; the access token lives in
    // worker memory. Neither may reach disk, and this is where that is real.
    expect(serialised).not.toContain('fixture-refresh-token');
    expect(serialised).not.toContain('fixture-access-token');
    expect(Object.keys(local).sort()).toEqual([
      'sf-releaselens.org-session-fixture-marker',
      'sf-releaselens.org-settings.v1',
      'sf-releaselens.org-snapshot.v1',
    ]);
  });

  test('sends the access token as a bearer header and nothing else', async ({ orgPanel }) => {
    await orgPanel.refresh();

    const authorised = orgPanel.headers.filter((entry) => entry.url.startsWith(ORG_HOST));
    expect(authorised.length).toBeGreaterThan(0);
    for (const entry of authorised) {
      expect(entry.authorization).toBe('Bearer fixture-access-token');
      // No cookies, no session id, nothing borrowed from a logged-in tab.
      expect(entry.cookie).toBeUndefined();
    }
  });

  test('talks only to the org and its login host', async ({ orgPanel }) => {
    await orgPanel.refresh();

    for (const url of orgPanel.requests) {
      expect(
        url.startsWith(ORG_HOST) || url.startsWith(LOGIN_HOST),
        `unexpected request to ${url}`,
      ).toBe(true);
    }
  });
});
