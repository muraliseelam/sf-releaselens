/**
 * A diagnostic report that is safe to paste into a public issue.
 *
 * When something fails against a real Salesforce org, the maintainer cannot
 * reproduce it and the reporter cannot share the data. This closes that gap
 * from the safe side: the report carries **shapes, counts, versions and error
 * codes, and nothing else**.
 *
 * The design rule is allow-listing, not filtering. Every field below is
 * constructed from a count, a boolean, an enum, a version string or a duration.
 * No field is copied from org data, so there is no value to accidentally leave
 * in — a redaction pass over a report built by copying would be one forgotten
 * field away from leaking an org name, and this cannot be.
 *
 * Deliberately absent, and listed in the report itself so a reader can see the
 * promise rather than take it on trust:
 *
 *  - Access tokens, refresh tokens, the Consumer Key, the code verifier.
 *  - The org name, instance URL, org id, user id or username.
 *  - Deploy ids, release names, component names, file paths, ticket references,
 *    approval comments, approver names.
 *
 * Hosts are *classified*, never reported: `login.salesforce.com` and
 * `test.salesforce.com` are the two published endpoints and identify nobody, so
 * they are named; anything else is reported as `other`. An instance host is
 * reported only as which pattern it matches.
 */

import { classifyInstanceHost, classifyLoginHost } from './hosts.js';
import { RELEASE_STATUSES, type ReleaseStatus, type Snapshot } from './types.js';

export interface DiagnosticEnvironment {
  /** From the manifest, e.g. `0.4.0`. */
  readonly extensionVersion: string;
  /** Chrome's major version only, e.g. `131`. Never the full user-agent string. */
  readonly browserMajorVersion: string;
  /** `Windows`, `macOS`, `Linux` or `unknown`. Never a build or a device name. */
  readonly platform: string;
  /** The pinned Salesforce API version this build talks. */
  readonly apiVersion: string;
}

export interface DiagnosticOrgInput {
  readonly connected: boolean;
  readonly hasHostPermission: boolean;
  readonly loginUrl?: string | undefined;
  readonly instanceUrl?: string | undefined;
  readonly connectedAt?: string | undefined;
  readonly hasClientId: boolean;
}

export interface DiagnosticInput {
  readonly now: string;
  readonly environment: DiagnosticEnvironment;
  readonly org: DiagnosticOrgInput;
  readonly snapshot: Snapshot | null;
  /** Storage keys present, and roughly how many bytes each holds. */
  readonly storage: readonly { readonly key: string; readonly bytes: number }[];
}

export interface DiagnosticReport {
  readonly report: 'sf-releaselens-diagnostics';
  readonly version: 1;
  readonly generatedAt: string;
  readonly contains: string;
  readonly excludes: readonly string[];
  readonly environment: DiagnosticEnvironment;
  readonly org: {
    readonly connected: boolean;
    readonly hasHostPermission: boolean;
    readonly loginHost: string;
    readonly instanceHostPattern: string;
    readonly hasClientId: boolean;
    readonly connectedMinutesAgo: number | null;
    readonly lastRefreshMinutesAgo: number | null;
  };
  readonly snapshot: {
    readonly present: boolean;
    readonly schemaVersion: number | null;
    readonly isDemoData: boolean | null;
    readonly counts: Readonly<Record<string, number>>;
    readonly releasesByStatus: Readonly<Record<ReleaseStatus, number>>;
    readonly itemsWithCoverage: number;
    readonly itemsWithWarnings: number;
    readonly itemsWithUnavailableDependencies: number;
    readonly itemsWithDependencyEdges: number;
    readonly approvalsByStatus: Readonly<Record<string, number>>;
    readonly distinctMetadataTypes: number;
  };
  readonly storage: readonly { readonly key: string; readonly bytes: number }[];
  readonly recentActivity: readonly { readonly action: string; readonly minutesAgo: number }[];
}

const EXCLUDES = [
  'access tokens, refresh tokens, the Consumer Key and the PKCE verifier',
  'the org name, instance URL, org id, user id and username',
  'deploy ids, release names, component names and file paths',
  'ticket references, approval comments and approver names',
];

