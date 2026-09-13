/**
 * One hundred profiles, driven through the shipping data layer.
 *
 * ## What this is, and what it is not
 *
 * This extension is local-first and has no server: two installs are two
 * independent snapshots, and nothing is shared between them. So "a hundred
 * users" cannot mean concurrent load — there is no contended resource to
 * contend for, and a test that pretended otherwise would measure nothing.
 *
 * What a hundred users *does* mean here is a hundred different **profiles**
 * meeting the same data, which is the product's real multi-person surface:
 * the "acting as" switcher decides which approval gates a person may clear,
 * and `Snapshot.actor` is the only input to that decision. A role set is
 * therefore the variable worth sweeping, and one profile per role combination
 * is a sweep no hand-written test covers.
 *
 * Two arrangements are exercised:
 *
 *   1. **Separate installs.** Each profile gets its own storage area and its
 *      own `LocalDataSource`, seeded from the demo dataset. This is what a
 *      hundred people each installing the extension actually produces.
 *   2. **One shared snapshot.** All hundred profiles take turns against a
 *      single data source via `setActor`, which is what the profile switcher
 *      does. Decisions accumulate, so later profiles meet approvals earlier
 *      ones have already decided — the interesting case, and the one that
 *      exercises the already-decided path at scale.
 *
 * Every attempt is predicted before it is made, from the rules restated in
 * `mayDecide` and `stillOpen` below rather than from the functions under test,
 * and the prediction is asserted against what happened. A permitted decision
 * that throws is a defect; a forbidden one that succeeds is a worse defect.
 *
 * ## Determinism
 *
 * The action order comes from a seeded PRNG with the seed written into this
 * file, and time and ids come from injected ports, so a failure reproduces
 * exactly. Nothing here calls `Math.random`, `Date.now` or the network.
 */

import { describe, expect, it } from 'vitest';

import { createSequentialIdFactory, type Clock } from '../../src/core/clock.js';
import {
  ApprovalNotPermittedError,
  InvalidApprovalTransitionError,
  MissingRejectionCommentError,
} from '../../src/core/errors.js';
import { deriveReleaseStatus } from '../../src/core/releases.js';
import { parseSnapshot } from '../../src/core/validate.js';
import type {
  Actor,
  Approval,
  ApprovalDecisionOutcome,
  Snapshot,
} from '../../src/core/types.js';
import { createLocalDataSource } from '../../src/data/local.js';
import { createDemoSnapshot } from '../../src/data/seed.js';
import { createMemoryStorageArea } from '../../src/data/storage.js';

const SEED = 0x5f3759df;
const START = '2026-03-01T09:00:00.000Z';
const MINUTE_MS = 60_000;

/** The five roles the demo dataset's gates actually require, plus two that no gate requires. */
const REAL_ROLES = [
  'release-manager',
  'uat-approver',
  'qa-lead',
  'security-reviewer',
  'cab-approver',
] as const;
const DECOY_ROLES = ['observer', 'admin'] as const;

const OUTCOMES: readonly ApprovalDecisionOutcome[] = ['approved', 'rejected', 'cancelled'];

/** mulberry32 — small, seeded, and reproducible across platforms. */
function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A clock that advances one minute per read, so audit entries are ordered and distinct. */
function createAdvancingClock(startIso: string): Clock {
  let tick = 0;
  return {
    now(): string {
      const at = new Date(Date.parse(startIso) + tick * MINUTE_MS).toISOString();
      tick += 1;
      return at;
    },
  };
}

export interface Profile {
  readonly index: number;
  readonly actor: Actor;
}

/**
 * A hundred profiles whose role sets are spread deliberately rather than
 * randomly: every single role alone, every pair, the full set, the empty set,
 * and sets holding only roles no gate requires. The empty and decoy profiles
 * are the ones that must never be able to approve anything.
 */
export function buildProfiles(count: number): Profile[] {
  const combinations: string[][] = [[]];
  for (const role of REAL_ROLES) combinations.push([role]);
  for (let i = 0; i < REAL_ROLES.length; i += 1) {
    for (let j = i + 1; j < REAL_ROLES.length; j += 1) {
      combinations.push([REAL_ROLES[i]!, REAL_ROLES[j]!]);
    }
  }
  combinations.push([...REAL_ROLES]);
  for (const decoy of DECOY_ROLES) combinations.push([decoy]);
  combinations.push([...DECOY_ROLES]);
  for (const role of REAL_ROLES) combinations.push([role, DECOY_ROLES[0]]);

  return Array.from({ length: count }, (_, index) => ({
    index,
    actor: {
      name: `Tester ${String(index + 1).padStart(3, '0')}`,
      roles: combinations[index % combinations.length]!,
    },
  }));
}

