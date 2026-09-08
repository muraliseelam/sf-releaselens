/**
 * A Chromium running the extension against captured Salesforce payloads.
 *
 * Separate from `fixtures.ts` because it needs a different extension build —
 * see `scripts/build-org-test-extension.mjs` and the note at the top of
 * `org.spec.ts` — and because every request the worker makes is routed to a
 * fixture rather than to a network.
 *
 * The routing is deliberately literal. Each URL the extension asks for is
 * matched against the shape of the captured response for that endpoint, and an
 * unmatched request fails the test rather than returning something plausible: a
 * fixture server that quietly answers everything is a fixture server that
 * proves nothing.
 */

import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TEST_EXTENSION = join(projectRoot, '.org-test-extension');
const FIXTURES = join(projectRoot, 'test', 'fixtures', 'org');

/** The org this fixture pretends to be. Matches the manifest's host pattern. */
export const ORG_HOST = 'https://fixture-org.my.salesforce.com';
export const LOGIN_HOST = 'https://test.salesforce.com';
const API_VERSION = '62.0';

const SESSION_KEY = 'sf-releaselens.org-session.v1';
const SETTINGS_KEY = 'sf-releaselens.org-settings.v1';
const ORG_SNAPSHOT_KEY = 'sf-releaselens.org-snapshot.v1';
const OVERLAY_KEY = 'sf-releaselens.release-overlay.v1';

/**
 * A marker key, so the storage-contents assertion in `org.spec.ts` has
 * something stable to name. Written by the harness, never by the product.
 */
const MARKER_KEY = 'sf-releaselens.org-session-fixture-marker';

interface Capture {
  versions: { ok: boolean; value?: unknown };
  limits: { ok: boolean; value?: unknown };
  organization: { ok: boolean; value?: unknown };
  deployRequests: { ok: boolean; value?: { records?: { Id?: string }[] } };
  coverage: { ok: boolean; value?: unknown; status?: number; errorCode?: string; message?: string };
  deployDetails: { ok: boolean; value?: { id?: string } }[];
}

function loadCapture(label: string): Capture {
  const path = join(FIXTURES, `${label}.json`);
  if (!existsSync(path)) throw new Error(`No captured fixture named "${label}" in ${FIXTURES}`);
  return JSON.parse(readFileSync(path, 'utf8')) as Capture;
}

export interface OrgPanel {
  readonly context: BrowserContext;
  readonly page: Page;
  worker(): Promise<Worker>;
  /** Presses Refresh and waits for the panel to settle. */
  refresh(): Promise<void>;
  /** Switches which captured org is being served, and reconnects to it. */
  useFixture(label: string): Promise<void>;
  /** Writes the local release-name overlay. */
  setOverlay(overlay: Record<string, unknown>): Promise<void>;
  /** Backdates the last refresh by N minutes, so staleness can be observed. */
  ageLastRefresh(minutes: number): Promise<void>;
  /** The `detail` of the most recent audit entry in the org snapshot. */
  readAuditDetail(): Promise<string>;
  /** Serves a version list without the version this build pins. */
  retirePinnedApiVersion(): Promise<void>;
  /** Every URL the extension asked for, in order. */
  readonly requests: string[];
  /** Authorization and cookie headers seen per request. */
  readonly headers: { url: string; authorization?: string | undefined; cookie?: string | undefined }[];
}

