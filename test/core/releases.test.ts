import { describe, expect, it } from 'vitest';

import {
  countItemsByRelease,
  countPendingApprovalsByRelease,
  deriveReleaseStatus,
  filterReleasesByStatus,
  findEnvironment,
  findRelease,
  isAttention,
  sortReleasesForDashboard,
  summariseByStatus,
} from '../../src/core/releases.js';
import { RELEASE_STATUSES } from '../../src/core/types.js';
import { makeApproval, makeEnvironment, makeItem, makeRelease } from '../fixtures/snapshot.js';

describe('summariseByStatus', () => {
  it('reports every status, including the ones at zero', () => {
    const summary = summariseByStatus([makeRelease({ status: 'deployed' })]);

    expect(Object.keys(summary.byStatus).sort()).toEqual([...RELEASE_STATUSES].sort());
    expect(summary.byStatus.deployed).toBe(1);
    expect(summary.byStatus.draft).toBe(0);
    expect(summary.total).toBe(1);
  });

  it('returns an all-zero summary for no releases', () => {
    const summary = summariseByStatus([]);

    expect(summary.total).toBe(0);
    expect(summary.needsAttention).toBe(0);
    expect(Object.values(summary.byStatus).every((count) => count === 0)).toBe(true);
  });

  it('counts blocked, failed and rolled back as needing attention, and nothing else', () => {
    const summary = summariseByStatus([
      makeRelease({ id: 'a', status: 'blocked' }),
      makeRelease({ id: 'b', status: 'failed' }),
      makeRelease({ id: 'c', status: 'rolled_back' }),
      makeRelease({ id: 'd', status: 'deployed' }),
      makeRelease({ id: 'e', status: 'in_progress' }),
    ]);

    expect(summary.needsAttention).toBe(3);
    expect(summary.total).toBe(5);
  });
});

describe('deriveReleaseStatus', () => {
  const release = makeRelease({ id: 'rel-1', status: 'draft' });

  it('blocks when any approval was rejected, even if others approved', () => {
    const status = deriveReleaseStatus(release, [
      makeApproval({ id: 'a', status: 'approved' }),
      makeApproval({ id: 'b', status: 'rejected' }),
      makeApproval({ id: 'c', status: 'pending' }),
    ]);

    expect(status).toBe('blocked');
  });

  it('awaits approval when something is still pending and nothing was rejected', () => {
    const status = deriveReleaseStatus(release, [
      makeApproval({ id: 'a', status: 'approved' }),
      makeApproval({ id: 'b', status: 'pending' }),
    ]);

    expect(status).toBe('awaiting_approval');
  });

  it('schedules when every gate is approved', () => {
    const status = deriveReleaseStatus(release, [
      makeApproval({ id: 'a', status: 'approved' }),
      makeApproval({ id: 'b', status: 'approved' }),
    ]);

    expect(status).toBe('scheduled');
  });

  it('ignores cancelled approvals rather than treating them as cleared or blocking', () => {
    expect(
      deriveReleaseStatus(release, [
        makeApproval({ id: 'a', status: 'cancelled' }),
        makeApproval({ id: 'b', status: 'approved' }),
      ]),
    ).toBe('scheduled');

    // Every gate cancelled leaves no opinion at all, so the status is untouched.
    expect(
      deriveReleaseStatus(release, [makeApproval({ id: 'a', status: 'cancelled' })]),
    ).toBe('draft');
  });

  it('leaves a release with no approvals alone', () => {
    expect(deriveReleaseStatus(release, [])).toBe('draft');
  });

  it('ignores approvals belonging to other releases', () => {
    const status = deriveReleaseStatus(release, [
      makeApproval({ id: 'other', releaseId: 'rel-2', status: 'rejected' }),
    ]);

    expect(status).toBe('draft');
  });

  it.each(['in_progress', 'deployed', 'failed', 'rolled_back'] as const)(
    'never overwrites %s, which is a fact about an org rather than an opinion',
    (status) => {
      const orgFact = makeRelease({ id: 'rel-1', status });
      const approvals = [
        makeApproval({ id: 'a', status: 'rejected' }),
        makeApproval({ id: 'b', status: 'pending' }),
      ];

      expect(deriveReleaseStatus(orgFact, approvals)).toBe(status);
    },
  );
});

