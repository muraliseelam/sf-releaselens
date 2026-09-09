/**
 * The org-backed DataSource. docs/DATASOURCE.md §3, §5, §7, §8.
 *
 * Every test drives `FakeOrgConnection`. There is no live org anywhere in this
 * suite, and the two rules that matter most are asserted directly: `load()`
 * makes no request at all, and `refresh()` never destroys local approvals.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createFixedClock, createSequentialIdFactory } from '../../src/core/clock.js';
import {
  ApiLimitExhaustedError,
  OrgAuthExpiredError,
  OrgRequestFailedError,
  OrgResponseInvalidError,
} from '../../src/core/errors.js';
import type { DataSource } from '../../src/data/datasource.js';
import {
  API_LIMIT_REFUSE_RATIO,
  DEFAULT_DEPLOY_LIMIT,
  MAX_DEPLOY_LIMIT,
  ORG_SNAPSHOT_KEY,
  clampDeployLimit,
  RELEASE_OVERLAY_KEY,
  createSalesforceDataSource,
} from '../../src/data/salesforce.js';
import { createMemoryStorageArea, type StorageArea } from '../../src/data/storage.js';
import { fakeOrgConnection, type FakeConnectionOptions } from '../fixtures/fakeConnection.js';
import {
  API_VERSIONS,
  API_VERSIONS_WITHOUT_PINNED,
  COVERAGE_ROWS,
  DEPLOY_EMPTY_DETAIL,
  DEPLOY_FAILED,
  DEPLOY_FAILED_DETAIL,
  DEPLOY_SUCCEEDED,
  DEPLOY_SUCCEEDED_DETAIL,
  DEPLOY_VALIDATED,
  DEPLOY_VALIDATED_DETAIL,
  DEVELOPER_ORG,
  EXHAUSTED_LIMITS,
  HEALTHY_LIMITS,
  PRODUCTION_ORG,
  SANDBOX_ORG,
  queryResponse,
} from '../fixtures/salesforce.js';
import { makeApproval, makeRelease, makeSnapshot } from '../fixtures/snapshot.js';

const FIXED_NOW = '2026-09-07T09:00:00.000Z';
const API = '/services/data/v62.0';

/** Wires the fake connection with the four calls a refresh makes. */
function connectionFor(
  options: {
    org?: typeof SANDBOX_ORG;
    deploys?: unknown[];
    details?: Record<string, unknown>;
    limits?: unknown;
    coverage?: unknown[];
    versions?: unknown;
  } = {},
): FakeConnectionOptions {
  const deploys = options.deploys ?? [DEPLOY_SUCCEEDED];
  const details = options.details ?? { [DEPLOY_SUCCEEDED.Id]: DEPLOY_SUCCEEDED_DETAIL };

  return {
    getResponses: {
      // The version list is read once per refresh, before anything that
      // depends on a response shape.
      '/services/data/': options.versions ?? API_VERSIONS,
      [`${API}/limits`]: options.limits ?? HEALTHY_LIMITS,
      [`${API}/query`]: queryResponse([options.org ?? SANDBOX_ORG]),
      // Component details come from the Metadata REST API, not the Tooling
      // record — see the note in test/fixtures/salesforce.ts.
      ...Object.fromEntries(
        Object.entries(details).map(([id, detail]) => [
          `${API}/metadata/deployRequest/${id}`,
          detail,
        ]),
      ),
    },
    queryResponses: [
      // Before the list, because the matcher takes the first substring hit and
      // `SELECT COUNT() FROM DeployRequest` contains `FROM DeployRequest` too.
      {
        match: 'COUNT() FROM DeployRequest',
        response: { totalSize: deploys.length, records: [], done: true },
      },
      { match: 'FROM DeployRequest', response: queryResponse(deploys) },
      {
        match: 'FROM ApexCodeCoverageAggregate',
        response: queryResponse(options.coverage ?? COVERAGE_ROWS),
      },
    ],
  };
}

function build(connectionOptions: FakeConnectionOptions = connectionFor(), storage?: StorageArea) {
  const area = storage ?? createMemoryStorageArea();
  const connection = fakeOrgConnection(connectionOptions);
  const dataSource: DataSource = createSalesforceDataSource({
    storage: area,
    connection,
    clock: createFixedClock(FIXED_NOW),
    newId: createSequentialIdFactory('org'),
    orgAlias: 'uat',
  });
  return { dataSource, connection, storage: area };
}

