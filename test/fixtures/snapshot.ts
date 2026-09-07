/**
 * Test builders.
 *
 * Fields are read individually rather than spread from a `Partial<T>`, because
 * `exactOptionalPropertyTypes` makes "absent" and "present but undefined"
 * different types — and the difference between absent and zero coverage is one
 * of the rules under test.
 */

import { createFixedClock, createSequentialIdFactory } from '../../src/core/clock.js';
import type { SnapshotDeps } from '../../src/core/snapshot.js';
import {
  CURRENT_SCHEMA_VERSION,
  type Actor,
  type Approval,
  type ApprovalStatus,
  type Environment,
  type MetadataItem,
  type MetadataOperation,
  type MetadataWarning,
  type Release,
  type ReleaseStatus,
  type RiskLevel,
  type Snapshot,
} from '../../src/core/types.js';

export const FIXED_NOW = '2026-09-07T09:00:00.000Z';

export function testDeps(now = FIXED_NOW, prefix = 'gen'): SnapshotDeps {
  return { clock: createFixedClock(now), newId: createSequentialIdFactory(prefix) };
}

export const ACTOR: Actor = { name: 'Sam Okafor', roles: ['release-manager', 'uat-approver'] };

export function makeEnvironment(options: {
  id?: string;
  name?: string;
  kind?: Environment['kind'];
} = {}): Environment {
  return {
    id: options.id ?? 'env-uat',
    name: options.name ?? 'UAT',
    kind: options.kind ?? 'sandbox',
    orgAlias: 'uat',
  };
}

export function makeRelease(options: {
  id?: string;
  name?: string;
  version?: string;
  status?: ReleaseStatus;
  environmentId?: string;
  updatedAt?: string;
  riskLevel?: RiskLevel;
  ticketRefs?: readonly string[];
} = {}): Release {
  return {
    id: options.id ?? 'rel-1',
    name: options.name ?? 'Q3 Billing',
    version: options.version ?? '2026.09.1',
    status: options.status ?? 'draft',
    targetEnvironmentId: options.environmentId ?? 'env-uat',
    owner: 'Sam Okafor',
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: options.updatedAt ?? '2026-09-05T09:00:00.000Z',
    ticketRefs: options.ticketRefs ?? ['W-1'],
    riskLevel: options.riskLevel ?? 'medium',
  };
}

export function makeItem(options: {
  id?: string;
  releaseId?: string;
  fullName?: string;
  type?: string;
  operation?: MetadataOperation;
  filePath?: string;
  lastModifiedBy?: string;
  lastModifiedAt?: string;
  dependsOn?: readonly string[];
  testCoverage?: number;
  warnings?: readonly MetadataWarning[];
} = {}): MetadataItem {
  const fullName = options.fullName ?? 'AccountTriggerHandler';
  return {
    id: options.id ?? `item-${fullName}`,
    releaseId: options.releaseId ?? 'rel-1',
    fullName,
    type: options.type ?? 'ApexClass',
    operation: options.operation ?? 'modify',
    filePath: options.filePath ?? `force-app/main/default/classes/${fullName}.cls`,
    apiVersion: '62.0',
    lastModifiedBy: options.lastModifiedBy ?? 'Lin Zhou',
    lastModifiedAt: options.lastModifiedAt ?? '2026-09-04T09:00:00.000Z',
    dependsOn: options.dependsOn ?? [],
    warnings: options.warnings ?? [],
    ...(options.testCoverage === undefined ? {} : { testCoverage: options.testCoverage }),
  };
}

