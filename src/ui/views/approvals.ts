/**
 * Approvals helper: what is waiting on me, what is waiting on others, and what
 * has already been decided.
 *
 * Two deliberate choices:
 *  - Only the "waiting on me" queue gets action buttons. Rendering disabled
 *    buttons on gates the actor cannot decide invites clicking and being told no.
 *  - The result of a decision names the release status change, in place, so the
 *    consequence is visible where the action happened.
 */

import {
  canDecide,
  hasRequiredRole,
  partitionApprovals,
} from '../../core/approvals.js';
import type { Approval, Snapshot } from '../../core/types.js';
import { el } from '../dom.js';
import { absoluteTime, approvalStatusLabel, relativeTime } from '../format.js';
import type { Handlers } from '../handlers.js';
import type { ViewState } from '../state.js';

export function renderApprovals(
  state: ViewState,
  snapshot: Snapshot,
  handlers: Handlers,
  now: number,
): HTMLElement {
  const queues = partitionApprovals(snapshot.approvals, snapshot.actor);
  const { busyApprovalId, error, lastOutcome, drafts } = state.approvals;

  return el('section', { className: 'view', attrs: { 'aria-label': 'Approvals' } }, [
    renderActorBar(snapshot, handlers),

    lastOutcome === null
      ? null
      : renderFeedback('notice--ok', lastOutcome, 'Decision recorded', handlers),

    error === null
      ? null
      : renderFeedback('notice--error', error.message, `Could not record the decision (${error.code})`, handlers),

    renderQueue(
      'Waiting on you',
      queues.mine,
      snapshot,
      handlers,
      now,
      { actionable: true, busyApprovalId, drafts },
      'Nothing is waiting on your roles right now.',
    ),

    renderQueue(
      'Waiting on others',
      queues.others,
      snapshot,
      handlers,
      now,
      { actionable: false, busyApprovalId, drafts },
      'No other approvals are pending.',
    ),

    renderQueue(
      'Recently decided',
      queues.decided.slice(0, 20),
      snapshot,
      handlers,
      now,
      { actionable: false, busyApprovalId, drafts },
      'No decisions have been recorded yet.',
    ),
  ]);
}

/**
 * The local profile switcher.
 *
 * This is a demo affordance and is labelled as one: with no server there is no
 * identity to authenticate, and pretending otherwise would misrepresent what the
 * approval trail is worth. Roles offered are the ones some gate actually
 * requires, so switching always has a visible effect.
 */
function renderActorBar(snapshot: Snapshot, handlers: Handlers): HTMLElement {
  const roles = [
    ...new Set([
      'release-manager',
      ...snapshot.approvals.map((approval) => approval.requiredRole),
      ...snapshot.actor.roles,
    ]),
  ].sort((a, b) => a.localeCompare(b));

  const current = snapshot.actor.roles.find((role) => role !== 'release-manager') ?? 'release-manager';

  return el('div', { className: 'actorbar' }, [
    el('span', { className: 'actorbar__label', text: 'Acting as' }),
    el('span', { className: 'actorbar__name', text: snapshot.actor.name }),
    el(
      'select',
      {
        className: 'select select--inline',
        attrs: { id: 'actor-role', 'aria-label': 'Local role used for approval permissions' },
        on: {
          change: (event) => {
            const role = (event.currentTarget as HTMLSelectElement).value;
            handlers.setActor({
              name: snapshot.actor.name,
              roles: role === 'release-manager' ? ['release-manager'] : ['release-manager', role],
            });
          },
        },
      },
      roles.map((role) =>
        el('option', {
          text: role,
          attrs: { value: role, ...(role === current ? { selected: 'selected' } : {}) },
        }),
      ),
    ),
    el('span', {
      className: 'actorbar__hint',
      text: 'local profile, not a verified identity',
      title:
        'Approvals recorded here are a workflow aid, not an auditable control. ' +
        'There is no server, so this profile is not authenticated.',
    }),
  ]);
}

interface QueueOptions {
  readonly actionable: boolean;
  readonly busyApprovalId: string | null;
  readonly drafts: Readonly<Record<string, string>>;
}

function renderQueue(
  title: string,
  approvals: readonly Approval[],
  snapshot: Snapshot,
  handlers: Handlers,
  now: number,
  options: QueueOptions,
  emptyText: string,
): HTMLElement {
  return el('div', { className: 'queue' }, [
    el('h2', { className: 'queue__title' }, [
      title,
      el('span', { className: 'queue__count', text: String(approvals.length) }),
    ]),
    approvals.length === 0
      ? el('p', { className: 'muted', text: emptyText })
      : el(
          'ul',
          { className: 'list' },
          approvals.map((approval) =>
            renderApproval(approval, snapshot, handlers, now, options),
          ),
        ),
  ]);
}