describe('load() never touches the network', () => {
  it('makes no request at all', async () => {
    const { dataSource, connection } = build();

    await dataSource.load();

    // The single most important property of this data source: the panel opens
    // instantly and works offline.
    expect(connection.requestCount()).toBe(0);
  });

  it('returns an empty snapshot before the first refresh, never demo data', async () => {
    // Invented releases in a connected panel would be indistinguishable from a
    // broken refresh.
    const { dataSource } = build();

    const snapshot = await dataSource.load();

    expect(snapshot.releases).toEqual([]);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.isDemoData).toBe(false);
  });

  it('returns the cached snapshot once refreshed, still without a request', async () => {
    const { dataSource, connection } = build();
    await dataSource.refresh();
    const before = connection.requestCount();

    const snapshot = await dataSource.load();

    expect(snapshot.releases).toHaveLength(1);
    expect(connection.requestCount()).toBe(before);
  });

  it('reads and writes a key separate from the local snapshot', async () => {
    // Connecting an org must never destroy local or demo data.
    const { dataSource, storage } = build();
    await dataSource.refresh();

    expect(await storage.read(ORG_SNAPSHOT_KEY)).toBeDefined();
    expect(await storage.read('sf-releaselens.snapshot.v1')).toBeUndefined();
  });
});

describe('refresh() maps the org', () => {
  it('produces a release per deploy, with the org as the environment', async () => {
    const { dataSource } = build();

    const snapshot = await dataSource.refresh();

    expect(snapshot.releases).toHaveLength(1);
    expect(snapshot.environments).toEqual([
      { id: SANDBOX_ORG.Id, name: 'Acme UAT', kind: 'sandbox', orgAlias: 'uat' },
    ]);
    expect(snapshot.releases[0]!.targetEnvironmentId).toBe(SANDBOX_ORG.Id);
  });

  it('uses the deploy id as the release id, so approvals survive a refresh', async () => {
    const { dataSource } = build();

    expect((await dataSource.refresh()).releases[0]!.id).toBe(DEPLOY_SUCCEEDED.Id);
  });

  it('maps components, dropping the package.xml pseudo-component', async () => {
    const { dataSource } = build();

    const snapshot = await dataSource.refresh();

    expect(snapshot.items.map((item) => item.fullName).sort()).toEqual([
      'InvoiceBuilder',
      'Invoice__c.UsageTotal__c',
    ]);
  });

  it('maps a component failure to an error warning', async () => {
    const { dataSource } = build(
      connectionFor({
        deploys: [DEPLOY_FAILED],
        details: { [DEPLOY_FAILED.Id]: DEPLOY_FAILED_DETAIL },
      }),
    );

    const snapshot = await dataSource.refresh();
    const failed = snapshot.items.find((item) => item.fullName === 'LegacyTaxCalculator')!;

    expect(failed.operation).toBe('delete');
    // `DEPLOY_FAILURE`, not `ERROR`. The hand-written fixture used to set
    // `problemType: 'Error'` and this asserted that it was read; every real
    // failure across four orgs has `problemType: null` and the text in
    // `problem`, so the code is derived rather than read.
    expect(failed.warnings[0]).toMatchObject({
      code: 'DEPLOY_FAILURE',
      severity: 'error',
      message: 'Dependent class is invalid and needs recompilation.',
    });
  });

  it('maps a check-only success to validated, and flags it as check-only', async () => {
    const { dataSource } = build(
      connectionFor({
        deploys: [DEPLOY_VALIDATED],
        details: { [DEPLOY_VALIDATED.Id]: DEPLOY_VALIDATED_DETAIL },
      }),
    );

    const release = (await dataSource.refresh()).releases[0]!;

    /*
     * This asserted `scheduled` until a real org proved how wrong that was: a
     * passing validation sat on the dashboard under "Scheduled", telling a
     * release manager a deploy was queued when none had been requested.
     * Salesforce has no scheduled-deploy concept here at all.
     */
    expect(release.status).toBe('validated');
    expect(release.checkOnly).toBe(true);
    expect(release.notes).toContain('deployed nothing');
  });

  it('flags a check-only run that failed, without calling it validated', async () => {
    const failedValidation = { ...DEPLOY_FAILED, CheckOnly: true };
    const { dataSource } = build(
      connectionFor({
        deploys: [failedValidation],
        details: { [failedValidation.Id]: DEPLOY_FAILED_DETAIL },
      }),
    );

    const release = (await dataSource.refresh()).releases[0]!;

    // What happened is that it failed. That it deployed nothing is a separate
    // fact, and folding them together would lose whichever one mattered.
    expect(release.status).toBe('failed');
    expect(release.checkOnly).toBe(true);
  });

  it('treats a Developer Edition org as a sandbox, not production', async () => {
    // IsSandbox is false for a DE org; calling it production would gate every
    // scratch org. Same rule as DESIGN §8.2.
    const { dataSource } = build(connectionFor({ org: DEVELOPER_ORG }));

    expect((await dataSource.refresh()).environments[0]!.kind).toBe('sandbox');
  });

  it('treats a real production org as production', async () => {
    const { dataSource } = build(connectionFor({ org: PRODUCTION_ORG }));

    expect((await dataSource.refresh()).environments[0]!.kind).toBe('production');
  });
});

