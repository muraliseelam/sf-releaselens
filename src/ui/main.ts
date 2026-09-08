/**
 * Side panel entry point: the only file on the UI side that touches `chrome.*`.
 *
 * It exists so that `panel.ts` has no module-level side effects and can be
 * exercised in a test with a stub client. Everything here is wiring.
 */

import { isSnapshotChangedEvent } from '../background/messages.js';
import { createChromeClient } from './client.js';
import { start } from './panel.js';

const root = document.getElementById('root');
if (root === null) {
  // The panel HTML is ours, so this can only happen if the build dropped a file.
  throw new Error('sf-releaselens: #root is missing from sidepanel.html; the build is incomplete.');
}

const panel = start(root, createChromeClient(), {
  // `permissions.request` needs a user gesture, which the service worker does
  // not have when it handles a message — so it is requested here, inside the
  // click that started the connect flow.
  request: (origins) => chrome.permissions.request({ origins: [...origins] }),
});

/** Another window recorded a decision; pick it up without blanking this one. */
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (isSnapshotChangedEvent(message)) {
    panel.onExternalChange();
  }
});
