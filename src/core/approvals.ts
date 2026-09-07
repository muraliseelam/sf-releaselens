/**
 * Approval rules as a pure state machine.
 *
 * "Not possible" and "not allowed" are deliberately separate checks with
 * separate errors: telling someone to reload the panel when the real problem is
 * that they lack a role sends them round a loop that can never succeed.
 */

import {
  ApprovalNotPermittedError,
  InvalidApprovalTransitionError,
  MissingRejectionCommentError,
} from './errors.js';
import type {
  Actor,
  Approval,
  ApprovalDecisionOutcome,
  ApprovalStatus,
  ReleaseId,
} from './types.js';

/** The only status an approval may be decided from. */
const DECIDABLE_FROM: ApprovalStatus = 'pending';

export interface DecisionRequest {
  readonly outcome: ApprovalDecisionOutcome;
  /** `null` rather than optional so the value survives a JSON message round trip. */
  readonly comment: string | null;
}

/** Whether the actor holds the role this gate requires. */
export function hasRequiredRole(approval: Approval, actor: Actor): boolean {
  return actor.roles.includes(approval.requiredRole);
}

/**
 * Whether this actor may record this outcome.
 *
 * Approve and reject require the gate's role. Cancel is additionally allowed to
 * the person who requested the approval: withdrawing your own request is not a
 * privileged act.
 */
export function canDecide(
  approval: Approval,
  actor: Actor,
  outcome: ApprovalDecisionOutcome,
): boolean {
  if (hasRequiredRole(approval, actor)) return true;
  return outcome === 'cancelled' && approval.requestedBy === actor.name;
}

/** Whether the approval is in a state that can still be decided at all. */
export function isDecidable(approval: Approval): boolean {
  return approval.status === DECIDABLE_FROM;
}

/**
 * Records a decision, returning a new approval. Throws rather than returning a
 * result union, because every caller either succeeds or shows the message.
 *
 * @throws InvalidApprovalTransitionError when the approval was already decided.
 * @throws ApprovalNotPermittedError when the actor lacks the required role.
 * @throws MissingRejectionCommentError when rejecting without a reason.
 */
export function decideApproval(
  approval: Approval,
  request: DecisionRequest,
  actor: Actor,
  now: string,
): Approval {
  if (!isDecidable(approval)) {
    throw new InvalidApprovalTransitionError(
      approval.id,
      approval.status,
      request.outcome,
      approval.decision?.by,
    );
  }
  if (!canDecide(approval, actor, request.outcome)) {
    throw new ApprovalNotPermittedError(approval.id, approval.requiredRole, actor.name);
  }

  const comment = request.comment?.trim() ?? '';
  if (request.outcome === 'rejected' && comment.length === 0) {
    throw new MissingRejectionCommentError(approval.id);
  }

  return {
    ...approval,
    status: request.outcome,
    decision: {
      by: actor.name,
      at: now,
      ...(comment.length > 0 ? { comment } : {}),
    },
  };
}

export interface ApprovalQueues {
  /** Pending and decidable by this actor — the work they can clear right now. */
  readonly mine: readonly Approval[];
  /** Pending, but waiting on somebody else. */
  readonly others: readonly Approval[];
  /** Already approved, rejected or cancelled, newest decision first. */
  readonly decided: readonly Approval[];
}

/**
 * Splits approvals into the three lists the Approvals tab renders, in the order
 * a reviewer cares about them.
 */
export function partitionApprovals(
  approvals: readonly Approval[],
  actor: Actor,
): ApprovalQueues {
  const mine: Approval[] = [];
  const others: Approval[] = [];
  const decided: Approval[] = [];

  for (const approval of approvals) {
    if (approval.status === 'pending') {
      (hasRequiredRole(approval, actor) ? mine : others).push(approval);
    } else {
      decided.push(approval);
    }
  }

  mine.sort(byRequestedAtAscending);
  others.sort(byRequestedAtAscending);
  decided.sort(byDecidedAtDescending);

  return { mine, others, decided };
}

/** Badge count for the Approvals tab: pending work this actor can act on. */
export function countPendingForActor(approvals: readonly Approval[], actor: Actor): number {
  return approvals.filter(
    (approval) => approval.status === 'pending' && hasRequiredRole(approval, actor),
  ).length;
}

export function findApproval(
  approvals: readonly Approval[],
  id: string,
): Approval | undefined {
  return approvals.find((approval) => approval.id === id);
}

export function approvalsForRelease(
  approvals: readonly Approval[],
  releaseId: ReleaseId,
): Approval[] {
  return approvals.filter((approval) => approval.releaseId === releaseId);
}

/** Oldest request first: the longest-waiting gate is the one blocking a release. */
function byRequestedAtAscending(a: Approval, b: Approval): number {
  return a.requestedAt.localeCompare(b.requestedAt);
}

function byDecidedAtDescending(a: Approval, b: Approval): number {
  return (b.decision?.at ?? '').localeCompare(a.decision?.at ?? '');
}