describe('what a real org actually returns', () => {
  /*
   * Every test in this block corrects something the hand-written fixtures got
   * wrong. They were found by running the shipping code against five live orgs
   * — see docs/ORG-COMPATIBILITY.md — not by reading it.
   */

  it('reads component details from the Metadata API, not the Tooling record', async () => {
    const { dataSource, connection } = build();

    await dataSource.refresh();

    const paths = connection.calls.filter((call) => call.kind === 'get').map((call) => call.argument);
    // The Tooling record has no DeployResult field at all, in any org measured.
    // Reading details from it produced zero components every time.
    expect(paths).toContain(`${API}/metadata/deployRequest/${DEPLOY_SUCCEEDED.Id}`);
    expect(paths.some((path) => path.includes('tooling/sobjects/DeployRequest'))).toBe(false);
  });

  it('attributes a component to whoever ran the deploy', async () => {
    const { dataSource } = build();

    const snapshot = await dataSource.refresh();

    // A component carries no author in either the Metadata API or the CLI's
    // report. Reading one off the component — which this used to do — made
    // every org-sourced component say "unknown".
    expect(snapshot.items.every((item) => item.lastModifiedBy === 'Lin Zhou')).toBe(true);
    expect(snapshot.items.some((item) => item.lastModifiedBy === 'unknown')).toBe(false);
  });

  it('renders an org with no deploy history as empty, not as an error', async () => {
    const { dataSource } = build(connectionFor({ deploys: [], details: {} }));

    const snapshot = await dataSource.refresh();

    expect(snapshot.releases).toEqual([]);
    expect(snapshot.items).toEqual([]);
    // Two of the five orgs measured have never had a deploy. An empty snapshot
    // is the correct answer, and it must still be a valid one.
    expect(snapshot.environments).toHaveLength(1);
    expect(snapshot.isDemoData).toBe(false);
  });

  it('survives a deploy whose details came back with no components', async () => {
    const { dataSource } = build(
      connectionFor({
        deploys: [DEPLOY_VALIDATED],
        details: { [DEPLOY_VALIDATED.Id]: DEPLOY_EMPTY_DETAIL },
      }),
    );

    const snapshot = await dataSource.refresh();

    expect(snapshot.releases).toHaveLength(1);
    expect(snapshot.items).toEqual([]);
  });
});

