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
import { pluralise } from './format.js';
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
import { describeAnnouncement } from './announce.js';
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
        toolbarButton('toolbar-reload', 'Reload', 'Re-read the snapshot from storage', () =>
          handlers.reload(),
        ),
        toolbarButton('toolbar-import', 'Import', 'Import an export or an sf deploy report', () =>
          handlers.importSnapshot(),
        ),
        toolbarButton('toolbar-export', 'Export', 'Download the current snapshot as JSON', () =>
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
            attrs: { id: 'demo-start-empty', type: 'button' },
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
      TABS.map((tab) => {
        const selected = state.tab === tab;
        return el(
          'button',
          {
            className: `tab${selected ? ' tab--on' : ''}`,
            attrs: {
              id: `tab-${tab}`,
              type: 'button',
              role: 'tab',
              'aria-selected': String(selected),
              'aria-controls': 'panel-body',
              /*
               * Roving tabindex, as the ARIA tabs pattern requires: one Tab
               * press moves into the tab strip, and the arrow keys move
               * between tabs. Without it a keyboard user pays three Tab
               * presses to get past a three-tab strip on every pass.
               */
              tabindex: selected ? '0' : '-1',
              ...(tab === 'approvals' && pendingForMe > 0
                ? { 'aria-label': `${TAB_LABELS[tab]}, ${pluralise(pendingForMe, 'approval')} waiting on you` }
                : {}),
            },
            on: {
              click: () => handlers.dispatch({ type: 'tab/selected', tab }),
              keydown: (event) => onTabKeydown(event, tab, handlers),
            },
          },
          [
            TAB_LABELS[tab],
            tab === 'approvals' && pendingForMe > 0
              ? el('span', {
                  className: 'tab__badge',
                  text: String(pendingForMe),
                  attrs: { 'aria-hidden': 'true' },
                  title: `${pendingForMe} approval(s) waiting on you`,
                })
              : null,
          ],
        );
      }),
    ),

    el(
      'div',
      {
        className: 'shell__body',
        attrs: {
          id: 'panel-body',
          role: 'tabpanel',
          'aria-labelledby': `tab-${state.tab}`,
          // Focusable so that following the tab's aria-controls, or paging
          // past the tab strip, lands somewhere. -1 keeps it out of the Tab
          // order itself.
          tabindex: '-1',
        },
      },
      [renderBody(state, handlers)],
    ),
  ]);
}

/**
 * Arrow, Home and End keys across the tab strip, wrapping at both ends.
 *
 * Selection follows focus, which is the right choice here: switching tab is
 * cheap, reversible and has no side effect, so making the user press Enter as
 * well would be ceremony. Focus lands on the newly selected tab because the
 * re-render restores focus by id, and the selected tab is the one holding
 * `tabindex="0"`.
 */
function onTabKeydown(event: Event, current: Tab, handlers: Handlers): void {
  if (!(event instanceof KeyboardEvent)) return;
  const index = TABS.indexOf(current);
  const last = TABS.length - 1;

  let next: number;
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = index === last ? 0 : index + 1;
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      next = index === 0 ? last : index - 1;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = last;
      break;
    default:
      return;
  }

  // Stop ArrowDown and friends scrolling the panel underneath.
  event.preventDefault();
  const tab = TABS[next];
  if (tab === undefined) return;

  handlers.dispatch({ type: 'tab/selected', tab });
  // The dispatch re-rendered and put focus back where it was — on the tab the
  // user just left. In this pattern focus follows the arrow key, so move it.
  const target = document.getElementById(`tab-${tab}`);
  if (target instanceof HTMLElement) target.focus();
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

  return el(
    'div',
    {
      className: 'notice notice--error',
      // The body it replaced is gone, so this is where a keyboard user should
      // land. Announcement goes through the panel's persistent live region,
      // not this node's role, which a full re-render would make unreliable.
      attrs: { id: 'load-error', role: 'alert', tabindex: '-1', 'data-focus-fallback': '' },
    },
    [
      el('strong', { text: 'Could not load release data' }),
      el('p', { text: error.message }),
      el('p', { className: 'muted', text: `Error code: ${error.code}` }),
      el('div', { className: 'notice__actions' }, [
        el('button', {
          className: 'button button--primary',
          text: 'Retry',
          attrs: { id: 'error-retry', type: 'button', 'aria-label': 'Retry loading release data' },
          on: { click: () => handlers.reload() },
        }),
        recoverable
          ? el('button', {
              className: 'button',
              text: 'Export raw data',
              title: 'Download exactly what is stored, before changing anything',
              attrs: {
                id: 'error-export-raw',
                type: 'button',
                'aria-label': 'Export raw data: download exactly what is stored, before changing anything',
              },
              on: { click: () => handlers.exportSnapshot() },
            })
          : null,
        recoverable
          ? el('button', {
              className: 'button button--danger',
              text: 'Reset to demo data',
              attrs: {
                id: 'error-reset',
                type: 'button',
                'aria-label': 'Reset to demo data. This discards the stored snapshot.',
              },
              on: { click: () => handlers.reset('demo') },
            })
          : null,
      ]),
    ],
  );
}

function toolbarButton(id: string, label: string, title: string, onClick: () => void): HTMLElement {
  return el('button', {
    className: 'button button--quiet',
    text: label,
    title,
    // The title is a tooltip, which a screen reader may or may not read; the
    // label alone ("Export") does not say what is exported.
    attrs: { id, type: 'button', 'aria-label': `${label}: ${title}` },
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
