/**
 * Panel controller.
 *
 * Owns the one mutable variable in the UI (`state`), turns user intent into
 * messages to the background worker, and re-renders. The render is a full
 * rebuild of the body on every change: the panel is small, and a rebuild cannot
 * leave a stale row behind the way a partial update can. Focus and caret are
 * carried across explicitly so typing is unaffected.
 *
 * Deliberately free of `chrome.*` and of any module-level side effect: the
 * bootstrap lives in `main.ts`, so this file can be imported by a test with a
 * stub client and a jsdom document.
 */

import type { Actor, ApprovalDecisionOutcome } from '../core/types.js';
import type { SeedKind } from '../data/datasource.js';
import { RemoteError, toSerialisedError, type Client } from './client.js';
import { captureFocus, el, focusFallback, restoreFocus } from './dom.js';
import { diagnosticsFilename } from '../core/diagnostics.js';
import type { Handlers } from './handlers.js';
import { INITIAL_STATE, reduce, type Action, type ViewState } from './state.js';
import { describeAnnouncement } from './announce.js';
import { renderShell } from './shell.js';

export interface Panel {
  readonly handlers: Handlers;
  /**
   * Re-reads storage without blanking the panel. Called when another window
   * wrote a decision; a blank-then-fill there would be more disruptive than the
   * stale second it avoids.
   */
  onExternalChange(): void;
}

/**
 * The `chrome.permissions` surface the panel needs.
 *
 * Requested from **here**, not from the service worker: `permissions.request`
 * requires a user gesture, and a worker handling a message does not have one.
 * Injected so tests need no browser.
 */
export interface PanelPermissions {
  request(origins: readonly string[]): Promise<boolean>;
}

/** Origins needed before the OAuth flow can run. */
export function connectOrigins(loginUrl: string): string[] {
  const login = `${new URL(loginUrl).origin}/*`;
  // The instance URL is not known until after sign-in, and the token POST that
  // discovers it already needs an origin grant — so the instance pattern has to
  // be requested up front. `*.my.salesforce.com` is broader than a single
  // origin, which is a deliberate, documented trade-off (DATASOURCE.md §4):
  // one prompt inside the user's click, rather than a second prompt afterwards
  // that Chrome would refuse for want of a gesture.
  return [login, 'https://*.my.salesforce.com/*'];
}