describe('the deploy window is never silently truncated', () => {
  /**
   * A release dashboard showing the ten most recent of twelve deployments, with
   * nothing saying so, is wrong rather than incomplete — the two it hid
   * included a failure. Found against a real org.
   */
  function orgWith(deployCount: number, limit?: number) {
    const deploys = Array.from({ length: Math.min(deployCount, limit ?? DEFAULT_DEPLOY_LIMIT) }, (_, index) => ({
      ...DEPLOY_SUCCEEDED,
      Id: `0Af5f0000000${String(index).padStart(3, '0')}`,
    }));
    const base = connectionFor({ deploys, details: {} });
    return {
      ...base,
      getResponses: {
        ...base.getResponses,
        ...Object.fromEntries(
          deploys.map((deploy) => [
            `${API}/metadata/deployRequest/${deploy.Id}`,
            { id: deploy.Id, deployResult: { details: {} } },
          ]),
        ),
      },
      queryResponses: [
        { match: 'COUNT() FROM DeployRequest', response: { totalSize: deployCount, records: [], done: true } },
        { match: 'FROM DeployRequest', response: queryResponse(deploys) },
        { match: 'FROM ApexCodeCoverageAggregate', response: queryResponse([]) },
      ],
    };
  }

  it('records how many of how many deployments it read', async () => {
    const { dataSource } = build(orgWith(12));

    const snapshot = await dataSource.refresh();

    expect(snapshot.deployWindow).toEqual({ shown: 10, total: 12, limit: 10 });
  });

  it('says so in the refresh entry as well as in the snapshot', async () => {
    const { dataSource } = build(orgWith(12));

    const snapshot = await dataSource.refresh();

    expect(snapshot.auditLog.at(-1)?.detail).toContain('of 12 deployment(s) in the org');
  });

  it('claims no truncation when it read everything', async () => {
    const { dataSource } = build(orgWith(3));

    const snapshot = await dataSource.refresh();

    expect(snapshot.deployWindow).toEqual({ shown: 3, total: 3, limit: 10 });
    expect(snapshot.auditLog.at(-1)?.detail).not.toContain('in the org');
  });

  it('honours a widened limit', async () => {
    const storage = createMemoryStorageArea();
    const connection = fakeOrgConnection(orgWith(12, 12));
    const dataSource = createSalesforceDataSource({
      storage,
      connection,
      clock: createFixedClock(FIXED_NOW),
      newId: createSequentialIdFactory('org'),
      orgAlias: 'uat',
      deployLimit: 12,
    });

    const snapshot = await dataSource.refresh();

    expect(snapshot.deployWindow).toEqual({ shown: 12, total: 12, limit: 12 });
  });

  it('refuses to read more than the ceiling, however it is asked', async () => {
    const storage = createMemoryStorageArea();
    const dataSource = createSalesforceDataSource({
      storage,
      connection: fakeOrgConnection(orgWith(12, 12)),
      clock: createFixedClock(FIXED_NOW),
      newId: createSequentialIdFactory('org'),
      deployLimit: 10_000,
    });

    // The budget guard refuses near the daily limit; this is the ceiling that
    // stops somebody reaching it by pressing a button repeatedly.
    expect((await dataSource.refresh()).deployWindow?.limit).toBe(MAX_DEPLOY_LIMIT);
  });

  it('degrades to what it read when the count query fails', async () => {
    const base = orgWith(3);
    const { dataSource } = build({
      ...base,
      queryResponses: [
        { match: 'COUNT() FROM DeployRequest', reject: new OrgRequestFailedError(400, 'MALFORMED_QUERY', 'no') },
        ...base.queryResponses.filter((entry) => !entry.match.startsWith('COUNT()')),
      ],
    });

    // Not knowing the total is a worse dashboard, not a broken one.
    const snapshot = await dataSource.refresh();

    expect(snapshot.deployWindow).toEqual({ shown: 3, total: 3, limit: 10 });
  });
});

describe('clampDeployLimit', () => {
  it('defaults, floors and caps', () => {
    expect(clampDeployLimit(undefined)).toBe(DEFAULT_DEPLOY_LIMIT);
    expect(clampDeployLimit(Number.NaN)).toBe(DEFAULT_DEPLOY_LIMIT);
    expect(clampDeployLimit(0)).toBe(1);
    expect(clampDeployLimit(-5)).toBe(1);
    expect(clampDeployLimit(12.7)).toBe(12);
    expect(clampDeployLimit(10_000)).toBe(MAX_DEPLOY_LIMIT);
  });
});

