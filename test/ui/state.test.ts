import { describe, expect, it } from 'vitest';

import { EMPTY_QUERY } from '../../src/core/metadata.js';
import type { DecisionResult } from '../../src/core/snapshot.js';
import {
  INITIAL_STATE,
  currentSnapshot,
  describeDecision,
  hasActiveFilters,
  reduce,
  type ViewState,
} from '../../src/ui/state.js';
import { makeApproval, makeItem, makeRelease, makeSnapshot } from '../fixtures/snapshot.js';

const snapshot = makeSnapshot({ items: [makeItem({ id: 'i1' }), makeItem({ id: 'i2', fullName: 'Other' })] });

function ready(patch: Partial<ViewState> = {}): ViewState {
  return { ...INITIAL_STATE, load: { status: 'ready', snapshot }, ...patch };
}

describe('load lifecycle', () => {
  it('drops the previous snapshot while loading, so nothing stale is actionable', () => {
    const loading = reduce(ready(), { type: 'load/started' });

    expect(loading.load.status).toBe('loading');
    expect(currentSnapshot(loading)).toBeNull();
  });

  it('stores the snapshot on success', () => {
    const loaded = reduce(INITIAL_STATE, { type: 'load/succeeded', snapshot });

    expect(currentSnapshot(loaded)).toBe(snapshot);
  });

  it('clears a selection the new snapshot no longer contains', () => {
    const withSelection = ready({ inspector: { query: EMPTY_QUERY, selectedItemId: 'i1' } });

    const replaced = reduce(withSelection, {
      type: 'load/succeeded',
      snapshot: makeSnapshot({ items: [makeItem({ id: 'i9' })] }),
    });

    expect(replaced.inspector.selectedItemId).toBeNull();
  });

  it('keeps a selection the new snapshot still contains', () => {
    const withSelection = ready({ inspector: { query: EMPTY_QUERY, selectedItemId: 'i1' } });

    expect(
      reduce(withSelection, { type: 'load/succeeded', snapshot }).inspector.selectedItemId,
    ).toBe('i1');
  });

  it('records the error on failure', () => {
    const failed = reduce(INITIAL_STATE, {
      type: 'load/failed',
      error: { code: 'STORAGE_UNAVAILABLE', name: 'StorageUnavailableError', message: 'boom' },
    });

    expect(failed.load).toEqual({
      status: 'error',
      error: { code: 'STORAGE_UNAVAILABLE', name: 'StorageUnavailableError', message: 'boom' },
    });
  });
});

describe('navigation', () => {
  it('switches tab', () => {
    expect(reduce(INITIAL_STATE, { type: 'tab/selected', tab: 'approvals' }).tab).toBe('approvals');
  });

  it('opening a release jumps to the inspector scoped to it, clearing any selection', () => {
    const state = reduce(ready({ inspector: { query: EMPTY_QUERY, selectedItemId: 'i1' } }), {
      type: 'dashboard/releaseOpened',
      releaseId: 'rel-7',
    });

    expect(state.tab).toBe('inspector');
    expect(state.inspector.query.releaseId).toBe('rel-7');
    expect(state.inspector.selectedItemId).toBeNull();
  });

  it('opening a release keeps other filters, so the scope narrows rather than resets', () => {
    const filtered = reduce(ready(), { type: 'inspector/textChanged', text: 'invoice' });

    const state = reduce(filtered, { type: 'dashboard/releaseOpened', releaseId: 'rel-7' });

    expect(state.inspector.query.text).toBe('invoice');
  });
});

