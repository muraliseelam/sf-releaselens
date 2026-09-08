/**
 * The one place that knows how to get a real Chromium running this extension.
 *
 * Everything here is deliberately strict about failure. The value of an
 * end-to-end suite over the unit tests is that it can observe things a mock
 * cannot: a service worker that throws on registration, a module the manifest
 * does not ship, a `chrome.*` call that rejects only in a real browser. All of
 * those surface as console noise rather than as a failed assertion, so console
 * output is treated as a test failure by default.
 *
 * ## What this can and cannot drive
 *
 * The panel document is loaded as an extension page at the manifest's
 * `side_panel.default_path`, not inside Chrome's side-panel host frame. There
 * is no automation surface for the browser's own side-panel chrome, so clicking
 * the toolbar icon is not reachable. Everything below the host frame — the
 * document, the service worker, `chrome.storage`, message passing, the whole
 * product — is the real thing at the real extension origin. What stays
 * unverified is the host frame itself: that `openPanelOnActionClick` actually
 * opens it, and how the panel is sized when it does. Those are in
 * `docs/QA-CHECKLIST.md`.
 *
 * ## Why the browser is shared
 *
 * One Chromium per worker, not per test. Launching costs a couple of seconds;
 * *deleting* a Chromium profile directory on Windows costs tens of seconds,
 * because the browser is still letting go of its file handles. Doing that
 * thirty times turned a 90-second suite into a seven-minute one. Isolation is
 * kept by clearing both storage areas before every test, which is the only
 * state the extension has.
 */

import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type Download,
  type Page,
  type Worker,
} from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DIST = join(projectRoot, 'dist');

export const SNAPSHOT_KEY = 'sf-releaselens.snapshot.v1';

/**
 * Console messages that are Chrome talking to itself rather than the extension
 * misbehaving. Kept as an explicit, tiny list: an allow-list that grows without
 * argument is how a console-error gate stops finding anything.
 */
const IGNORED_CONSOLE: readonly RegExp[] = [
  // Chromium emits this when a page is closed while a message is in flight,
  // which happens in teardown and says nothing about the extension.
  /message channel closed before a response was received/i,
];

interface Browser {
  readonly context: BrowserContext;
  /** The extension id Chrome assigned this load. Never hardcoded. */
  readonly extensionId: string;
  readonly panelUrl: string;
  /** Errors seen since the last reset; the per-test fixture drains this. */
  readonly errors: string[];
}

export interface PanelHarness {
  readonly context: BrowserContext;
  readonly extensionId: string;
  /** The panel document, already loaded and past its first paint. */
  readonly page: Page;
  /** The extension's service worker, restarted if Chrome had evicted it. */
  worker(): Promise<Worker>;
  /** Reloads the panel document and waits for it to be interactive again. */
  reloadPanel(): Promise<void>;
  /** Opens a second panel document, for the two-windows-at-once cases. */
  openSecondPanel(): Promise<Page>;
  /** Everything the browser has complained about during this test. */
  readonly consoleErrors: readonly string[];
}

