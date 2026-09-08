/**
 * Import and export.
 *
 * Two entry points, both ending at {@link parseSnapshot} so that nothing reaches
 * storage without passing the same validation:
 *
 *  1. A snapshot previously exported from this extension.
 *  2. The JSON emitted by `sf project deploy report --json`, mapped onto the
 *     domain model. This is the no-backend path described in docs/DESIGN.md §6.
 */

import type { SnapshotDeps } from '../core/snapshot.js';
import { ImportFormatError } from '../core/errors.js';
import {
  CURRENT_SCHEMA_VERSION,
  type Actor,
  type EnvironmentKind,
  type MetadataItem,
  type MetadataOperation,
  type MetadataWarning,
  type Release,
  type ReleaseStatus,
  type Snapshot,
} from '../core/types.js';
import { parseSnapshot } from '../core/validate.js';

/** Pretty-printed so an exported file is reviewable in a diff. */
export function toExportJson(snapshot: Snapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function suggestedExportFilename(now: string): string {
  const stamp = now.replace(/[:.]/g, '-');
  return `sf-releaselens-${stamp}.json`;
}

/**
 * Parses import text, accepting either supported shape.
 *
 * @throws ImportFormatError when the text is not JSON at all, or is JSON of no
 *         recognised shape. Schema faults inside a recognised shape surface as
 *         {@link SnapshotValidationError} instead, because those name a field.
 */
export function parseImportText(
  text: string,
  deps: SnapshotDeps,
  options: DeployReportOptions,
): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ImportFormatError(
      `the file is not valid JSON (${cause instanceof Error ? cause.message : String(cause)}).`,
    );
  }

  if (looksLikeSnapshot(parsed)) {
    return parseSnapshot(parsed);
  }
  if (looksLikeDeployReport(parsed)) {
    return snapshotFromDeployReport(parsed, deps, options);
  }
  throw new ImportFormatError(
    'the JSON is neither a sf-releaselens export (no "schemaVersion") nor an ' +
      'sf deploy report (no "result.details.componentSuccesses").',
  );
}

export interface DeployReportOptions {
  readonly actor: Actor;
  readonly environmentName: string;
  readonly environmentKind: EnvironmentKind;
  readonly orgAlias: string;
  /** Falls back to the deploy id when the caller has no better name. */
  readonly releaseName?: string;
  readonly owner: string;
}

/**
 * Maps one `sf project deploy report --json` payload onto a single-release
 * snapshot.
 *
 * Deliberate gaps, because the report simply does not carry the data:
 *  - Dependencies are empty. A deploy report lists components, not edges.
 *  - Coverage is absent rather than zero, per the model's rule about unknowns.
 *  - No approvals are invented. Gates are a human process this import cannot see.
 */
export function snapshotFromDeployReport(
  raw: unknown,
  deps: SnapshotDeps,
  options: DeployReportOptions,
): Snapshot {
  const result = readResult(raw);
  const deployId = readString(result['id']) ?? 'unknown-deploy';
  const now = deps.clock.now();
  const createdAt = readString(result['createdDate']) ?? now;
  const completedAt = readString(result['completedDate']) ?? createdAt;
  const environmentId = deps.newId();
  const releaseId = deps.newId();

  const details = asRecord(result['details']) ?? {};
  const successes = asArray(details['componentSuccesses']);
  const failures = asArray(details['componentFailures']);

  const items: MetadataItem[] = [
    ...successes.map((entry) => itemFromDeployComponent(entry, releaseId, deps, completedAt, [])),
    ...failures.map((entry) =>
      itemFromDeployComponent(entry, releaseId, deps, completedAt, [warningFromDeployFailure(entry)]),
    ),
  ].filter((item) => item.type.length > 0 && item.fullName.length > 0);

  const release: Release = {
    id: releaseId,
    name: options.releaseName ?? `Deploy ${deployId}`,
    version: deployId,
    status: releaseStatusFromDeployStatus(readString(result['status']), result['checkOnly'] === true),
    targetEnvironmentId: environmentId,
    owner: options.owner,
    createdAt,
    updatedAt: completedAt,
    ticketRefs: [],
    riskLevel: failures.length > 0 ? 'high' : 'medium',
    notes:
      `Imported from an sf deploy report: ${successes.length} succeeded, ` +
      `${failures.length} failed. Dependencies and approvals are not present in a deploy report.`,
  };

  const snapshot: Snapshot = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    actor: options.actor,
    environments: [
      {
        id: environmentId,
        name: options.environmentName,
        kind: options.environmentKind,
        orgAlias: options.orgAlias,
      },
    ],
    releases: [release],
    items,
    approvals: [],
    auditLog: [],
    isDemoData: false,
  };

  // Round-trips through the same validator as stored data, so a mapping bug
  // cannot introduce a snapshot the rest of the app would refuse to load.
  return parseSnapshot(JSON.parse(JSON.stringify(snapshot)));
}