export function makeApproval(options: {
  id?: string;
  releaseId?: string;
  stage?: string;
  requiredRole?: string;
  requestedBy?: string;
  requestedAt?: string;
  status?: ApprovalStatus;
  decidedBy?: string;
  decidedAt?: string;
  comment?: string;
} = {}): Approval {
  const status = options.status ?? 'pending';
  const decided = status !== 'pending';
  return {
    id: options.id ?? 'apr-1',
    releaseId: options.releaseId ?? 'rel-1',
    stage: options.stage ?? 'UAT sign-off',
    requiredRole: options.requiredRole ?? 'uat-approver',
    requestedBy: options.requestedBy ?? 'Lin Zhou',
    requestedAt: options.requestedAt ?? '2026-09-03T09:00:00.000Z',
    status,
    ...(decided
      ? {
          decision: {
            by: options.decidedBy ?? 'Tomas Reid',
            at: options.decidedAt ?? '2026-09-04T09:00:00.000Z',
            ...(options.comment === undefined ? {} : { comment: options.comment }),
          },
        }
      : {}),
  };
}

export function makeSnapshot(options: {
  actor?: Actor;
  environments?: readonly Environment[];
  releases?: readonly Release[];
  items?: readonly MetadataItem[];
  approvals?: readonly Approval[];
  isDemoData?: boolean;
} = {}): Snapshot {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    actor: options.actor ?? ACTOR,
    environments: options.environments ?? [makeEnvironment()],
    releases: options.releases ?? [makeRelease()],
    items: options.items ?? [],
    approvals: options.approvals ?? [],
    auditLog: [],
    isDemoData: options.isDemoData ?? false,
  };
}

/** A realistic multi-release snapshot for integration tests. */
export function realisticSnapshot(): Snapshot {
  const environments = [
    makeEnvironment({ id: 'env-uat', name: 'UAT', kind: 'sandbox' }),
    makeEnvironment({ id: 'env-prod', name: 'Production', kind: 'production' }),
  ];
  const releases = [
    makeRelease({ id: 'rel-billing', name: 'Q3 Billing', status: 'awaiting_approval' }),
    makeRelease({
      id: 'rel-hotfix',
      name: 'Payment Hotfix',
      version: '2026.09.2',
      status: 'blocked',
      environmentId: 'env-prod',
      riskLevel: 'high',
    }),
    makeRelease({
      id: 'rel-console',
      name: 'Console Refresh',
      version: '2026.08.9',
      status: 'deployed',
      environmentId: 'env-prod',
      riskLevel: 'low',
    }),
  ];
  const items = [
    makeItem({ id: 'i1', releaseId: 'rel-billing', fullName: 'InvoiceBuilder', operation: 'add', dependsOn: ['UsageAggregator'], testCoverage: 0.91 }),
    makeItem({ id: 'i2', releaseId: 'rel-billing', fullName: 'UsageAggregator', operation: 'add', testCoverage: 0.88 }),
    makeItem({ id: 'i3', releaseId: 'rel-billing', fullName: 'Invoice_Approval_Routing', type: 'Flow', operation: 'modify', dependsOn: ['InvoiceBuilder', 'Billing_Approvers'] }),
    makeItem({ id: 'i4', releaseId: 'rel-hotfix', fullName: 'PaymentRetryScheduler', lastModifiedBy: 'Marco Bellini', warnings: [{ code: 'HARDCODED_ID', message: 'Hard-coded record id.', severity: 'warning' }] }),
    makeItem({ id: 'i5', releaseId: 'rel-console', fullName: 'CaseConsoleController', operation: 'modify' }),
  ];
  const approvals = [
    makeApproval({ id: 'apr-uat', releaseId: 'rel-billing', requiredRole: 'uat-approver' }),
    makeApproval({ id: 'apr-qa', releaseId: 'rel-billing', stage: 'QA sign-off', requiredRole: 'qa-lead' }),
    makeApproval({ id: 'apr-cab', releaseId: 'rel-hotfix', stage: 'Change board', requiredRole: 'cab-approver', status: 'rejected', comment: 'No rollback plan.' }),
    makeApproval({ id: 'apr-console', releaseId: 'rel-console', stage: 'Change board', requiredRole: 'cab-approver', status: 'approved' }),
  ];

  return makeSnapshot({ environments, releases, items, approvals });
}
