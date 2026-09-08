/**
 * Release-level derivations for the dashboard. Pure: given the same records it
 * returns the same answer, with no I/O and no clock.
 */

import {
  ATTENTION_STATUSES,
  ORG_FACT_STATUSES,
  RELEASE_STATUSES,
  type Approval,
  type Environment,
  type EnvironmentId,
  type MetadataItem,
  type Release,
  type ReleaseId,
  type ReleaseStatus,
} from './types.js';

export interface StatusSummary {
  readonly total: number;
  /**
   * Every status is present, including zeros, so the dashboard's bar and legend
   * keep a stable layout as counts change.
   */
  readonly byStatus: Readonly<Record<ReleaseStatus, number>>;
  /** Blocked, failed or rolled back — what a release manager looks at first. */
  readonly needsAttention: number;
}

export function summariseByStatus(releases: readonly Release[]): StatusSummary {
  const byStatus = Object.fromEntries(
    RELEASE_STATUSES.map((status) => [status, 0]),
  ) as Record<ReleaseStatus, number>;

  for (const release of releases) {
    byStatus[release.status] += 1;
  }

  const needsAttention = ATTENTION_STATUSES.reduce((sum, status) => sum + byStatus[status], 0);

  return { total: releases.length, byStatus, needsAttention };
}

/**
 * Derives what a release's status *should* be given its approvals.
 *
 * Precedence, in order: any rejection blocks; any pending approval means the
 * release is awaiting approval; otherwise every gate is cleared and the release
 * is scheduled. Cancelled approvals are ignored — cancelling a gate removes it
 * from the decision rather than clearing or blocking it.
 *
 * Statuses in {@link ORG_FACT_STATUSES} are never overwritten: those describe
 * what actually happened in an org, and no opinion recorded here may contradict
 * them. A release with no live approvals keeps whatever status it has.
 */
export function deriveReleaseStatus(
  release: Release,
  approvals: readonly Approval[],
): ReleaseStatus {
  if (ORG_FACT_STATUSES.includes(release.status)) {
    return release.status;
  }

  const live = approvals.filter(
    (approval) => approval.releaseId === release.id && approval.status !== 'cancelled',
  );

  if (live.length === 0) {
    return release.status;
  }
  if (live.some((approval) => approval.status === 'rejected')) {
    return 'blocked';
  }
  if (live.some((approval) => approval.status === 'pending')) {
    return 'awaiting_approval';
  }
  return 'scheduled';
}

/** Releases needing attention first, then most recently updated. */
export function sortReleasesForDashboard(releases: readonly Release[]): Release[] {
  return [...releases].sort((a, b) => {
    const attention = Number(isAttention(b)) - Number(isAttention(a));
    if (attention !== 0) return attention;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function isAttention(release: Release): boolean {
  return ATTENTION_STATUSES.includes(release.status);
}

export function filterReleasesByStatus(
  releases: readonly Release[],
  status: ReleaseStatus | 'all',
): Release[] {
  if (status === 'all') return [...releases];
  return releases.filter((release) => release.status === status);
}

export function findRelease(
  releases: readonly Release[],
  id: ReleaseId,
): Release | undefined {
  return releases.find((release) => release.id === id);
}

export function findEnvironment(
  environments: readonly Environment[],
  id: EnvironmentId,
): Environment | undefined {
  return environments.find((environment) => environment.id === id);
}

/** Count of approvals still pending per release id, for dashboard badges. */
/**
 * Components per release, in one pass.
 *
 * The dashboard needs this for every row. Filtering the item list per row is
 * the obvious way to write it and is quadratic in (releases x components): at
 * 60 releases and 10,000 components that is 600,000 comparisons per render, and
 * the render happens on every keystroke elsewhere in the panel. Measured at
 * 64ms for one dashboard paint before this existed.
 */
export function countItemsByRelease(
  items: readonly MetadataItem[],
): ReadonlyMap<ReleaseId, number> {
  const counts = new Map<ReleaseId, number>();
  for (const item of items) {
    counts.set(item.releaseId, (counts.get(item.releaseId) ?? 0) + 1);
  }
  return counts;
}

export function countPendingApprovalsByRelease(
  approvals: readonly Approval[],
): ReadonlyMap<ReleaseId, number> {
  const counts = new Map<ReleaseId, number>();
  for (const approval of approvals) {
    if (approval.status !== 'pending') continue;
    counts.set(approval.releaseId, (counts.get(approval.releaseId) ?? 0) + 1);
  }
  return counts;
}