export const test = base.extend<{ panel: PanelHarness }, { browser_: Browser }>({
  browser_: [
    // Playwright's fixture signature requires the first parameter even when
    // nothing is destructured out of it.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      if (!existsSync(join(DIST, 'manifest.json'))) {
        throw new Error(
          'dist/manifest.json is missing. These tests drive the built extension, not the source. Run "npm run build" first.',
        );
      }

      const userDataDir = await mkdtemp(join(tmpdir(), 'sf-releaselens-e2e-'));
      const context = await chromium.launchPersistentContext(userDataDir, {
        // The bundled Chromium's new headless mode, which — unlike the old one
        // — loads extensions and runs service workers.
        channel: 'chromium',
        args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
        // Roughly the width Chrome gives a side panel, so a layout that only
        // breaks when narrow breaks here too.
        viewport: { width: 480, height: 900 },
      });

      const errors: string[] = [];
      const record = (source: string, text: string): void => {
        if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return;
        errors.push(`${source}: ${text}`);
      };
      context.on('console', (message) => {
        if (message.type() === 'error') record('console', message.text());
      });
      // `weberror` is the context-level uncaught exception. There is no
      // context-level `pageerror`: attaching one compiles to nothing and
      // silently records no errors at all, which is worse than not trying.
      context.on('weberror', (error) => record('weberror', error.error().message));

      /*
       * An unhandled promise rejection fires neither of the above — it is a
       * window event, and it is exactly the failure mode of a UI whose every
       * action is an async message to a service worker. Forwarded into the
       * console channel, which is already a failure.
       */
      await context.addInitScript(() => {
        window.addEventListener('unhandledrejection', (event) => {
          const reason: unknown = event.reason;
          console.error(
            `unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
          );
        });
      });

      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      // A worker's console does not surface on the context.
      const watchWorker = (target: Worker): void => {
        target.on('console', (message) => {
          if (message.type() === 'error') record('serviceworker', message.text());
        });
      };
      watchWorker(worker);
      context.on('serviceworker', watchWorker);

      const extensionId = new URL(worker.url()).host;

      await use({
        context,
        extensionId,
        panelUrl: `chrome-extension://${extensionId}/ui/sidepanel.html`,
        errors,
      });

      await context.close();
      // Chromium may still be releasing handles; a profile left in the temp
      // directory is not worth failing a suite over.
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    },
    { scope: 'worker' },
  ],

  panel: async ({ browser_ }, use, testInfo) => {
    const extraPages: Page[] = [];
    const page = await browser_.context.newPage();

    const openPanel = async (target: Page = page): Promise<void> => {
      await target.goto(browser_.panelUrl);
      // The panel paints a loading state first and fills in once the worker
      // answers. Waiting for the tab strip means waiting for a real round trip
      // through `chrome.runtime.sendMessage`.
      await target.waitForSelector('[role="tab"]');
      await expect(target.locator('.loading')).toHaveCount(0);
    };

    /*
     * Loading the panel is itself what wakes an evicted worker, because the
     * panel's first act is to message it. So this polls for the worker rather
     * than waiting on the `serviceworker` event: by the time anyone can
     * subscribe, the restart may already have happened, and waiting for an
     * event that has been and gone is how a suite acquires a hang.
     */
    const wakeWorker = async (): Promise<Worker> => {
      const running = browser_.context.serviceWorkers()[0];
      if (running !== undefined) return running;
      await openPanel();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const restarted = browser_.context.serviceWorkers()[0];
        if (restarted !== undefined) return restarted;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('the service worker did not restart within 5 seconds');
    };

    // Fresh state, without a fresh browser. This is the entire isolation
    // story, so it runs before the test rather than after: a test that
    // crashes mid-way must not leave the next one dirty.
    const worker = await wakeWorker();
    await worker.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
    });
    browser_.errors.length = 0;

    await openPanel();

    await use({
      context: browser_.context,
      extensionId: browser_.extensionId,
      page,
      worker: wakeWorker,
      reloadPanel: () => openPanel(),
      async openSecondPanel() {
        const second = await browser_.context.newPage();
        extraPages.push(second);
        await openPanel(second);
        return second;
      },
      consoleErrors: browser_.errors,
    });

    for (const extra of extraPages) await extra.close();
    await page.close();

    // A test that already failed has a better story to tell than "and also the
    // console was noisy", so only assert this on a passing test.
    if (testInfo.status === testInfo.expectedStatus && browser_.errors.length > 0) {
      testInfo.status = 'failed';
      testInfo.error = {
        message: `The browser reported ${browser_.errors.length} error(s) that no assertion caught:\n  ${browser_.errors.join('\n  ')}`,
      };
    }
  },
});

export { expect };

/** Reads a key straight out of the extension's own storage, as Chrome sees it. */
export async function readStorage<T>(context: BrowserContext, key: string): Promise<T | undefined> {
  const worker = context.serviceWorkers()[0];
  if (worker === undefined) throw new Error('the service worker is not running');
  const value: unknown = await worker.evaluate(async (storageKey: string) => {
    const result = await chrome.storage.local.get(storageKey);
    return result[storageKey];
  }, key);
  // Storage is `unknown` by construction; the caller says what it expects, and
  // the assertion it makes is the thing under test.
  return value as T | undefined;
}

/**
 * The text of a download, read from where Chrome actually put it.
 *
 * `createReadStream` hands back a Node stream, not a web one, which is a
 * distinction the type checker catches and a transpiling test runner does not.
 */
export async function readDownload(download: Download): Promise<string> {
  const path = await download.path();
  return readFile(path, 'utf8');
}
