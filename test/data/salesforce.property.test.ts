/**
 * The org boundary, fuzzed.
 *
 * A Salesforce org is the one input this project genuinely does not control.
 * The API version is pinned, but field availability differs between org
 * editions, `DeployResult.details` is absent on some records, and a platform
 * release can change a shape without warning. `test/data/salesforce.test.ts`
 * covers the payloads we know about. This covers the ones we do not.
 *
 * The property that matters is not "it works" — with arbitrary junk it should
 * usually refuse. It is **all-or-nothing**: a refresh either lands a snapshot
 * the validator accepts, or it changes nothing at all. A half-applied refresh
 * is the dangerous outcome, because a dashboard built from half an org read
 * looks exactly like a dashboard built from a whole one.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createFixedClock, createSequentialIdFactory } from '../../src/core/clock.js';
import { ReleaseLensError } from '../../src/core/errors.js';
import type { Snapshot } from '../../src/core/types.js';
import { parseSnapshot } from '../../src/core/validate.js';
import { ORG_SNAPSHOT_KEY, createSalesforceDataSource } from '../../src/data/salesforce.js';
import { createMemoryStorageArea } from '../../src/data/storage.js';
import { fakeOrgConnection } from '../fixtures/fakeConnection.js';
import { API_VERSIONS, HEALTHY_LIMITS } from '../fixtures/salesforce.js';

const RUNS = Number(process.env['FC_RUNS'] ?? 200);
const config: fc.Parameters<unknown> = { numRuns: RUNS };

const API = '/services/data/v62.0';
const FIXED_NOW = '2026-09-07T09:00:00.000Z';

const anyJson = fc.jsonValue({ maxDepth: 3 });

/**
 * Mostly the right shape, occasionally not.
 *
 * The first version of this file drew every field from `anyJson`, and every one
 * of 300 runs was refused at `Organization.Id` before a single deploy row was
 * mapped. A fuzzer that never gets through the front door tests the front door.
 * So each field is a valid value four times out of five and arbitrary JSON the
 * fifth, which puts most runs deep in the mapping code and still corrupts
 * something on most of them.
 */
function mostly<T>(valid: fc.Arbitrary<T>): fc.Arbitrary<unknown> {
  return fc.oneof({ arbitrary: valid, weight: 4 }, { arbitrary: anyJson, weight: 1 });
}

const isoish = fc.constantFrom(
  '2026-09-01T10:00:00.000Z',
  '2026-09-01T10:05:00.000Z',
  '2025-12-31T23:59:59.000Z',
);

/** A record shaped like a `DeployRequest` row. */
const deployRow = fc.record({
  // Ids are drawn from a small pool so that detail lookups mostly resolve;
  // a unique id per row would send every detail fetch down the "unknown
  // endpoint" path and test only that.
  Id: mostly(fc.constantFrom('0AfWs00000aaa001', '0AfWs00000aaa002', '0AfWs00000aaa003')),
  Status: mostly(fc.constantFrom('Succeeded', 'Failed', 'Canceled', 'InProgress', 'Pending')),
  CheckOnly: mostly(fc.boolean()),
  CreatedDate: mostly(isoish),
  CompletedDate: mostly(isoish),
  CreatedBy: mostly(fc.record({ Name: fc.string({ maxLength: 20 }) })),
  NumberComponentsTotal: mostly(fc.nat({ max: 200 })),
});

/** A record shaped like a component in `DeployResult.details`. */
const componentRow = fc.record({
  fullName: mostly(fc.string({ minLength: 1, maxLength: 30 })),
  componentType: mostly(fc.constantFrom('ApexClass', 'Flow', 'CustomObject', '')),
  fileName: mostly(fc.string({ maxLength: 40 })),
  createdByName: mostly(fc.string({ maxLength: 20 })),
  createdDate: mostly(isoish),
  created: mostly(fc.boolean()),
  changed: mostly(fc.boolean()),
  deleted: mostly(fc.boolean()),
  problem: mostly(fc.string({ maxLength: 40 })),
  problemType: mostly(fc.string({ maxLength: 12 })),
});

