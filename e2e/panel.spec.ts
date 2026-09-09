/**
 * The extension, in a real browser, doing what the README says it does.
 *
 * Every assertion here is against rendered output produced by the real service
 * worker, the real `chrome.storage`, and the real message channel. Nothing is
 * stubbed. Numbers are the demo dataset's actual numbers, so a change to the
 * seed that quietly changes what a new user sees fails here.
 */

import type { Page } from '@playwright/test';

import { expect, readDownload, readStorage, SNAPSHOT_KEY, test } from './fixtures.js';

test.describe('loading the extension', () => {
  test('registers a service worker at the extension origin', async ({ panel }) => {
    const worker = await panel.worker();

    expect(worker.url()).toBe(
      `chrome-extension://${panel.extensionId}/background/service-worker.js`,
    );
    // A module worker that failed to parse would still register but could not
    // answer; this proves it is alive and running our code.
    expect(await worker.evaluate(() => typeof chrome.runtime.getManifest())).toBe('object');
  });

  test('ships the manifest it claims, including the side panel entry point', async ({ panel }) => {
    const worker = await panel.worker();
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(['storage', 'sidePanel', 'identity']);
    // The load must request no host permission at all. This is the claim in
    // SECURITY.md that matters most, and Chrome is the authority on it.
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.side_panel?.default_path).toBe('ui/sidepanel.html');
  });

  test('has the side panel API available and takes no host permission on install', async ({
    panel,
  }) => {
    const worker = await panel.worker();

    expect(await worker.evaluate(() => typeof chrome.sidePanel.setPanelBehavior)).toBe('function');
    expect(
      await worker.evaluate(() =>
        chrome.permissions.contains({ origins: ['https://login.salesforce.com/*'] }),
      ),
    ).toBe(false);
  });

  test('ships every icon the manifest declares, and Chrome can decode them', async ({ panel }) => {
    for (const size of [16, 32, 48, 128]) {
      // Fetched from inside the extension page: chrome-extension: is not a
      // protocol Playwright's request context speaks, and decoding it as an
      // image is a stronger claim than "the bytes are there" anyway.
      const decoded = await panel.page.evaluate(async (iconSize: number) => {
        const response = await fetch(chrome.runtime.getURL(`icons/icon-${iconSize}.png`));
        if (!response.ok) return { ok: false, status: response.status, width: 0, height: 0 };
        const bitmap = await createImageBitmap(await response.blob());
        return { ok: true, status: response.status, width: bitmap.width, height: bitmap.height };
      }, size);

      expect(decoded, `icon-${size}.png`).toEqual({
        ok: true,
        status: 200,
        width: size,
        height: size,
      });
    }
  });
});

