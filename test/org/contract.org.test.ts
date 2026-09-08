/**
 * The contract with a real Salesforce org.
 *
 * Everything else in this suite runs against a fake. This runs the **shipping**
 * code — `createFetchOrgConnection` and `createSalesforceDataSource`, not a
 * reimplementation — against orgs the `sf` CLI is authenticated to, and asserts
 * that the fields the mapper reads are actually there, that the nulls it
 * tolerates are the nulls that occur, and that a full `refresh()` produces a
 * snapshot the product's own validator accepts.
 *
 * ## Opt-in, and never coupled to CI
 *
 *   npm run test:org                          every connected org
 *   npm run test:org -- --target-org nsorg    one org
 *
 * It is a separate vitest project with its own include, so `npm test`, `npm run
 * check` and CI never load it. With no CLI, no orgs, or no network it skips
 * with a message that says which — a skip is the correct outcome of "no org
 * available", and turning it into a failure would make the suite unusable for
 * anyone without one.
 *
 * ## Read-only
 *
 * Every call goes through `OrgConnection`, whose interface is `get`,
 * `toolingQuery` and `queryMore`. There is no write member, so there is no code
 * path from this file that could change an org. Treat these as production
 * orgs — they are somebody's.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { createFixedClock, createSequentialIdFactory } from '../../src/core/clock.js';
import { parseSnapshot } from '../../src/core/validate.js';
import type { OrgConnection } from '../../src/data/connection.js';
import { createFetchOrgConnection } from '../../src/data/fetchConnection.js';
import { createSalesforceDataSource } from '../../src/data/salesforce.js';
import { createMemoryStorageArea } from '../../src/data/storage.js';

/** The version this build pins. Kept in step with `service-worker.ts` by hand. */
const API_VERSION = '62.0';

const FIXED_NOW = '2026-09-08T12:00:00.000Z';

interface OrgUnderTest {
  readonly alias: string;
  readonly instanceUrl: string;
  readonly accessToken: string;
  readonly instanceApiVersion: string | null;
  readonly namespacePrefix: string | null;
}

let orgs: OrgUnderTest[] = [];
let skipReason: string | undefined;

beforeAll(async () => {
  const requested = requestedAlias();
  try {
    // A plain `.mjs` helper with no types of its own; the shape it returns is
    // asserted here rather than declared there.
    const harness = (await import('../../scripts/org-harness.mjs')) as {
      listOrgAliases: () => Promise<string[]>;
      describeOrg: (alias: string) => Promise<OrgUnderTest>;
    };
    const aliases = await harness.listOrgAliases();
    const chosen = requested === undefined ? aliases : aliases.filter((a) => a === requested);

    if (aliases.length === 0) {
      skipReason =
        'the Salesforce CLI reported no connected orgs. Authenticate one with `sf org login web`, or skip these tests.';
      return;
    }
    if (chosen.length === 0) {
      skipReason = `no connected org is aliased "${requested}". Available: ${aliases.join(', ')}.`;
      return;
    }
    orgs = await Promise.all(chosen.map((alias) => harness.describeOrg(alias)));
  } catch (cause) {
    skipReason = `the Salesforce CLI could not be run (${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}). Install it, or skip these tests.`;
  }
}, 120_000);

/**
 * Which org to test, if the caller named one.
 *
 * Read from the environment rather than argv: vitest rejects CLI flags it does
 * not recognise, so `scripts/run-org-tests.mjs` lifts `--target-org` into
 * `SFRL_TARGET_ORG` before starting the runner.
 */
function requestedAlias(): string | undefined {
  const value = process.env['SFRL_TARGET_ORG'];
  return value === undefined || value.length === 0 ? undefined : value;
}

/** The extension's own transport, pointed at a real org. */
function connect(org: OrgUnderTest): OrgConnection {
  return createFetchOrgConnection({
    instanceUrl: org.instanceUrl,
    apiVersion: API_VERSION,
    // The token is never stored on the connection; it is asked for per request.
    getAccessToken: () => Promise.resolve(org.accessToken),
  });
}

function dataSourceFor(org: OrgUnderTest) {
  const storage = createMemoryStorageArea();
  return {
    storage,
    source: createSalesforceDataSource({
      storage,
      connection: connect(org),
      clock: createFixedClock(FIXED_NOW),
      newId: createSequentialIdFactory('live'),
      orgAlias: org.alias,
    }),
  };
}

/**
 * Runs `body` once per org, or reports the skip.
 *
 * vitest cannot generate cases from an async `beforeAll`, so the loop is inside
 * the test rather than around it. The trade is a less granular report for a
 * suite that can honestly say "no org" instead of failing.
 */
