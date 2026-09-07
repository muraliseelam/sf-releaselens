/**
 * Display formatting. Pure and separated from the views so the wording of
 * statuses and relative dates is asserted in tests rather than eyeballed.
 */

import type { ApprovalStatus, MetadataOperation, ReleaseStatus, RiskLevel } from '../core/types.js';

const RELEASE_STATUS_LABELS: Readonly<Record<ReleaseStatus, string>> = {
  draft: 'Draft',
  awaiting_approval: 'Awaiting approval',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  deployed: 'Deployed',
  blocked: 'Blocked',
  failed: 'Failed',
  rolled_back: 'Rolled back',
};

const APPROVAL_STATUS_LABELS: Readonly<Record<ApprovalStatus, string>> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const OPERATION_LABELS: Readonly<Record<MetadataOperation, string>> = {
  add: 'Added',
  modify: 'Modified',
  delete: 'Deleted',
};

const RISK_LABELS: Readonly<Record<RiskLevel, string>> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
};

export function releaseStatusLabel(status: ReleaseStatus): string {
  return RELEASE_STATUS_LABELS[status];
}

export function approvalStatusLabel(status: ApprovalStatus): string {
  return APPROVAL_STATUS_LABELS[status];
}

export function operationLabel(operation: MetadataOperation): string {
  return OPERATION_LABELS[operation];
}

export function riskLabel(risk: RiskLevel): string {
  return RISK_LABELS[risk];
}

/**
 * Coverage as a whole percentage, or an explicit "unknown". Never renders
 * unknown coverage as 0% — that is the difference between "we did not measure"
 * and "this will fail the gate".
 */
export function coverageLabel(coverage: number | undefined): string {
  if (coverage === undefined) return 'Coverage unknown';
  return `${Math.round(coverage * 100)}% covered`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Short relative time, e.g. `3d ago`, `in 2d`. Coarse on purpose: release work
 * is measured in days, and a ticking "42 seconds ago" invites a re-render loop.
 */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;

  const delta = then - now;
  const magnitude = Math.abs(delta);
  const suffix = delta < 0 ? ' ago' : '';
  const prefix = delta < 0 ? '' : 'in ';

  if (magnitude < MINUTE) return 'just now';
  if (magnitude < HOUR) return `${prefix}${Math.round(magnitude / MINUTE)}m${suffix}`;
  if (magnitude < DAY) return `${prefix}${Math.round(magnitude / HOUR)}h${suffix}`;
  return `${prefix}${Math.round(magnitude / DAY)}d${suffix}`;
}

/** Absolute timestamp for tooltips, where precision beats brevity. */
export function absoluteTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleString();
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
