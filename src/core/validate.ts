/**
 * Runtime validation for anything that crosses a trust boundary: data read back
 * from `chrome.storage`, and JSON a user imports.
 *
 * Written by hand rather than with a schema library, for three reasons: it is
 * the only validation in the project, it must produce a *path* precise enough to
 * show a human, and a zero-dependency extension has a smaller review surface for
 * anyone deciding whether to install it.
 *
 * The whole payload is rejected on the first fault. Partial acceptance is never
 * attempted — half-loaded release data is worse than none, because it looks fine.
 */

import { SnapshotValidationError, UnsupportedSchemaVersionError } from './errors.js';
import {
  APPROVAL_STATUSES,
  AUDIT_ACTIONS,
  CURRENT_SCHEMA_VERSION,
  ENVIRONMENT_KINDS,
  METADATA_OPERATIONS,
  RELEASE_STATUSES,
  RISK_LEVELS,
  WARNING_SEVERITIES,
  type Actor,
  type Approval,
  type ApprovalDecision,
  type AuditEntry,
  type Environment,
  type MetadataItem,
  type MetadataWarning,
  type Release,
  type Snapshot,
} from './types.js';

/**
 * Parses an untrusted value into a Snapshot.
 *
 * @throws UnsupportedSchemaVersionError when the version is readable but not ours.
 * @throws SnapshotValidationError naming the exact failing path otherwise.
 */
export function parseSnapshot(raw: unknown): Snapshot {
  const root = asObject(raw, 'snapshot');

  const schemaVersion = asNumber(root['schemaVersion'], 'snapshot.schemaVersion');
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(schemaVersion, CURRENT_SCHEMA_VERSION);
  }

  const environments = asArray(root['environments'], 'snapshot.environments').map(
    (value, index) => parseEnvironment(value, `snapshot.environments[${index}]`),
  );
  const releases = asArray(root['releases'], 'snapshot.releases').map((value, index) =>
    parseRelease(value, `snapshot.releases[${index}]`),
  );
  const items = asArray(root['items'], 'snapshot.items').map((value, index) =>
    parseMetadataItem(value, `snapshot.items[${index}]`),
  );
  const approvals = asArray(root['approvals'], 'snapshot.approvals').map((value, index) =>
    parseApproval(value, `snapshot.approvals[${index}]`),
  );
  const auditLog = asArray(root['auditLog'], 'snapshot.auditLog').map((value, index) =>
    parseAuditEntry(value, `snapshot.auditLog[${index}]`),
  );

  const snapshot: Snapshot = {
    schemaVersion,
    actor: parseActor(root['actor'], 'snapshot.actor'),
    environments,
    releases,
    items,
    approvals,
    auditLog,
    isDemoData: asBoolean(root['isDemoData'], 'snapshot.isDemoData'),
  };

  assertUniqueIds(environments, 'snapshot.environments');
  assertUniqueIds(releases, 'snapshot.releases');
  assertUniqueIds(items, 'snapshot.items');
  assertUniqueIds(approvals, 'snapshot.approvals');
  assertReferentialIntegrity(snapshot);

  return snapshot;
}

// --- Record parsers ----------------------------------------------------------

function parseActor(raw: unknown, path: string): Actor {
  const value = asObject(raw, path);
  return {
    name: asNonEmptyString(value['name'], `${path}.name`),
    roles: asArray(value['roles'], `${path}.roles`).map((role, index) =>
      asNonEmptyString(role, `${path}.roles[${index}]`),
    ),
  };
}

function parseEnvironment(raw: unknown, path: string): Environment {
  const value = asObject(raw, path);
  return {
    id: asNonEmptyString(value['id'], `${path}.id`),
    name: asNonEmptyString(value['name'], `${path}.name`),
    kind: asEnum(value['kind'], ENVIRONMENT_KINDS, `${path}.kind`),
    orgAlias: asString(value['orgAlias'], `${path}.orgAlias`),
  };
}

