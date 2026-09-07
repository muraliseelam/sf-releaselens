/**
 * The demo dataset is the first thing anyone evaluating this extension sees, so
 * it is held to the same validity rules as imported data.
 */

import { describe, expect, it } from 'vitest';

import { deriveReleaseStatus, summariseByStatus } from '../../src/core/releases.js';
import { parseSnapshot } from '../../src/core/validate.js';
import { createDemoSnapshot } from '../../src/data/seed.js';
import { testDeps } from '../fixtures/snapshot.js';

describe('createDemoSnapshot', () => {
  const snapshot = createDemoSnapshot(testDeps());

  it('passes the same validation as stored and imported data', () => {
    expect(() => parseSnapshot(JSON.parse(JSON.stringify(snapshot)))).not.toThrow();
  });

  it('is deterministic given a fixed clock and id factory', () => {
    expect(createDemoSnapshot(testDeps())).toEqual(snapshot);
  });

  it('is labelled as demo data so the panel can say so', () => {
    expect(snapshot.isDemoData).toBe(true);
  });

  it('covers enough statuses to exercise the dashboard', () => {
    const summary = summariseByStatus(snapshot.releases);

    expect(summary.total).toBe(5);
    expect(summary.needsAttention).toBeGreaterThan(0);
    expect(new Set(snapshot.releases.map((release) => release.status)).size).toBeGreaterThanOrEqual(4);
  });

  it('gives every release a target environment that exists', () => {
    const environmentIds = new Set(snapshot.environments.map((environment) => environment.id));

    expect(snapshot.releases.every((release) => environmentIds.has(release.targetEnvironmentId))).toBe(
      true,
    );
  });

  it('includes components with unknown coverage, so that state is visible', () => {
    expect(snapshot.items.some((item) => item.testCoverage === undefined)).toBe(true);
    expect(snapshot.items.some((item) => item.testCoverage !== undefined)).toBe(true);
  });

  it('includes dependencies that point outside the snapshot', () => {
    const names = new Set(snapshot.items.map((item) => item.fullName));

    expect(
      snapshot.items.some((item) => item.dependsOn.some((name) => !names.has(name))),
    ).toBe(true);
  });

  it('demonstrates the org-fact rule: a failed release with approvals stays failed', () => {
    const failed = snapshot.releases.find((release) => release.id === 'rel-tax-migration')!;

    expect(failed.status).toBe('failed');
    expect(snapshot.approvals.filter((a) => a.releaseId === failed.id)).not.toHaveLength(0);
    expect(deriveReleaseStatus(failed, snapshot.approvals)).toBe('failed');
  });

  it('has a blocked release whose block is explained by a rejected approval', () => {
    const blocked = snapshot.releases.find((release) => release.id === 'rel-payment-hotfix')!;

    expect(deriveReleaseStatus(blocked, snapshot.approvals)).toBe('blocked');
  });

  it('leaves work pending for the default profile, so the approvals tab is not empty', () => {
    const pendingForActor = snapshot.approvals.filter(
      (approval) =>
        approval.status === 'pending' && snapshot.actor.roles.includes(approval.requiredRole),
    );

    expect(pendingForActor).not.toHaveLength(0);
  });
});