describe('sortReleasesForDashboard', () => {
  it('puts releases needing attention first, then the most recently updated', () => {
    const sorted = sortReleasesForDashboard([
      makeRelease({ id: 'old-ok', status: 'deployed', updatedAt: '2026-09-01T00:00:00.000Z' }),
      makeRelease({ id: 'new-ok', status: 'deployed', updatedAt: '2026-09-06T00:00:00.000Z' }),
      makeRelease({ id: 'blocked', status: 'blocked', updatedAt: '2026-08-01T00:00:00.000Z' }),
    ]);

    expect(sorted.map((release) => release.id)).toEqual(['blocked', 'new-ok', 'old-ok']);
  });

  it('does not mutate the input array', () => {
    const releases = [
      makeRelease({ id: 'a', status: 'deployed' }),
      makeRelease({ id: 'b', status: 'blocked' }),
    ];
    sortReleasesForDashboard(releases);

    expect(releases.map((release) => release.id)).toEqual(['a', 'b']);
  });
});

describe('filterReleasesByStatus', () => {
  const releases = [
    makeRelease({ id: 'a', status: 'blocked' }),
    makeRelease({ id: 'b', status: 'deployed' }),
  ];

  it('returns everything for "all"', () => {
    expect(filterReleasesByStatus(releases, 'all')).toHaveLength(2);
  });

  it('returns only the matching status', () => {
    expect(filterReleasesByStatus(releases, 'blocked').map((r) => r.id)).toEqual(['a']);
  });
});

describe('countItemsByRelease', () => {
  it('counts each release in one pass, including the ones with none', () => {
    const counts = countItemsByRelease([
      makeItem({ id: 'a', releaseId: 'rel-1' }),
      makeItem({ id: 'b', releaseId: 'rel-1' }),
      makeItem({ id: 'c', releaseId: 'rel-2' }),
    ]);

    expect(counts.get('rel-1')).toBe(2);
    expect(counts.get('rel-2')).toBe(1);
    // Absent rather than zero: the caller supplies the default, and a release
    // with no components is not the same fact as a release nobody counted.
    expect(counts.get('rel-3')).toBeUndefined();
  });

  it('returns an empty map for an empty snapshot', () => {
    expect(countItemsByRelease([]).size).toBe(0);
  });
});

describe('countPendingApprovalsByRelease', () => {
  it('counts only pending approvals, grouped by release', () => {
    const counts = countPendingApprovalsByRelease([
      makeApproval({ id: '1', releaseId: 'rel-1', status: 'pending' }),
      makeApproval({ id: '2', releaseId: 'rel-1', status: 'pending' }),
      makeApproval({ id: '3', releaseId: 'rel-1', status: 'approved' }),
      makeApproval({ id: '4', releaseId: 'rel-2', status: 'pending' }),
    ]);

    expect(counts.get('rel-1')).toBe(2);
    expect(counts.get('rel-2')).toBe(1);
    expect(counts.get('rel-3')).toBeUndefined();
  });
});

describe('lookups', () => {
  it('finds a release and an environment by id, and returns undefined otherwise', () => {
    expect(findRelease([makeRelease({ id: 'rel-1' })], 'rel-1')?.id).toBe('rel-1');
    expect(findRelease([makeRelease({ id: 'rel-1' })], 'missing')).toBeUndefined();
    expect(findEnvironment([makeEnvironment({ id: 'env-1' })], 'env-1')?.id).toBe('env-1');
    expect(findEnvironment([], 'env-1')).toBeUndefined();
  });

  it('flags attention statuses', () => {
    expect(isAttention(makeRelease({ status: 'failed' }))).toBe(true);
    expect(isAttention(makeRelease({ status: 'scheduled' }))).toBe(false);
  });
});