test.describe('release dashboard', () => {
  test('summarises the demo dataset with the numbers the README quotes', async ({ panel }) => {
    await expect(panel.page.locator('.summary__headline')).toHaveText(
      '5 releases tracked · 2 need attention',
    );

    // Nine statuses plus "All". Every status is shown, including the ones at
    // zero: a missing chip reads as "no such status", not as "none of these".
    await expect(panel.page.locator('.chips .chip')).toHaveCount(10);
    await expect(panel.page.locator('#chip-status-blocked')).toHaveAttribute(
      'aria-label',
      'Blocked: 1 release',
    );
    await expect(panel.page.locator('#chip-status-rolled_back')).toHaveAttribute(
      'aria-label',
      'Rolled back: 0 releases',
    );
  });

  test('says it is demo data, and offers a way out', async ({ panel }) => {
    await expect(panel.page.locator('.notice--info')).toContainText('Demo data');
    await expect(panel.page.locator('#demo-start-empty')).toBeVisible();
  });

  test('sorts the releases that need attention to the top', async ({ panel }) => {
    const first = panel.page.locator('.list .row').first();

    await expect(first).toHaveClass(/row--attention/);
    await expect(first).toContainText('Payment Retry Hotfix');
  });

  test('filters to one release when a status chip is clicked', async ({ panel }) => {
    await panel.page.locator('#chip-status-blocked').click();

    await expect(panel.page.locator('.list .row')).toHaveCount(1);
    await expect(panel.page.locator('.list .row')).toContainText('Payment Retry Hotfix');
    await expect(panel.page.locator('#chip-status-blocked')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('opens a release in the inspector, already scoped to it', async ({ panel }) => {
    await panel.page.locator('.list .row').first().click();

    await expect(panel.page.locator('[aria-label="Metadata inspector"]')).toBeVisible();
    await expect(panel.page.locator('#tab-inspector')).toHaveAttribute('aria-selected', 'true');
    const caption = await panel.page.locator('.caption').textContent();
    expect(caption).toMatch(/^\d+ of 57 components/);
    expect(caption).not.toMatch(/^57 of 57/);
  });
});

/*
 * The first run, for somebody who has not read the documentation.
 *
 * The fixture clears both storage areas before every test, so each of these
 * starts from a genuinely empty profile — the same state a fresh install is in.
 */
test.describe('the first run', () => {
  test('seeds demo data and says so, with a way out beside it', async ({ panel }) => {
    // Demo data on a genuinely fresh profile is a deliberate choice: it makes
    // the product evaluable in one click. It is only defensible while it is
    // labelled and reversible in the same breath.
    const notice = panel.page.locator('.notice--info');

    await expect(notice).toContainText('Demo data');
    await expect(notice).toContainText('not your org');
    await expect(panel.page.locator('#demo-start-empty')).toBeVisible();
  });

  test('offers to connect an org without anybody reading the documentation', async ({ panel }) => {
    await expect(panel.page.locator('#org-connect')).toBeVisible();
    await expect(panel.page.locator('.orgbar')).toContainText('no org connected');
  });

  test('links to the Connected App instructions rather than naming a file path', async ({
    panel,
  }) => {
    // A side panel has no checkout to open a relative path in.
    await panel.page.locator('#org-connect').click();

    const help = panel.page.locator('#org-connected-app-help');
    await expect(help).toBeVisible();
    expect(await help.getAttribute('href')).toMatch(/^https:\/\/github\.com\//);
    expect(await help.getAttribute('rel')).toBe('noreferrer');
    await expect(panel.page.locator('.connectform')).not.toContainText('docs/CONNECTED-APP.md');
  });

  test('offers both routes once the demo data is cleared', async ({ panel }) => {
    await panel.page.locator('#demo-start-empty').click();
    await expect(panel.page.locator('.summary__headline')).toContainText('0 releases tracked');

    const empty = panel.page.locator('.empty');
    await expect(empty).toContainText('No releases yet.');
    await expect(panel.page.locator('#dashboard-connect')).toBeVisible();
    await expect(panel.page.locator('#dashboard-import')).toBeVisible();
    // Each route says what it gives, rather than being a bare pair of buttons.
    await expect(empty).toContainText('Read-only');
    await expect(empty).toContainText('sf project deploy report');
  });

  test('connecting from the empty dashboard opens the one connect form', async ({ panel }) => {
    await panel.page.locator('#demo-start-empty').click();
    await panel.page.locator('#dashboard-connect').click();

    // The same form the org strip opens, not a second copy of it.
    await expect(panel.page.locator('.connectform')).toHaveCount(1);
    await expect(panel.page.locator('#org-login-url')).toHaveValue(
      'https://login.salesforce.com',
    );
    await expect(panel.page.locator('#org-client-id')).toHaveValue('');
  });

  test('survives a reload with the empty state it was left in', async ({ panel }) => {
    await panel.page.locator('#demo-start-empty').click();
    await panel.reloadPanel();

    // Not re-seeded: the snapshot exists and is empty, which is different from
    // absent, and only absent seeds.
    await expect(panel.page.locator('.summary__headline')).toContainText('0 releases tracked');
    await expect(panel.page.locator('#dashboard-connect')).toBeVisible();
  });
});

test.describe('metadata inspector', () => {
  test.beforeEach(async ({ panel }) => {
    await panel.page.locator('#tab-inspector').click();
  });

  test('starts with the whole snapshot', async ({ panel }) => {
    await expect(panel.page.locator('.caption')).toContainText('57 of 57 components');
  });

  test('narrows on a search term and reports the count', async ({ panel }) => {
    await panel.page.locator('#inspector-search').fill('payment');

    const rows = panel.page.locator('.list--compact .row');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(57);
    await expect(panel.page.locator('.caption')).toContainText(`${count} of 57 components`);
  });

  test('shows the detail pane for a selected component', async ({ panel }) => {
    await panel.page.locator('#inspector-search').fill('PaymentGatewayAdapter');
    await panel.page.locator('.list--compact .row').first().click();

    const detail = panel.page.locator('.detail');
    await expect(detail.locator('.detail__title')).toHaveText('PaymentGatewayAdapter');
    await expect(detail).toContainText('55% covered');
    await expect(detail).toContainText('HARDCODED_ID');
  });

  test('never shows unknown coverage as zero', async ({ panel }) => {
    await panel.page.locator('#inspector-search').fill('ProrationCalculator');
    await panel.page.locator('.list--compact .row').first().click();

    await expect(panel.page.locator('.detail .fields')).toContainText('Coverage unknown');
    await expect(panel.page.locator('.detail')).not.toContainText('0% covered');
  });

  test('walks the dependency graph in both directions', async ({ panel }) => {
    await panel.page.locator('#inspector-search').fill('InvoiceBuilder');
    await panel.page.locator('.list--compact .row').first().click();
    await expect(panel.page.locator('.detail__title')).toHaveText('InvoiceBuilder');

    await expect(panel.page.locator('.detail')).toContainText('Depends on (2)');
    await panel.page.locator('#dep-in-' + (await firstDependentId(panel))).click();

    // Selection moved to the dependent, and the detail pane followed.
    await expect(panel.page.locator('.detail__title')).not.toHaveText('InvoiceBuilder');
  });

  test('filters by metadata type using the facet chips', async ({ panel }) => {
    await panel.page.locator('#chip-type-Flow').click();

    await expect(panel.page.locator('#chip-type-Flow')).toHaveAttribute('aria-pressed', 'true');
    const rows = await panel.page.locator('.list--compact .row').count();
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(57);
  });
});

/** The id of the first component listed under "Depended on by". */
async function firstDependentId(panel: { page: Page }): Promise<string> {
  const id = await panel.page
    .locator('.detail__block')
    .filter({ hasText: 'Depended on by' })
    .locator('.link')
    .first()
    .getAttribute('id');
  if (id === null) throw new Error('no dependent link rendered');
  return id.replace(/^dep-in-/, '');
}

test.describe('approvals helper', () => {
  test.beforeEach(async ({ panel }) => {
    await panel.page.locator('#tab-approvals').click();
  });

  test('splits the queues and badges what is waiting on the actor', async ({ panel }) => {
    await expect(panel.page.locator('.queue__title').first()).toContainText('Waiting on you');
    await expect(panel.page.locator('#tab-approvals .tab__badge')).toHaveText('1');
    // Only the actionable queue offers buttons.
    await expect(panel.page.locator('.card__buttons')).toHaveCount(1);
  });

  test('refuses a rejection with no comment', async ({ panel }) => {
    await panel.page.locator('.card__buttons .button--danger').click();

    await expect(panel.page.locator('.notice--error')).toContainText('MISSING_REJECTION_COMMENT');
    // Refused, not partly applied: the approval is still pending.
    await expect(panel.page.locator('#tab-approvals .tab__badge')).toHaveText('1');
  });

  test('keeps a half-typed comment across the re-render every keystroke causes', async ({
    panel,
  }) => {
    await panel.page.locator('.card__buttons .button--danger').click();
    await expect(panel.page.locator('.notice--error')).toBeVisible();

    // The panel rebuilds its whole body on every input event, so this is a
    // real test of the draft surviving, not of the DOM holding its own value.
    await panel.page.locator('.card__actions .textarea').type('half a thought');

    await expect(panel.page.locator('.card__actions .textarea')).toHaveValue('half a thought');
  });

  test('records an approval and reports the effect on the release', async ({ panel }) => {
    await panel.page.locator('.card__actions .textarea').fill('Verified in UAT.');
    await panel.page.locator('.card__buttons .button--primary').click();

    await expect(panel.page.locator('#approvals-feedback')).toContainText('Decision recorded');
    await expect(panel.page.locator('#approvals-feedback')).toContainText('is now approved');
    // Nothing is left waiting on the actor, so the badge goes.
    await expect(panel.page.locator('#tab-approvals .tab__badge')).toHaveCount(0);
  });

  test('the decision survives a panel reload, because it was written to storage', async ({
    panel,
  }) => {
    await panel.page.locator('.card__actions .textarea').fill('Signed off after regression.');
    await panel.page.locator('.card__buttons .button--primary').click();
    await expect(panel.page.locator('#approvals-feedback')).toContainText('Decision recorded');

    await panel.reloadPanel();
    await panel.page.locator('#tab-approvals').click();

    await expect(
      panel.page.locator('.queue').filter({ hasText: 'Recently decided' }),
    ).toContainText('Signed off after regression.');
    await expect(panel.page.locator('#tab-approvals .tab__badge')).toHaveCount(0);

    // And it is genuinely on disk, not merely in the page's memory.
    const stored = await readStorage<{ approvals: { decision?: { comment?: string } }[] }>(
      panel.context,
      SNAPSHOT_KEY,
    );
    const comments = (stored?.approvals ?? []).map((approval) => approval.decision?.comment);
    expect(comments).toContain('Signed off after regression.');
  });

  test('a rejection blocks the release and says so', async ({ panel }) => {
    // Switch to the role the QA gate requires, so a rejection is possible.
    await panel.page.locator('#actor-role').selectOption('qa-lead');
    await panel.page.locator('.card__actions .textarea').fill('Regression suite is red.');
    await panel.page.locator('.card__buttons .button--danger').click();

    await expect(panel.page.locator('#approvals-feedback')).toContainText('is now rejected');
    await expect(panel.page.locator('#approvals-feedback')).toContainText('to blocked');

    await panel.page.locator('#tab-dashboard').click();
    await expect(panel.page.locator('.summary__headline')).toContainText('3 need attention');
  });
});

test.describe('import and export', () => {
  test('exports the snapshot as a real download', async ({ panel }) => {
    const [download] = await Promise.all([
      panel.page.waitForEvent('download'),
      panel.page.locator('#toolbar-export').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/^sf-releaselens-.*\.json$/);
    const text = await readDownload(download);
    const parsed = JSON.parse(text) as { releases: unknown[]; items: unknown[] };
    expect(parsed.releases).toHaveLength(5);
    expect(parsed.items).toHaveLength(57);
  });

  test('round-trips its own export back through import', async ({ panel }) => {
    const [download] = await Promise.all([
      panel.page.waitForEvent('download'),
      panel.page.locator('#toolbar-export').click(),
    ]);
    const exported = await readDownload(download);

    // Change the state, so a no-op import would be indistinguishable from a
    // working one.
    await panel.page.locator('#demo-start-empty').click();
    await expect(panel.page.locator('.summary__headline')).toContainText('0 releases tracked');

    const [chooser] = await Promise.all([
      panel.page.waitForEvent('filechooser'),
      panel.page.locator('#toolbar-import').click(),
    ]);
    await chooser.setFiles({
      name: 'round-trip.json',
      mimeType: 'application/json',
      buffer: Buffer.from(exported, 'utf8'),
    });

    await expect(panel.page.locator('.summary__headline')).toHaveText(
      '5 releases tracked · 2 need attention',
    );
    // The demo banner is gone: this is imported data now, not the seed.
    await expect(panel.page.locator('.notice--info')).toHaveCount(0);
  });

  test('imports an sf deploy report and marks its dependency data unavailable', async ({
    panel,
  }) => {
    const [chooser] = await Promise.all([
      panel.page.waitForEvent('filechooser'),
      panel.page.locator('#toolbar-import').click(),
    ]);
    await chooser.setFiles({
      name: 'deploy-report.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(DEPLOY_REPORT), 'utf8'),
    });

    await expect(panel.page.locator('.summary__headline')).toContainText('1 release tracked');

    await panel.page.locator('#tab-inspector').click();
    await panel.page.locator('.list--compact .row').first().click();

    const detail = panel.page.locator('.detail');
    // The whole point of the flag: this must not read as "no dependencies".
    await expect(detail.locator('.notice--warn')).toHaveCount(2);
    await expect(detail).toContainText('Dependency data is not available');
    await expect(detail).toContainText('deploy report');
    await expect(detail).not.toContainText('No dependencies recorded');
    await expect(detail).not.toContainText('Nothing in this snapshot depends on it');
    // And no "(0)" count beside either heading.
    const subtitles = await detail.locator('.detail__subtitle').allTextContents();
    expect(subtitles).toContain('Depends on');
    expect(subtitles).toContain('Depended on by');

    // package.xml is a manifest, not metadata, and must not be listed.
    await panel.page.locator('#detail-close').click();
    await expect(panel.page.locator('.list--compact')).not.toContainText('package.xml');
  });

  test('refuses a malformed import and leaves the snapshot untouched', async ({ panel }) => {
    const [chooser] = await Promise.all([
      panel.page.waitForEvent('filechooser'),
      panel.page.locator('#toolbar-import').click(),
    ]);
    await chooser.setFiles({
      name: 'nonsense.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{not json', 'utf8'),
    });

    await expect(panel.page.locator('.notice--error')).toContainText('IMPORT_FORMAT');
    await expect(panel.page.locator('.notice--error')).toContainText('untouched');

    // Recovery works, and the original data is still there.
    await panel.page.locator('#error-retry').click();
    await expect(panel.page.locator('.summary__headline')).toHaveText(
      '5 releases tracked · 2 need attention',
    );
  });
});

test.describe('keyboard only', () => {
  test('moves between the three surfaces with the arrow keys', async ({ panel }) => {
    await panel.page.locator('#tab-dashboard').focus();

    await panel.page.keyboard.press('ArrowRight');
    await expect(panel.page.locator('[aria-label="Metadata inspector"]')).toBeVisible();
    expect(await focusedId(panel.page)).toBe('tab-inspector');

    await panel.page.keyboard.press('ArrowRight');
    await expect(panel.page.locator('[aria-label="Approvals"]')).toBeVisible();

    await panel.page.keyboard.press('Home');
    await expect(panel.page.locator('[aria-label="Release dashboard"]')).toBeVisible();
    expect(await focusedId(panel.page)).toBe('tab-dashboard');
  });

  test('costs one Tab stop for the whole tab strip', async ({ panel }) => {
    await panel.page.locator('#toolbar-export').focus();

    await panel.page.keyboard.press('Tab');
    expect(await focusedId(panel.page)).toBe('demo-start-empty');

    // Through the org bar, then into the strip, then straight past it.
    const seen: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      await panel.page.keyboard.press('Tab');
      seen.push(await focusedId(panel.page));
    }
    const tabsVisited = seen.filter((id) => id.startsWith('tab-'));
    expect(tabsVisited).toEqual(['tab-dashboard']);
  });

  test('drives a whole approval from the keyboard, and keeps focus somewhere useful', async ({
    panel,
  }) => {
    await panel.page.locator('#tab-approvals').focus();
    await panel.page.keyboard.press('End');
    await expect(panel.page.locator('[aria-label="Approvals"]')).toBeVisible();

    const comment = panel.page.locator('.card__actions .textarea');
    await comment.focus();
    await panel.page.keyboard.type('Approved from the keyboard.');
    await panel.page.keyboard.press('Tab');
    expect(await focusedId(panel.page)).toMatch(/^approve-/);

    await panel.page.keyboard.press('Enter');

    await expect(panel.page.locator('#approvals-feedback')).toContainText('Decision recorded');
    // The card the user was standing on has gone; focus must not be on <body>.
    expect(await focusedId(panel.page)).toBe('approvals-feedback');
  });

  test('activates a status chip with the keyboard and stays on it', async ({ panel }) => {
    await panel.page.locator('#chip-status-blocked').focus();
    await panel.page.keyboard.press('Enter');

    await expect(panel.page.locator('.list .row')).toHaveCount(1);
    expect(await focusedId(panel.page)).toBe('chip-status-blocked');
  });

  test('selects a component with the keyboard and stays on the row', async ({ panel }) => {
    await panel.page.locator('#tab-inspector').click();
    const row = panel.page.locator('.list--compact .row').first();
    const id = await row.getAttribute('id');
    await row.focus();
    await panel.page.keyboard.press('Enter');

    await expect(panel.page.locator('.detail')).toBeVisible();
    expect(await focusedId(panel.page)).toBe(id);
  });
});

async function focusedId(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.id ?? '');
}

/** Shaped after a real `sf project deploy report --json` payload. */
const DEPLOY_REPORT = {
  status: 0,
  result: {
    id: '0AfWs00000abcDEFG',
    status: 'Failed',
    checkOnly: false,
    createdDate: '2026-09-05T08:00:00.000Z',
    completedDate: '2026-09-05T08:07:31.000Z',
    numberComponentsTotal: 3,
    details: {
      componentSuccesses: [
        {
          fullName: 'InvoiceBuilder',
          componentType: 'ApexClass',
          fileName: 'classes/InvoiceBuilder.cls',
          created: true,
          changed: false,
          deleted: false,
          createdByName: 'Lin Zhou',
        },
        {
          fullName: 'package.xml',
          componentType: '',
          fileName: 'package.xml',
          created: false,
          changed: true,
          deleted: false,
        },
      ],
      componentFailures: [
        {
          fullName: 'LegacyTaxCalculator',
          componentType: 'ApexClass',
          fileName: 'classes/LegacyTaxCalculator.cls',
          problem: 'Dependent class is invalid and needs recompilation.',
          problemType: 'Error',
          deleted: true,
        },
      ],
    },
  },
};