describe('inspector filters', () => {
  it('toggles a type on and off', () => {
    const on = reduce(ready(), { type: 'inspector/typeToggled', value: 'Flow' });
    const off = reduce(on, { type: 'inspector/typeToggled', value: 'Flow' });

    expect(on.inspector.query.types).toEqual(['Flow']);
    expect(off.inspector.query.types).toEqual([]);
  });

  it('accumulates several types', () => {
    const state = reduce(
      reduce(ready(), { type: 'inspector/typeToggled', value: 'Flow' }),
      { type: 'inspector/typeToggled', value: 'ApexClass' },
    );

    expect(state.inspector.query.types).toEqual(['Flow', 'ApexClass']);
  });

  it('toggles operations and the warnings-only switch', () => {
    const state = reduce(
      reduce(ready(), { type: 'inspector/operationToggled', value: 'delete' }),
      { type: 'inspector/warningsToggled' },
    );

    expect(state.inspector.query.operations).toEqual(['delete']);
    expect(state.inspector.query.onlyWithWarnings).toBe(true);
  });

  it('clears every filter and the selection at once', () => {
    const dirty = reduce(
      reduce(ready(), { type: 'inspector/textChanged', text: 'x' }),
      { type: 'inspector/itemSelected', itemId: 'i1' },
    );

    const cleared = reduce(dirty, { type: 'inspector/filtersCleared' });

    expect(cleared.inspector).toEqual({ query: EMPTY_QUERY, selectedItemId: null });
  });

  it('knows when filters are active', () => {
    expect(hasActiveFilters(EMPTY_QUERY)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_QUERY, text: '   ' })).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_QUERY, text: 'a' })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_QUERY, types: ['Flow'] })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_QUERY, operations: ['add'] })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_QUERY, releaseId: 'rel-1' })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_QUERY, onlyWithWarnings: true })).toBe(true);
  });
});

describe('approval decisions', () => {
  const result: DecisionResult = {
    snapshot: makeSnapshot({ approvals: [makeApproval({ status: 'approved' })] }),
    approval: makeApproval({ status: 'approved' }),
    release: makeRelease({ status: 'scheduled' }),
    statusChange: { from: 'awaiting_approval', to: 'scheduled' },
  };

  it('marks the approval busy and clears earlier feedback', () => {
    const busy = reduce(ready(), { type: 'approvals/decisionStarted', approvalId: 'apr-1' });

    expect(busy.approvals.busyApprovalId).toBe('apr-1');
    expect(busy.approvals.error).toBeNull();
    expect(busy.approvals.lastOutcome).toBeNull();
  });

  it('adopts the returned snapshot and explains the consequence', () => {
    const done = reduce(ready(), { type: 'approvals/decisionSucceeded', result });

    expect(currentSnapshot(done)).toBe(result.snapshot);
    expect(done.approvals.busyApprovalId).toBeNull();
    expect(done.approvals.lastOutcome).toMatch(/moved from awaiting_approval to scheduled/);
  });

  it('keeps a comment draft when the decision fails, and discards it when it succeeds', () => {
    const typed = reduce(ready(), {
      type: 'approvals/commentChanged',
      approvalId: 'apr-1',
      comment: 'half a thought',
    });

    const failed = reduce(typed, {
      type: 'approvals/decisionFailed',
      error: { code: 'MISSING_REJECTION_COMMENT', name: 'x', message: 'needs a comment' },
    });
    expect(failed.approvals.drafts['apr-1']).toBe('half a thought');
    expect(failed.approvals.error?.code).toBe('MISSING_REJECTION_COMMENT');

    const succeeded = reduce(typed, { type: 'approvals/decisionSucceeded', result });
    expect(succeeded.approvals.drafts).not.toHaveProperty('apr-1');
  });

  it('dismisses feedback without touching the drafts', () => {
    const withFeedback = reduce(
      reduce(ready(), { type: 'approvals/commentChanged', approvalId: 'apr-1', comment: 'x' }),
      { type: 'approvals/decisionSucceeded', result },
    );

    const dismissed = reduce(withFeedback, { type: 'approvals/feedbackDismissed' });

    expect(dismissed.approvals.lastOutcome).toBeNull();
    expect(dismissed.approvals.error).toBeNull();
  });
});

describe('describeDecision', () => {
  it('says the release did not move when it did not', () => {
    const text = describeDecision({
      snapshot: makeSnapshot(),
      approval: makeApproval({ status: 'approved' }),
      release: makeRelease({ name: 'Q3 Billing' }),
      statusChange: null,
    });

    expect(text).toBe(
      'UAT sign-off on Q3 Billing is now approved. The release status is unchanged.',
    );
  });
});

describe('dashboard filter', () => {
  it('stores the selected status', () => {
    expect(
      reduce(ready(), { type: 'dashboard/statusFiltered', status: 'blocked' }).dashboard
        .statusFilter,
    ).toBe('blocked');
  });
});