export function buildDiagnostics(input: DiagnosticInput): DiagnosticReport {
  const { snapshot } = input;
  const nowMs = Date.parse(input.now);

  return {
    report: 'sf-releaselens-diagnostics',
    version: 1,
    generatedAt: input.now,
    contains: 'Counts, versions, shapes and durations only. No org data.',
    excludes: EXCLUDES,
    environment: input.environment,
    org: {
      connected: input.org.connected,
      hasHostPermission: input.org.hasHostPermission,
      loginHost: classifyLoginHost(input.org.loginUrl),
      instanceHostPattern: classifyInstanceHost(input.org.instanceUrl),
      hasClientId: input.org.hasClientId,
      connectedMinutesAgo: minutesSince(input.org.connectedAt, nowMs),
      lastRefreshMinutesAgo: minutesSince(lastRefreshAt(snapshot), nowMs),
    },
    snapshot: describeSnapshot(snapshot),
    storage: input.storage,
    recentActivity: recentActivity(snapshot, nowMs),
  };
}

function minutesSince(at: string | null | undefined, nowMs: number): number | null {
  if (at === null || at === undefined) return null;
  const then = Date.parse(at);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.round((nowMs - then) / 60_000));
}

function lastRefreshAt(snapshot: Snapshot | null): string | null {
  if (snapshot === null) return null;
  for (let index = snapshot.auditLog.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.auditLog[index];
    if (entry?.action === 'snapshot.refreshed') return entry.at;
  }
  return null;
}

function describeSnapshot(snapshot: Snapshot | null): DiagnosticReport['snapshot'] {
  const releasesByStatus = Object.fromEntries(
    RELEASE_STATUSES.map((status) => [status, 0]),
  ) as Record<ReleaseStatus, number>;

  if (snapshot === null) {
    return {
      present: false,
      schemaVersion: null,
      isDemoData: null,
      counts: {},
      releasesByStatus,
      itemsWithCoverage: 0,
      itemsWithWarnings: 0,
      itemsWithUnavailableDependencies: 0,
      itemsWithDependencyEdges: 0,
      approvalsByStatus: {},
      distinctMetadataTypes: 0,
    };
  }

  for (const release of snapshot.releases) releasesByStatus[release.status] += 1;

  const approvalsByStatus: Record<string, number> = {};
  for (const approval of snapshot.approvals) {
    approvalsByStatus[approval.status] = (approvalsByStatus[approval.status] ?? 0) + 1;
  }

  return {
    present: true,
    schemaVersion: snapshot.schemaVersion,
    isDemoData: snapshot.isDemoData,
    counts: {
      environments: snapshot.environments.length,
      releases: snapshot.releases.length,
      items: snapshot.items.length,
      approvals: snapshot.approvals.length,
      auditEntries: snapshot.auditLog.length,
      actorRoles: snapshot.actor.roles.length,
    },
    releasesByStatus,
    itemsWithCoverage: snapshot.items.filter((item) => item.testCoverage !== undefined).length,
    itemsWithWarnings: snapshot.items.filter((item) => item.warnings.length > 0).length,
    itemsWithUnavailableDependencies: snapshot.items.filter(
      (item) => item.dependenciesUnavailable === true,
    ).length,
    itemsWithDependencyEdges: snapshot.items.filter((item) => item.dependsOn.length > 0).length,
    approvalsByStatus,
    // The count, not the names: a custom metadata type name can be as
    // identifying as an org name.
    distinctMetadataTypes: new Set(snapshot.items.map((item) => item.type)).size,
  };
}

/** The last ten audit actions, as action names and ages. Never their detail. */
function recentActivity(
  snapshot: Snapshot | null,
  nowMs: number,
): readonly { action: string; minutesAgo: number }[] {
  if (snapshot === null) return [];
  return snapshot.auditLog.slice(-10).map((entry) => ({
    action: entry.action,
    minutesAgo: minutesSince(entry.at, nowMs) ?? 0,
  }));
}

/** `sf-releaselens-diagnostics-2026-09-08T13-25-54-000Z.json`. */
export function diagnosticsFilename(now: string): string {
  return `sf-releaselens-diagnostics-${now.replace(/[:.]/g, '-')}.json`;
}
