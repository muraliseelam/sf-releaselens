/**
 * Properties of the trust boundary.
 *
 * `parseSnapshot` and `parseImportText` are the only two functions in this
 * project that read data nobody here wrote: a file a user chose, a payload an
 * org returned, bytes that survived in `chrome.storage` across an extension
 * upgrade. The example-based tests cover the shapes we thought of. These cover
 * the shapes we did not.
 *
 * Three properties, each chosen because its failure mode is silent:
 *
 *  1. **Refusal is always clean.** Any input at all either parses or throws a
 *     `ReleaseLensError` naming a field. A `TypeError` from deep inside a
 *     parser reaches the panel as "Cannot read properties of undefined", which
 *     tells a release manager nothing and tells us nothing either.
 *  2. **Export round-trips.** Anything the validator accepts must survive
 *     `toExportJson` → `JSON.parse` → `parseSnapshot` unchanged. Export is the
 *     documented way to move data between machines and the rescue path out of a
 *     corrupt store; a field that silently does not survive it is data loss.
 *  3. **No partial application.** The deploy-report importer must never produce
 *     a snapshot the validator would reject. If it could, a malformed org
 *     payload would land as a half-built snapshot that looks fine on the
 *     dashboard and fails somewhere else later.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ReleaseLensError } from '../../src/core/errors.js';
import {
  APPROVAL_STATUSES,
  AUDIT_ACTIONS,
  CURRENT_SCHEMA_VERSION,
  ENVIRONMENT_KINDS,
  METADATA_OPERATIONS,
  RELEASE_STATUSES,
  RISK_LEVELS,
  WARNING_SEVERITIES,
  type Snapshot,
} from '../../src/core/types.js';
import { parseSnapshot } from '../../src/core/validate.js';
import {
  parseImportText,
  snapshotFromDeployReport,
  toExportJson,
} from '../../src/data/transfer.js';

/**
 * Enough runs to explore the shape space without making `npm test` a coffee
 * break. Raise it locally when hunting something specific:
 * `FC_RUNS=5000 npm test`.
 */
const RUNS = Number(process.env['FC_RUNS'] ?? 300);

const config: fc.Parameters<unknown> = { numRuns: RUNS };

// --- Generators ---------------------------------------------------------------

/** A non-empty string that survives `asNonEmptyString`, which trims. */
const text = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((value) => value.trim().length > 0);

const isoDate = fc
  .date({
    min: new Date('2000-01-01T00:00:00.000Z'),
    max: new Date('2100-01-01T00:00:00.000Z'),
    // Without this, fast-check happily produces an Invalid Date and
    // `toISOString` throws inside the generator rather than in the code under
    // test — which looks exactly like a product bug for about ten minutes.
    noInvalidDate: true,
  })
  .map((date) => date.toISOString());

const warning = fc.record({
  code: text,
  message: text,
  severity: fc.constantFrom(...WARNING_SEVERITIES),
});

/**
 * A snapshot that satisfies every rule the validator enforces, including the
 * cross-record ones: unique ids, and every reference resolving.
 *
 * Built by generating the ids first and then drawing references from them,
 * rather than by generating freely and filtering. Filtering for referential
 * integrity would reject almost every candidate and fast-check would give up.
 */