describe('coverage that the org will not answer for', () => {
  /**
   * One of the five orgs rejects `ApexCodeCoverageAggregate` outright:
   * `INVALID_TYPE: sObject type 'ApexCodeCoverageAggregate' is not supported`.
   * That used to fail the whole refresh, so the org showed no releases at all
   * because a supplementary field could not be read.
   */
  const unsupported = () => ({
    ...connectionFor(),
    queryResponses: [
      { match: 'FROM DeployRequest', response: queryResponse([DEPLOY_SUCCEEDED]) },
    ],
    failures: {
      toolingQuery: undefined,
    },
  });

  function coverageRejecting(): FakeConnectionOptions {
    const base = connectionFor();
    return {
      ...base,
      queryResponses: [
        { match: 'FROM DeployRequest', response: queryResponse([DEPLOY_SUCCEEDED]) },
        {
          match: 'FROM ApexCodeCoverageAggregate',
          reject: new OrgRequestFailedError(
            400,
            'INVALID_TYPE',
            "sObject type 'ApexCodeCoverageAggregate' is not supported.",
          ),
        },
      ],
    };
  }

  it('still produces the releases', async () => {
    const { dataSource } = build(coverageRejecting());

    const snapshot = await dataSource.refresh();

    expect(snapshot.releases).toHaveLength(1);
    expect(snapshot.items.length).toBeGreaterThan(0);
  });

  it('leaves coverage unknown rather than reporting zero', async () => {
    const { dataSource } = build(coverageRejecting());

    const snapshot = await dataSource.refresh();

    expect(snapshot.items.every((item) => item.testCoverage === undefined)).toBe(true);
  });

  it('records why, so the degradation is not silent', async () => {
    const { dataSource } = build(coverageRejecting());

    const snapshot = await dataSource.refresh();
    const entry = snapshot.auditLog.at(-1);

    expect(entry?.detail).toContain('Coverage is unavailable in this org');
    expect(entry?.detail).toContain('INVALID_TYPE');
  });

  it('does not mistake an auth failure for an org without coverage', async () => {
    const base = connectionFor();
    const { dataSource } = build({
      ...base,
      queryResponses: [
        { match: 'FROM DeployRequest', response: queryResponse([DEPLOY_SUCCEEDED]) },
        {
          match: 'FROM ApexCodeCoverageAggregate',
          reject: new OrgAuthExpiredError('the session expired'),
        },
      ],
    });

    // "No coverage" and "no session" are different answers, and only the first
    // is allowed to degrade.
    await expect(dataSource.refresh()).rejects.toBeInstanceOf(OrgAuthExpiredError);
  });

  void unsupported;
});

describe('the pinned API version', () => {
  it('refuses clearly when the org no longer offers it', async () => {
    const { dataSource } = build(connectionFor({ versions: API_VERSIONS_WITHOUT_PINNED }));

    // Otherwise every later request fails with a bare 404 that says nothing.
    await expect(dataSource.refresh()).rejects.toBeInstanceOf(OrgResponseInvalidError);
    await expect(dataSource.refresh()).rejects.toThrow(/no longer offers/);
    await expect(dataSource.refresh()).rejects.toThrow(/needs updating/);
  });

  it('records drift when the org has moved a long way ahead', async () => {
    const { dataSource } = build(connectionFor());

    const snapshot = await dataSource.refresh();

    // 62.0 pinned against an org offering 67.0: five versions, under the
    // threshold, so nothing is said.
    expect(snapshot.auditLog.at(-1)?.detail).not.toContain('fields added since then');

    const far = build(
      connectionFor({
        versions: [
          { label: "Winter '25", url: '/services/data/v62.0', version: '62.0' },
          { label: "Winter '28", url: '/services/data/v70.0', version: '70.0' },
        ],
      }),
    );
    const drifted = await far.dataSource.refresh();

    expect(drifted.auditLog.at(-1)?.detail).toContain('v70.0');
    expect(drifted.auditLog.at(-1)?.detail).toContain('fields added since then');
  });

  it('refreshes anyway when the version list cannot be read', async () => {
    const base = connectionFor();
    const { dataSource } = build({
      ...base,
      getResponses: Object.fromEntries(
        Object.entries(base.getResponses ?? {}).filter(([path]) => path !== '/services/data/'),
      ),
    });

    // The list is a diagnostic. Failing the refresh because a nicety could not
    // be read would trade a capability for a warning.
    await expect(dataSource.refresh()).resolves.toBeDefined();
  });
});

describe('a mapping failure blames the org, not the stored snapshot', () => {
  /**
   * The panel offers "Reset to demo data" beside a snapshot-validation error,
   * because that error normally means the local store is corrupt. If a bad org
   * response produced the same error, a release manager would reset — and lose
   * their local approvals — over a problem that arrived down the wire.
   *
   * Two `DeployRequest` rows with the same Id is the reachable version of this:
   * a query that pages can overlap, and the mapper keys releases by deploy id.
   */
  const duplicated = () =>
    connectionFor({
      deploys: [DEPLOY_SUCCEEDED, DEPLOY_SUCCEEDED],
      details: { [DEPLOY_SUCCEEDED.Id]: DEPLOY_SUCCEEDED_DETAIL },
    });

  it('reports ORG_RESPONSE_INVALID rather than SNAPSHOT_VALIDATION', async () => {
    const { dataSource } = build(duplicated());

    await expect(dataSource.refresh()).rejects.toBeInstanceOf(OrgResponseInvalidError);
  });

  it('says the local data is untouched, because it is', async () => {
    const { dataSource, storage } = build(duplicated());

    await expect(dataSource.refresh()).rejects.toThrow(/local data and approvals are untouched/);
    // Not merely claimed — nothing was written.
    expect(await storage.read(ORG_SNAPSHOT_KEY)).toBeUndefined();
  });

  it('keeps the failing field in the message, so the cause is still findable', async () => {
    const { dataSource } = build(duplicated());

    await expect(dataSource.refresh()).rejects.toThrow(/DeployRequest -> releases/);
    await expect(dataSource.refresh()).rejects.toThrow(/duplicate id/);
  });
});

