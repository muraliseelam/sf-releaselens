/**
 * Release dashboard: the answer to "what is in flight, and what needs me".
 *
 * Every status is rendered even at zero, so the legend does not reflow as
 * releases move and the eye can go to the same place each time.
 */

import {
  countItemsByRelease,
  countPendingApprovalsByRelease,
  filterReleasesByStatus,
  isAttention,
  sortReleasesForDashboard,
  summariseByStatus,
} from '../../core/releases.js';
import {
  RELEASE_STATUSES,
  type DeployWindow,
  type Release,
  type Snapshot,
} from '../../core/types.js';
import { DEPLOY_LIMIT_STEP, MAX_DEPLOY_LIMIT } from '../../data/salesforce.js';
import { el } from '../dom.js';
import { absoluteTime, pluralise, relativeTime, releaseStatusLabel, riskLabel } from '../format.js';
import type { Handlers } from '../handlers.js';
import type { ViewState } from '../state.js';

export function renderDashboard(
  state: ViewState,
  snapshot: Snapshot,
  handlers: Handlers,
  now: number,
): HTMLElement {
  const summary = summariseByStatus(snapshot.releases);
  const pendingByRelease = countPendingApprovalsByRelease(snapshot.approvals);
  // Counted once for the whole list, not per row: see countItemsByRelease.
  const componentsByRelease = countItemsByRelease(snapshot.items);
  const filter = state.dashboard.statusFilter;
  const visible = sortReleasesForDashboard(filterReleasesByStatus(snapshot.releases, filter));

  return el('section', { className: 'view', attrs: { 'aria-label': 'Release dashboard' } }, [
    el('div', { className: 'summary' }, [
      el('p', { className: 'summary__headline' }, [
        el('strong', { text: String(summary.total) }),
        ` ${summary.total === 1 ? 'release' : 'releases'} tracked`,
        summary.needsAttention > 0
          ? el('span', {
              className: 'summary__attention',
              text: ` · ${summary.needsAttention} need${summary.needsAttention === 1 ? 's' : ''} attention`,
            })
          : null,
      ]),
      renderStatusBar(summary.byStatus, summary.total),
      renderDeployWindow(snapshot.deployWindow, handlers),
    ]),

    el(
      'div',
      { className: 'chips', attrs: { role: 'group', 'aria-label': 'Filter releases by status' } },
      [
        statusChip('all', 'All', summary.total, filter === 'all', handlers),
        ...RELEASE_STATUSES.map((status) =>
          statusChip(
            status,
            releaseStatusLabel(status),
            summary.byStatus[status],
            filter === status,
            handlers,
          ),
        ),
      ],
    ),

    visible.length === 0
      ? renderEmpty(filter === 'all', handlers)
      : el(
          'ul',
          { className: 'list', attrs: { 'aria-label': 'Releases' } },
          visible.map((release) =>
            renderReleaseRow(
              release,
              snapshot,
              componentsByRelease.get(release.id) ?? 0,
              pendingByRelease.get(release.id) ?? 0,
              handlers,
              now,
            ),
          ),
        ),
  ]);
}

/**
 * Says how much of the org's deploy history is on screen, and offers more.
 *
 * Silence here was the bug: a release dashboard showing the ten most recent of
 * twelve deployments, with no indication that two were missing — one of them a
 * failure. A dashboard that is quietly a subset is wrong, not incomplete.
 *
 * Nothing is fetched automatically. The button says what it will cost, because
 * each additional deployment is one more API call against the org's daily
 * budget, and this project does not spend somebody's quota on their behalf.
 */
function renderDeployWindow(
  window: DeployWindow | undefined,
  handlers: Handlers,
): HTMLElement | null {
  if (window === undefined || window.shown >= window.total) return null;

  const remaining = window.total - window.shown;
  const step = Math.min(remaining, DEPLOY_LIMIT_STEP);
  const nextLimit = Math.min(window.limit + step, MAX_DEPLOY_LIMIT);
  const atCeiling = nextLimit <= window.limit;

  return el('div', { className: 'notice notice--warn', attrs: { role: 'status' } }, [
    el('p', {
      className: 'notice__title',
      text: `Showing ${window.shown} of ${window.total} deployments`,
    }),
    el('p', {
      className: 'muted',
      text: atCeiling
        ? `A refresh reads at most ${MAX_DEPLOY_LIMIT} deployments. The remaining ` +
          `${pluralise(remaining, 'deployment')} cannot be loaded from here.`
        : `The ${pluralise(remaining, 'older deployment')} in this org ${
            remaining === 1 ? 'is' : 'are'
          } not on this dashboard.`,
    }),
    atCeiling
      ? null
      : el('button', {
          className: 'button',
          text: `Load ${step} more`,
          attrs: {
            id: 'dashboard-load-more',
            type: 'button',
            'aria-label': `Load ${pluralise(step, 'more deployment')} from the org. Costs about ${pluralise(step + 1, 'API call')}.`,
          },
          title: `Reads the ${pluralise(nextLimit, 'most recent deployment')} instead of ${window.limit}. Costs about ${pluralise(step + 1, 'API call')}.`,
          on: { click: () => handlers.refreshOrg(nextLimit) },
        }),
  ]);
}

function renderStatusBar(
  byStatus: Readonly<Record<string, number>>,
  total: number,
): HTMLElement {
  if (total === 0) {
    return el('div', { className: 'bar bar--empty', attrs: { 'aria-hidden': 'true' } });
  }
  return el(
    'div',
    {
      className: 'bar',
      attrs: { role: 'img', 'aria-label': describeDistribution(byStatus) },
    },
    RELEASE_STATUSES.filter((status) => (byStatus[status] ?? 0) > 0).map((status) => {
      const count = byStatus[status] ?? 0;
      const segment = el('span', {
        className: `bar__segment status--${status}`,
        title: `${releaseStatusLabel(status)}: ${count}`,
      });
      segment.style.flexGrow = String(count);
      return segment;
    }),
  );
}

