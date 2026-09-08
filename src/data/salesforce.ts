/**
 * The org-backed `DataSource`. docs/DATASOURCE.md §3, §5, §7, §8.
 *
 * Two rules shape this file:
 *
 *  1. **`load()` never touches the network.** It returns the cached snapshot
 *     from `chrome.storage.local`, so the panel opens instantly and keeps
 *     working offline. Only `refresh()` reaches the org, and only when a user
 *     asks. Nothing here polls or sets a timer.
 *  2. **`refresh()` merges; it does not replace.** Approvals, the audit log and
 *     the actor are local and survive every refresh untouched — connecting an
 *     org does not make approvals trustworthy, and it must not destroy them
 *     either. Releases are upserted by deploy id so a release that drops out of
 *     the recent-deploys window keeps its approvals rather than dangling.
 *
 * Honest gaps, carried into the data rather than papered over:
 *  - `dependsOn` is empty and `dependenciesUnavailable` is set, because a deploy
 *    report lists components, not edges.
 *  - `riskLevel` stays a human judgement; the org has no such field.
 *  - Release names come from a local overlay keyed by deploy id. With no overlay
 *    entry the deploy id is shown. A name is never invented.
 */

import type { Clock, IdFactory } from '../core/clock.js';
import {
  ApiLimitExhaustedError,
  OrgResponseInvalidError,
  SnapshotValidationError,
} from '../core/errors.js';
import {
  applyApprovalDecision,
  appendAudit,
  withActor,
  type DecisionCommand,
  type DecisionResult,
  type SnapshotDeps,
} from '../core/snapshot.js';
import {
  CURRENT_SCHEMA_VERSION,
  emptySnapshot,
  type Actor,
  type Environment,
  type MetadataItem,
  type Release,
  type RiskLevel,
  type Snapshot,
} from '../core/types.js';
import { parseSnapshot } from '../core/validate.js';
import type {
  ApexCoverageRow,
  DeployRequestRow,
  OrganizationRow,
  OrgConnection,
  OrgLimits,
} from './connection.js';
import { asRecord, optionalNumber, optionalString } from './connection.js';
import type { DataSource, SeedKind } from './datasource.js';
import type { StorageArea } from './storage.js';
import { itemFromDeployComponent, releaseStatusFromDeployStatus, warningFromDeployFailure } from './transfer.js';

/**
 * The org cache is a **separate key** from the local snapshot, so connecting an
 * org never destroys local or demo data, and disconnecting returns you to
 * exactly what you had.
 */
export const ORG_SNAPSHOT_KEY = 'sf-releaselens.org-snapshot.v1';
/** Deploy id → human name. See decision 5 in docs/DATASOURCE.md. */
export const RELEASE_OVERLAY_KEY = 'sf-releaselens.release-overlay.v1';

/** Refuse to refresh at or above this share of the daily API budget. */
export const API_LIMIT_REFUSE_RATIO = 0.95;

/** How many recent deploys a refresh pulls components for. */
export const DEFAULT_DEPLOY_LIMIT = 10;

/** A locally-held name for an org deploy. Nothing here comes from the org. */
export interface ReleaseOverlayEntry {
  name?: string;
  version?: string;
  ticketRefs?: readonly string[];
  riskLevel?: RiskLevel;
  notes?: string;
}

export type ReleaseOverlay = Readonly<Record<string, ReleaseOverlayEntry>>;

export interface SalesforceDataSourceDeps {
  /** `chrome.storage.local` — the cache, not the tokens. */
  storage: StorageArea;
  connection: OrgConnection;
  clock: Clock;
  newId: IdFactory;
  /** Shown as the environment's alias. Display only. */
  orgAlias?: string;
  /** Recent deploys to pull components for. Each costs one API call. */
  deployLimit?: number;
}