describe('honest gaps', () => {
  it('marks every org item as having unavailable dependencies', async () => {
    // An empty dependsOn here means "unknown", not "none" — the inspector must
    // not tell a reader the component is safe to change.
    const { dataSource } = build();

    const snapshot = await dataSource.refresh();

    expect(snapshot.items.length).toBeGreaterThan(0);
    for (const item of snapshot.items) {
      expect(item.dependsOn).toEqual([]);
      expect(item.dependenciesUnavailable).toBe(true);
    }
  });

  it('says in the release notes that dependencies and risk are not org data', async () => {
    const { dataSource } = build();

    expect((await dataSource.refresh()).releases[0]!.notes).toMatch(
      /Dependencies are not available.*risk level is a local judgement/s,
    );
  });

  it('invents no approvals', async () => {
    const { dataSource } = build();

    expect((await dataSource.refresh()).approvals).toEqual([]);
  });
});

describe('release naming (decision 5)', () => {
  it('shows the deploy id when no local overlay entry exists', async () => {
    const { dataSource } = build();

    const release = (await dataSource.refresh()).releases[0]!;

    expect(release.name).toBe(DEPLOY_SUCCEEDED.Id);
    expect(release.version).toBe(DEPLOY_SUCCEEDED.Id);
    expect(release.notes).toContain('No local name is set');
  });

  it('applies a local overlay keyed by deploy id', async () => {
    const storage = createMemoryStorageArea();
    await storage.write(RELEASE_OVERLAY_KEY, {
      [DEPLOY_SUCCEEDED.Id]: {
        name: 'Q3 Billing Enhancements',
        version: '2026.09.3',
        ticketRefs: ['W-14822'],
        riskLevel: 'low',
      },
    });
    const { dataSource } = build(connectionFor(), storage);

    const release = (await dataSource.refresh()).releases[0]!;

    expect(release.name).toBe('Q3 Billing Enhancements');
    expect(release.version).toBe('2026.09.3');
    expect(release.ticketRefs).toEqual(['W-14822']);
    expect(release.riskLevel).toBe('low');
  });

  it('defaults risk from the outcome when the overlay is silent', async () => {
    const { dataSource } = build(
      connectionFor({
        deploys: [DEPLOY_FAILED],
        details: { [DEPLOY_FAILED.Id]: DEPLOY_FAILED_DETAIL },
      }),
    );

    expect((await dataSource.refresh()).releases[0]!.riskLevel).toBe('high');
  });

  it('ignores a malformed overlay rather than failing the refresh', async () => {
    const storage = createMemoryStorageArea();
    await storage.write(RELEASE_OVERLAY_KEY, 'not an object');
    const { dataSource } = build(connectionFor(), storage);

    expect((await dataSource.refresh()).releases[0]!.name).toBe(DEPLOY_SUCCEEDED.Id);
  });
});

describe('coverage', () => {
  it('attaches coverage as a 0..1 fraction', async () => {
    const { dataSource } = build();

    const item = (await dataSource.refresh()).items.find((i) => i.fullName === 'InvoiceBuilder')!;

    expect(item.testCoverage).toBeCloseTo(0.91, 5);
  });

  it('leaves coverage absent when the class has no lines, rather than reporting 0%', async () => {
    const { dataSource } = build();

    const items = (await dataSource.refresh()).items;

    // EmptyClass has 0 covered and 0 uncovered: genuinely unknown.
    expect(items.every((item) => item.fullName !== 'EmptyClass')).toBe(true);
  });

  it('leaves coverage absent for a component the coverage query did not mention', async () => {
    const { dataSource } = build(connectionFor({ coverage: [] }));

    const items = (await dataSource.refresh()).items;

    expect(items.every((item) => !('testCoverage' in item))).toBe(true);
  });
});