function forEachOrg(
  name: string,
  body: (org: OrgUnderTest) => Promise<void>,
  timeout = 120_000,
): void {
  it(name, async (context) => {
    if (skipReason !== undefined) context.skip(skipReason);
    expect(orgs.length).toBeGreaterThan(0);
    for (const org of orgs) {
      await body(org).catch((cause: unknown) => {
        throw new Error(
          `[${org.alias}] ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      });
    }
  }, timeout);
}

describe('the transport reaches a real org', () => {
  forEachOrg('reads the API limits with the fields the budget guard needs', async (org) => {
    const limits = await connect(org).get<Record<string, { Max?: number; Remaining?: number }>>(
      `/services/data/v${API_VERSION}/limits`,
    );

    const daily = limits['DailyApiRequests'];
    expect(daily, 'DailyApiRequests missing from the limits response').toBeDefined();
    expect(typeof daily?.Max).toBe('number');
    expect(typeof daily?.Remaining).toBe('number');
  });

  forEachOrg('still offers the API version this build pins', async (org) => {
    const versions = await connect(org).get<{ version?: string }[]>('/services/data/');

    expect(Array.isArray(versions)).toBe(true);
    expect(
      versions.map((entry) => entry.version),
      `this org no longer offers v${API_VERSION}`,
    ).toContain(API_VERSION);
  });
});

describe('the Organization row', () => {
  forEachOrg('has every field the environment mapping reads', async (org) => {
    const page = await connect(org).get<{ records?: Record<string, unknown>[] }>(
      `/services/data/v${API_VERSION}/query`,
      {
        q: 'SELECT Id, Name, IsSandbox, TrialExpirationDate, OrganizationType, InstanceName FROM Organization LIMIT 1',
      },
    );
    const row = page.records?.[0];

    expect(row, 'the org returned no Organization row').toBeDefined();
    // `Id` is the environment id, so it must be a non-empty string.
    expect(typeof row?.['Id']).toBe('string');
    expect(String(row?.['Id']).length).toBeGreaterThan(0);
    expect(typeof row?.['IsSandbox']).toBe('boolean');
    // Nullable, and the mapper depends on `null` meaning "not a trial".
    expect(['string', 'object']).toContain(typeof row?.['TrialExpirationDate']);
  });
});

describe('the DeployRequest list query', () => {
  forEachOrg('returns rows whose types match what the mapper assumes', async (org) => {
    const rows = await connect(org).toolingQuery<Record<string, unknown>>(
      'SELECT Id, Status, CheckOnly, CreatedDate, StartDate, CompletedDate, ' +
        'NumberComponentsTotal, NumberComponentErrors, NumberComponentsDeployed, CreatedBy.Name ' +
        'FROM DeployRequest ORDER BY CreatedDate DESC LIMIT 10',
    );

    expect(typeof rows.done).toBe('boolean');
    expect(Array.isArray(rows.records)).toBe(true);

    for (const row of rows.records) {
      expect(typeof row['Id'], 'a DeployRequest row with no Id').toBe('string');
      // Every one of these is optional in the row type and must stay that way:
      // `CompletedDate` is null while a deploy runs, and `CreatedBy` is null
      // when the API user cannot see the creating user.
      for (const field of ['Status', 'CreatedDate', 'StartDate', 'CompletedDate']) {
        const value = row[field];
        expect(['string', 'undefined', 'object'], `${field} was a ${typeof value}`).toContain(
          typeof value,
        );
      }
      expect(['boolean', 'undefined', 'object']).toContain(typeof row['CheckOnly']);
      expect(['number', 'undefined', 'object']).toContain(typeof row['NumberComponentsTotal']);

      // The nesting the mapper walks: `CreatedBy.Name`, not a flat field.
      const createdBy = row['CreatedBy'];
      if (createdBy !== null && createdBy !== undefined) {
        expect(typeof (createdBy as { Name?: unknown }).Name).toBe('string');
      }
    }
  });

  forEachOrg('reports a status this build can map', async (org) => {
    const rows = await connect(org).toolingQuery<{ Status?: string | null }>(
      'SELECT Id, Status FROM DeployRequest ORDER BY CreatedDate DESC LIMIT 10',
    );

    const { releaseStatusFromDeployStatus } = await import('../../src/data/transfer.js');
    for (const row of rows.records) {
      const status = releaseStatusFromDeployStatus(row.Status ?? undefined, false);
      // The mapper has a documented default for a status it does not know, so
      // this cannot throw — what it must not do is silently produce `deployed`
      // for something that failed.
      expect(typeof status).toBe('string');
      if (row.Status === 'Failed') expect(status).toBe('failed');
      if (row.Status === 'Succeeded') expect(status).toBe('deployed');
    }
  });
});

describe('deploy component details', () => {
  forEachOrg('come from the Metadata API, and the Tooling record has none', async (org) => {
    const connection = connect(org);
    const rows = await connection.toolingQuery<{ Id: string }>(
      'SELECT Id FROM DeployRequest ORDER BY CreatedDate DESC LIMIT 1',
    );
    const id = rows.records[0]?.Id;
    if (id === undefined) return; // An org with no deploys proves nothing here.

    const tooling = await connection.get<Record<string, unknown>>(
      `/services/data/v${API_VERSION}/tooling/sobjects/DeployRequest/${id}`,
    );
    // The defect this file exists to have caught: the record the code used to
    // read details from does not carry them, in any org.
    expect(Object.keys(tooling)).not.toContain('DeployResult');

    const detail = await connection.get<{
      deployResult?: { details?: { componentSuccesses?: unknown }; createdByName?: string };
    }>(`/services/data/v${API_VERSION}/metadata/deployRequest/${id}`, { includeDetails: 'true' });

    expect(detail.deployResult, 'the Metadata API returned no deployResult').toBeDefined();
    expect(detail.deployResult?.details).toBeDefined();
    // The author lives here and nowhere else.
    expect(typeof detail.deployResult?.createdByName).toBe('string');
  });

  forEachOrg('carry no author on the component itself', async (org) => {
    const connection = connect(org);
    const rows = await connection.toolingQuery<{ Id: string }>(
      'SELECT Id FROM DeployRequest ORDER BY CreatedDate DESC LIMIT 3',
    );

    for (const row of rows.records) {
      const detail = await connection.get<{
        deployResult?: { details?: { componentSuccesses?: unknown; componentFailures?: unknown } };
      }>(`/services/data/v${API_VERSION}/metadata/deployRequest/${row.Id}`, {
        includeDetails: 'true',
      });
      const details = detail.deployResult?.details;
      const components = [
        ...asArray(details?.componentSuccesses),
        ...asArray(details?.componentFailures),
      ];

      for (const component of components) {
        // Reading an author off a component is what produced "unknown"
        // everywhere. If a future API version adds one, this test fails and
        // the mapper can start preferring it.
        expect(component['createdByName'], 'a component gained an author field').toBeUndefined();
        expect(typeof component['fullName']).toBe('string');
        expect(['string', 'undefined', 'object']).toContain(typeof component['componentType']);
      }
    }
  });
});

describe('a full refresh against a real org', () => {
  forEachOrg('produces a snapshot the product validator accepts', async (org) => {
    const { source, storage } = dataSourceFor(org);

    const snapshot = await source.refresh();

    // The strongest single assertion available: whatever came back must pass
    // the same gate a user's own file passes.
    expect(() => parseSnapshot(JSON.parse(JSON.stringify(snapshot)))).not.toThrow();
    expect(snapshot.isDemoData).toBe(false);
    expect(snapshot.environments).toHaveLength(1);
    // And it must be what was cached, not merely what was returned.
    expect(await storage.read('sf-releaselens.org-snapshot.v1')).toEqual(snapshot);
  });

  forEachOrg('reads no components without a release to hang them on', async (org) => {
    const { source } = dataSourceFor(org);

    const snapshot = await source.refresh();
    const releaseIds = new Set(snapshot.releases.map((release) => release.id));

    for (const item of snapshot.items) {
      expect(releaseIds.has(item.releaseId)).toBe(true);
    }
    // An org with no deploy history is a valid empty snapshot, not an error.
    if (snapshot.releases.length === 0) expect(snapshot.items).toEqual([]);
  });

  forEachOrg('attributes every component to a person, not to "unknown"', async (org) => {
    const { source } = dataSourceFor(org);

    const snapshot = await source.refresh();
    if (snapshot.items.length === 0) return;

    // The deploy's author is threaded down to its components. Before that, a
    // real org produced "unknown" for every single one.
    expect(snapshot.items.some((item) => item.lastModifiedBy !== 'unknown')).toBe(true);
  });

  forEachOrg('marks every org-sourced component as having no dependency data', async (org) => {
    const { source } = dataSourceFor(org);

    const snapshot = await source.refresh();

    for (const item of snapshot.items) {
      expect(item.dependsOn).toEqual([]);
      expect(item.dependenciesUnavailable).toBe(true);
    }
  });

  forEachOrg('invents no approvals', async (org) => {
    const { source } = dataSourceFor(org);

    expect((await source.refresh()).approvals).toEqual([]);
  });

  forEachOrg('is idempotent: a second refresh changes nothing structural', async (org) => {
    const { source } = dataSourceFor(org);

    const first = await source.refresh();
    const second = await source.refresh();

    expect(second.releases.map((release) => release.id)).toEqual(
      first.releases.map((release) => release.id),
    );
    expect(second.items.length).toBe(first.items.length);
  });

  forEachOrg('never touches the network on load()', async (org) => {
    const { source } = dataSourceFor(org);
    await source.refresh();

    // A connection that would throw if used, so a request is impossible to miss.
    const offline = createSalesforceDataSource({
      storage: createMemoryStorageArea(),
      connection: {
        instanceUrl: org.instanceUrl,
        apiVersion: API_VERSION,
        get: () => Promise.reject(new Error('load() made a request')),
        toolingQuery: () => Promise.reject(new Error('load() made a request')),
        queryMore: () => Promise.reject(new Error('load() made a request')),
      },
      clock: createFixedClock(FIXED_NOW),
      newId: createSequentialIdFactory('live'),
      orgAlias: org.alias,
    });

    await expect(offline.load()).resolves.toBeDefined();
  });
});

function asArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value !== null && typeof value === 'object') return [value as Record<string, unknown>];
  return [];
}