export function createSalesforceDataSource(deps: SalesforceDataSourceDeps): DataSource {
  const { storage, connection, clock, newId } = deps;
  const snapshotDeps: SnapshotDeps = { clock, newId };
  const deployLimit = deps.deployLimit ?? DEFAULT_DEPLOY_LIMIT;

  /** The cached snapshot, or an empty one when the org has never been read. */
  async function readCache(): Promise<Snapshot> {
    const raw = await storage.read(ORG_SNAPSHOT_KEY);
    if (raw === undefined) {
      // Deliberately NOT demo data: an org-connected panel showing invented
      // releases would be indistinguishable from a broken refresh.
      return emptySnapshot({ name: 'Local user', roles: ['release-manager'] });
    }
    return parseSnapshot(raw);
  }

  async function writeCache(snapshot: Snapshot): Promise<Snapshot> {
    await storage.write(ORG_SNAPSHOT_KEY, snapshot);
    return snapshot;
  }

  async function readOverlay(): Promise<ReleaseOverlay> {
    const raw = await storage.read(RELEASE_OVERLAY_KEY);
    const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
    return record as ReleaseOverlay;
  }

  return {
    load: readCache,
    exportSnapshot: readCache,

    readRaw() {
      return storage.read(ORG_SNAPSHOT_KEY);
    },

    async refresh(): Promise<Snapshot> {
      const cached = await readCache();
      const overlay = await readOverlay();

      // The budget guard runs first and cheapest. Refusing is the point: the
      // call we are about to make could be the one that breaks a production
      // integration, so we do not "try anyway".
      await assertBudgetAvailable(connection);

      const organization = await fetchOrganization(connection);
      const environment = toEnvironment(organization, deps.orgAlias ?? 'connected org');

      const deploys = await fetchRecentDeploys(connection, deployLimit);
      const releases: Release[] = [];
      const items: MetadataItem[] = [];

      for (const deploy of deploys) {
        const detailed = await fetchDeployDetail(connection, deploy.Id);
        releases.push(toRelease(detailed, environment.id, overlay[detailed.Id]));
        items.push(...toItems(detailed, snapshotDeps));
      }

      applyCoverage(items, await fetchCoverage(connection));

      const merged = mergeIntoCache(cached, { environment, releases, items });
      const audited = appendAudit(
        merged,
        {
          action: 'snapshot.refreshed',
          detail:
            `Refreshed from ${environment.name}: ${releases.length} deployment(s), ` +
            `${items.length} component(s). Dependencies are not available from a deploy report.`,
        },
        snapshotDeps,
      );

      // Round-trips through the same validator as stored data, so a mapping bug
      // is caught here rather than surfacing as a corrupt cache later.
      return writeCache(validateMapping(audited));
    },

    async decide(command: DecisionCommand): Promise<DecisionResult> {
      // Approvals are local (decision 2). The org is never told, and never asked.
      const current = await readCache();
      const result = applyApprovalDecision(current, command, snapshotDeps);
      await writeCache(result.snapshot);
      return result;
    },

    async importSnapshot(raw: unknown): Promise<Snapshot> {
      const parsed = parseSnapshot(raw);
      return writeCache(
        appendAudit(
          { ...parsed, isDemoData: false },
          {
            action: 'snapshot.imported',
            detail: `Imported ${parsed.releases.length} release(s) over the org cache`,
          },
          snapshotDeps,
        ),
      );
    },

    async reset(kind: SeedKind): Promise<Snapshot> {
      // `demo` is meaningless against an org: seeding invented releases into a
      // connected panel is exactly the confusion this build avoids. Both kinds
      // clear the cache; the next refresh repopulates it from the org.
      void kind;
      const actor = (await readCache()).actor;
      return writeCache(
        appendAudit(
          emptySnapshot(actor),
          { action: 'snapshot.reset', detail: 'Cleared the org cache. Refresh to repopulate it.' },
          snapshotDeps,
        ),
      );
    },

    async setActor(actor: Actor): Promise<Snapshot> {
      return writeCache(withActor(await readCache(), actor));
    },
  };
}

// --- Fetching ----------------------------------------------------------------

async function assertBudgetAvailable(connection: OrgConnection): Promise<void> {
  const limits = await connection.get<OrgLimits>(
    `/services/data/v${connection.apiVersion}/limits`,
  );
  const daily = limits['DailyApiRequests'];
  // A missing limits entry is not treated as "fine": we simply cannot tell, and
  // refusing on a guess would block every refresh. Proceed, and let the request
  // itself fail if the budget really is gone.
  if (daily === undefined) return;

  const used = daily.Max - daily.Remaining;
  if (daily.Max > 0 && used / daily.Max >= API_LIMIT_REFUSE_RATIO) {
    throw new ApiLimitExhaustedError(used, daily.Max);
  }
}