function parseRelease(raw: unknown, path: string): Release {
  const value = asObject(raw, path);
  const scheduledFor = asOptionalIsoDate(value['scheduledFor'], `${path}.scheduledFor`);
  const notes = asOptionalString(value['notes'], `${path}.notes`);

  return {
    id: asNonEmptyString(value['id'], `${path}.id`),
    name: asNonEmptyString(value['name'], `${path}.name`),
    version: asNonEmptyString(value['version'], `${path}.version`),
    status: asEnum(value['status'], RELEASE_STATUSES, `${path}.status`),
    targetEnvironmentId: asNonEmptyString(
      value['targetEnvironmentId'],
      `${path}.targetEnvironmentId`,
    ),
    owner: asNonEmptyString(value['owner'], `${path}.owner`),
    createdAt: asIsoDate(value['createdAt'], `${path}.createdAt`),
    updatedAt: asIsoDate(value['updatedAt'], `${path}.updatedAt`),
    ticketRefs: asArray(value['ticketRefs'], `${path}.ticketRefs`).map((ref, index) =>
      asNonEmptyString(ref, `${path}.ticketRefs[${index}]`),
    ),
    riskLevel: asEnum(value['riskLevel'], RISK_LEVELS, `${path}.riskLevel`),
    // Optional fields are omitted rather than set to undefined, which
    // `exactOptionalPropertyTypes` treats as a meaningful difference.
    ...(scheduledFor === undefined ? {} : { scheduledFor }),
    ...(notes === undefined ? {} : { notes }),
  };
}

function parseMetadataItem(raw: unknown, path: string): MetadataItem {
  const value = asObject(raw, path);
  const testCoverage = asOptionalFraction(value['testCoverage'], `${path}.testCoverage`);
  const dependenciesUnavailable = asOptionalBoolean(
    value['dependenciesUnavailable'],
    `${path}.dependenciesUnavailable`,
  );

  return {
    id: asNonEmptyString(value['id'], `${path}.id`),
    releaseId: asNonEmptyString(value['releaseId'], `${path}.releaseId`),
    fullName: asNonEmptyString(value['fullName'], `${path}.fullName`),
    type: asNonEmptyString(value['type'], `${path}.type`),
    operation: asEnum(value['operation'], METADATA_OPERATIONS, `${path}.operation`),
    filePath: asString(value['filePath'], `${path}.filePath`),
    apiVersion: asString(value['apiVersion'], `${path}.apiVersion`),
    lastModifiedBy: asString(value['lastModifiedBy'], `${path}.lastModifiedBy`),
    lastModifiedAt: asIsoDate(value['lastModifiedAt'], `${path}.lastModifiedAt`),
    dependsOn: asArray(value['dependsOn'], `${path}.dependsOn`).map((name, index) =>
      asNonEmptyString(name, `${path}.dependsOn[${index}]`),
    ),
    warnings: asArray(value['warnings'], `${path}.warnings`).map((warning, index) =>
      parseWarning(warning, `${path}.warnings[${index}]`),
    ),
    ...(testCoverage === undefined ? {} : { testCoverage }),
    ...(dependenciesUnavailable === undefined ? {} : { dependenciesUnavailable }),
  };
}

function parseWarning(raw: unknown, path: string): MetadataWarning {
  const value = asObject(raw, path);
  return {
    code: asNonEmptyString(value['code'], `${path}.code`),
    message: asNonEmptyString(value['message'], `${path}.message`),
    severity: asEnum(value['severity'], WARNING_SEVERITIES, `${path}.severity`),
  };
}

function parseApproval(raw: unknown, path: string): Approval {
  const value = asObject(raw, path);
  const status = asEnum(value['status'], APPROVAL_STATUSES, `${path}.status`);
  const decisionRaw = value['decision'];

  if (status !== 'pending' && decisionRaw == null) {
    throw new SnapshotValidationError(
      `${path}.decision`,
      `an approval with status "${status}" must record who decided it and when`,
    );
  }
  if (status === 'pending' && decisionRaw != null) {
    throw new SnapshotValidationError(
      `${path}.decision`,
      'a pending approval must not carry a decision',
    );
  }

  return {
    id: asNonEmptyString(value['id'], `${path}.id`),
    releaseId: asNonEmptyString(value['releaseId'], `${path}.releaseId`),
    stage: asNonEmptyString(value['stage'], `${path}.stage`),
    requiredRole: asNonEmptyString(value['requiredRole'], `${path}.requiredRole`),
    requestedBy: asNonEmptyString(value['requestedBy'], `${path}.requestedBy`),
    requestedAt: asIsoDate(value['requestedAt'], `${path}.requestedAt`),
    status,
    ...(decisionRaw == null ? {} : { decision: parseDecision(decisionRaw, `${path}.decision`) }),
  };
}

