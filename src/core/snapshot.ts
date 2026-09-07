/**
 * Snapshot-level transactions. Pure functions from one snapshot to the next, so
 * the whole mutation path is testable without storage, a worker or a browser.
 */

import { findApproval } from './approvals.js';
import { decideApproval, type DecisionRequest } from './approvals.js';
import type { Clock, IdFactory } from './clock.js';
import { RecordNotFoundError } from './errors.js';
import { deriveReleaseStatus, findRelease } from './releases.js';
import type {
  Actor,
  Approval,
  ApprovalDecisionOutcome,
  AuditAction,
  AuditEntry,
  Release,
  ReleaseStatus,
  Snapshot,
} from './types.js';

export interface SnapshotDeps {
  readonly clock: Clock;
  readonly newId: IdFactory;
}

export interface DecisionCommand extends DecisionRequest {
  readonly approvalId: string;
}

export interface DecisionResult {
  readonly snapshot: Snapshot;
  readonly approval: Approval;
  readonly release: Release;
  /** Present only when the decision moved the release; `null` when it did not. */
  readonly statusChange: { readonly from: ReleaseStatus; readonly to: ReleaseStatus } | null;
}

/**
 * Records an approval decision and propagates its consequence to the release.
 *
 * The decision is applied first and the release status is *derived* from the
 * resulting approval set, never patched directly — so the release status is
 * always explainable by the approvals visible next to it.
 *
 * @throws RecordNotFoundError when the approval or its release is missing.
 * @throws InvalidApprovalTransitionError / ApprovalNotPermittedError /
 *         MissingRejectionCommentError from {@link decideApproval}.
 */
export function applyApprovalDecision(
  snapshot: Snapshot,
  command: DecisionCommand,
  deps: SnapshotDeps,
): DecisionResult {
  const existing = findApproval(snapshot.approvals, command.approvalId);
  if (existing === undefined) {
    throw new RecordNotFoundError('approval', command.approvalId);
  }

  const release = findRelease(snapshot.releases, existing.releaseId);
  if (release === undefined) {
    throw new RecordNotFoundError('release', existing.releaseId);
  }

  const now = deps.clock.now();
  const decided = decideApproval(
    existing,
    { outcome: command.outcome, comment: command.comment },
    snapshot.actor,
    now,
  );

  const approvals = snapshot.approvals.map((approval) =>
    approval.id === decided.id ? decided : approval,
  );

  const nextStatus = deriveReleaseStatus(release, approvals);
  const statusChange =
    nextStatus === release.status ? null : { from: release.status, to: nextStatus };

  const updatedRelease: Release =
    statusChange === null ? release : { ...release, status: nextStatus, updatedAt: now };

  const auditLog: AuditEntry[] = [
    ...snapshot.auditLog,
    auditEntry(deps, {
      at: now,
      by: snapshot.actor.name,
      action: outcomeToAuditAction(command.outcome),
      detail: `${describeOutcome(command.outcome)} "${existing.stage}" on ${release.name} (${release.version})`,
      releaseId: release.id,
    }),
  ];

  if (statusChange !== null) {
    auditLog.push(
      auditEntry(deps, {
        at: now,
        by: snapshot.actor.name,
        action: 'release.status_changed',
        detail: `${release.name} moved from ${statusChange.from} to ${statusChange.to}`,
        releaseId: release.id,
      }),
    );
  }

  return {
    snapshot: {
      ...snapshot,
      approvals,
      releases: snapshot.releases.map((candidate) =>
        candidate.id === updatedRelease.id ? updatedRelease : candidate,
      ),
      auditLog,
    },
    approval: decided,
    release: updatedRelease,
    statusChange,
  };
}

/** Appends an audit entry without mutating the input snapshot. */
export function appendAudit(
  snapshot: Snapshot,
  entry: Omit<AuditEntry, 'id' | 'at' | 'by'> & { by?: string },
  deps: SnapshotDeps,
): Snapshot {
  const { by, ...rest } = entry;
  return {
    ...snapshot,
    auditLog: [
      ...snapshot.auditLog,
      auditEntry(deps, {
        ...rest,
        at: deps.clock.now(),
        by: by ?? snapshot.actor.name,
      }),
    ],
  };
}

/** Replaces the local profile used for approval permission checks. */
export function withActor(snapshot: Snapshot, actor: Actor): Snapshot {
  return { ...snapshot, actor };
}

function auditEntry(deps: SnapshotDeps, entry: Omit<AuditEntry, 'id'>): AuditEntry {
  return { id: deps.newId(), ...entry };
}

function outcomeToAuditAction(outcome: ApprovalDecisionOutcome): AuditAction {
  switch (outcome) {
    case 'approved':
      return 'approval.approved';
    case 'rejected':
      return 'approval.rejected';
    case 'cancelled':
      return 'approval.cancelled';
  }
}

function describeOutcome(outcome: ApprovalDecisionOutcome): string {
  switch (outcome) {
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    case 'cancelled':
      return 'Cancelled';
  }
}
