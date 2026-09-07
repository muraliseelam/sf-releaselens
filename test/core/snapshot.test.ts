import { describe, expect, it } from 'vitest';

import { RecordNotFoundError } from '../../src/core/errors.js';
import { appendAudit, applyApprovalDecision, withActor } from '../../src/core/snapshot.js';
import { ACTOR, FIXED_NOW, makeApproval, makeRelease, makeSnapshot, testDeps } from '../fixtures/snapshot.js';

describe('applyApprovalDecision', () => {
  const base = makeSnapshot({
    releases: [makeRelease({ id: 'rel-1', status: 'awaiting_approval' })],
    approvals: [
      makeApproval({ id: 'apr-uat', requiredRole: 'uat-approver' }),
      makeApproval({ id: 'apr-qa', requiredRole: 'uat-approver', stage: 'QA sign-off' }),
    ],
  });

  it('records the decision and leaves the input snapshot untouched', () => {
    const result = applyApprovalDecision(
      base,
      { approvalId: 'apr-uat', outcome: 'approved', comment: null },
      testDeps(),
    );

    expect(result.approval.status).toBe('approved');
    expect(result.snapshot.approvals.find((a) => a.id === 'apr-uat')?.status).toBe('approved');
    expect(base.approvals.find((a) => a.id === 'apr-uat')?.status).toBe('pending');
  });

  it('keeps the release awaiting approval while another gate is still pending', () => {
    const result = applyApprovalDecision(
      base,
      { approvalId: 'apr-uat', outcome: 'approved', comment: null },
      testDeps(),
    );

    expect(result.statusChange).toBeNull();
    expect(result.release.status).toBe('awaiting_approval');
  });

  it('moves the release to scheduled once the last gate clears', () => {
    const afterFirst = applyApprovalDecision(
      base,
      { approvalId: 'apr-uat', outcome: 'approved', comment: null },
      testDeps(),
    ).snapshot;

    const result = applyApprovalDecision(
      afterFirst,
      { approvalId: 'apr-qa', outcome: 'approved', comment: null },
      testDeps(),
    );

    expect(result.statusChange).toEqual({ from: 'awaiting_approval', to: 'scheduled' });
    expect(result.release.status).toBe('scheduled');
    expect(result.release.updatedAt).toBe(FIXED_NOW);
  });

  it('blocks the release on a rejection', () => {
    const result = applyApprovalDecision(
      base,
      { approvalId: 'apr-uat', outcome: 'rejected', comment: 'Needs a rollback plan.' },
      testDeps(),
    );

    expect(result.statusChange).toEqual({ from: 'awaiting_approval', to: 'blocked' });
  });

  it('does not move a release whose status is a fact about an org', () => {
    const deployed = makeSnapshot({
      releases: [makeRelease({ id: 'rel-1', status: 'deployed' })],
      approvals: [makeApproval({ id: 'apr-uat', requiredRole: 'uat-approver' })],
    });

    const result = applyApprovalDecision(
      deployed,
      { approvalId: 'apr-uat', outcome: 'rejected', comment: 'too late' },
      testDeps(),
    );

    expect(result.statusChange).toBeNull();
    expect(result.release.status).toBe('deployed');
  });

  it('writes one audit entry for the decision and one for the status change', () => {
    const afterFirst = applyApprovalDecision(
      base,
      { approvalId: 'apr-uat', outcome: 'approved', comment: null },
      testDeps(FIXED_NOW, 'a'),
    ).snapshot;

    const result = applyApprovalDecision(
      afterFirst,
      { approvalId: 'apr-qa', outcome: 'approved', comment: null },
      testDeps(FIXED_NOW, 'b'),
    );

    expect(afterFirst.auditLog).toHaveLength(1);
    expect(afterFirst.auditLog[0]).toEqual({
      id: 'a-1',
      at: FIXED_NOW,
      by: 'Sam Okafor',
      action: 'approval.approved',
      detail: 'Approved "UAT sign-off" on Q3 Billing (2026.09.1)',
      releaseId: 'rel-1',
    });
    expect(result.snapshot.auditLog.map((entry) => entry.action)).toEqual([
      'approval.approved',
      'approval.approved',
      'release.status_changed',
    ]);
    expect(result.snapshot.auditLog[2]?.detail).toBe(
      'Q3 Billing moved from awaiting_approval to scheduled',
    );
  });

  it('throws a named error when the approval does not exist', () => {
    expect(() =>
      applyApprovalDecision(base, { approvalId: 'nope', outcome: 'approved', comment: null }, testDeps()),
    ).toThrow(RecordNotFoundError);
  });

  it('throws a named error when the approval points at a missing release', () => {
    const orphaned = makeSnapshot({
      releases: [],
      approvals: [makeApproval({ id: 'apr-uat', releaseId: 'gone' })],
    });

    expect(() =>
      applyApprovalDecision(
        orphaned,
        { approvalId: 'apr-uat', outcome: 'approved', comment: null },
        testDeps(),
      ),
    ).toThrow(/No release with id "gone"/);
  });

  it('propagates the permission failure rather than recording anything', () => {
    const foreign = makeSnapshot({
      actor: { name: 'Ada Kensington', roles: ['developer'] },
      approvals: [makeApproval({ id: 'apr-uat' })],
    });

    expect(() =>
      applyApprovalDecision(
        foreign,
        { approvalId: 'apr-uat', outcome: 'approved', comment: null },
        testDeps(),
      ),
    ).toThrow(/does not hold the "uat-approver" role/);
  });
});

describe('appendAudit', () => {
  it('appends an entry attributed to the actor by default', () => {
    const result = appendAudit(
      makeSnapshot(),
      { action: 'snapshot.reset', detail: 'Reset to empty data' },
      testDeps(FIXED_NOW, 'audit'),
    );

    expect(result.auditLog).toEqual([
      {
        id: 'audit-1',
        at: FIXED_NOW,
        by: 'Sam Okafor',
        action: 'snapshot.reset',
        detail: 'Reset to empty data',
      },
    ]);
  });

  it('accepts an explicit author', () => {
    const result = appendAudit(
      makeSnapshot(),
      { action: 'snapshot.imported', detail: 'x', by: 'importer' },
      testDeps(),
    );

    expect(result.auditLog[0]?.by).toBe('importer');
  });
});

describe('withActor', () => {
  it('replaces the profile and nothing else', () => {
    const next = withActor(makeSnapshot(), { name: 'Lin Zhou', roles: ['qa-lead'] });

    expect(next.actor).toEqual({ name: 'Lin Zhou', roles: ['qa-lead'] });
    expect(next.releases).toEqual(makeSnapshot().releases);
    expect(ACTOR.name).toBe('Sam Okafor');
  });
});
