/**
 * The org network port. docs/DATASOURCE.md §5.
 *
 * `OrgConnection` is **read-only by construction**: there is no `post`, `patch`
 * or `delete` member, so a future contributor cannot give a read path a write
 * side effect without changing this interface — which is a visible diff in
 * review. That is the mechanism behind the claim in the README that the
 * extension never writes to an org.
 *
 * `createFetchOrgConnection` in `fetchConnection.ts` is the **only** place in
 * the codebase permitted to call `fetch`.
 */

import {
  OrgResponseInvalidError,
} from '../core/errors.js';

/** A Salesforce SOQL/REST query response page. */
export interface QueryPage<T> {
  records: T[];
  done: boolean;
  totalSize: number;
  /** Present when `done` is false; pass to `queryMore`. */
  nextRecordsUrl?: string;
}

export interface OrgConnection {
  /** `https://acme.my.salesforce.com`, no trailing slash. */
  readonly instanceUrl: string;
  /** e.g. `62.0`. */
  readonly apiVersion: string;

  /**
   * REST `GET` against a path relative to the instance, e.g.
   * `/services/data/v62.0/limits`.
   */
  get<T>(path: string, params?: Readonly<Record<string, string>>): Promise<T>;

  /** Tooling API SOQL. Returns one page. */
  toolingQuery<T>(soql: string): Promise<QueryPage<T>>;

  /** Continues a `toolingQuery` from a `nextRecordsUrl`. */
  queryMore<T>(nextRecordsUrl: string): Promise<QueryPage<T>>;
}

// --- Response shapes ---------------------------------------------------------
//
// Restated structurally rather than imported from a Salesforce SDK: this keeps
// the mapping code testable against plain fixtures, and means an SDK change
// would break one adapter rather than every test. Every field except the few we
// genuinely require is optional, because an unusual org response is a case to
// handle rather than assume away.

export interface OrganizationRow {
  Id: string;
  IsSandbox: boolean;
  TrialExpirationDate: string | null;
  OrganizationType?: string | null;
  InstanceName?: string | null;
  Name?: string | null;
}

/** One component row inside a `DeployRequest`'s details. */
export interface DeployMessageRow {
  fullName?: string | null;
  componentType?: string | null;
  fileName?: string | null;
  created?: boolean | null;
  changed?: boolean | null;
  deleted?: boolean | null;
  createdByName?: string | null;
  createdDate?: string | null;
  problem?: string | null;
  problemType?: string | null;
}

export interface DeployRequestRow {
  Id: string;
  Status?: string | null;
  CheckOnly?: boolean | null;
  CreatedDate?: string | null;
  StartDate?: string | null;
  CompletedDate?: string | null;
  CreatedBy?: { Name?: string | null } | null;
  NumberComponentsTotal?: number | null;
  NumberComponentErrors?: number | null;
  NumberComponentsDeployed?: number | null;
  TestLevel?: string | null;
  DeployOptions?: unknown;
  /**
   * Present only when the record is fetched individually — the Tooling API
   * omits `Metadata`/details from list queries.
   */
  DeployResult?: {
    details?: {
      componentSuccesses?: DeployMessageRow[] | null;
      componentFailures?: DeployMessageRow[] | null;
    } | null;
  } | null;
}

export interface ApexCoverageRow {
  ApexClassOrTrigger?: { Name?: string | null } | null;
  NumLinesCovered?: number | null;
  NumLinesUncovered?: number | null;
}

export interface OrgLimit {
  Max: number;
  Remaining: number;
}

export type OrgLimits = Readonly<Record<string, OrgLimit>>;

// --- Narrowing helpers -------------------------------------------------------
//
// Shared by the transport and by the mapper so an unexpected shape produces the
// same named error wherever it is noticed.

export function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OrgResponseInvalidError(path, `expected an object, received ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

export function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new OrgResponseInvalidError(path, `expected an array, received ${describe(value)}`);
  }
  return value;
}

export function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new OrgResponseInvalidError(path, `expected a string, received ${describe(value)}`);
  }
  return value;
}

/** Optional string that tolerates `null`, which Salesforce uses for "unset". */
export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
