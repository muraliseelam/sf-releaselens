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
import { toSerialisedError, type Client } from './client.js';
import { captureFocus, el, restoreFocus } from './dom.js';
import { countPendingForActor } from '../core/approvals.js';
import type { Handlers } from './handlers.js';
import {
  INITIAL_STATE,
  TABS,
  currentSnapshot,
  lastRefreshedAt,
  reduce,
  type Action,
  type Tab,
  type ViewState,
} from './state.js';
import { renderOrgBar } from './views/orgbar.js';
import { renderApprovals } from './views/approvals.js';
import { renderDashboard } from './views/dashboard.js';
import { renderInspector } from './views/inspector.js';

const TAB_LABELS: Readonly<Record<Tab, string>> = {
  dashboard: 'Dashboard',
  inspector: 'Inspector',
  approvals: 'Approvals',
};

export interface Panel {
  readonly handlers: Handlers;
  /**
   * Re-reads storage without blanking the panel. Called when another window
   * wrote a decision; a blank-then-fill there would be more disruptive than the
   * stale second it avoids.
   */
  onExternalChange(): void;
}

export function start(root: HTMLElement, client: Client): Panel {
  let state: ViewState = INITIAL_STATE;

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

    refreshOrg(): void {
      dispatch({ type: 'org/actionStarted', action: 'refreshing' });
      client
        .send({ type: 'snapshot.refresh' })
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
      client
        .send({ type: 'org.connect', loginUrl, clientId })
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
    root.replaceChildren(renderShell(state, handlers));
    restoreFocus(document, focus);
  }

  render();
  refresh();
  loadOrgStatus();
  return { handlers, onExternalChange: () => refresh({ silent: true }) };
}

function renderShell(state: ViewState, handlers: Handlers): HTMLElement {
  const snapshot = currentSnapshot(state);
  const pendingForMe =
    snapshot === null ? 0 : countPendingForActor(snapshot.approvals, snapshot.actor);

  return el('div', { className: 'shell' }, [
    el('header', { className: 'shell__header' }, [
      el('h1', { className: 'shell__title', text: 'sf-releaselens' }),
      el('div', { className: 'shell__actions' }, [
        toolbarButton('Reload', 'Re-read the snapshot from storage', () => handlers.reload()),
        toolbarButton('Import', 'Import an export or an sf deploy report', () =>
          handlers.importSnapshot(),
        ),
        toolbarButton('Export', 'Download the current snapshot as JSON', () =>
          handlers.exportSnapshot(),
        ),
      ]),
    ]),

    snapshot?.isDemoData === true
      ? el('div', { className: 'notice notice--info', attrs: { role: 'status' } }, [
          el('strong', { text: 'Demo data' }),
          el('p', {
            text: 'This is the sample dataset shipped with the extension, not your org.',
          }),
          el('button', {
            className: 'button button--quiet',
            text: 'Start empty',
            attrs: { type: 'button' },
            on: { click: () => handlers.reset('empty') },
          }),
        ])
      : null,

    renderOrgBar({
      state,
      lastRefreshed: lastRefreshedAt(snapshot),
      now: Date.now(),
      handlers,
    }),

    el(
      'nav',
      { className: 'tabs', attrs: { role: 'tablist', 'aria-label': 'Panel sections' } },
      TABS.map((tab) =>
        el(
          'button',
          {
            className: `tab${state.tab === tab ? ' tab--on' : ''}`,
            attrs: {
              id: `tab-${tab}`,
              type: 'button',
              role: 'tab',
              'aria-selected': String(state.tab === tab),
            },
            on: { click: () => handlers.dispatch({ type: 'tab/selected', tab }) },
          },
          [
            TAB_LABELS[tab],
            tab === 'approvals' && pendingForMe > 0
              ? el('span', {
                  className: 'tab__badge',
                  text: String(pendingForMe),
                  title: `${pendingForMe} approval(s) waiting on you`,
                })
              : null,
          ],
        ),
      ),
    ),

    el('div', { className: 'shell__body' }, [renderBody(state, handlers)]),
  ]);
}

function renderBody(state: ViewState, handlers: Handlers): HTMLElement {
  switch (state.load.status) {
    case 'idle':
    case 'loading':
      return renderLoading();
    case 'error':
      return renderError(state.load.error, handlers);
    case 'ready': {
      const snapshot = state.load.snapshot;
      const now = Date.now();
      switch (state.tab) {
        case 'dashboard':
          return renderDashboard(state, snapshot, handlers, now);
        case 'inspector':
          return renderInspector(state, snapshot, handlers, now);
        case 'approvals':
          return renderApprovals(state, snapshot, handlers, now);
      }
    }
  }
}

function renderLoading(): HTMLElement {
  return el('div', { className: 'loading', attrs: { role: 'status', 'aria-live': 'polite' } }, [
    el('span', { className: 'spinner', attrs: { 'aria-hidden': 'true' } }),
    el('p', { text: 'Loading release data…' }),
  ]);
}

/**
 * The error state offers rescue before destruction: a corrupt snapshot can be
 * exported raw first, and only then reset. Resetting is never automatic.
 */
function renderError(
  error: { readonly code: string; readonly message: string },
  handlers: Handlers,
): HTMLElement {
  const recoverable =
    error.code === 'SNAPSHOT_VALIDATION' || error.code === 'UNSUPPORTED_SCHEMA_VERSION';

  return el('div', { className: 'notice notice--error', attrs: { role: 'alert' } }, [
    el('strong', { text: 'Could not load release data' }),
    el('p', { text: error.message }),
    el('p', { className: 'muted', text: `Error code: ${error.code}` }),
    el('div', { className: 'notice__actions' }, [
      el('button', {
        className: 'button button--primary',
        text: 'Retry',
        attrs: { type: 'button' },
        on: { click: () => handlers.reload() },
      }),
      recoverable
        ? el('button', {
            className: 'button',
            text: 'Export raw data',
            title: 'Download exactly what is stored, before changing anything',
            attrs: { type: 'button' },
            on: { click: () => handlers.exportSnapshot() },
          })
        : null,
      recoverable
        ? el('button', {
            className: 'button button--danger',
            text: 'Reset to demo data',
            attrs: { type: 'button' },
            on: { click: () => handlers.reset('demo') },
          })
        : null,
    ]),
  ]);
}

function toolbarButton(label: string, title: string, onClick: () => void): HTMLElement {
  return el('button', {
    className: 'button button--quiet',
    text: label,
    title,
    attrs: { type: 'button' },
    on: { click: onClick },
  });
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

function download(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const anchor = el('a', { attrs: { href: url, download: filename } });
  anchor.click();
  URL.revokeObjectURL(url);
}