async function fetchOrganization(connection: OrgConnection): Promise<OrganizationRow> {
  const soql =
    'SELECT Id, Name, IsSandbox, TrialExpirationDate, OrganizationType, InstanceName FROM Organization LIMIT 1';
  const page = await connection.get<{ records?: unknown }>(
    `/services/data/v${connection.apiVersion}/query`,
    { q: soql },
  );
  // `Array.isArray` narrows `unknown` to `any[]`, so the element type is
  // restated as `unknown` rather than inherited as `any`.
  const records: unknown[] = Array.isArray(page.records) ? (page.records as unknown[]) : [];
  const row = records[0];
  if (row === undefined) {
    throw new OrgResponseInvalidError(
      'Organization',
      'the org returned no Organization row, so it could not be identified',
    );
  }
  const record = asRecord(row, 'Organization');
  const id = optionalString(record['Id']);
  if (id === undefined) {
    throw new OrgResponseInvalidError('Organization.Id', 'expected a non-empty string');
  }
  return {
    Id: id,
    IsSandbox: record['IsSandbox'] === true,
    TrialExpirationDate: optionalString(record['TrialExpirationDate']) ?? null,
    OrganizationType: optionalString(record['OrganizationType']) ?? null,
    InstanceName: optionalString(record['InstanceName']) ?? null,
    Name: optionalString(record['Name']) ?? null,
  };
}

async function fetchRecentDeploys(
  connection: OrgConnection,
  limit: number,
): Promise<DeployRequestRow[]> {
  const soql =
    'SELECT Id, Status, CheckOnly, CreatedDate, StartDate, CompletedDate, ' +
    'NumberComponentsTotal, NumberComponentErrors, NumberComponentsDeployed, TestLevel, CreatedBy.Name ' +
    `FROM DeployRequest ORDER BY CreatedDate DESC LIMIT ${Math.max(1, Math.trunc(limit))}`;
  const page = await connection.toolingQuery<DeployRequestRow>(soql);
  // A row with no Id cannot become a release; skip it rather than emitting a
  // release keyed by undefined.
  return page.records.filter((row) => typeof row.Id === 'string');
}

/**
 * A list query omits the details, so each deploy needs its own read. That is
 * one API call per release, which is why `deployLimit` exists and why refresh
 * is user-initiated.
 */
async function fetchDeployDetail(
  connection: OrgConnection,
  deployId: string,
): Promise<DeployRequestRow> {
  return connection.get<DeployRequestRow>(
    `/services/data/v${connection.apiVersion}/tooling/sobjects/DeployRequest/${deployId}`,
  );
}

async function fetchCoverage(connection: OrgConnection): Promise<Map<string, number>> {
  const soql =
    'SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate';
  const byName = new Map<string, number>();

  const page = await connection.toolingQuery<ApexCoverageRow>(soql);
  for (const row of page.records) {
    const name = optionalString(row.ApexClassOrTrigger?.Name);
    const covered = optionalNumber(row.NumLinesCovered) ?? 0;
    const uncovered = optionalNumber(row.NumLinesUncovered) ?? 0;
    const total = covered + uncovered;
    // Zero lines means coverage is genuinely unknown, not 0%. Same rule as
    // everywhere else in this codebase: unknown and zero are different answers.
    if (name === undefined || total === 0) continue;
    byName.set(name, covered / total);
  }
  return byName;
}

// --- Mapping -----------------------------------------------------------------

function toEnvironment(organization: OrganizationRow, alias: string): Environment {
  // Same rule as DESIGN §8.2: a Developer Edition org has IsSandbox false but a
  // trial date, and calling that production would be wrong.
  const isProduction = !organization.IsSandbox && organization.TrialExpirationDate === null;
  return {
    id: organization.Id,
    name: organization.Name ?? organization.InstanceName ?? organization.Id,
    kind: isProduction ? 'production' : 'sandbox',
    orgAlias: alias,
  };
}

function toRelease(
  deploy: DeployRequestRow,
  environmentId: string,
  overlay: ReleaseOverlayEntry | undefined,
): Release {
  const createdAt = optionalString(deploy.CreatedDate) ?? new Date(0).toISOString();
  const updatedAt =
    optionalString(deploy.CompletedDate) ?? optionalString(deploy.StartDate) ?? createdAt;
  const errors = optionalNumber(deploy.NumberComponentErrors) ?? 0;

  const notes =
    overlay?.notes ??
    `Read from the org's deploy history. Dependencies are not available from a deploy ` +
      `report, and risk level is a local judgement rather than an org field.` +
      (overlay === undefined
        ? ' No local name is set for this deploy, so its id is shown.'
        : '');

  return {
    id: deploy.Id,
    // Never invent a name. With no overlay entry the deploy id is the name.
    name: overlay?.name ?? deploy.Id,
    version: overlay?.version ?? deploy.Id,
    status: releaseStatusFromDeployStatus(
      optionalString(deploy.Status),
      deploy.CheckOnly === true,
    ),
    targetEnvironmentId: environmentId,
    owner: optionalString(deploy.CreatedBy?.Name) ?? 'unknown',
    createdAt,
    updatedAt,
    ticketRefs: overlay?.ticketRefs ?? [],
    // The org has no risk field. Default by outcome, and let a human override
    // it through the overlay.
    riskLevel: overlay?.riskLevel ?? (errors > 0 ? 'high' : 'medium'),
    notes,
  };
}