const validSnapshot: fc.Arbitrary<Snapshot> = fc
  .record({
    environmentIds: fc.uniqueArray(text, { minLength: 1, maxLength: 4 }),
    releaseIds: fc.uniqueArray(text, { minLength: 1, maxLength: 5 }),
    itemIds: fc.uniqueArray(text, { maxLength: 8 }),
    approvalIds: fc.uniqueArray(text, { maxLength: 5 }),
    auditIds: fc.uniqueArray(text, { maxLength: 4 }),
    actorName: text,
    roles: fc.array(text, { minLength: 1, maxLength: 3 }),
    isDemoData: fc.boolean(),
  })
  .chain((skeleton) => {
    const anEnvironment = fc.constantFrom(...skeleton.environmentIds);
    const aRelease = fc.constantFrom(...skeleton.releaseIds);

    return fc.record({
      schemaVersion: fc.constant(CURRENT_SCHEMA_VERSION),
      actor: fc.constant({ name: skeleton.actorName, roles: skeleton.roles }),
      isDemoData: fc.constant(skeleton.isDemoData),

      environments: fc.tuple(
        ...skeleton.environmentIds.map((id) =>
          fc.record({
            id: fc.constant(id),
            name: text,
            kind: fc.constantFrom(...ENVIRONMENT_KINDS),
            orgAlias: fc.string({ maxLength: 12 }),
          }),
        ),
      ),

      releases: fc.tuple(
        ...skeleton.releaseIds.map((id) =>
          fc.record(
            {
              id: fc.constant(id),
              name: text,
              version: text,
              status: fc.constantFrom(...RELEASE_STATUSES),
              targetEnvironmentId: anEnvironment,
              owner: text,
              createdAt: isoDate,
              updatedAt: isoDate,
              ticketRefs: fc.array(text, { maxLength: 3 }),
              riskLevel: fc.constantFrom(...RISK_LEVELS),
              // Optional, and their absence is meaningful: the validator omits
              // rather than sets undefined, so the generator must too.
              scheduledFor: isoDate,
              notes: fc.string({ maxLength: 40 }),
            },
            { requiredKeys: [...REQUIRED_RELEASE_KEYS] },
          ),
        ),
      ),

      items: fc.tuple(
        ...skeleton.itemIds.map((id) =>
          fc.record(
            {
              id: fc.constant(id),
              releaseId: aRelease,
              fullName: text,
              type: text,
              operation: fc.constantFrom(...METADATA_OPERATIONS),
              filePath: fc.string({ maxLength: 30 }),
              apiVersion: fc.string({ maxLength: 6 }),
              lastModifiedBy: fc.string({ maxLength: 20 }),
              lastModifiedAt: isoDate,
              dependsOn: fc.array(text, { maxLength: 4 }),
              warnings: fc.array(warning, { maxLength: 3 }),
              testCoverage: fc.double({ min: 0, max: 1, noNaN: true }),
              dependenciesUnavailable: fc.boolean(),
            },
            { requiredKeys: [...REQUIRED_ITEM_KEYS] },
          ),
        ),
      ),

      approvals: fc.tuple(
        ...skeleton.approvalIds.map((id) =>
          fc
            .record({
              id: fc.constant(id),
              releaseId: aRelease,
              stage: text,
              requiredRole: text,
              requestedBy: text,
              requestedAt: isoDate,
              status: fc.constantFrom(...APPROVAL_STATUSES),
              decisionBy: text,
              decisionAt: isoDate,
              decisionComment: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
            })
            // A decided approval must carry a decision and a pending one must
            // not; the validator enforces both directions, so the generator
            // derives the decision from the status rather than drawing it.
            .map(({ decisionBy, decisionAt, decisionComment, ...approval }) =>
              approval.status === 'pending'
                ? approval
                : {
                    ...approval,
                    decision: {
                      by: decisionBy,
                      at: decisionAt,
                      ...(decisionComment === undefined ? {} : { comment: decisionComment }),
                    },
                  },
            ),
        ),
      ),

      auditLog: fc.tuple(
        ...skeleton.auditIds.map((id) =>
          fc.record(
            {
              id: fc.constant(id),
              at: isoDate,
              by: text,
              action: fc.constantFrom(...AUDIT_ACTIONS),
              detail: fc.string({ maxLength: 40 }),
              releaseId: aRelease,
            },
            { requiredKeys: ['id', 'at', 'by', 'action', 'detail'] },
          ),
        ),
      ),
    });
  });

const REQUIRED_RELEASE_KEYS = [
  'id',
  'name',
  'version',
  'status',
  'targetEnvironmentId',
  'owner',
  'createdAt',
  'updatedAt',
  'ticketRefs',
  'riskLevel',
] as const;

const REQUIRED_ITEM_KEYS = [
  'id',
  'releaseId',
  'fullName',
  'type',
  'operation',
  'filePath',
  'apiVersion',
  'lastModifiedBy',
  'lastModifiedAt',
  'dependsOn',
  'warnings',
] as const;

