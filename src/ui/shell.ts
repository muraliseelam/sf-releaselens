/**
 * The panel's chrome: header, demo notice, org strip, tab strip, body, footer.
 *
 * Split out of `panel.ts`, which had grown to 668 lines holding two unrelated
 * jobs — turning user intent into messages to the worker, and turning state
 * into DOM. Nothing here changed in the move; the suites are the proof.
 *
 * Everything is a pure function of `(state, handlers)`. No module-level state,
 * no `chrome.*`, and no I/O: a view that could start its own request would be
 * a view that could bypass the single-writer discipline in `router.ts`.
 */

import { countPendingForActor } from '../core/approvals.js';
import { el } from './dom.js';
import { pluralise } from './format.js';
import type { Handlers } from './handlers.js';
import {
  TABS,
  currentSnapshot,
  lastRefreshedAt,
  type Tab,
  type ViewState,
} from './state.js';
import { renderApprovals } from './views/approvals.js';
import { renderDashboard } from './views/dashboard.js';
import { renderInspector } from './views/inspector.js';
import { renderOrgBar } from './views/orgbar.js';

const TAB_LABELS: Readonly<Record<Tab, string>> = {
  dashboard: 'Dashboard',
  inspector: 'Inspector',
  approvals: 'Approvals',
};

export function renderShell(state: ViewState, handlers: Handlers): HTMLElement {
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
              click: () => {
                handlers.dispatch({ type: 'tab/selected', tab });
                handlers.recordViewOpened(tab);
              },
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

    renderPrivacyFooter(state, handlers),
  ]);
}

/**
 * The opt-in telemetry control.
 *
 * Deliberately plain. It is an unchecked checkbox with a sentence saying
 * exactly what would be sent and a line saying where — read from the transport
 * actually in use, not from a constant, so the UI cannot claim "nowhere" while
 * something else is wired in.
 *
 * There is no nag, no banner, no "help us improve", and no pre-tick. A user who
 * never reads this row is a user who sends nothing, which is the correct
 * default for a tool that sits next to somebody's production org.
 */
function renderPrivacyFooter(state: ViewState, handlers: Handlers): HTMLElement | null {
  const telemetry = state.telemetry;
  // Renders nothing until the worker has answered. No control means no way to
  // turn it on, which is the safe direction to fail in.
  if (telemetry === null) return null;

  return el('footer', { className: 'shell__footer' }, [
    el('label', { className: 'toggle', attrs: { for: 'telemetry-enabled' } }, [
      el('input', {
        attrs: {
          id: 'telemetry-enabled',
          type: 'checkbox',
          ...(telemetry.enabled ? { checked: 'checked' } : {}),
        },
        on: {
          change: (event) =>
            handlers.setTelemetryEnabled((event.currentTarget as HTMLInputElement).checked),
        },
      }),
      'Share which tabs I open',
    ]),
    el('p', {
      className: 'muted shell__footer-note',
      text: `Off by default. If on, it would send ${telemetry.collects.join('; ')}. Never anything from your org. ${telemetry.destination}`,
    }),
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
              on: { click: () => handlers.exportRawSnapshot() },
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
