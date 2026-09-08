/**
 * Launch assets, captured by driving the real extension.
 *
 * Not part of the default e2e run — see the `capture` project in
 * `playwright.config.ts`. Run it with `npm run assets`.
 *
 * The point of generating these from a live browser rather than mocking up a
 * design is that a screenshot then cannot show a state the product does not
 * actually reach. If the dashboard stops rendering the blocked release first,
 * the screenshot changes; there is no separate mockup to forget to update.
 *
 * Output goes to `build-assets/`, which is gitignored. Committing a megabyte of
 * PNGs that a script regenerates in ninety seconds is how a repository becomes
 * unpleasant to clone.
 */

import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(projectRoot, 'dist');
const OUT = join(projectRoot, 'build-assets');
const RAW = join(OUT, 'raw');
const VIDEO = join(OUT, 'video');

/**
 * The width Chrome gives a side panel by default, and the height of a laptop
 * browser window. The store plates are composed from these by
 * `scripts/compose-store-shots.mjs`; capturing at panel width keeps the text
 * at the size a user actually reads it.
 */
const PANEL = { width: 480, height: 800 };

/** Long enough for a viewer to register what changed, short enough to loop. */
const BEAT = 900;

test('captures the walkthrough, the store shots and a video', async () => {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(RAW, { recursive: true });
  await mkdir(VIDEO, { recursive: true });

  const userDataDir = await mkdtemp(join(tmpdir(), 'sf-releaselens-capture-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    viewport: PANEL,
    recordVideo: { dir: VIDEO, size: PANEL },
    // A recording made at 1x on a HiDPI machine and at 1x on a normal one
    // should be the same file; pinning this is what makes that true.
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });

  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();

  const shots: string[] = [];
  const shoot = async (name: string): Promise<void> => {
    const file = join(RAW, `${name}.png`);
    await page.screenshot({ path: file });
    shots.push(name);
    // Progress, because this run is mostly deliberate waiting and a silent
    // two minutes is indistinguishable from a hang.
    process.stdout.write(`  captured ${name}
`);
  };
  const beat = async (): Promise<void> => {
    await page.waitForTimeout(BEAT);
  };

  await page.goto(`chrome-extension://${extensionId}/ui/sidepanel.html`);
  await page.waitForSelector('[role="tab"]');
  await expect(page.locator('.loading')).toHaveCount(0);
  await beat();

  // ---- 1. The dashboard, as a new user first sees it -----------------------
  await shoot('01-dashboard');
  await beat();

  // The blocked release, found by clicking the chip rather than by scrolling.
  await page.locator('#chip-status-blocked').click();
  await beat();
  await shoot('02-dashboard-blocked');
  await beat();

  // ---- 2. Into the inspector, scoped to that release -----------------------
  await page.locator('.list .row').first().click();
  await expect(page.locator('[aria-label="Metadata inspector"]')).toBeVisible();
  await beat();

  await page.locator('#inspector-search').fill('payment');
  await beat();
  await shoot('03-inspector-filtered');
  await beat();

  // ---- 3. One component, in detail ----------------------------------------
  await page.locator('#inspector-search').fill('PaymentGatewayAdapter');
  await page.locator('.list--compact .row').first().click();
  await expect(page.locator('.detail__title')).toHaveText('PaymentGatewayAdapter');
  await beat();
  await shoot('04-component-detail');
  await beat();

  // ---- 4. An approval, decided --------------------------------------------
  await page.locator('#tab-approvals').click();
  await expect(page.locator('[aria-label="Approvals"]')).toBeVisible();
  await beat();
  await shoot('05-approvals-queues');

  await typeLikeAPerson(page, '.card__actions .textarea', 'Verified in UAT.');
  await beat();
  await page.locator('.card__buttons .button--primary').click();
  await expect(page.locator('#approvals-feedback')).toContainText('Decision recorded');
  await beat();
  await shoot('06-approval-recorded');
  await beat();

  // ---- 5. The honest states, which are the differentiator ------------------
  /*
   * A component whose source records no dependency edges.
   *
   * The import goes through the same `snapshot.import` message the toolbar
   * button sends, rather than through the OS file picker. The rendered state
   * is therefore genuinely the product's, and the only step skipped is the one
   * that has nothing to do with the screenshot. The picker itself is covered
   * by `panel.spec.ts`; driving it here made the capture hang, and a recording
   * script is not the place to fight the operating system.
   */
  await page.evaluate(async (text: string) => {
    await chrome.runtime.sendMessage({ type: 'snapshot.import', text });
  }, JSON.stringify(DEPLOY_REPORT));
  await page.reload();
  await page.waitForSelector('[role="tab"]');
  await expect(page.locator('.summary__headline')).toContainText('1 release tracked');
  await beat();

  await page.locator('#tab-inspector').click();
  await page.locator('.list--compact .row').first().click();
  const unavailable = page.locator('.detail .notice--warn').first();
  await expect(unavailable).toBeVisible();
  // The notice is the point of this shot, and the detail pane is below the
  // filters; without this it sits under the fold at panel height.
  await unavailable.scrollIntoViewIfNeeded();
  await beat();
  await shoot('07-dependencies-unavailable');

  // The org strip, in the only state reachable without a live org: the form
  // that asks the user for their own Connected App. A "connected" shot would
  // have to be staged, and a staged screenshot of a connection that never
  // happened is not something to put on a store listing.
  await page.locator('#org-connect').click();
  await expect(page.locator('#org-client-id')).toBeVisible();
  await beat();
  await shoot('08-org-connect-form');

  /*
   * Order matters. The video file is only finalised once the page is closed,
   * and its path is only resolvable after that; Playwright names it after an
   * internal id, so it is renamed to something a human can find. The profile
   * directory is left behind on purpose — deleting one on Windows can take
   * most of a minute while Chromium lets go of its handles, and the operating
   * system cleans its own temp directory.
   */
  const video = page.video();
  await page.close();
  if (video !== null) {
    await rename(await video.path(), join(VIDEO, 'walkthrough.webm')).catch(() => undefined);
  }
  await context.close();

  // Chromium sometimes finalises a second, empty recording for a page the
  // runner opened. Leaving it beside the real one makes the output directory
  // ambiguous.
  for (const leftover of await readdir(VIDEO)) {
    if (leftover !== 'walkthrough.webm') {
      await rm(join(VIDEO, leftover), { force: true }).catch(() => undefined);
    }
  }

  await writeFile(
    join(OUT, 'manifest.json'),
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        panelViewport: PANEL,
        shots,
        video: 'video/walkthrough.webm',
        note: 'Regenerate with `npm run assets`. Nothing here is committed; see docs/ASSETS.md.',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  expect(shots.length).toBe(8);
});

/**
 * Types a character at a time, because a recording of text appearing all at
 * once reads as a cut rather than as someone using the tool.
 */
async function typeLikeAPerson(page: Page, selector: string, text: string): Promise<void> {
  await page.locator(selector).focus();
  await page.keyboard.type(text, { delay: 45 });
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