/**
 * Arbitrary JSON-shaped data: what actually arrives when someone imports the
 * wrong file. Depth is capped because the interesting failures are shallow and
 * a 30-deep object only slows the run down.
 */
const anyJson = fc.jsonValue({ maxDepth: 4 });

/**
 * A valid snapshot with exactly one field corrupted.
 *
 * Purely random data is rejected at `snapshot.schemaVersion` and never reaches
 * the record parsers, so it proves very little about them. This gets past the
 * front door and then breaks something specific, which is the shape of a real
 * corrupt export.
 */
const nearMissSnapshot = fc
  .tuple(validSnapshot, fc.nat(), anyJson)
  .map(([snapshot, which, junk]) => {
    const copy: Record<string, unknown> = structuredClone(snapshot);
    const keys = Object.keys(copy).filter((key) => key !== 'schemaVersion');
    const key = keys[which % keys.length];
    if (key !== undefined) copy[key] = junk;
    return copy;
  });

const deps = {
  clock: { now: () => '2026-09-08T12:00:00.000Z' },
  newId: (() => {
    let counter = 0;
    return () => `generated-${(counter += 1)}`;
  })(),
};

const IMPORT_OPTIONS = {
  actor: { name: 'Sam Okafor', roles: ['release-manager'] },
  environmentName: 'Imported org',
  environmentKind: 'sandbox' as const,
  orgAlias: 'imported',
  owner: 'Sam Okafor',
};

/** Whatever the boundary threw, was it a refusal we designed? */
function expectCleanRefusal(run: () => unknown): void {
  try {
    run();
  } catch (cause) {
    if (cause instanceof ReleaseLensError) {
      // A refusal must say what it refused. An empty message reaches the panel
      // as a blank error notice.
      expect(cause.message.length).toBeGreaterThan(0);
      expect(cause.code.length).toBeGreaterThan(0);
      return;
    }
    throw new Error(
      `expected a ReleaseLensError, got ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`,
      { cause },
    );
  }
}

// --- Properties ---------------------------------------------------------------

describe('parseSnapshot refuses cleanly, whatever it is given', () => {
  it('never throws anything but a typed error, for any JSON at all', () => {
    fc.assert(
      fc.property(anyJson, (value) => {
        expectCleanRefusal(() => parseSnapshot(value));
      }),
      config,
    );
  });

  it('never throws anything but a typed error for a snapshot with one field corrupted', () => {
    fc.assert(
      fc.property(nearMissSnapshot, (value) => {
        expectCleanRefusal(() => parseSnapshot(value));
      }),
      config,
    );
  });

  it('names a field path when it refuses a corrupted snapshot', () => {
    fc.assert(
      fc.property(nearMissSnapshot, (value) => {
        try {
          parseSnapshot(value);
        } catch (cause) {
          if (cause instanceof ReleaseLensError && cause.code === 'SNAPSHOT_VALIDATION') {
            // "Snapshot is not valid at "snapshot.releases[2].status": ..." —
            // the path is the whole point of hand-written validation.
            expect(cause.message).toMatch(/at "snapshot(\.[\w[\]]+)+"/);
          }
        }
      }),
      config,
    );
  });

  it('accepts every snapshot the generator claims is valid', () => {
    fc.assert(
      fc.property(validSnapshot, (snapshot) => {
        expect(() => parseSnapshot(structuredClone(snapshot))).not.toThrow();
      }),
      config,
    );
  });
});

