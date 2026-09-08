/**
 * Release dashboard: the answer to "what is in flight, and what needs me".
 *
 * Every status is rendered even at zero, so the legend does not reflow as
 * releases move and the eye can go to the same place each time.
 */

import {
  countPendingApprovalsByRelease,
  filterReleasesByStatus,
  isAttention,
  sortReleasesForDashboard,
  summariseByStatus,
} from '../../core/releases.js';
import { RELEASE_STATUSES, type Release, type Snapshot } from '../../core/types.js';
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
            renderReleaseRow(release, snapshot, pendingByRelease.get(release.id) ?? 0, handlers, now),
          ),
        ),
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
  pendingApprovals: number,
  handlers: Handlers,
  now: number,
): HTMLElement {
  const environment = snapshot.environments.find((it) => it.id === release.targetEnvironmentId);
  const componentCount = snapshot.items.filter((item) => item.releaseId === release.id).length;

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
