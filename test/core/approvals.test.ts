import { describe, expect, it } from 'vitest';

import {
  approvalsForRelease,
  canDecide,
  countPendingForActor,
  decideApproval,
  findApproval,
  hasRequiredRole,
  isDecidable,
  partitionApprovals,
} from '../../src/core/approvals.js';
import {
  ApprovalNotPermittedError,
  InvalidApprovalTransitionError,
  MissingRejectionCommentError,
} from '../../src/core/errors.js';
import type { Actor } from '../../src/core/types.js';
import { ACTOR, makeApproval } from '../fixtures/snapshot.js';

const NOW = '2026-09-07T09:00:00.000Z';
const OUTSIDER: Actor = { name: 'Ada Kensington', roles: ['developer'] };

describe('decideApproval', () => {
  it('records an approval with the actor and time', () => {
    const decided = decideApproval(makeApproval(), { outcome: 'approved', comment: null }, ACTOR, NOW);

    expect(decided.status).toBe('approved');
    expect(decided.decision).toEqual({ by: 'Sam Okafor', at: NOW });
  });

  it('keeps a trimmed comment and drops a blank one', () => {
    const withComment = decideApproval(
      makeApproval(),
      { outcome: 'approved', comment: '  looks good  ' },
      ACTOR,
      NOW,
    );
    const withoutComment = decideApproval(
      makeApproval(),
      { outcome: 'approved', comment: '   ' },
      ACTOR,
      NOW,
    );

    expect(withComment.decision?.comment).toBe('looks good');
    expect(withoutComment.decision).not.toHaveProperty('comment');
  });

  it('does not mutate the approval it was given', () => {
    const original = makeApproval();
    decideApproval(original, { outcome: 'approved', comment: null }, ACTOR, NOW);

    expect(original.status).toBe('pending');
    expect(original.decision).toBeUndefined();
  });

  it('requires a comment to reject, because the reason is the point', () => {
    expect(() =>
      decideApproval(makeApproval(), { outcome: 'rejected', comment: '  ' }, ACTOR, NOW),
    ).toThrow(MissingRejectionCommentError);

    const rejected = decideApproval(
      makeApproval(),
      { outcome: 'rejected', comment: 'No rollback plan.' },
      ACTOR,
      NOW,
    );
    expect(rejected.decision?.comment).toBe('No rollback plan.');
  });

  it.each(['approved', 'rejected', 'cancelled'] as const)(
    'refuses to decide an approval that is already %s',
    (status) => {
      const already = makeApproval({ status, decidedBy: 'Tomas Reid' });

      expect(() =>
        decideApproval(already, { outcome: 'approved', comment: null }, ACTOR, NOW),
      ).toThrow(InvalidApprovalTransitionError);
    },
  );

  it('names the earlier decider in the conflict message, so the panel can explain itself', () => {
    const already = makeApproval({ status: 'approved', decidedBy: 'Tomas Reid' });

    expect(() =>
      decideApproval(already, { outcome: 'rejected', comment: 'no' }, ACTOR, NOW),
    ).toThrow(/Tomas Reid/);
  });

  it('refuses an actor without the required role, and says so distinctly', () => {
    expect(() =>
      decideApproval(makeApproval(), { outcome: 'approved', comment: null }, OUTSIDER, NOW),
    ).toThrow(ApprovalNotPermittedError);
  });

  it('checks decidability before permission, so an outsider is told the real reason', () => {
    const already = makeApproval({ status: 'approved' });

    expect(() =>
      decideApproval(already, { outcome: 'approved', comment: null }, OUTSIDER, NOW),
    ).toThrow(InvalidApprovalTransitionError);
  });

  it('lets the requester withdraw their own request without holding the role', () => {
    const own = makeApproval({ requestedBy: OUTSIDER.name });
    const cancelled = decideApproval(own, { outcome: 'cancelled', comment: null }, OUTSIDER, NOW);

    expect(cancelled.status).toBe('cancelled');
  });

  it('does not let a non-requester without the role cancel', () => {
    expect(() =>
      decideApproval(makeApproval(), { outcome: 'cancelled', comment: null }, OUTSIDER, NOW),
    ).toThrow(ApprovalNotPermittedError);
  });
});

describe('permission predicates', () => {
  it('separates holding the role from being allowed to act', () => {
    const own = makeApproval({ requestedBy: OUTSIDER.name });

    expect(hasRequiredRole(own, OUTSIDER)).toBe(false);
    expect(canDecide(own, OUTSIDER, 'cancelled')).toBe(true);
    expect(canDecide(own, OUTSIDER, 'approved')).toBe(false);
    expect(canDecide(own, ACTOR, 'approved')).toBe(true);
  });

  it('treats only pending approvals as decidable', () => {
    expect(isDecidable(makeApproval())).toBe(true);
    expect(isDecidable(makeApproval({ status: 'approved' }))).toBe(false);
  });
});

describe('partitionApprovals', () => {
  const approvals = [
    makeApproval({ id: 'mine-new', requiredRole: 'uat-approver', requestedAt: '2026-09-05T00:00:00.000Z' }),
    makeApproval({ id: 'mine-old', requiredRole: 'uat-approver', requestedAt: '2026-09-01T00:00:00.000Z' }),
    makeApproval({ id: 'theirs', requiredRole: 'qa-lead' }),
    makeApproval({ id: 'done-old', status: 'approved', decidedAt: '2026-09-02T00:00:00.000Z' }),
    makeApproval({ id: 'done-new', status: 'rejected', decidedAt: '2026-09-06T00:00:00.000Z', comment: 'no' }),
  ];

  it('splits by who can act, and sorts each queue usefully', () => {
    const queues = partitionApprovals(approvals, ACTOR);

    // Longest-waiting first: that is the one actually blocking a release.
    expect(queues.mine.map((a) => a.id)).toEqual(['mine-old', 'mine-new']);
    expect(queues.others.map((a) => a.id)).toEqual(['theirs']);
    // Most recent decision first.
    expect(queues.decided.map((a) => a.id)).toEqual(['done-new', 'done-old']);
  });

  it('returns three empty queues for no approvals', () => {
    expect(partitionApprovals([], ACTOR)).toEqual({ mine: [], others: [], decided: [] });
  });
});

describe('countPendingForActor', () => {
  it('counts only pending approvals the actor holds the role for', () => {
    const approvals = [
      makeApproval({ id: '1', requiredRole: 'uat-approver' }),
      makeApproval({ id: '2', requiredRole: 'qa-lead' }),
      makeApproval({ id: '3', requiredRole: 'uat-approver', status: 'approved' }),
    ];

    expect(countPendingForActor(approvals, ACTOR)).toBe(1);
  });
});

describe('lookups', () => {
  it('finds by id and filters by release', () => {
    const approvals = [
      makeApproval({ id: 'a', releaseId: 'rel-1' }),
      makeApproval({ id: 'b', releaseId: 'rel-2' }),
    ];

    expect(findApproval(approvals, 'b')?.releaseId).toBe('rel-2');
    expect(findApproval(approvals, 'missing')).toBeUndefined();
    expect(approvalsForRelease(approvals, 'rel-1').map((a) => a.id)).toEqual(['a']);
  });
});
