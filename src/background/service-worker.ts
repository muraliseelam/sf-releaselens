/**
 * Service worker entry point: the only file that touches `chrome.*` on the
 * background side. It wires real implementations into the ports and forwards
 * messages to the router, which holds all of the behaviour.
 *
 * MV3 workers are evicted when idle, so nothing here holds state between
 * messages. The snapshot lives in storage; this file is stateless on purpose.
 */

import { createOrgSession } from '../auth/oauth.js';
import { redact } from '../core/redact.js';
import { systemClock, systemIdFactory } from '../core/clock.js';
import { createFetchOrgConnection } from '../data/fetchConnection.js';
import { createLocalDataSource } from '../data/local.js';
import { createSalesforceDataSource } from '../data/salesforce.js';
import { createChromeStorageArea } from '../data/storage.js';
import { createRouter } from './router.js';
import type { SnapshotChangedEvent } from './messages.js';

/** REST/Tooling API version. Pinned so a platform release cannot shift shapes. */
const API_VERSION = '62.0';

const localStorageArea = createChromeStorageArea(chrome.storage.local);

/**
 * The refresh token lives here and nowhere else.
 *
 * `chrome.storage.session` is memory-backed and cleared when the browser
 * closes; `chrome.storage.local` is written to disk. That difference is the
 * whole reason this line exists, so do not "simplify" it to one area.
 */
const sessionStorageArea = createChromeStorageArea(chrome.storage.session);

const orgSession = createOrgSession({
  identity: {
    launchWebAuthFlow: (details) => chrome.identity.launchWebAuthFlow(details),
    getRedirectURL: (path) => chrome.identity.getRedirectURL(path),
  },
  sessionStorage: sessionStorageArea,
});

const router = createRouter({
  dataSource: createLocalDataSource({
    storage: localStorageArea,
    clock: systemClock,
    newId: systemIdFactory,
  }),
  deps: { clock: systemClock, newId: systemIdFactory },
  orgSession,
  permissions: {
    contains: (origins) => chrome.permissions.contains({ origins: [...origins] }),
    request: (origins) => chrome.permissions.request({ origins: [...origins] }),
    remove: (origins) => chrome.permissions.remove({ origins: [...origins] }),
  },
  settingsStorage: localStorageArea,
  orgDataSource: ({ instanceUrl, getAccessToken, orgAlias, deployLimit }) =>
    createSalesforceDataSource({
      storage: localStorageArea,
      connection: createFetchOrgConnection({ instanceUrl, apiVersion: API_VERSION, getAccessToken }),
      clock: systemClock,
      newId: systemIdFactory,
      orgAlias,
      ...(deployLimit === undefined ? {} : { deployLimit }),
    }),
  deployImportDefaults: {
    environmentName: 'Imported org',
    environmentKind: 'sandbox',
    orgAlias: 'imported',
    owner: 'Local user',
  },
  // Read here rather than in the router: these are the only facts about the
  // running browser the worker can see, and the router has no `chrome.*`.
  diagnosticEnvironment: {
    extensionVersion: chrome.runtime.getManifest().version,
    browserMajorVersion: browserMajorVersion(),
    platform: platformName(),
    apiVersion: API_VERSION,
  },
  diagnosticStorage: localStorageArea,
});

/**
 * Chrome's major version and nothing else.
 *
 * The full user-agent string carries a build number and the OS version, which
 * narrows a reporter down considerably. The major version answers every
 * question a bug report actually asks of it.
 */
function browserMajorVersion(): string {
  const brand = userAgentData()?.brands.find((entry) => entry.brand === 'Chromium');
  if (brand !== undefined) return brand.version;
  const match = /Chrome\/(\d+)/.exec(navigator.userAgent);
  return match?.[1] ?? 'unknown';
}

/** `Windows`, `macOS`, `Linux` — never a version or a device name. */
function platformName(): string {
  const platform = userAgentData()?.platform;
  if (platform !== undefined && platform !== '') return platform;
  if (navigator.userAgent.includes('Windows')) return 'Windows';
  if (navigator.userAgent.includes('Mac OS')) return 'macOS';
  if (navigator.userAgent.includes('Linux')) return 'Linux';
  return 'unknown';
}

/**
 * `navigator.userAgentData`, which `@types/chrome`'s lib does not declare.
 *
 * Narrowed to the two fields used, so this cannot quietly become a route to
 * `getHighEntropyValues` — the API's whole purpose is that the detailed
 * fields require an explicit, auditable request.
 */
interface UserAgentDataLite {
  readonly brands: readonly { readonly brand: string; readonly version: string }[];
  readonly platform?: string;
}

function userAgentData(): UserAgentDataLite | undefined {
  return (navigator as Navigator & { userAgentData?: UserAgentDataLite }).userAgentData;
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  router.handle(message).then(sendResponse, (cause: unknown) => {
    // `handle` is written not to reject; this is belt and braces so a bug there
    // becomes a visible error in the panel rather than a silent dead channel.
    // Redacted, and only the message: logging the raw cause would print a
    // whole error chain to a console anyone can open.
    console.error(
      '[sf-releaselens] router rejected unexpectedly:',
      redact(cause instanceof Error ? cause.message : String(cause)),
    );
    sendResponse({
      ok: false,
      error: {
        code: 'UNEXPECTED',
        name: 'Error',
        message: redact(cause instanceof Error ? cause.message : String(cause)),
      },
    });
  });
  // Keeps the message channel open for the async response above.
  return true;
});

/** Clicking the toolbar icon opens the side panel. */
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((cause: unknown) => {
      console.error('[sf-releaselens] could not set side panel behaviour', cause);
    });
});

/**
 * Tells an open panel that storage changed underneath it — which happens when a
 * second window records a decision. The panel reloads rather than merging, so
 * two panels cannot drift.
 *
 * `sendMessage` rejects when no panel is listening. That is the normal case, not
 * an error, so it is swallowed here with a comment rather than logged as noise.
 */
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName !== 'local') return;
  const event: SnapshotChangedEvent = { type: 'snapshot.changed' };
  chrome.runtime.sendMessage(event).catch(() => {
    // No side panel is open to receive it. Nothing to do and nothing to report.
  });
});