export const orgTest = base.extend<{ orgPanel: OrgPanel }>({
  // Playwright's fixture signature requires the first parameter even when
  // nothing is destructured out of it.
  // eslint-disable-next-line no-empty-pattern
  orgPanel: async ({}, use) => {
    if (!existsSync(join(TEST_EXTENSION, 'manifest.json'))) {
      throw new Error(
        'The org-test extension is missing. Run `npm run build && node scripts/build-org-test-extension.mjs`, or use `npm run test:e2e:org`.',
      );
    }

    const userDataDir = await mkdtemp(join(tmpdir(), 'sf-releaselens-org-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${TEST_EXTENSION}`,
        `--load-extension=${TEST_EXTENSION}`,
      ],
      viewport: { width: 480, height: 900 },
    });

    let capture = loadCapture('rich-history');
    let versionsOverride: unknown;
    const requests: string[] = [];
    const headers: {
      url: string;
      authorization?: string | undefined;
      cookie?: string | undefined;
    }[] = [];

    const json = (body: unknown, status = 200) => ({
      status,
      headers: {
        'content-type': 'application/json',
        // The extension has the host permission in this build, but the routed
        // response still has to satisfy CORS for the worker's fetch.
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      },
      body: JSON.stringify(body),
    });

    await context.route(`${LOGIN_HOST}/**`, async (route) => {
      const request = route.request();
      requests.push(request.url());
      if (request.method() === 'OPTIONS') return route.fulfill(json({}, 204));
      // The refresh-token grant. The panel never sees this; the worker does.
      return route.fulfill(
        json({
          access_token: 'fixture-access-token',
          instance_url: ORG_HOST,
          issued_at: String(Date.now()),
          token_type: 'Bearer',
        }),
      );
    });

    await context.route(`${ORG_HOST}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push(request.url());
      headers.push({
        url: request.url(),
        authorization: (await request.headerValue('authorization')) ?? undefined,
        cookie: (await request.headerValue('cookie')) ?? undefined,
      });

      if (request.method() === 'OPTIONS') return route.fulfill(json({}, 204));

      const path = url.pathname;
      const query = url.searchParams.get('q') ?? '';

      if (path === '/services/data/' || path === '/services/data') {
        return route.fulfill(json(versionsOverride ?? capture.versions.value));
      }
      if (path === `/services/data/v${API_VERSION}/limits`) {
        return route.fulfill(json(capture.limits.value));
      }
      if (path === `/services/data/v${API_VERSION}/query`) {
        if (query.includes('FROM Organization')) {
          return route.fulfill(json(capture.organization.value));
        }
      }
      if (path === `/services/data/v${API_VERSION}/tooling/query`) {
        if (query.includes('FROM DeployRequest')) {
          return route.fulfill(json(capture.deployRequests.value));
        }
        if (query.includes('FROM ApexCodeCoverageAggregate')) {
          // A capture whose coverage call failed replays that failure, which is
          // how the "org that will not answer" case stays real.
          if (!capture.coverage.ok) {
            return route.fulfill(
              json(
                [
                  {
                    message: capture.coverage.message ?? 'not supported',
                    errorCode: capture.coverage.errorCode ?? 'INVALID_TYPE',
                  },
                ],
                capture.coverage.status ?? 400,
              ),
            );
          }
          return route.fulfill(json(capture.coverage.value));
        }
      }
      if (path.startsWith(`/services/data/v${API_VERSION}/metadata/deployRequest/`)) {
        const id = path.split('/').pop();
        const detail = capture.deployDetails.find((entry) => entry.value?.id === id);
        // Captures hold details for the first few deploys only. A deploy with
        // none is a real case — the details age out — and maps to no
        // components rather than to a failure.
        return route.fulfill(json(detail?.value ?? { id, deployResult: { details: {} } }));
      }

      // Deliberately loud. A fixture server that answers everything proves
      // nothing about what the extension actually asks for.
      return route.fulfill(
        json([{ message: `no fixture for ${request.method()} ${path}`, errorCode: 'NO_FIXTURE' }], 404),
      );
    });

    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    const panelUrl = `chrome-extension://${extensionId}/ui/sidepanel.html`;

    const currentWorker = async (): Promise<Worker> => {
      const running = context.serviceWorkers()[0];
      if (running !== undefined) return running;
      const page = await context.newPage();
      await page.goto(panelUrl);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const restarted = context.serviceWorkers()[0];
        if (restarted !== undefined) {
          await page.close();
          return restarted;
        }
        await new Promise((resolve_) => setTimeout(resolve_, 100));
      }
      throw new Error('the service worker did not restart');
    };

    /**
     * Writes the state a completed sign-in leaves behind.
     *
     * The refresh token goes to `chrome.storage.session` because that is where
     * the product puts it, and the assertion that it never reaches
     * `chrome.storage.local` is only meaningful if the harness respects that
     * too.
     */
    const connect = async (): Promise<void> => {
      const target = await currentWorker();
      await target.evaluate(
        async ([sessionKey, settingsKey, markerKey, orgHost, loginHost]: string[]) => {
          await chrome.storage.session.set({
            [sessionKey!]: {
              refreshToken: 'fixture-refresh-token',
              instanceUrl: orgHost,
              loginUrl: loginHost,
              clientId: '3MVGfixtureConsumerKey',
              connectedAt: new Date().toISOString(),
            },
          });
          await chrome.storage.local.set({
            [settingsKey!]: { clientId: '3MVGfixtureConsumerKey', loginUrl: loginHost },
            [markerKey!]: true,
          });
        },
        [SESSION_KEY, SETTINGS_KEY, MARKER_KEY, ORG_HOST, LOGIN_HOST],
      );
    };

    const page = await context.newPage();
    const openPanel = async (): Promise<void> => {
      await page.goto(panelUrl);
      await page.waitForSelector('[role="tab"]');
      await expect(page.locator('.loading')).toHaveCount(0);
    };

    await connect();
    await openPanel();

    const readOrgSnapshot = async (): Promise<Record<string, unknown> | undefined> => {
      const target = await currentWorker();
      const value: unknown = await target.evaluate(async (key: string) => {
        const result = await chrome.storage.local.get(key);
        return result[key];
      }, ORG_SNAPSHOT_KEY);
      return value as Record<string, unknown> | undefined;
    };

    const orgPanel: OrgPanel = {
      context,
      page,
      worker: currentWorker,
      requests,
      headers,

      async refresh() {
        await page.locator('#org-refresh').click();
        // The button reads "Refreshing…" while the request is in flight.
        await expect(page.locator('#org-refresh')).toBeEnabled({ timeout: 20_000 });
        await expect(page.locator('.loading')).toHaveCount(0);
      },

      async useFixture(label: string) {
        capture = loadCapture(label);
        requests.length = 0;
        headers.length = 0;
        const target = await currentWorker();
        await target.evaluate(async (key: string) => {
          await chrome.storage.local.remove(key);
        }, ORG_SNAPSHOT_KEY);
        await connect();
        await openPanel();
      },

      async setOverlay(overlay) {
        const target = await currentWorker();
        await target.evaluate(
          async ([key, value]: [string, Record<string, unknown>]) => {
            await chrome.storage.local.set({ [key]: value });
          },
          [OVERLAY_KEY, overlay] as [string, Record<string, unknown>],
        );
      },

      async ageLastRefresh(minutes: number) {
        const target = await currentWorker();
        await target.evaluate(
          async ([key, shiftMinutes]: [string, number]) => {
            const stored = await chrome.storage.local.get(key);
            const snapshot = stored[key] as { auditLog?: { action: string; at: string }[] };
            const shifted = new Date(Date.now() - shiftMinutes * 60_000).toISOString();
            for (const entry of snapshot.auditLog ?? []) {
              if (entry.action === 'snapshot.refreshed') entry.at = shifted;
            }
            await chrome.storage.local.set({ [key]: snapshot });
          },
          [ORG_SNAPSHOT_KEY, minutes] as [string, number],
        );
        await openPanel();
      },

      async readAuditDetail() {
        const snapshot = await readOrgSnapshot();
        const log = (snapshot?.['auditLog'] ?? []) as { detail?: string }[];
        return log.at(-1)?.detail ?? '';
      },

      retirePinnedApiVersion() {
        const offered = (capture.versions.value ?? []) as { version?: string }[];
        versionsOverride = offered.filter((entry) => entry.version !== API_VERSION);
        return Promise.resolve();
      },
    };

    await use(orgPanel);

    await context.close();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  },
});

export { expect };