export function start(root: HTMLElement, client: Client, permissions?: PanelPermissions): Panel {
  let state: ViewState = INITIAL_STATE;

  /*
   * The panel rebuilds its body on every state change. A live region that is
   * destroyed and recreated on each rebuild announces nothing dependably, so
   * these two live outside the rebuilt subtree and are only ever written to.
   * `mount` is the part that gets replaced.
   */
  const mount = el('div', { className: 'mount' });
  const politeRegion = el('div', {
    className: 'sr-only',
    attrs: { id: 'panel-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
  });
  const alertRegion = el('div', {
    className: 'sr-only',
    attrs: { id: 'panel-alert', role: 'alert', 'aria-atomic': 'true' },
  });
  root.replaceChildren(mount, politeRegion, alertRegion);

  function announce(): void {
    const { polite, assertive } = describeAnnouncement(state);
    // Writing the same text again would make some screen readers repeat
    // themselves on every keystroke. Only a real change is spoken.
    if (politeRegion.textContent !== polite) politeRegion.textContent = polite;
    if (alertRegion.textContent !== assertive) alertRegion.textContent = assertive;
  }

  function dispatch(action: Action): void {
    state = reduce(state, action);
    render();
  }

  /**
   * @param silent when true the current snapshot stays on screen while the new
   *        one loads. Used for changes another window made, where blanking the
   *        panel would be more disruptive than the stale second it avoids.
   */
  function refresh(options: { silent: boolean } = { silent: false }): void {
    if (!options.silent) dispatch({ type: 'load/started' });
    client
      .send({ type: 'snapshot.load' })
      .then((snapshot) => dispatch({ type: 'load/succeeded', snapshot }))
      .catch((cause: unknown) => dispatch({ type: 'load/failed', error: toSerialisedError(cause) }));
  }

  /**
   * Asks Chrome for the origins the flow needs, inside the click that started
   * it. A malformed login URL is reported as a refusal rather than throwing.
   */
  async function requestConnectPermission(loginUrl: string): Promise<boolean> {
    if (permissions === undefined) return true;
    let origins: string[];
    try {
      origins = connectOrigins(loginUrl);
    } catch (cause) {
      void cause;
      return false;
    }
    return permissions.request(origins);
  }

  /**
   * Reads whether telemetry is on.
   *
   * Asked for rather than assumed, so the footer states the real setting even
   * if it was changed in another window. Never blocks the first paint.
   */
  function loadTelemetry(): void {
    client
      .send({ type: 'telemetry.info' })
      .then((info) => dispatch({ type: 'telemetry/loaded', info }))
      // A panel that cannot read the setting simply renders no control, which
      // is the safe direction: no control means no way to turn it on.
      .catch(() => undefined);
  }

  /** Loads the org status. Never blocks the first paint. */
  function loadOrgStatus(): void {
    client
      .send({ type: 'org.info' })
      .then((status) => dispatch({ type: 'org/statusLoaded', status }))
      .catch((cause: unknown) => dispatch({ type: 'org/actionFailed', error: toSerialisedError(cause) }));
  }

  const handlers: Handlers = {
    dispatch,
    reload: () => refresh(),

    refreshOrg(deployLimit?: number): void {
      dispatch({ type: 'org/actionStarted', action: 'refreshing' });
      client
        .send({ type: 'snapshot.refresh', ...(deployLimit === undefined ? {} : { deployLimit }) })
        .then((result) =>
          dispatch({ type: 'org/actionSucceeded', status: result.org, snapshot: result.snapshot }),
        )
        // A failed refresh must NOT clear the snapshot: `org/actionFailed`
        // deliberately leaves `load` alone so the cache stays on screen.
        .catch((cause: unknown) =>
          dispatch({ type: 'org/actionFailed', error: toSerialisedError(cause) }),
        );
    },

    connectOrg(loginUrl: string, clientId: string): void {
      dispatch({ type: 'org/actionStarted', action: 'connecting' });
      requestConnectPermission(loginUrl)
        .then((granted) => {
          if (!granted) {
            throw new RemoteError({
              code: 'HOST_PERMISSION_REVOKED',
              name: 'HostPermissionRevokedError',
              message:
                'Chrome did not grant this extension access to the Salesforce org, so sign-in was not started.',
            });
          }
          return client.send({ type: 'org.connect', loginUrl, clientId });
        })
        .then((result) =>
          dispatch({ type: 'org/actionSucceeded', status: result.org, snapshot: result.snapshot }),
        )
        .catch((cause: unknown) =>
          dispatch({ type: 'org/actionFailed', error: toSerialisedError(cause) }),
        );
    },

    disconnectOrg(): void {
      dispatch({ type: 'org/actionStarted', action: 'disconnecting' });
      client
        .send({ type: 'org.disconnect' })
        .then((result) =>
          dispatch({ type: 'org/actionSucceeded', status: result.org, snapshot: result.snapshot }),
        )
        .catch((cause: unknown) =>
          dispatch({ type: 'org/actionFailed', error: toSerialisedError(cause) }),
        );
    },

    grantOrgPermission(): void {
      client
        .send({ type: 'org.grantPermission' })
        .then((status) => dispatch({ type: 'org/actionSucceeded', status, snapshot: null }))
        .catch((cause: unknown) =>
          dispatch({ type: 'org/actionFailed', error: toSerialisedError(cause) }),
        );
    },

    decide(approvalId: string, outcome: ApprovalDecisionOutcome, comment: string | null): void {
      dispatch({ type: 'approvals/decisionStarted', approvalId });
      client
        .send({ type: 'approval.decide', approvalId, outcome, comment })
        .then((result) => dispatch({ type: 'approvals/decisionSucceeded', result }))
        .catch((cause: unknown) =>
          dispatch({ type: 'approvals/decisionFailed', error: toSerialisedError(cause) }),
        );
    },

    exportSnapshot(): void {
      client
        .send({ type: 'snapshot.export' })
        .then((payload) => download(payload.filename, payload.json))
        .catch((cause: unknown) => dispatch({ type: 'load/failed', error: toSerialisedError(cause) }));
    },

    /*
     * The rescue path out of a corrupt snapshot. It must not go through
     * `snapshot.export`, which validates on the way out and therefore fails on
     * exactly the data this exists to save — the bug this replaces, where the
     * button was offered, downloaded nothing, and the next button destroyed
     * the data.
     */
    exportRawSnapshot(): void {
      client
        .send({ type: 'snapshot.readRaw' })
        .then((payload) => {
          if (payload.raw === undefined) {
            dispatch({
              type: 'load/failed',
              error: {
                code: 'NOTHING_STORED',
                name: 'NothingStoredError',
                message: 'There is nothing in storage to export. Nothing has been changed.',
              },
            });
            return;
          }
          download(rawExportName(), JSON.stringify(payload.raw, null, 2));
        })
        .catch((cause: unknown) => dispatch({ type: 'load/failed', error: toSerialisedError(cause) }));
    },

    recordViewOpened(view): void {
      // Fire and forget, and deliberately not awaited: a telemetry round trip
      // must never sit between a click and a tab switching.
      if (state.telemetry?.enabled !== true) return;
      client
        .send({ type: 'telemetry.record', event: { name: 'view.opened', view } })
        .catch(() => undefined);
    },

    setTelemetryEnabled(enabled: boolean): void {
      client
        .send({ type: 'telemetry.setEnabled', enabled })
        .then((info) => dispatch({ type: 'telemetry/loaded', info }))
        .catch((cause: unknown) => dispatch({ type: 'org/actionFailed', error: toSerialisedError(cause) }));
    },

    downloadDiagnostics(): void {
      client
        .send({ type: 'diagnostics.collect' })
        .then((report) => {
          download(diagnosticsFilename(report.generatedAt), `${JSON.stringify(report, null, 2)}
`);
        })
        .catch((cause: unknown) => dispatch({ type: 'org/actionFailed', error: toSerialisedError(cause) }));
    },

    importSnapshot(): void {
      pickFile()
        .then((text) => {
          if (text === null) return;
          dispatch({ type: 'load/started' });
          return client
            .send({ type: 'snapshot.import', text })
            .then((snapshot) => dispatch({ type: 'load/succeeded', snapshot }));
        })
        .catch((cause: unknown) => dispatch({ type: 'load/failed', error: toSerialisedError(cause) }));
    },

    reset(seed: SeedKind): void {
      dispatch({ type: 'load/started' });
      client
        .send({ type: 'snapshot.reset', seed })
        .then((snapshot) => dispatch({ type: 'load/succeeded', snapshot }))
        .catch((cause: unknown) => dispatch({ type: 'load/failed', error: toSerialisedError(cause) }));
    },

    setActor(actor: Actor): void {
      client
        .send({ type: 'actor.set', actor })
        .then((snapshot) => dispatch({ type: 'load/succeeded', snapshot }))
        .catch((cause: unknown) => dispatch({ type: 'load/failed', error: toSerialisedError(cause) }));
    },
  };

  function render(): void {
    const focus = captureFocus(document);
    mount.replaceChildren(renderShell(state, handlers));
    // When the control the user was on has gone — an approved card that moved
    // queue, a row a filter removed — put focus on whatever replaced it rather
    // than dropping the keyboard user back at the top of the panel.
    if (!restoreFocus(document, focus) && focus !== null) focusFallback(document);
    announce();
  }

  render();
  refresh();
  loadOrgStatus();
  loadTelemetry();
  return { handlers, onExternalChange: () => refresh({ silent: true }) };
}

/** Resolves to the file's text, or `null` when the user dismissed the picker. */
function pickFile(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = el('input', { attrs: { type: 'file', accept: 'application/json,.json' } });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file === undefined) {
        resolve(null);
        return;
      }
      file.text().then(resolve, reject);
    });
    // A dismissed picker fires no event in Chrome, so the promise simply never
    // settles. That is harmless here: nothing is awaiting it but a UI update.
    input.click();
  });
}

/** `sf-releaselens-raw-2026-09-08T13-25-54.json` — timestamped, so a second attempt does not overwrite the first. */
function rawExportName(): string {
  return `sf-releaselens-raw-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
}

function download(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const anchor = el('a', { attrs: { href: url, download: filename } });
  anchor.click();
  URL.revokeObjectURL(url);
}