function parseDecision(raw: unknown, path: string): ApprovalDecision {
  const value = asObject(raw, path);
  const comment = asOptionalString(value['comment'], `${path}.comment`);
  return {
    by: asNonEmptyString(value['by'], `${path}.by`),
    at: asIsoDate(value['at'], `${path}.at`),
    ...(comment === undefined ? {} : { comment }),
  };
}

function parseAuditEntry(raw: unknown, path: string): AuditEntry {
  const value = asObject(raw, path);
  const releaseId = asOptionalString(value['releaseId'], `${path}.releaseId`);
  return {
    id: asNonEmptyString(value['id'], `${path}.id`),
    at: asIsoDate(value['at'], `${path}.at`),
    by: asNonEmptyString(value['by'], `${path}.by`),
    action: asEnum(value['action'], AUDIT_ACTIONS, `${path}.action`),
    detail: asString(value['detail'], `${path}.detail`),
    ...(releaseId === undefined ? {} : { releaseId }),
  };
}

// --- Cross-record checks -----------------------------------------------------

function assertUniqueIds(records: readonly { id: string }[], path: string): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) {
      throw new SnapshotValidationError(path, `duplicate id "${record.id}"`);
    }
    seen.add(record.id);
  }
}

/**
 * Dangling references are rejected rather than pruned. A release pointing at a
 * missing environment is a corrupt export, and quietly dropping it would hide
 * the corruption behind a plausible-looking dashboard.
 */
function assertReferentialIntegrity(snapshot: Snapshot): void {
  const environmentIds = new Set(snapshot.environments.map((environment) => environment.id));
  const releaseIds = new Set(snapshot.releases.map((release) => release.id));

  snapshot.releases.forEach((release, index) => {
    if (!environmentIds.has(release.targetEnvironmentId)) {
      throw new SnapshotValidationError(
        `snapshot.releases[${index}].targetEnvironmentId`,
        `references environment "${release.targetEnvironmentId}", which is not in this snapshot`,
      );
    }
  });

  snapshot.items.forEach((item, index) => {
    if (!releaseIds.has(item.releaseId)) {
      throw new SnapshotValidationError(
        `snapshot.items[${index}].releaseId`,
        `references release "${item.releaseId}", which is not in this snapshot`,
      );
    }
  });

  snapshot.approvals.forEach((approval, index) => {
    if (!releaseIds.has(approval.releaseId)) {
      throw new SnapshotValidationError(
        `snapshot.approvals[${index}].releaseId`,
        `references release "${approval.releaseId}", which is not in this snapshot`,
      );
    }
  });
}

// --- Primitives --------------------------------------------------------------

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SnapshotValidationError(path, `expected an object, received ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new SnapshotValidationError(path, `expected an array, received ${describe(value)}`);
  }
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new SnapshotValidationError(path, `expected a string, received ${describe(value)}`);
  }
  return value;
}

function asNonEmptyString(value: unknown, path: string): string {
  const text = asString(value, path);
  if (text.trim().length === 0) {
    throw new SnapshotValidationError(path, 'expected a non-empty string');
  }
  return text;
}

function asOptionalString(value: unknown, path: string): string | undefined {
  if (value == null) return undefined;
  return asString(value, path);
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SnapshotValidationError(path, `expected a finite number, received ${describe(value)}`);
  }
  return value;
}

function asOptionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value == null) return undefined;
  return asBoolean(value, path);
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new SnapshotValidationError(path, `expected a boolean, received ${describe(value)}`);
  }
  return value;
}

/** Coverage is a 0..1 fraction; a percentage sneaking in would silently mislead. */
function asOptionalFraction(value: unknown, path: string): number | undefined {
  if (value == null) return undefined;
  const numeric = asNumber(value, path);
  if (numeric < 0 || numeric > 1) {
    throw new SnapshotValidationError(
      path,
      `expected a fraction between 0 and 1, received ${numeric} (percentages must be divided by 100)`,
    );
  }
  return numeric;
}

function asIsoDate(value: unknown, path: string): string {
  const text = asNonEmptyString(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw new SnapshotValidationError(path, `expected an ISO-8601 timestamp, received "${text}"`);
  }
  return text;
}

function asOptionalIsoDate(value: unknown, path: string): string | undefined {
  if (value == null) return undefined;
  return asIsoDate(value, path);
}

function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  const text = asString(value, path);
  const match = allowed.find((candidate) => candidate === text);
  if (match === undefined) {
    throw new SnapshotValidationError(
      path,
      `expected one of ${allowed.map((option) => `"${option}"`).join(', ')}, received "${text}"`,
    );
  }
  return match;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
