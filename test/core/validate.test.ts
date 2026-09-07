import { describe, expect, it } from 'vitest';

import { SnapshotValidationError, UnsupportedSchemaVersionError } from '../../src/core/errors.js';
import { parseSnapshot } from '../../src/core/validate.js';
import { makeApproval, makeItem, makeRelease, makeSnapshot, realisticSnapshot } from '../fixtures/snapshot.js';

/** Round-trips through JSON, exactly as stored data arrives. */
function asStored(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('parseSnapshot', () => {
  it('accepts a snapshot it produced itself, unchanged', () => {
    const snapshot = realisticSnapshot();

    expect(parseSnapshot(asStored(snapshot))).toEqual(snapshot);
  });

  it('rejects a schema version it does not understand, without discarding anything', () => {
    const future = { ...makeSnapshot(), schemaVersion: 99 };

    expect(() => parseSnapshot(asStored(future))).toThrow(UnsupportedSchemaVersionError);
    expect(() => parseSnapshot(asStored(future))).toThrow(/version 99.*version 1/s);
  });

  it.each([
    ['null', null, 'snapshot'],
    ['an array', [], 'snapshot'],
    ['a string', 'nope', 'snapshot'],
    ['a number', 7, 'snapshot'],
  ])('rejects %s at the top level', (_label, value, path) => {
    expect(() => parseSnapshot(value)).toThrow(new RegExp(`"${path}"`));
  });

  it('names the exact failing path', () => {
    const broken = asStored(makeSnapshot({ releases: [makeRelease()] })) as Record<string, unknown>;
    (broken['releases'] as Record<string, unknown>[])[0]!['status'] = 'shipped';

    expect(() => parseSnapshot(broken)).toThrow(SnapshotValidationError);
    expect(() => parseSnapshot(broken)).toThrow(/snapshot\.releases\[0\]\.status/);
    expect(() => parseSnapshot(broken)).toThrow(/received "shipped"/);
  });

  it.each([
    ['missing actor', (s: Record<string, unknown>) => delete s['actor'], /snapshot\.actor/],
    ['non-array releases', (s: Record<string, unknown>) => (s['releases'] = {}), /snapshot\.releases/],
    ['non-boolean isDemoData', (s: Record<string, unknown>) => (s['isDemoData'] = 'yes'), /snapshot\.isDemoData/],
    ['blank actor name', (s: Record<string, unknown>) => ((s['actor'] as Record<string, unknown>)['name'] = '   '), /snapshot\.actor\.name/],
  ])('rejects %s', (_label, mutate, expected) => {
    const snapshot = asStored(makeSnapshot()) as Record<string, unknown>;
    mutate(snapshot);

    expect(() => parseSnapshot(snapshot)).toThrow(expected);
  });

  it('rejects an unparseable timestamp', () => {
    const snapshot = asStored(makeSnapshot({ releases: [makeRelease()] })) as Record<string, unknown>;
    (snapshot['releases'] as Record<string, unknown>[])[0]!['updatedAt'] = 'last Tuesday';

    expect(() => parseSnapshot(snapshot)).toThrow(/updatedAt.*ISO-8601/s);
  });

  it('rejects coverage expressed as a percentage, naming the fix', () => {
    const snapshot = asStored(
      makeSnapshot({ items: [makeItem({ testCoverage: 0.8 })] }),
    ) as Record<string, unknown>;
    (snapshot['items'] as Record<string, unknown>[])[0]!['testCoverage'] = 80;

    expect(() => parseSnapshot(snapshot)).toThrow(/between 0 and 1.*divided by 100/s);
  });

  it('preserves absent coverage as absent rather than defaulting it to zero', () => {
    const parsed = parseSnapshot(asStored(makeSnapshot({ items: [makeItem({})] })));

    expect(parsed.items[0]).not.toHaveProperty('testCoverage');
  });

  it('accepts zero coverage as a real, distinct value', () => {
    const parsed = parseSnapshot(
      asStored(makeSnapshot({ items: [makeItem({ testCoverage: 0 })] })),
    );

    expect(parsed.items[0]?.testCoverage).toBe(0);
  });

  it('requires a decided approval to record who decided it', () => {
    const snapshot = asStored(
      makeSnapshot({ approvals: [makeApproval({ status: 'approved' })] }),
    ) as Record<string, unknown>;
    delete (snapshot['approvals'] as Record<string, unknown>[])[0]!['decision'];

    expect(() => parseSnapshot(snapshot)).toThrow(/must record who decided it/);
  });

  it('refuses a pending approval that carries a decision', () => {
    const snapshot = asStored(makeSnapshot({ approvals: [makeApproval()] })) as Record<string, unknown>;
    (snapshot['approvals'] as Record<string, unknown>[])[0]!['decision'] = {
      by: 'Someone',
      at: '2026-09-01T00:00:00.000Z',
    };

    expect(() => parseSnapshot(snapshot)).toThrow(/pending approval must not carry a decision/);
  });

  it('rejects duplicate ids', () => {
    const snapshot = makeSnapshot({
      releases: [makeRelease({ id: 'rel-1' }), makeRelease({ id: 'rel-1', name: 'Copy' })],
    });

    expect(() => parseSnapshot(asStored(snapshot))).toThrow(/duplicate id "rel-1"/);
  });

  it.each([
    [
      'a release pointing at a missing environment',
      makeSnapshot({ environments: [], releases: [makeRelease()] }),
      /releases\[0\]\.targetEnvironmentId/,
    ],
    [
      'an item pointing at a missing release',
      makeSnapshot({ releases: [], items: [makeItem({ releaseId: 'gone' })] }),
      /items\[0\]\.releaseId/,
    ],
    [
      'an approval pointing at a missing release',
      makeSnapshot({ releases: [], approvals: [makeApproval({ releaseId: 'gone' })] }),
      /approvals\[0\]\.releaseId/,
    ],
  ])('rejects %s rather than quietly pruning it', (_label, snapshot, expected) => {
    expect(() => parseSnapshot(asStored(snapshot))).toThrow(expected);
  });

  it('validates nested warning severities', () => {
    const snapshot = asStored(
      makeSnapshot({
        items: [makeItem({ warnings: [{ code: 'X', message: 'y', severity: 'warning' }] })],
      }),
    ) as Record<string, unknown>;
    const item = (snapshot['items'] as Record<string, unknown>[])[0]!;
    (item['warnings'] as Record<string, unknown>[])[0]!['severity'] = 'critical';

    expect(() => parseSnapshot(snapshot)).toThrow(/items\[0\]\.warnings\[0\]\.severity/);
  });

  it('validates audit entries', () => {
    const snapshot = asStored(makeSnapshot()) as Record<string, unknown>;
    snapshot['auditLog'] = [
      { id: 'a', at: '2026-09-01T00:00:00.000Z', by: 'x', action: 'released', detail: 'd' },
    ];

    expect(() => parseSnapshot(snapshot)).toThrow(/auditLog\[0\]\.action/);
  });

  it('accepts a valid audit entry with an optional release reference', () => {
    const snapshot = asStored(makeSnapshot()) as Record<string, unknown>;
    snapshot['auditLog'] = [
      {
        id: 'a',
        at: '2026-09-01T00:00:00.000Z',
        by: 'x',
        action: 'snapshot.reset',
        detail: 'd',
        releaseId: 'rel-1',
      },
    ];

    expect(parseSnapshot(snapshot).auditLog[0]?.releaseId).toBe('rel-1');
  });
});
