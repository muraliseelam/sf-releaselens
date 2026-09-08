/**
 * The domain model. Everything persisted, imported or rendered is one of these
 * shapes. This module is deliberately free of behaviour so that it can be read
 * top-to-bottom as documentation of what the extension knows about.
 */

export type EnvironmentId = string;
export type ReleaseId = string;
export type MetadataItemId = string;
export type ApprovalId = string;

/** Schema version of a {@link Snapshot}. Bumped on any breaking shape change. */
export const CURRENT_SCHEMA_VERSION = 1;

// --- Environments ------------------------------------------------------------

export const ENVIRONMENT_KINDS = ['scratch', 'sandbox', 'production'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

export interface Environment {
  readonly id: EnvironmentId;
  readonly name: string;
  readonly kind: EnvironmentKind;
  /** `sf` CLI alias the environment is known by locally, e.g. `uat`. */
  readonly orgAlias: string;
}

// --- Releases ----------------------------------------------------------------

/**
 * Ordered for display, not by lifecycle: the dashboard renders statuses in this
 * order so that the bar chart does not reshuffle as counts change.
 */
export const RELEASE_STATUSES = [
  'draft',
  'awaiting_approval',
  'scheduled',
  'in_progress',
  'deployed',
  'blocked',
  'failed',
  'rolled_back',
] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

/**
 * Statuses that are facts about an org rather than opinions about a release.
 * {@link deriveReleaseStatus} refuses to overwrite these: an approval decision
 * must never claim a deployment that actually failed is now `scheduled`.
 */
export const ORG_FACT_STATUSES: readonly ReleaseStatus[] = [
  'in_progress',
  'deployed',
  'failed',
  'rolled_back',
];

/** Statuses a release manager needs to look at today. */
export const ATTENTION_STATUSES: readonly ReleaseStatus[] = ['blocked', 'failed', 'rolled_back'];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface Release {
  readonly id: ReleaseId;
  readonly name: string;
  /** Human release version, e.g. `2026.09.3`. Not a semver constraint. */
  readonly version: string;
  readonly status: ReleaseStatus;
  readonly targetEnvironmentId: EnvironmentId;
  readonly owner: string;
  /** ISO-8601 UTC timestamps throughout; the UI formats, the model stores. */
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly scheduledFor?: string;
  /** Work item references, e.g. `W-12345`, `REL-88`. */
  readonly ticketRefs: readonly string[];
  readonly riskLevel: RiskLevel;
  readonly notes?: string;
}

// --- Metadata ----------------------------------------------------------------

/**
 * Salesforce metadata type name, e.g. `ApexClass`. Intentionally a plain string
 * rather than a union: the platform has hundreds of types and adds more every
 * release, so a closed union would reject a valid imported deployment report.
 * {@link COMMON_METADATA_TYPES} exists for seeding and UI ordering only.
 */
export type MetadataType = string;

export const COMMON_METADATA_TYPES: readonly MetadataType[] = [
  'ApexClass',
  'ApexTrigger',
  'CustomObject',
  'CustomField',
  'Flow',
  'LightningComponentBundle',
  'PermissionSet',
  'ValidationRule',
  'Layout',
  'CustomLabel',
];

export const METADATA_OPERATIONS = ['add', 'modify', 'delete'] as const;
export type MetadataOperation = (typeof METADATA_OPERATIONS)[number];

export const WARNING_SEVERITIES = ['info', 'warning', 'error'] as const;
export type WarningSeverity = (typeof WARNING_SEVERITIES)[number];

export interface MetadataWarning {
  /** Stable machine code, e.g. `NO_TEST_COVERAGE`. Safe to filter or link on. */
  readonly code: string;
  readonly message: string;
  readonly severity: WarningSeverity;
}

export interface MetadataItem {
  readonly id: MetadataItemId;
  readonly releaseId: ReleaseId;
  /** Salesforce full name, e.g. `AccountTriggerHandler` or `Account.Region__c`. */
  readonly fullName: string;
  readonly type: MetadataType;
  readonly operation: MetadataOperation;
  readonly filePath: string;
  readonly apiVersion: string;
  readonly lastModifiedBy: string;
  readonly lastModifiedAt: string;
  /**
   * Full names this component depends on. Stored as names, not ids, because the
   * interesting dependency is usually on something *outside* this release.
   */
  readonly dependsOn: readonly string[];
  /**
   * Apex coverage as a 0..1 fraction. Absent means *unknown*, which is not the
   * same decision as zero — never default this.
   */
  readonly testCoverage?: number;
  /**
   * True when the source of this item cannot supply dependency edges at all, so
   * an empty `dependsOn` means "unknown" rather than "none".
   *
   * A deploy report — whether imported from the CLI or read from the Tooling
   * API — lists components, not edges. Rendering that as "No recorded
   * dependencies" would tell a reader the component is safe to change, which is
   * exactly the wrong conclusion. Same rule as `testCoverage`: unknown and zero
   * are different answers and must not be conflated.
   */
  readonly dependenciesUnavailable?: boolean;
  readonly warnings: readonly MetadataWarning[];
}

// --- Approvals ---------------------------------------------------------------

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** The subset of statuses a pending approval may be moved to. */
export const APPROVAL_DECISIONS = ['approved', 'rejected', 'cancelled'] as const;
export type ApprovalDecisionOutcome = (typeof APPROVAL_DECISIONS)[number];

export interface ApprovalDecision {
  readonly by: string;
  readonly at: string;
  readonly comment?: string;
}

export interface Approval {
  readonly id: ApprovalId;
  readonly releaseId: ReleaseId;
  /** Gate being approved, e.g. `UAT sign-off`. */
  readonly stage: string;
  /** Role a decider must hold; matched against {@link Actor.roles}. */
  readonly requiredRole: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly status: ApprovalStatus;
  readonly decision?: ApprovalDecision;
}

// --- Actor and audit ---------------------------------------------------------

/**
 * Who "I" am. Local profile, not an authenticated identity — see the honest
 * limitation in docs/DESIGN.md §2.
 */
export interface Actor {
  readonly name: string;
  readonly roles: readonly string[];
}

export const AUDIT_ACTIONS = [
  'approval.approved',
  'approval.rejected',
  'approval.cancelled',
  'release.status_changed',
  'snapshot.imported',
  'snapshot.reset',
  'snapshot.refreshed',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  readonly id: string;
  readonly at: string;
  readonly by: string;
  readonly action: AuditAction;
  /** Human-readable, already formatted for display. */
  readonly detail: string;
  readonly releaseId?: ReleaseId;
}

// --- Snapshot ----------------------------------------------------------------

/** The unit of persistence, import and export. */
export interface Snapshot {
  readonly schemaVersion: number;
  readonly actor: Actor;
  readonly environments: readonly Environment[];
  readonly releases: readonly Release[];
  readonly items: readonly MetadataItem[];
  readonly approvals: readonly Approval[];
  readonly auditLog: readonly AuditEntry[];
  /** True while the snapshot is the shipped demo dataset, so the UI can say so. */
  readonly isDemoData: boolean;
}

export function emptySnapshot(actor: Actor): Snapshot {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    actor,
    environments: [],
    releases: [],
    items: [],
    approvals: [],
    auditLog: [],
    isDemoData: false,
  };
}