function renderApproval(
  approval: Approval,
  snapshot: Snapshot,
  handlers: Handlers,
  now: number,
  options: QueueOptions,
): HTMLElement {
  const release = snapshot.releases.find((candidate) => candidate.id === approval.releaseId);
  const busy = options.busyApprovalId === approval.id;
  const draft = options.drafts[approval.id] ?? '';

  return el('li', { className: 'card' }, [
    el('div', { className: 'card__head' }, [
      el('span', { className: 'card__stage', text: approval.stage }),
      el('span', {
        className: `pill approval--${approval.status}`,
        text: approvalStatusLabel(approval.status),
      }),
    ]),

    el('p', { className: 'card__release' }, [
      release === undefined
        ? `unknown release (${approval.releaseId})`
        : `${release.name} · ${release.version}`,
      release === undefined
        ? null
        : el('button', {
            className: 'link link--small',
            text: 'view components',
            attrs: { type: 'button' },
            on: {
              click: () =>
                handlers.dispatch({ type: 'dashboard/releaseOpened', releaseId: release.id }),
            },
          }),
    ]),

    el('p', { className: 'card__meta muted' }, [
      `requires ${approval.requiredRole} · requested by ${approval.requestedBy} `,
      el('span', {
        text: relativeTime(approval.requestedAt, now),
        title: absoluteTime(approval.requestedAt),
      }),
    ]),

    approval.decision === undefined
      ? null
      : el('p', { className: 'card__decision' }, [
          el('span', {
            text: `${approvalStatusLabel(approval.status)} by ${approval.decision.by} `,
          }),
          el('span', {
            className: 'muted',
            text: relativeTime(approval.decision.at, now),
            title: absoluteTime(approval.decision.at),
          }),
          approval.decision.comment === undefined
            ? null
            : el('span', { className: 'card__comment', text: `“${approval.decision.comment}”` }),
        ]),

    !options.actionable || approval.status !== 'pending'
      ? null
      : renderActions(approval, snapshot, handlers, busy, draft),
  ]);
}

function renderActions(
  approval: Approval,
  snapshot: Snapshot,
  handlers: Handlers,
  busy: boolean,
  draft: string,
): HTMLElement {
  const mayApprove = canDecide(approval, snapshot.actor, 'approved');
  const mayCancel = canDecide(approval, snapshot.actor, 'cancelled');

  const comment = el('textarea', {
    className: 'textarea',
    attrs: {
      id: `comment-${approval.id}`,
      rows: '2',
      placeholder: 'Comment (required to reject)',
      'aria-label': `Comment on ${approval.stage}`,
      ...(busy ? { disabled: 'disabled' } : {}),
    },
    on: {
      input: (event) =>
        handlers.dispatch({
          type: 'approvals/commentChanged',
          approvalId: approval.id,
          comment: (event.currentTarget as HTMLTextAreaElement).value,
        }),
    },
  });
  comment.value = draft;

  const act = (outcome: 'approved' | 'rejected' | 'cancelled') => () => {
    handlers.decide(approval.id, outcome, draft.trim() === '' ? null : draft);
  };

  return el('div', { className: 'card__actions' }, [
    comment,
    el('div', { className: 'card__buttons' }, [
      el('button', {
        className: 'button button--primary',
        text: busy ? 'Recording…' : 'Approve',
        attrs: { type: 'button', ...(busy || !mayApprove ? { disabled: 'disabled' } : {}) },
        on: { click: act('approved') },
      }),
      el('button', {
        className: 'button button--danger',
        text: 'Reject',
        attrs: { type: 'button', ...(busy || !mayApprove ? { disabled: 'disabled' } : {}) },
        on: { click: act('rejected') },
      }),
      !mayCancel
        ? null
        : el('button', {
            className: 'button button--quiet',
            text: 'Cancel request',
            title: 'Withdraw the approval request you raised',
            attrs: { type: 'button', ...(busy ? { disabled: 'disabled' } : {}) },
            on: { click: act('cancelled') },
          }),
    ]),
    hasRequiredRole(approval, snapshot.actor)
      ? null
      : el('p', {
          className: 'muted',
          text: `You do not hold the ${approval.requiredRole} role, so you can only withdraw this request.`,
        }),
  ]);
}

function renderFeedback(
  variant: string,
  message: string,
  title: string,
  handlers: Handlers,
): HTMLElement {
  return el('div', { className: `notice ${variant}`, attrs: { role: 'status' } }, [
    el('strong', { text: title }),
    el('p', { text: message }),
    el('button', {
      className: 'button button--quiet',
      text: 'Dismiss',
      attrs: { type: 'button' },
      on: { click: () => handlers.dispatch({ type: 'approvals/feedbackDismissed' }) },
    }),
  ]);
}