/**
 * Maps one deploy component row to a MetadataItem.
 *
 * Exported so the org-backed data source reuses it rather than duplicating the
 * mapping: a deploy report and the Tooling API return the same component shape,
 * and two copies would drift.
 */
export function itemFromDeployComponent(
  entry: unknown,
  releaseId: string,
  deps: SnapshotDeps,
  lastModifiedAt: string,
  warnings: readonly MetadataWarning[],
): MetadataItem {
  const record = asRecord(entry) ?? {};
  return {
    id: deps.newId(),
    releaseId,
    fullName: readString(record['fullName']) ?? '',
    type: readString(record['componentType']) ?? '',
    operation: toOperation(record),
    filePath: readString(record['fileName']) ?? '',
    apiVersion: readString(record['apiVersion']) ?? '',
    lastModifiedBy: readString(record['createdByName']) ?? 'unknown',
    lastModifiedAt: readString(record['createdDate']) ?? lastModifiedAt,
    dependsOn: [],
    warnings,
  };
}

function toOperation(record: Record<string, unknown>): MetadataOperation {
  if (record['deleted'] === true) return 'delete';
  if (record['created'] === true) return 'add';
  return 'modify';
}

export function warningFromDeployFailure(entry: unknown): MetadataWarning {
  const record = asRecord(entry) ?? {};
  return {
    code: readString(record['problemType'])?.toUpperCase() ?? 'DEPLOY_FAILURE',
    message: readString(record['problem']) ?? 'The deploy report recorded a failure with no detail.',
    severity: 'error',
  };
}

/**
 * A check-only deploy that succeeded has been *validated*, not deployed, so it
 * maps to `scheduled`. Conflating the two would let the dashboard claim a
 * release is live when nothing was written to the org.
 */
export function releaseStatusFromDeployStatus(status: string | undefined, checkOnly: boolean): ReleaseStatus {
  switch (status) {
    case 'Succeeded':
      return checkOnly ? 'scheduled' : 'deployed';
    case 'SucceededPartial':
    case 'Failed':
      return 'failed';
    case 'Canceled':
    case 'Canceling':
      return 'blocked';
    case 'InProgress':
    case 'Pending':
      return 'in_progress';
    default:
      // An unrecognised status degrades to the least confident answer rather
      // than guessing that a deploy succeeded.
      return 'draft';
  }
}

function looksLikeSnapshot(value: unknown): boolean {
  const record = asRecord(value);
  return record !== undefined && typeof record['schemaVersion'] === 'number';
}

function looksLikeDeployReport(value: unknown): boolean {
  const record = asRecord(value);
  if (record === undefined) return false;
  const result = asRecord(record['result']) ?? record;
  const details = asRecord(result['details']);
  return details !== undefined && Array.isArray(details['componentSuccesses']);
}

/** `sf` wraps its payload in `result`; a bare report body is accepted too. */
function readResult(raw: unknown): Record<string, unknown> {
  const record = asRecord(raw);
  if (record === undefined) {
    throw new ImportFormatError('the top level of the file is not a JSON object.');
  }
  const result = asRecord(record['result']) ?? record;
  if (asRecord(result['details']) === undefined) {
    throw new ImportFormatError('the deploy report has no "details" section to read components from.');
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  // A single-component deploy report emits an object, not a one-element array.
  return value === undefined || value === null ? [] : [value];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
