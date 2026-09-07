/**
 * The constant lists in `types.ts` are load-bearing: the dashboard renders
 * statuses in their declared order, and `deriveReleaseStatus` consults
 * `ORG_FACT_STATUSES` by membership. A typo in either is a silent behaviour
 * change, so both are asserted here rather than trusted.
 */

import { describe, expect, it } from 'vitest';

import {
  APPROVAL_DECISIONS,
  APPROVAL_STATUSES,
  ATTENTION_STATUSES,
  AUDIT_ACTIONS,
  CURRENT_SCHEMA_VERSION,
  ENVIRONMENT_KINDS,
  METADATA_OPERATIONS,
  ORG_FACT_STATUSES,
  RELEASE_STATUSES,
  RISK_LEVELS,
  WARNING_SEVERITIES,
  emptySnapshot,
} from '../../src/core/types.js';

describe('emptySnapshot', () => {
  it('produces a valid, empty, non-demo snapshot carrying the given profile', () => {
    const actor = { name: 'Lin Zhou', roles: ['qa-lead'] };

    expect(emptySnapshot(actor)).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      actor,
      environments: [],
      releases: [],
      items: [],
      approvals: [],
      auditLog: [],
      isDemoData: false,
    });
  });

  it('does not share array references between two empty snapshots', () => {
    const first = emptySnapshot({ name: 'a', roles: [] });
    const second = emptySnapshot({ name: 'b', roles: [] });

    expect(first.releases).not.toBe(second.releases);
  });
});

describe('status vocabularies', () => {
  it('keeps the dashboard display order stable', () => {
    // Changing this order reshuffles the dashboard bar and legend for everyone.
    expect(RELEASE_STATUSES).toEqual([
      'draft',
      'awaiting_approval',
      'scheduled',
      'in_progress',
      'deployed',
      'blocked',
      'failed',
      'rolled_back',
    ]);
  });

  it('treats exactly the four org-fact statuses as unoverwritable', () => {
    expect([...ORG_FACT_STATUSES].sort()).toEqual(
      ['deployed', 'failed', 'in_progress', 'rolled_back'].sort(),
    );
  });

  it('treats exactly the three attention statuses as needing a look', () => {
    expect([...ATTENTION_STATUSES].sort()).toEqual(['blocked', 'failed', 'rolled_back'].sort());
  });

  it('draws every derived status list from the release status vocabulary', () => {
    for (const status of [...ORG_FACT_STATUSES, ...ATTENTION_STATUSES]) {
      expect(RELEASE_STATUSES).toContain(status);
    }
  });

  it('offers only decided outcomes as approval decisions', () => {
    expect(APPROVAL_DECISIONS).toEqual(['approved', 'rejected', 'cancelled']);
    expect(APPROVAL_STATUSES).toContain('pending');
    for (const outcome of APPROVAL_DECISIONS) {
      expect(APPROVAL_STATUSES).toContain(outcome);
    }
    expect(APPROVAL_DECISIONS).not.toContain('pending');
  });
});

describe('other vocabularies', () => {
  it('exposes the fixed enumerations the validator checks against', () => {
    expect(ENVIRONMENT_KINDS).toEqual(['scratch', 'sandbox', 'production']);
    expect(METADATA_OPERATIONS).toEqual(['add', 'modify', 'delete']);
    expect(WARNING_SEVERITIES).toEqual(['info', 'warning', 'error']);
    expect(RISK_LEVELS).toEqual(['low', 'medium', 'high']);
  });

  it('namespaces every audit action, so the log can be filtered by subject', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(action).toMatch(/^(approval|release|snapshot)\./);
    }
  });

  it('pins the schema version, so a bump is a deliberate edit', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });
});