function describeDistribution(byStatus: Readonly<Record<string, number>>): string {
  return RELEASE_STATUSES.filter((status) => (byStatus[status] ?? 0) > 0)
    .map((status) => `${releaseStatusLabel(status)} ${byStatus[status] ?? 0}`)
    .join(', ');
}

function statusChip(
  value: (typeof RELEASE_STATUSES)[number] | 'all',
  label: string,
  count: number,
  selected: boolean,
  handlers: Handlers,
): HTMLElement {
  return el(
    'button',
    {
      className: `chip${selected ? ' chip--on' : ''}${count === 0 ? ' chip--zero' : ''}`,
      attrs: {
        // Stable id so a full re-render can put focus back on the chip the
        // keyboard user just activated. Without it, every Enter press drops
        // focus to the document body.
        id: `chip-status-${value}`,
        type: 'button',
        'aria-pressed': String(selected),
        // The visible chip is "Blocked 1"; a screen reader would read that as
        // two unrelated tokens. Say what the number counts.
        'aria-label': `${label}: ${pluralise(count, 'release')}`,
      },
      on: {
        click: () => handlers.dispatch({ type: 'dashboard/statusFiltered', status: value }),
      },
    },
    [
      value === 'all' ? null : el('span', { className: `dot status--${value}` }),
      label,
      el('span', { className: 'chip__count', text: String(count) }),
    ],
  );
}

function renderReleaseRow(
  release: Release,
  snapshot: Snapshot,
  componentCount: number,
  pendingApprovals: number,
  handlers: Handlers,
  now: number,
): HTMLElement {
  const environment = snapshot.environments.find((it) => it.id === release.targetEnvironmentId);

  return el('li', {}, [
    el(
      'button',
      {
        className: `row${isAttention(release) ? ' row--attention' : ''}`,
        attrs: {
          id: `release-${release.id}`,
          type: 'button',
          // The row's visible content is four lines of chips and metadata,
          // which a screen reader would read as a run-on. Lead with the
          // sentence a release manager actually needs.
          'aria-label': [
            `${release.name} ${release.version}`,
            releaseStatusLabel(release.status),
            pluralise(componentCount, 'component'),
            pendingApprovals > 0 ? pluralise(pendingApprovals, 'pending approval') : null,
          ]
            .filter((part) => part !== null)
            .join(', '),
        },
        title: 'Open this release in the metadata inspector',
        on: {
          click: () => handlers.dispatch({ type: 'dashboard/releaseOpened', releaseId: release.id }),
        },
      },
      [
        el('div', { className: 'row__main' }, [
          el('span', { className: 'row__title', text: release.name }),
          el('span', { className: 'row__version', text: release.version }),
        ]),
        el('div', { className: 'row__meta' }, [
          el('span', { className: `pill status--${release.status}`, text: releaseStatusLabel(release.status) }),
          // Orthogonal to the status pill: a *failed* validation is `failed`,
          // and this is the only thing that says it deployed nothing.
          release.checkOnly === true
            ? el('span', {
                className: 'badge badge--checkonly',
                text: 'Check-only',
                title: 'Salesforce validated this package and deployed nothing.',
              })
            : null,
          el('span', {
            className: 'row__env',
            // An environment can only go missing if the snapshot was hand-edited;
            // say so rather than rendering a blank space.
            text: environment?.name ?? `unknown environment (${release.targetEnvironmentId})`,
          }),
          el('span', { className: 'row__risk', text: riskLabel(release.riskLevel) }),
        ]),
        el('div', { className: 'row__meta row__meta--dim' }, [
          el('span', { text: pluralise(componentCount, 'component') }),
          pendingApprovals > 0
            ? el('span', {
                className: 'badge',
                text: `${pendingApprovals} pending approval${pendingApprovals === 1 ? '' : 's'}`,
              })
            : null,
          el('span', {
            text: `updated ${relativeTime(release.updatedAt, now)}`,
            title: absoluteTime(release.updatedAt),
          }),
        ]),
        release.ticketRefs.length > 0
          ? el(
              'div',
              { className: 'row__tickets' },
              release.ticketRefs.map((ref) => el('span', { className: 'ticket', text: ref })),
            )
          : null,
        release.notes === undefined
          ? null
          : el('p', { className: 'row__notes', text: release.notes }),
      ],
    ),
  ]);
}

function renderEmpty(unfiltered: boolean, handlers: Handlers): HTMLElement {
  if (unfiltered) {
    return el('div', { className: 'empty' }, [
      el('p', { text: 'No releases yet.' }),
      el('p', {
        className: 'empty__hint',
        text: 'Import an sf deploy report or a previous export to populate the dashboard.',
      }),
      el('button', {
        className: 'button',
        text: 'Import JSON…',
        attrs: { id: 'dashboard-import', type: 'button' },
        on: { click: () => handlers.importSnapshot() },
      }),
    ]);
  }
  return el('div', { className: 'empty' }, [
    el('p', { text: 'No releases have this status.' }),
    el('button', {
      className: 'button',
      text: 'Show all releases',
      attrs: { id: 'dashboard-show-all', type: 'button' },
      on: { click: () => handlers.dispatch({ type: 'dashboard/statusFiltered', status: 'all' }) },
    }),
  ]);
}