const orgRow = fc.record({
  // `Id` is the one field `fetchOrganization` refuses without.
  Id: mostly(fc.constant('00Dxx0000001gPFEAY')),
  Name: mostly(fc.string({ minLength: 1, maxLength: 24 })),
  OrganizationType: mostly(fc.constantFrom('Production', 'Developer Edition', 'Enterprise Edition')),
  IsSandbox: mostly(fc.boolean()),
  InstanceName: mostly(fc.string({ maxLength: 8 })),
  TrialExpirationDate: mostly(fc.oneof(fc.constant(null), isoish)),
});

/** Everything a refresh reads, drawn independently so faults combine. */
const orgResponses = fc.record({
  org: mostly(orgRow),
  deploys: fc.array(deployRow, { maxLength: 3 }),
  components: fc.array(componentRow, { maxLength: 4 }),
  failures: fc.array(componentRow, { maxLength: 2 }),
  detailsPresent: fc.boolean(),
  coverage: fc.array(
    fc.record({
      ApexClassOrTrigger: mostly(fc.record({ Name: fc.string({ minLength: 1, maxLength: 20 }) })),
      NumLinesCovered: mostly(fc.nat({ max: 500 })),
      NumLinesUncovered: mostly(fc.nat({ max: 500 })),
    }),
    { maxLength: 3 },
  ),
});

interface ResponseDraft {
  org: unknown;
  deploys: readonly { Id: unknown }[];
  components: readonly unknown[];
  failures: readonly unknown[];
  detailsPresent: boolean;
  coverage: readonly unknown[];
}

type Wiring = ReturnType<typeof buildResponses>;

function buildResponses(responses: ResponseDraft) {
  // The Metadata REST API's shape, which is where component details live.
  const detailFor = (id: unknown): unknown => ({
    id,
    deployResult: {
      status: 'Succeeded',
      checkOnly: false,
      createdDate: '2026-09-01T10:00:00.000Z',
      completedDate: '2026-09-01T10:05:00.000Z',
      createdByName: 'Alex Fixture',
      ...(responses.detailsPresent
        ? {
            details: {
              componentSuccesses: responses.components,
              componentFailures: responses.failures,
            },
          }
        : {}),
    },
  });

  return {
    getResponses: {
      '/services/data/': API_VERSIONS,
      [`${API}/limits`]: HEALTHY_LIMITS,
      [`${API}/query`]: { records: [responses.org], done: true, totalSize: 1 },
      ...Object.fromEntries(
        responses.deploys.map((deploy) => [
          `${API}/metadata/deployRequest/${String(deploy.Id)}`,
          detailFor(deploy.Id),
        ]),
      ),
    },
    queryResponses: [
      {
        match: 'FROM DeployRequest',
        response: { records: responses.deploys, done: true, totalSize: responses.deploys.length },
      },
      {
        match: 'FROM ApexCodeCoverageAggregate',
        response: { records: responses.coverage, done: true, totalSize: responses.coverage.length },
      },
    ],
  };
}

function dataSourceFor(wiring: Wiring) {
  const storage = createMemoryStorageArea();
  return {
    storage,
    source: createSalesforceDataSource({
      storage,
      connection: fakeOrgConnection(wiring),
      clock: createFixedClock(FIXED_NOW),
      newId: createSequentialIdFactory('gen'),
      orgAlias: 'fuzzed',
    }),
  };
}