describe('merge semantics', () => {
  let storage: StorageArea;

  beforeEach(() => {
    storage = createMemoryStorageArea();
  });

  it('keeps local approvals, audit log and actor across a refresh', async () => {
    // Connecting an org does not make approvals trustworthy, and must not
    // destroy them either.
    const seeded = makeSnapshot({
      actor: { name: 'Lin Zhou', roles: ['qa-lead'] },
      environments: [{ id: SANDBOX_ORG.Id, name: 'Acme UAT', kind: 'sandbox', orgAlias: 'uat' }],
      releases: [makeRelease({ id: DEPLOY_SUCCEEDED.Id, environmentId: SANDBOX_ORG.Id })],
      approvals: [makeApproval({ id: 'apr-1', releaseId: DEPLOY_SUCCEEDED.Id })],
    });
    await storage.write(ORG_SNAPSHOT_KEY, JSON.parse(JSON.stringify(seeded)));
    const { dataSource } = build(connectionFor(), storage);

    const refreshed = await dataSource.refresh();

    expect(refreshed.approvals.map((a) => a.id)).toEqual(['apr-1']);
    expect(refreshed.actor).toEqual({ name: 'Lin Zhou', roles: ['qa-lead'] });
  });

  it('keeps a release that has dropped out of the recent-deploys window', async () => {
    // Otherwise its approvals would dangle and fail referential integrity.
    const seeded = makeSnapshot({
      environments: [{ id: SANDBOX_ORG.Id, name: 'Acme UAT', kind: 'sandbox', orgAlias: 'uat' }],
      releases: [makeRelease({ id: 'old-deploy-id', environmentId: SANDBOX_ORG.Id })],
      approvals: [makeApproval({ id: 'apr-old', releaseId: 'old-deploy-id' })],
    });
    await storage.write(ORG_SNAPSHOT_KEY, JSON.parse(JSON.stringify(seeded)));
    const { dataSource } = build(connectionFor(), storage);

    const refreshed = await dataSource.refresh();

    expect(refreshed.releases.map((r) => r.id).sort()).toEqual(
      [DEPLOY_SUCCEEDED.Id, 'old-deploy-id'].sort(),
    );
    expect(refreshed.approvals).toHaveLength(1);
  });

  it('replaces the components of a release it refreshed', async () => {
    const { dataSource, storage: area } = build(connectionFor(), storage);
    await dataSource.refresh();
    const first = (await dataSource.load()).items.length;

    await dataSource.refresh();

    expect((await dataSource.load()).items).toHaveLength(first);
    expect(await area.read(ORG_SNAPSHOT_KEY)).toBeDefined();
  });

  it('appends an audit entry naming what was refreshed', async () => {
    const { dataSource } = build();

    const snapshot = await dataSource.refresh();
    const entry = snapshot.auditLog.at(-1)!;

    expect(entry.action).toBe('snapshot.refreshed');
    expect(entry.detail).toMatch(/1 deployment\(s\), 2 component\(s\)/);
    expect(entry.detail).toMatch(/Dependencies are not available/);
  });

  it('produces a snapshot that passes the same validator as stored data', async () => {
    const { dataSource, storage: area } = build();
    await dataSource.refresh();

    // `load` re-parses, so this would throw if the mapping produced anything
    // the rest of the app would refuse.
    await expect(dataSource.load()).resolves.toBeDefined();
    expect(await area.read(ORG_SNAPSHOT_KEY)).toBeDefined();
  });
});

describe('API budget guard (§8)', () => {
  it('refuses to refresh at or above 95% consumed, naming the usage', async () => {
    const { dataSource, connection } = build(connectionFor({ limits: EXHAUSTED_LIMITS }));

    const attempt = dataSource.refresh();

    await expect(attempt).rejects.toThrow(ApiLimitExhaustedError);
    await expect(attempt).rejects.toThrow(/14,400 of 15,000/);
    await expect(attempt).rejects.toThrow(/96%/);
    // And critically: it refused before making any other call.
    expect(connection.calls.filter((c) => c.kind !== 'get')).toHaveLength(0);
  });

  it('proceeds below the threshold', async () => {
    const { dataSource } = build(connectionFor({ limits: HEALTHY_LIMITS }));

    await expect(dataSource.refresh()).resolves.toBeDefined();
  });

  it('proceeds when the org does not report a daily API limit', async () => {
    // We cannot tell, and refusing on a guess would block every refresh.
    const { dataSource } = build(connectionFor({ limits: {} }));

    await expect(dataSource.refresh()).resolves.toBeDefined();
  });

  it('uses the documented threshold', () => {
    expect(API_LIMIT_REFUSE_RATIO).toBe(0.95);
  });
});