function toItems(deploy: DeployRequestRow, deps: SnapshotDeps): MetadataItem[] {
  const details = deploy.DeployResult?.details;
  const fallbackDate =
    optionalString(deploy.CompletedDate) ?? optionalString(deploy.CreatedDate) ?? deps.clock.now();

  const successes = details?.componentSuccesses ?? [];
  const failures = details?.componentFailures ?? [];

  // `dependenciesUnavailable` is set by `itemFromDeployComponent`, because it is
  // a property of the deploy-report shape rather than of this transport.
  return [
    ...successes.map((entry) => itemFromDeployComponent(entry, deploy.Id, deps, fallbackDate, [])),
    ...failures.map((entry) =>
      itemFromDeployComponent(entry, deploy.Id, deps, fallbackDate, [warningFromDeployFailure(entry)]),
    ),
  ]
    // `package.xml` comes back as a component with an empty type; it is a
    // manifest, not metadata.
    .filter((item) => item.type.length > 0 && item.fullName.length > 0);
}

/**
 * Validates a snapshot this file just built from an org response.
 *
 * The check itself is `parseSnapshot`, deliberately — one validator, no second
 * implementation to drift. What differs is the error. A validation failure here
 * is a statement about the *org's* response, not about the user's stored data,
 * and `SnapshotValidationError` says "Snapshot is not valid at ...", which a
 * release manager reads as "my local data is corrupt". The panel then offers
 * them Reset to demo data, and they lose their local approvals to fix a problem
 * that was never theirs.
 *
 * Found by the property test in `salesforce.property.test.ts`: roughly one
 * fuzzed org response in six was mapped into something the validator rejected,
 * and every one of them reported the wrong culprit.
 */
function validateMapping(candidate: Snapshot): Snapshot {
  // Through JSON first: the validator's contract is over plain data, and this
  // is the same trip the snapshot makes into storage.
  const plain: unknown = JSON.parse(JSON.stringify(candidate));
  try {
    return parseSnapshot(plain);
  } catch (cause) {
    if (cause instanceof SnapshotValidationError) {
      throw new OrgResponseInvalidError(
        cause.path.replace(/^snapshot\./, 'DeployRequest -> '),
        `${cause.detail}. The org's deploy records could not be mapped onto a release snapshot, ` +
          'so nothing was changed. Your local data and approvals are untouched.',
      );
    }
    throw cause;
  }
}

function applyCoverage(items: MetadataItem[], coverage: ReadonlyMap<string, number>): void {
  for (const [index, item] of items.entries()) {
    const fraction = coverage.get(item.fullName);
    if (fraction === undefined) continue;
    items[index] = { ...item, testCoverage: fraction };
  }
}

// --- Merging -----------------------------------------------------------------

interface RefreshResult {
  environment: Environment;
  releases: readonly Release[];
  items: readonly MetadataItem[];
}

/**
 * Upserts the refreshed data into the cache.
 *
 * Releases are keyed by deploy id, which is stable, so a release that has
 * scrolled out of the recent-deploys window keeps its local approvals rather
 * than dangling and failing referential integrity. Items are replaced only for
 * the releases that were actually refreshed.
 */
export function mergeIntoCache(cached: Snapshot, fresh: RefreshResult): Snapshot {
  const refreshedIds = new Set(fresh.releases.map((release) => release.id));

  const releases = [
    ...fresh.releases,
    ...cached.releases.filter((release) => !refreshedIds.has(release.id)),
  ];

  const items = [
    ...fresh.items,
    ...cached.items.filter((item) => !refreshedIds.has(item.releaseId)),
  ];

  const environments = [
    fresh.environment,
    ...cached.environments.filter((environment) => environment.id !== fresh.environment.id),
  ];

  // Any release kept from the cache whose environment is gone would dangle;
  // retaining every known environment keeps the snapshot valid.
  const keptEnvironmentIds = new Set(environments.map((environment) => environment.id));
  const orphanedEnvironments = cached.environments.filter(
    (environment) => !keptEnvironmentIds.has(environment.id),
  );

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    // Local, and untouched by a refresh. Connecting an org does not make
    // approvals trustworthy, and must not destroy them either.
    actor: cached.actor,
    approvals: cached.approvals,
    auditLog: cached.auditLog,
    environments: [...environments, ...orphanedEnvironments],
    releases,
    items,
    isDemoData: false,
  };
}