let installCount = 0;

function build(seedSnapshot?: Snapshot): ReturnType<typeof createLocalDataSource> {
  const clock = createAdvancingClock(START);
  // A distinct prefix per install. Production uses `crypto.randomUUID`, so two
  // installs never share an id space; giving them one here would manufacture a
  // collision this product cannot have.
  installCount += 1;
  const newId = createSequentialIdFactory(`sim${String(installCount)}`);
  return createLocalDataSource({
    storage: createMemoryStorageArea(),
    clock,
    newId,
    seedFactory: (deps) => seedSnapshot ?? createDemoSnapshot(deps),
  });
}

/** Every invariant that must hold of any snapshot this product produces. */
function assertSnapshotInvariants(snapshot: Snapshot, where: string): void {
  // It must survive its own validator: whatever we write, we can read back.
  expect(() => parseSnapshot(JSON.parse(JSON.stringify(snapshot))), where).not.toThrow();

  for (const approval of snapshot.approvals) {
    // The type cannot express this; the validator and the state machine must.
    if (approval.status === 'pending') {
      expect(approval.decision, `${where}: pending approval ${approval.id} carries a decision`)
        .toBeUndefined();
    } else {
      expect(approval.decision, `${where}: decided approval ${approval.id} has no decision`)
        .toBeDefined();
    }
    expect(
      snapshot.releases.some((release) => release.id === approval.releaseId),
      `${where}: approval ${approval.id} points at a release that is not here`,
    ).toBe(true);
  }

  // The release status is derived, never patched: re-deriving must be a no-op.
  for (const release of snapshot.releases) {
    expect(
      deriveReleaseStatus(release, snapshot.approvals),
      `${where}: release ${release.id} status is not what its approvals imply`,
    ).toBe(release.status);
  }

  const auditIds = snapshot.auditLog.map((entry) => entry.id);
  expect(new Set(auditIds).size, `${where}: duplicate audit ids`).toBe(auditIds.length);
}

/**
 * Whether this profile may record this outcome — restated here from
 * `docs/DESIGN.md` §4 rather than read from `src/core/approvals.ts`.
 *
 * The rule: approve and reject need the gate's role; cancel is additionally
 * open to whoever raised the request, because withdrawing your own request is
 * not a privileged act.
 *
 * This duplication is the point. An earlier draft called `canDecide` to predict
 * what `canDecide` would do, so forcing that function to permit everything left
 * every assertion passing — the test agreed with the bug. Keep this independent.
 */
function mayDecide(
  approval: Approval,
  actor: Actor,
  outcome: ApprovalDecisionOutcome,
): boolean {
  if (actor.roles.includes(approval.requiredRole)) return true;
  return outcome === 'cancelled' && approval.requestedBy === actor.name;
}

/** Restated likewise: only a pending approval can still be decided. */
function stillOpen(approval: Approval): boolean {
  return approval.status === 'pending';
}

interface Attempt {
  readonly permitted: boolean;
  readonly decidable: boolean;
  readonly outcome: ApprovalDecisionOutcome;
  readonly comment: string | null;
}

function predict(approval: Approval, actor: Actor, attempt: Attempt): 'ok' | typeof Error {
  if (!attempt.decidable) return InvalidApprovalTransitionError;
  if (!attempt.permitted) return ApprovalNotPermittedError;
  if (attempt.outcome === 'rejected' && (attempt.comment ?? '').trim().length === 0) {
    return MissingRejectionCommentError;
  }
  return 'ok';
}