describe('hostile or unusual org responses', () => {
  it('refuses when the Organization query returns no rows', async () => {
    const { dataSource } = build({
      ...connectionFor(),
      getResponses: {
        [`${API}/limits`]: HEALTHY_LIMITS,
        [`${API}/query`]: queryResponse([]),
      },
    });

    await expect(dataSource.refresh()).rejects.toThrow(OrgResponseInvalidError);
    await expect(dataSource.refresh()).rejects.toThrow(/could not be identified/);
  });

  it('names the offending field when the Organization row has no Id', async () => {
    const { dataSource } = build({
      ...connectionFor(),
      getResponses: {
        [`${API}/limits`]: HEALTHY_LIMITS,
        [`${API}/query`]: queryResponse([{ IsSandbox: true }]),
      },
    });

    await expect(dataSource.refresh()).rejects.toThrow(/Organization\.Id/);
  });

  it('tolerates a deploy with no details section', async () => {
    const { dataSource } = build(
      connectionFor({ details: { [DEPLOY_SUCCEEDED.Id]: { Id: DEPLOY_SUCCEEDED.Id } } }),
    );

    const snapshot = await dataSource.refresh();

    expect(snapshot.releases).toHaveLength(1);
    expect(snapshot.items).toEqual([]);
  });

  it('skips a deploy row with no Id rather than producing a broken release', async () => {
    const { dataSource } = build(connectionFor({ deploys: [{ Status: 'Succeeded' }] }));

    expect((await dataSource.refresh()).releases).toEqual([]);
  });

  it('leaves the cache untouched when a refresh fails partway', async () => {
    const { dataSource, storage: area } = build();
    await dataSource.refresh();
    const before = await area.read(ORG_SNAPSHOT_KEY);

    const failing = build(
      { ...connectionFor(), failures: { toolingQuery: new Error('org went away') } },
      area,
    );
    await expect(failing.dataSource.refresh()).rejects.toThrow('org went away');

    expect(await area.read(ORG_SNAPSHOT_KEY)).toEqual(before);
  });
});

describe('approvals stay local (decision 2)', () => {
  it('records a decision without contacting the org', async () => {
    const storage = createMemoryStorageArea();
    const seeded = makeSnapshot({
      environments: [{ id: SANDBOX_ORG.Id, name: 'Acme UAT', kind: 'sandbox', orgAlias: 'uat' }],
      releases: [makeRelease({ id: DEPLOY_SUCCEEDED.Id, environmentId: SANDBOX_ORG.Id })],
      approvals: [makeApproval({ id: 'apr-1', releaseId: DEPLOY_SUCCEEDED.Id })],
    });
    await storage.write(ORG_SNAPSHOT_KEY, JSON.parse(JSON.stringify(seeded)));
    const { dataSource, connection } = build(connectionFor(), storage);

    const result = await dataSource.decide({
      approvalId: 'apr-1',
      outcome: 'approved',
      comment: 'Checked in UAT.',
    });

    expect(result.approval.status).toBe('approved');
    // No org write path exists, and none was attempted.
    expect(connection.requestCount()).toBe(0);
  });
});

describe('reset and actor', () => {
  it('clears the cache and keeps the local profile', async () => {
    const { dataSource } = build();
    await dataSource.refresh();
    await dataSource.setActor({ name: 'Ada Kensington', roles: ['cab-approver'] });

    const reset = await dataSource.reset('empty');

    expect(reset.releases).toEqual([]);
    expect(reset.actor.name).toBe('Ada Kensington');
    expect(reset.auditLog.at(-1)?.detail).toMatch(/Refresh to repopulate/);
  });

  it('treats reset("demo") the same as empty, since demo data would mislead here', async () => {
    const { dataSource } = build();
    await dataSource.refresh();

    expect((await dataSource.reset('demo')).releases).toEqual([]);
  });

  it('persists an actor change', async () => {
    const { dataSource } = build();
    await dataSource.setActor({ name: 'Lin Zhou', roles: ['qa-lead'] });

    expect((await dataSource.load()).actor.roles).toEqual(['qa-lead']);
  });
});
