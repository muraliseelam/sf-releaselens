/**
 * Service worker entry point: the only file that touches `chrome.*` on the
 * background side. It wires real implementations into the ports and forwards
 * messages to the router, which holds all of the behaviour.
 *
 * MV3 workers are evicted when idle, so nothing here holds state between
 * messages. The snapshot lives in storage; this file is stateless on purpose.
 */

import { systemClock, systemIdFactory } from '../core/clock.js';
import { createLocalDataSource } from '../data/local.js';
import { createChromeStorageArea } from '../data/storage.js';
import { createRouter } from './router.js';
import type { SnapshotChangedEvent } from './messages.js';

const router = createRouter({
  dataSource: createLocalDataSource({
    storage: createChromeStorageArea(chrome.storage.local),
    clock: systemClock,
    newId: systemIdFactory,
  }),
  deps: { clock: systemClock, newId: systemIdFactory },
  deployImportDefaults: {
    environmentName: 'Imported org',
    environmentKind: 'sandbox',
    orgAlias: 'imported',
    owner: 'Local user',
  },
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  router.handle(message).then(sendResponse, (cause: unknown) => {
    // `handle` is written not to reject; this is belt and braces so a bug there
    // becomes a visible error in the panel rather than a silent dead channel.
    console.error('[sf-releaselens] router rejected unexpectedly', cause);
    sendResponse({
      ok: false,
      error: { code: 'UNEXPECTED', name: 'Error', message: String(cause) },
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