describe('refresh against an arbitrary org', () => {
  it('either lands a valid snapshot or changes nothing at all', async () => {
    await fc.assert(
      fc.asyncProperty(orgResponses, async (responses) => {
        const { storage, source } = dataSourceFor(buildResponses(responses));
        const before = await storage.read(ORG_SNAPSHOT_KEY);

        let refreshed: Snapshot;
        try {
          refreshed = await source.refresh();
        } catch (cause) {
          if (!(cause instanceof ReleaseLensError)) {
            throw new Error(
              `refresh threw an untyped error: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`,
              { cause },
            );
          }
          // The whole point: a refusal must leave the cache exactly as it was.
          expect(await storage.read(ORG_SNAPSHOT_KEY)).toEqual(before);
          // And it must blame the org, not the user's stored data. A refresh
          // that reports SNAPSHOT_VALIDATION sends a release manager to the
          // Reset button over a problem that came down the wire.
          expect(cause.code).not.toBe('SNAPSHOT_VALIDATION');
          expect(cause.code).not.toBe('UNSUPPORTED_SCHEMA_VERSION');
          return;
        }

        // A success must be loadable on the next open, by the same validator
        // that guards stored data.
        expect(() => parseSnapshot(JSON.parse(JSON.stringify(refreshed)))).not.toThrow();
        expect(await storage.read(ORG_SNAPSHOT_KEY)).toEqual(refreshed);
      }),
      config,
    );
  });

  it('never invents a dependency edge, whatever the org returned', async () => {
    await fc.assert(
      fc.asyncProperty(orgResponses, async (responses) => {
        const { source } = dataSourceFor(buildResponses(responses));

        let refreshed: Snapshot;
        try {
          refreshed = await source.refresh();
        } catch (cause) {
          if (cause instanceof ReleaseLensError) return;
          throw cause;
        }

        for (const item of refreshed.items) {
          expect(item.dependsOn).toEqual([]);
          expect(item.dependenciesUnavailable).toBe(true);
        }
      }),
      config,
    );
  });

  it('never invents an approval, whatever the org returned', async () => {
    await fc.assert(
      fc.asyncProperty(orgResponses, async (responses) => {
        const { source } = dataSourceFor(buildResponses(responses));

        let refreshed: Snapshot;
        try {
          refreshed = await source.refresh();
        } catch (cause) {
          if (cause instanceof ReleaseLensError) return;
          throw cause;
        }

        // Approvals are local, and a refresh must not manufacture one from a
        // deploy record. The org has no approval object to read.
        expect(refreshed.approvals).toEqual([]);
      }),
      config,
    );
  });

  it('leaves an existing cache untouched when the org read fails', async () => {
    await fc.assert(
      fc.asyncProperty(orgResponses, async (responses) => {
        const { storage, source } = dataSourceFor(buildResponses(responses));

        // Seed the cache with a good snapshot first, so a failure has something
        // to damage.
        const seeded = await source.importSnapshot(SEED_SNAPSHOT);
        const before: unknown = structuredClone(await storage.read(ORG_SNAPSHOT_KEY));

        try {
          await source.refresh();
        } catch (cause) {
          if (!(cause instanceof ReleaseLensError)) throw cause;
          expect(await storage.read(ORG_SNAPSHOT_KEY)).toEqual(before);
          return;
        }

        // On success the local approvals must have survived the merge — the
        // one rule DATASOURCE.md §5 states outright.
        const after = await source.load();
        expect(after.approvals.map((approval) => approval.id)).toEqual(
          seeded.approvals.map((approval) => approval.id),
        );
      }),
      config,
    );
  });
});

/** A minimal valid snapshot with one local approval to protect. */
const SEED_SNAPSHOT = {
  schemaVersion: 1,
  actor: { name: 'Sam Okafor', roles: ['release-manager'] },
  environments: [{ id: 'env-1', name: 'UAT', kind: 'sandbox', orgAlias: 'uat' }],
  releases: [
    {
      id: 'rel-1',
      name: 'Seeded',
      version: '1.0.0',
      status: 'awaiting_approval',
      targetEnvironmentId: 'env-1',
      owner: 'Sam Okafor',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      ticketRefs: [],
      riskLevel: 'low',
    },
  ],
  items: [],
  approvals: [
    {
      id: 'apr-1',
      releaseId: 'rel-1',
      stage: 'UAT sign-off',
      requiredRole: 'release-manager',
      requestedBy: 'Sam Okafor',
      requestedAt: '2026-09-01T00:00:00.000Z',
      status: 'pending',
    },
  ],
  auditLog: [],
  isDemoData: false,
};