describe('export round-trips', () => {
  it('survives toExportJson and back, byte for byte in meaning', () => {
    fc.assert(
      fc.property(validSnapshot, (snapshot) => {
        const reparsed = parseSnapshot(JSON.parse(toExportJson(snapshot)));

        // Deep equality, not a field-by-field spot check: a new field added to
        // the model without a parser case fails here rather than silently
        // vanishing on every export.
        expect(reparsed).toEqual(snapshot);
      }),
      config,
    );
  });

  it('reaches a fixed point, so re-exporting an imported file is byte-identical', () => {
    fc.assert(
      fc.property(validSnapshot, (snapshot) => {
        /*
         * The first export is deliberately not compared. `JSON.stringify`
         * follows insertion order, and the parser rebuilds each record in its
         * own field order, so a snapshot built in memory can serialise with its
         * keys in a different order from the same snapshot after a round trip.
         * That is cosmetic — but from the first round trip onward it must be
         * stable, or every re-export of the same data is a noisy diff and
         * "rebuild it and compare" stops being a usable check.
         */
        const once = toExportJson(parseSnapshot(JSON.parse(toExportJson(snapshot))));
        const twice = toExportJson(parseSnapshot(JSON.parse(once)));

        expect(twice).toBe(once);
      }),
      config,
    );
  });

  it('round-trips through the import path a user actually uses', () => {
    fc.assert(
      fc.property(validSnapshot, (snapshot) => {
        expect(parseImportText(toExportJson(snapshot), deps, IMPORT_OPTIONS)).toEqual(snapshot);
      }),
      config,
    );
  });
});

describe('parseImportText refuses cleanly, whatever the file contains', () => {
  it('never throws anything but a typed error for arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (value) => {
        expectCleanRefusal(() => parseImportText(value, deps, IMPORT_OPTIONS));
      }),
      config,
    );
  });

  it('never throws anything but a typed error for arbitrary JSON', () => {
    fc.assert(
      fc.property(anyJson, (value) => {
        expectCleanRefusal(() => parseImportText(JSON.stringify(value), deps, IMPORT_OPTIONS));
      }),
      config,
    );
  });
});

describe('the deploy-report importer cannot produce a half-built snapshot', () => {
  /**
   * A payload shaped like a deploy report, with arbitrary junk in the places a
   * real one carries data. This is the org's side of the trust boundary: the
   * Tooling API returns the same component shape, so anything true here is true
   * of an org refresh.
   */
  const deployReport = fc.record({
    status: fc.integer(),
    result: fc.record({
      id: anyJson,
      status: anyJson,
      checkOnly: anyJson,
      createdDate: anyJson,
      completedDate: anyJson,
      numberComponentsTotal: anyJson,
      details: fc.record({
        componentSuccesses: fc.oneof(
          fc.array(anyJson, { maxLength: 5 }),
          anyJson,
        ),
        componentFailures: fc.oneof(fc.array(anyJson, { maxLength: 5 }), anyJson),
      }),
    }),
  });

  it('either refuses cleanly or produces a snapshot the validator accepts', () => {
    fc.assert(
      fc.property(deployReport, (report) => {
        let produced: unknown;
        try {
          produced = snapshotFromDeployReport(report, deps, IMPORT_OPTIONS);
        } catch (cause) {
          if (cause instanceof ReleaseLensError) return;
          throw cause;
        }

        // The strong half of the property. Whatever came back must pass the
        // same gate a user's file passes, or the importer has a way to write a
        // snapshot that will fail to load on the next open.
        expect(() => parseSnapshot(JSON.parse(JSON.stringify(produced)))).not.toThrow();
      }),
      config,
    );
  });

  it('never invents an approval, whatever the report contains', () => {
    fc.assert(
      fc.property(deployReport, (report) => {
        let produced: Snapshot;
        try {
          produced = snapshotFromDeployReport(report, deps, IMPORT_OPTIONS);
        } catch (cause) {
          if (cause instanceof ReleaseLensError) return;
          throw cause;
        }

        // A deploy report cannot see a human gate. Inventing one would put a
        // fabricated sign-off in front of a release manager.
        expect(produced.approvals).toEqual([]);
      }),
      config,
    );
  });

  it('marks every component it produces as having no dependency data', () => {
    fc.assert(
      fc.property(deployReport, (report) => {
        let produced: Snapshot;
        try {
          produced = snapshotFromDeployReport(report, deps, IMPORT_OPTIONS);
        } catch (cause) {
          if (cause instanceof ReleaseLensError) return;
          throw cause;
        }

        for (const item of produced.items) {
          expect(item.dependsOn).toEqual([]);
          expect(item.dependenciesUnavailable).toBe(true);
        }
      }),
      config,
    );
  });
});
