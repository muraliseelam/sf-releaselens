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
  OrgRequestFailedError,
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
  DeployMessageRow,
  DeployRequestDetailResponse,
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

      // Then the version check, before anything that depends on the shape of a
      // response. An org that no longer offers this API version fails every
      // later request with an unhelpful 404.
      const versions = await checkApiVersion(connection);

      const organization = await fetchOrganization(connection);
      const environment = toEnvironment(organization, deps.orgAlias ?? 'connected org');

      const deploys = await fetchRecentDeploys(connection, deployLimit);
      const releases: Release[] = [];
      const items: MetadataItem[] = [];

      for (const deploy of deploys) {
        const components = await fetchDeployComponents(connection, deploy.Id);
        releases.push(toRelease(deploy, environment.id, overlay[deploy.Id]));
        items.push(...toItems(deploy, components, snapshotDeps));
      }

      const coverage = await fetchCoverage(connection);
      applyCoverage(items, coverage.byName);

      const merged = mergeIntoCache(cached, { environment, releases, items });
      const audited = appendAudit(
        merged,
        {
          action: 'snapshot.refreshed',
          detail:
            `Refreshed from ${environment.name}: ${releases.length} deployment(s), ` +
            `${items.length} component(s). Dependencies are not available from a deploy report.` +
            // Both of these are degradations, so both are recorded. Silence
            // here is how a partial refresh passes for a complete one.
            (coverage.unavailable === undefined
              ? ''
              : ` Coverage is unavailable in this org (${coverage.unavailable}), so every ` +
                'component reports coverage unknown.') +
            (versions.drift === undefined ? '' : ` ${versions.drift}`),
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
  /*
   * `TestLevel` used to be selected here and never read. Measured across five
   * real orgs and twenty deploy records it was `null` every single time — the
   * Tooling row simply does not populate it — so asking for it bought nothing
   * and widened the query surface. Test counts, if they are ever wanted, are on
   * the Metadata API's deployResult, populated.
   */
  const soql =
    'SELECT Id, Status, CheckOnly, CreatedDate, StartDate, CompletedDate, ' +
    'NumberComponentsTotal, NumberComponentErrors, NumberComponentsDeployed, CreatedBy.Name ' +
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
/** What one deploy contributes to the snapshot beyond its list row. */
export interface DeployComponents {
  readonly successes: readonly DeployMessageRow[];
  readonly failures: readonly DeployMessageRow[];
  /** The deploy's author, which is the only author a component has. */
  readonly deployedBy: string | undefined;
}

/**
 * Fetches one deploy's component details.
 *
 * The endpoint matters. This used to read
 * `tooling/sobjects/DeployRequest/{id}` and take `DeployResult.details` off it
 * — but that record has no `DeployResult` field at all, in any of the five orgs
 * measured, so every org-sourced release came back with **zero components** and
 * the metadata inspector was permanently empty for org data. The Metadata REST
 * API is where the details live, and `includeDetails=true` is required: without
 * it the arrays are present and empty, which fails in exactly the same way
 * while looking healthier.
 */
async function fetchDeployComponents(
  connection: OrgConnection,
  deployId: string,
): Promise<DeployComponents> {
  const response = await connection.get<DeployRequestDetailResponse>(
    `/services/data/v${connection.apiVersion}/metadata/deployRequest/${deployId}`,
    { includeDetails: 'true' },
  );
  const details = response.deployResult?.details;
  return {
    // A single-component deploy comes back as an object rather than a
    // one-element array in some responses, so both are accepted.
    successes: toRows(details?.componentSuccesses),
    failures: toRows(details?.componentFailures),
    deployedBy: optionalString(response.deployResult?.createdByName),
  };
}

function toRows(value: DeployMessageRow[] | DeployMessageRow | null | undefined): DeployMessageRow[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * How far the pinned API version may fall behind the org before the refresh
 * says so. Salesforce ships three releases a year, so six versions is about two
 * years — long enough not to nag, short enough to notice before retirement.
 */
export const API_VERSION_DRIFT_THRESHOLD = 6;

export interface ApiVersionCheck {
  /** The newest version the org offers, e.g. `67.0`. */
  readonly latest: string | undefined;
  /** A sentence for the refresh's audit entry, or absent when in step. */
  readonly drift?: string;
}

/**
 * Confirms the org still offers the version this build pins, before anything
 * that depends on a response shape.
 *
 * The version is pinned rather than negotiated on purpose: the mapper is
 * written against one version's shapes, and following the org's latest would
 * mean the shapes could change underneath a user with no code change at all —
 * which is the failure a pin exists to prevent.
 *
 * What a pin cannot do is notice that it has gone stale. Salesforce retires old
 * versions, and the day this one goes every request starts failing with a bare
 * 404 that says nothing about why. So the version list is read once per refresh
 * — one small GET among a dozen — and two things are surfaced: the version
 * being gone at all, which refuses clearly, and the version being far behind,
 * which is recorded in the refresh entry rather than blocking anything.
 *
 * Measured: all five orgs tested report 67.0 and all still serve 62.0.
 */
async function checkApiVersion(connection: OrgConnection): Promise<ApiVersionCheck> {
  let offered: readonly { version?: string | null }[];
  try {
    offered = await connection.get<{ version?: string | null }[]>('/services/data/');
  } catch (cause) {
    // The version list is a nicety. Failing the refresh because it could not be
    // read would trade a real capability for a diagnostic.
    void cause;
    return { latest: undefined };
  }

  // `Array.isArray` widens to `any[]`, so the element type is restated rather
  // than inherited — the same reason `fetchOrganization` does it. Read
  // defensively rather than through `asRecord`, which throws: a malformed entry
  // in a list that only exists to produce a warning must not fail the refresh.
  const entries: readonly unknown[] = Array.isArray(offered) ? offered : [];
  const versions = entries
    .map((entry) =>
      typeof entry === 'object' && entry !== null
        ? optionalString((entry as { version?: unknown }).version)
        : undefined,
    )
    .filter((version): version is string => version !== undefined);

  if (versions.length === 0) return { latest: undefined };

  const pinned = connection.apiVersion;
  const latest = versions.reduce((a, b) => (Number(a) >= Number(b) ? a : b));

  if (!versions.includes(pinned)) {
    throw new OrgResponseInvalidError(
      'apiVersion',
      `this build talks Salesforce API v${pinned}, which this org no longer offers ` +
        `(its versions run up to v${latest}). The extension needs updating; nothing was changed.`,
    );
  }

  const behind = Math.round(Number(latest) - Number(pinned));
  if (Number.isFinite(behind) && behind >= API_VERSION_DRIFT_THRESHOLD) {
    return {
      latest,
      drift:
        `This build talks API v${pinned} and the org offers up to v${latest}; ` +
        'fields added since then are not read.',
    };
  }
  return { latest };
}

export interface CoverageResult {
  readonly byName: ReadonlyMap<string, number>;
  /** Set when the org would not answer, with the reason. Absent on success. */
  readonly unavailable?: string;
}

/**
 * Coverage, or an explanation of why there is none.
 *
 * `ApexCodeCoverageAggregate` is not available in every org — one of the five
 * measured rejects it outright with `INVALID_TYPE: sObject type
 * 'ApexCodeCoverageAggregate' is not supported`. This used to let that error
 * escape, which failed the entire refresh: an org would show no releases at all
 * because a *supplementary* field could not be read.
 *
 * So this one degradation is allowed — and it is recorded rather than
 * swallowed. Coverage is optional in the model and renders as "Coverage
 * unknown", never as 0%, so the result is honest on screen; the reason lands in
 * the refresh's audit entry so it is honest in the record too. Failures that
 * are *not* about this object — an expired token, an unreachable org — are
 * rethrown, because those are not "no coverage", they are "no refresh".
 */
async function fetchCoverage(connection: OrgConnection): Promise<CoverageResult> {
  const soql =
    'SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate';
  const byName = new Map<string, number>();

  let page;
  try {
    page = await connection.toolingQuery<ApexCoverageRow>(soql);
  } catch (cause) {
    const reason = coverageUnavailableReason(cause);
    if (reason === undefined) throw cause;
    return { byName, unavailable: reason };
  }
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
  return { byName };
}

/**
 * Whether a failure means "this org cannot answer for coverage" rather than
 * "this org cannot answer".
 *
 * Deliberately narrow: only a request the org itself rejected as a bad request
 * about this object. Anything else — auth, network, a 500 — is a real failure
 * of the refresh and must not be mistaken for an org without coverage data.
 */
function coverageUnavailableReason(cause: unknown): string | undefined {
  if (!(cause instanceof OrgRequestFailedError)) return undefined;
  if (cause.status !== 400 && cause.status !== 403) return undefined;
  const detail = `${cause.errorCode} ${cause.message}`;
  if (!/ApexCodeCoverageAggregate|INVALID_TYPE|INSUFFICIENT_ACCESS/i.test(detail)) return undefined;
  return cause.errorCode === '' ? `HTTP ${cause.status}` : cause.errorCode;
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

function toItems(
  deploy: DeployRequestRow,
  components: DeployComponents,
  deps: SnapshotDeps,
): MetadataItem[] {
  const fallbackDate =
    optionalString(deploy.CompletedDate) ?? optionalString(deploy.CreatedDate) ?? deps.clock.now();
  // The deploy's author, since a component has none. The list row's
  // `CreatedBy.Name` is the same person and is the fallback when the Metadata
  // API omits it.
  const deployedBy = components.deployedBy ?? optionalString(deploy.CreatedBy?.Name);

  // `dependenciesUnavailable` is set by `itemFromDeployComponent`, because it is
  // a property of the deploy-report shape rather than of this transport.
  return [
    ...components.successes.map((entry) =>
      itemFromDeployComponent(entry, deploy.Id, deps, fallbackDate, [], deployedBy),
    ),
    ...components.failures.map((entry) =>
      itemFromDeployComponent(
        entry,
        deploy.Id,
        deps,
        fallbackDate,
        [warningFromDeployFailure(entry)],
        deployedBy,
      ),
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