describe('one hundred profiles against the shipping data layer', () => {
  const profiles = buildProfiles(100);

  it('gives every profile a distinct name, and covers the interesting role sets', () => {
    expect(profiles).toHaveLength(100);
    expect(new Set(profiles.map((p) => p.actor.name)).size).toBe(100);

    const shapes = new Set(profiles.map((p) => [...p.actor.roles].sort().join('+')));
    expect(shapes.size).toBeGreaterThanOrEqual(20);
    // The two that matter most: somebody with nothing, and somebody with everything.
    expect(shapes.has('')).toBe(true);
    expect(shapes.has([...REAL_ROLES].sort().join('+'))).toBe(true);
  });

  it('seeds a hundred independent installs identically, and none can see another', async () => {
    const snapshots = await Promise.all(
      profiles.map(async (profile) => {
        const dataSource = build();
        await dataSource.load();
        const withProfile = await dataSource.setActor(profile.actor);
        assertSnapshotInvariants(withProfile, `install ${profile.index}`);
        return withProfile;
      }),
    );

    expect(snapshots).toHaveLength(100);
    // Same seed, same clock, same id factory: the data a hundred people first
    // see must be the same data, or the demo dataset is not deterministic.
    const shapeOf = (snapshot: Snapshot): string =>
      JSON.stringify({
        releases: snapshot.releases.map((r) => [r.id, r.status]),
        approvals: snapshot.approvals.map((a) => [a.id, a.status]),
        items: snapshot.items.length,
      });
    const shapes = new Set(snapshots.map(shapeOf));
    expect(shapes.size, 'installs diverged from one another').toBe(1);

    // And each carries only its own profile.
    snapshots.forEach((snapshot, index) => {
      expect(snapshot.actor.name).toBe(profiles[index]!.actor.name);
    });
  });

  it('lets each profile decide exactly what its roles permit, and nothing more', async () => {
    const random = createRandom(SEED);
    let permittedAndDone = 0;
    let forbiddenAndRefused = 0;

    for (const profile of profiles) {
      const dataSource = build();
      await dataSource.load();
      let snapshot = await dataSource.setActor(profile.actor);

      // Every approval, in an order this profile does not control.
      const order = [...snapshot.approvals].sort(() => random() - 0.5);

      for (const target of order) {
        const current = snapshot.approvals.find((a) => a.id === target.id);
        expect(current, 'an approval vanished between reads').toBeDefined();
        if (current === undefined) continue;

        const outcome = OUTCOMES[Math.floor(random() * OUTCOMES.length)]!;
        const comment = outcome === 'rejected' && random() < 0.2 ? '   ' : 'Recorded by simulation';
        const attempt: Attempt = {
          permitted: mayDecide(current, profile.actor, outcome),
          decidable: stillOpen(current),
          outcome,
          comment,
        };
        const expected = predict(current, profile.actor, attempt);
        const where = `${profile.actor.name} [${profile.actor.roles.join(',') || 'no roles'}] -> ${outcome} on ${current.id}`;

        if (expected === 'ok') {
          const result = await dataSource.decide({
            approvalId: current.id,
            outcome,
            comment,
          });
          snapshot = result.snapshot;
          permittedAndDone += 1;

          expect(result.approval.status, where).toBe(outcome);
          expect(result.approval.decision?.by, `${where}: recorded against the wrong person`).toBe(
            profile.actor.name,
          );
          // The consequence the panel shows must be the consequence that happened.
          const release = snapshot.releases.find((r) => r.id === result.release.id);
          expect(release?.status, `${where}: release status disagrees with the result`).toBe(
            result.statusChange === null ? result.release.status : result.statusChange.to,
          );
          assertSnapshotInvariants(snapshot, where);
        } else {
          await expect(
            dataSource.decide({ approvalId: current.id, outcome, comment }),
            where,
          ).rejects.toBeInstanceOf(expected);
          forbiddenAndRefused += 1;

          // A refused attempt must leave nothing behind.
          const after = await dataSource.load();
          expect(
            after.approvals.find((a) => a.id === current.id)?.status,
            `${where}: a refused attempt changed the approval`,
          ).toBe(current.status);
          expect(after.auditLog.length, `${where}: a refused attempt wrote an audit entry`).toBe(
            snapshot.auditLog.length,
          );
        }
      }
    }

    // Both paths must actually have been exercised, or the sweep proved nothing.
    expect(permittedAndDone, 'no decision was ever permitted').toBeGreaterThan(0);
    expect(forbiddenAndRefused, 'no decision was ever refused').toBeGreaterThan(0);
  });

  it('holds every invariant when a hundred profiles take turns on one snapshot', async () => {
    const random = createRandom(SEED ^ 0x9e3779b9);
    const dataSource = build();
    await dataSource.load();

    let snapshot = await dataSource.load();
    let decisions = 0;
    let alreadyDecided = 0;
    let refused = 0;

    for (const profile of profiles) {
      snapshot = await dataSource.setActor(profile.actor);

      const target = snapshot.approvals[Math.floor(random() * snapshot.approvals.length)];
      if (target === undefined) continue;

      const outcome = OUTCOMES[Math.floor(random() * OUTCOMES.length)]!;
      const comment = 'Recorded by simulation';
      const attempt: Attempt = {
        permitted: mayDecide(target, profile.actor, outcome),
        decidable: stillOpen(target),
        outcome,
        comment,
      };
      const expected = predict(target, profile.actor, attempt);
      const where = `shared: ${profile.actor.name} -> ${outcome} on ${target.id}`;

      if (expected === 'ok') {
        const before = snapshot.auditLog.length;
        const result = await dataSource.decide({ approvalId: target.id, outcome, comment });
        snapshot = result.snapshot;
        decisions += 1;

        // One decision writes one decision entry, plus one status entry only
        // when the release actually moved.
        const expectedEntries = before + (result.statusChange === null ? 1 : 2);
        expect(snapshot.auditLog.length, `${where}: audit entries do not match the consequence`).toBe(
          expectedEntries,
        );
        expect(
          snapshot.auditLog.at(result.statusChange === null ? -1 : -2)?.by,
          `${where}: audit entry names the wrong person`,
        ).toBe(profile.actor.name);
        assertSnapshotInvariants(snapshot, where);
      } else {
        if (expected === InvalidApprovalTransitionError) alreadyDecided += 1;
        else refused += 1;
        await expect(
          dataSource.decide({ approvalId: target.id, outcome, comment }),
          where,
        ).rejects.toBeInstanceOf(expected);
      }
    }

    // The shared run is only interesting if later profiles met earlier decisions.
    expect(decisions, 'nobody decided anything').toBeGreaterThan(0);
    expect(
      alreadyDecided,
      'no profile ever met an approval another profile had already decided',
    ).toBeGreaterThan(0);
    expect(refused + alreadyDecided, 'nothing was ever refused').toBeGreaterThan(0);

    // The audit log is append-only: every entry from every profile survives, in order.
    const times = snapshot.auditLog.map((entry) => Date.parse(entry.at));
    expect([...times].sort((a, b) => a - b), 'audit log is out of order').toEqual(times);
  });

  it('round-trips each profile through export and import without losing a decision', async () => {
    const random = createRandom(SEED ^ 0x85ebca6b);

    for (const profile of profiles.slice(0, 25)) {
      const source = build();
      await source.load();
      await source.setActor(profile.actor);

      let exported = await source.exportSnapshot();
      const decidable = exported.approvals.filter(
        (a) => stillOpen(a) && mayDecide(a, profile.actor, 'approved'),
      );
      if (decidable.length > 0) {
        const pick = decidable[Math.floor(random() * decidable.length)]!;
        exported = (await source.decide({ approvalId: pick.id, outcome: 'approved', comment: null }))
          .snapshot;
      }

      // A second install imports the first one's file.
      const destination = build();
      await destination.load();
      const imported = await destination.importSnapshot(
        JSON.parse(JSON.stringify(exported)) as unknown,
      );

      const strip = (snapshot: Snapshot): unknown => ({
        releases: snapshot.releases,
        items: snapshot.items,
        approvals: snapshot.approvals,
        environments: snapshot.environments,
      });
      expect(strip(imported), `${profile.actor.name}: import lost data`).toEqual(strip(exported));
      // An imported file is somebody else's data, so it is never demo data again.
      expect(imported.isDemoData).toBe(false);
      // The import is recorded, not silent.
      expect(imported.auditLog.at(-1)?.action).toBe('snapshot.imported');
      assertSnapshotInvariants(imported, `${profile.actor.name}: imported`);
    }
  });

  it('refuses a malformed file from any profile without disturbing what is stored', async () => {
    const malformed: unknown[] = [
      null,
      42,
      'not a snapshot',
      {},
      { schemaVersion: 99 },
      { schemaVersion: 1, releases: 'no' },
      { schemaVersion: 1, releases: [], items: [], approvals: [], environments: [], auditLog: [] },
    ];

    for (const [index, profile] of profiles.slice(0, 10).entries()) {
      const dataSource = build();
      await dataSource.load();
      const before = await dataSource.setActor(profile.actor);

      for (const raw of malformed) {
        await expect(
          dataSource.importSnapshot(raw),
          `${profile.actor.name}: accepted ${String(JSON.stringify(raw)).slice(0, 40)}`,
        ).rejects.toThrow();
      }

      const after = await dataSource.load();
      expect(after, `${profile.actor.name} (#${index}): a refused import changed the snapshot`)
        .toEqual(before);
    }
  });
});
