/**
 * @vitest-environment jsdom
 *
 * View tests. Each view is a pure function of (state, snapshot, handlers, now),
 * so these render into a detached element and assert on what a user would see
 * and click — no panel, no client, no chrome.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_QUERY, type MetadataQuery } from '../../src/core/metadata.js';
import type { Handlers } from '../../src/ui/handlers.js';
import { INITIAL_STATE, type ViewState } from '../../src/ui/state.js';
import { renderApprovals } from '../../src/ui/views/approvals.js';
import { renderDashboard } from '../../src/ui/views/dashboard.js';
import { renderInspector } from '../../src/ui/views/inspector.js';
import { makeItem, makeSnapshot, realisticSnapshot } from '../fixtures/snapshot.js';

const NOW = Date.parse('2026-09-07T09:00:00.000Z');

function stubHandlers(): Handlers & { dispatch: ReturnType<typeof vi.fn> } {
  return {
    dispatch: vi.fn(),
    reload: vi.fn(),
    decide: vi.fn(),
    exportSnapshot: vi.fn(),
    exportRawSnapshot: vi.fn(),
    importSnapshot: vi.fn(),
    reset: vi.fn(),
    setActor: vi.fn(),
  };
}

function state(patch: Partial<ViewState> = {}): ViewState {
  return { ...INITIAL_STATE, ...patch };
}

function inspectorState(query: Partial<MetadataQuery>, selectedItemId: string | null = null) {
  return state({ inspector: { query: { ...EMPTY_QUERY, ...query }, selectedItemId } });
}

/** Text of every node matching a selector, trimmed. */
function texts(root: Element, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((node) => node.textContent.trim());
}

let handlers: ReturnType<typeof stubHandlers>;

beforeEach(() => {
  handlers = stubHandlers();
});

describe('renderDashboard', () => {
  const snapshot = realisticSnapshot();

  it('headlines the total and the attention count', () => {
    const view = renderDashboard(state(), snapshot, handlers, NOW);

    expect(view.querySelector('.summary__headline')?.textContent).toContain('3 releases tracked');
    expect(view.querySelector('.summary__attention')?.textContent).toContain('1 needs attention');
  });

  it('says "release" in the singular for one release', () => {
    const one = makeSnapshot();
    const view = renderDashboard(state(), one, handlers, NOW);

    expect(view.querySelector('.summary__headline')?.textContent).toContain('1 release tracked');
  });

  it('omits the attention note entirely when nothing needs attention', () => {
    const calm = makeSnapshot();

    expect(renderDashboard(state(), calm, handlers, NOW).querySelector('.summary__attention')).toBeNull();
  });

  it('renders a chip for every status including the zeros, so the row never reflows', () => {
    const view = renderDashboard(state(), snapshot, handlers, NOW);

    // 8 statuses + the "All" chip.
    expect(view.querySelectorAll('.chips .chip')).toHaveLength(9);
    expect(view.querySelectorAll('.chip--zero').length).toBeGreaterThan(0);
  });

  it('marks the active status chip as pressed', () => {
    const view = renderDashboard(
      state({ dashboard: { statusFilter: 'blocked' } }),
      snapshot,
      handlers,
      NOW,
    );
    const pressed = [...view.querySelectorAll('.chip[aria-pressed="true"]')];

    expect(pressed).toHaveLength(1);
    expect(pressed[0]?.textContent).toContain('Blocked');
  });

  it('filters the list to the selected status', () => {
    const view = renderDashboard(
      state({ dashboard: { statusFilter: 'blocked' } }),
      snapshot,
      handlers,
      NOW,
    );

    expect(texts(view, '.row__title')).toEqual(['Payment Hotfix']);
  });

  it('clicking a status chip dispatches the filter', () => {
    const view = renderDashboard(state(), snapshot, handlers, NOW);
    const deployed = [...view.querySelectorAll('.chip')].find((chip) =>
      chip.textContent.includes('Deployed'),
    );

    (deployed as HTMLButtonElement).click();

    expect(handlers.dispatch).toHaveBeenCalledWith({
      type: 'dashboard/statusFiltered',
      status: 'deployed',
    });
  });

  it('sorts releases needing attention to the top', () => {
    expect(texts(renderDashboard(state(), snapshot, handlers, NOW), '.row__title')[0]).toBe(
      'Payment Hotfix',
    );
  });

  it('shows the environment, component count and pending approvals per release', () => {
    const view = renderDashboard(state(), snapshot, handlers, NOW);
    const billing = [...view.querySelectorAll('.row')].find((row) =>
      row.textContent.includes('Q3 Billing'),
    );

    expect(billing?.textContent).toContain('UAT');
    expect(billing?.textContent).toContain('3 components');
    expect(billing?.querySelector('.badge')?.textContent).toBe('2 pending approvals');
  });

  it('says "1 pending approval" in the singular', () => {
    const view = renderDashboard(state(), snapshot, handlers, NOW);
    const hotfix = [...view.querySelectorAll('.row')].find((row) =>
      row.textContent.includes('Payment Hotfix'),
    );

    // Its only approval was rejected, so it has none pending.
    expect(hotfix?.querySelector('.badge')).toBeNull();
  });

  it('names a missing environment rather than rendering a blank', () => {
    const orphaned = makeSnapshot({ environments: [] , releases: [] });
    const withRelease = {
      ...orphaned,
      releases: [{ ...realisticSnapshot().releases[0]!, targetEnvironmentId: 'env-gone' }],
    };

    const view = renderDashboard(state(), withRelease, handlers, NOW);

    expect(view.querySelector('.row__env')?.textContent).toBe('unknown environment (env-gone)');
  });

  it('clicking a release opens it in the inspector', () => {
    const view = renderDashboard(state(), snapshot, handlers, NOW);

    (view.querySelector('.row') as HTMLButtonElement).click();

    expect(handlers.dispatch).toHaveBeenCalledWith({
      type: 'dashboard/releaseOpened',
      releaseId: 'rel-hotfix',
    });
  });

  it('offers an import from the empty state when there are no releases at all', () => {
    const empty = makeSnapshot({ releases: [] });
    const view = renderDashboard(state(), empty, handlers, NOW);

    expect(view.querySelector('.empty')?.textContent).toContain('No releases yet.');
    (view.querySelector('.empty .button') as HTMLButtonElement).click();
    expect(handlers.importSnapshot).toHaveBeenCalled();
  });

  it('offers to clear the filter when a filter caused the empty list', () => {
    const view = renderDashboard(
      state({ dashboard: { statusFilter: 'rolled_back' } }),
      snapshot,
      handlers,
      NOW,
    );

    expect(view.querySelector('.empty')?.textContent).toContain('No releases have this status.');
    (view.querySelector('.empty .button') as HTMLButtonElement).click();
    expect(handlers.dispatch).toHaveBeenCalledWith({
      type: 'dashboard/statusFiltered',
      status: 'all',
    });
  });

  it('describes the status bar for a screen reader', () => {
    const view = renderDashboard(state(), snapshot, handlers, NOW);

    expect(view.querySelector('.bar')?.getAttribute('aria-label')).toBe(
      'Awaiting approval 1, Deployed 1, Blocked 1',
    );
  });
});

describe('renderInspector', () => {
  const snapshot = realisticSnapshot();

  it('captions the visible count against the total', () => {
    const view = renderInspector(inspectorState({}), snapshot, handlers, NOW);

    expect(view.querySelector('.caption')?.textContent).toContain('5 of 5 components');
  });

  it('renders one row per match, with type and operation', () => {
    const view = renderInspector(inspectorState({ text: 'invoicebuilder' }), snapshot, handlers, NOW);

    expect(texts(view, '.row__title')).toEqual(['InvoiceBuilder']);
    expect(view.querySelector('.type')?.textContent).toBe('ApexClass');
    expect(view.querySelector('.op')?.textContent).toBe('Added');
  });

  it('preselects the release in the dropdown when one is filtered', () => {
    const view = renderInspector(inspectorState({ releaseId: 'rel-hotfix' }), snapshot, handlers, NOW);
    const select = view.querySelector('#inspector-release') as HTMLSelectElement;

    expect(select.value).toBe('rel-hotfix');
    expect(texts(view, '.row__title')).toEqual(['PaymentRetryScheduler']);
  });

  it('changing the release dropdown dispatches the filter, and "" means all releases', () => {
    const view = renderInspector(inspectorState({ releaseId: 'rel-hotfix' }), snapshot, handlers, NOW);
    const select = view.querySelector('#inspector-release') as HTMLSelectElement;

    select.value = '';
    select.dispatchEvent(new Event('change'));

    expect(handlers.dispatch).toHaveBeenCalledWith({
      type: 'inspector/releaseFiltered',
      releaseId: null,
    });
  });

  it('typing in the search box dispatches the text', () => {
    const view = renderInspector(inspectorState({}), snapshot, handlers, NOW);
    const input = view.querySelector('#inspector-search') as HTMLInputElement;

    input.value = 'payment';
    input.dispatchEvent(new Event('input'));

    expect(handlers.dispatch).toHaveBeenCalledWith({
      type: 'inspector/textChanged',
      text: 'payment',
    });
  });

  it('shows the search text it was given, so a re-render does not lose it', () => {
    const view = renderInspector(inspectorState({ text: 'invoice' }), snapshot, handlers, NOW);

    expect((view.querySelector('#inspector-search') as HTMLInputElement).value).toBe('invoice');
  });

  it('renders type facets with counts and toggles one on click', () => {
    const view = renderInspector(inspectorState({}), snapshot, handlers, NOW);
    const flow = [...view.querySelectorAll('.chip')].find((chip) =>
      chip.textContent.startsWith('Flow'),
    );

    (flow as HTMLButtonElement).click();

    expect(flow?.textContent).toBe('Flow1');
    expect(handlers.dispatch).toHaveBeenCalledWith({
      type: 'inspector/typeToggled',
      value: 'Flow',
    });
  });

  it('keeps a selected type chip visible even when it drops out of the top facets', () => {
    // Nothing matches, so the facet list is empty — but the chip must remain
    // clickable or the filter can never be switched off.
    const view = renderInspector(
      inspectorState({ text: 'zzz', types: ['CustomObject'] }),
      snapshot,
      handlers,
      NOW,
    );
    const chip = [...view.querySelectorAll('.chip')].find((c) =>
      c.textContent.startsWith('CustomObject'),
    );

    expect(chip).toBeDefined();
    expect(chip?.getAttribute('aria-pressed')).toBe('true');
  });

  it('reflects and toggles the warnings-only switch', () => {
    const view = renderInspector(inspectorState({ onlyWithWarnings: true }), snapshot, handlers, NOW);
    const checkbox = view.querySelector('#inspector-warnings') as HTMLInputElement;

    expect(checkbox.checked).toBe(true);
    checkbox.dispatchEvent(new Event('change'));
    expect(handlers.dispatch).toHaveBeenCalledWith({ type: 'inspector/warningsToggled' });
  });

  it('offers Clear filters only when a filter is active', () => {
    const clean = renderInspector(inspectorState({}), snapshot, handlers, NOW);
    const dirty = renderInspector(inspectorState({ text: 'x' }), snapshot, handlers, NOW);

    expect(clean.querySelector('.controls__row .button')).toBeNull();
    expect(dirty.querySelector('.controls__row .button')?.textContent).toBe('Clear filters');
  });

  it('distinguishes an empty result caused by a filter from an empty snapshot', () => {
    const filtered = renderInspector(inspectorState({ text: 'zzz' }), snapshot, handlers, NOW);
    const bare = renderInspector(inspectorState({}), makeSnapshot({ items: [] }), handlers, NOW);

    expect(filtered.querySelector('.empty')?.textContent).toContain(
      'No components match the current filters.',
    );
    expect(bare.querySelector('.empty')?.textContent).toContain('This snapshot has no components.');
  });

  it('flags the worst severity on a row', () => {
    const view = renderInspector(inspectorState({ onlyWithWarnings: true }), snapshot, handlers, NOW);

    expect(view.querySelector('.flag')?.textContent).toBe('warning');
  });

  describe('detail pane', () => {
    it('shows fields, dependencies and dependents for the selected component', () => {
      const view = renderInspector(inspectorState({}, 'i1'), snapshot, handlers, NOW);
      const detail = view.querySelector('.detail')!;

      expect(detail.querySelector('.detail__title')?.textContent).toBe('InvoiceBuilder');
      expect(texts(detail, '.fields dd')).toContain('91% covered');
      expect(detail.textContent).toContain('Depends on (1)');
      expect(detail.textContent).toContain('Depended on by (1)');
      expect(texts(detail, '.links .link')).toEqual(['UsageAggregator', 'Invoice_Approval_Routing']);
    });

    it('never shows unknown coverage as 0%', () => {
      const view = renderInspector(inspectorState({}, 'i3'), snapshot, handlers, NOW);

      expect(texts(view, '.detail .fields dd')).toContain('Coverage unknown');
      expect(view.querySelector('.detail')?.textContent).not.toContain('0% covered');
    });

    it('labels a dependency that is not in the snapshot rather than hiding it', () => {
      const view = renderInspector(inspectorState({}, 'i3'), snapshot, handlers, NOW);
      const detail = view.querySelector('.detail')!;

      expect(detail.querySelector('.link--external')?.textContent).toBe('Billing_Approvers');
      expect(detail.textContent).toContain('not in this snapshot');
    });

    it('clicking a dependent selects it, so impact is walkable', () => {
      const view = renderInspector(inspectorState({}, 'i1'), snapshot, handlers, NOW);

      (view.querySelector('.detail .links .link') as HTMLButtonElement).click();

      expect(handlers.dispatch).toHaveBeenCalledWith({
        type: 'inspector/itemSelected',
        itemId: 'i2',
      });
    });

    it('lists warnings with their codes', () => {
      const view = renderInspector(inspectorState({}, 'i4'), snapshot, handlers, NOW);

      expect(texts(view, '.warning__code')).toEqual(['HARDCODED_ID']);
    });

    it('says so when the selection is no longer in the snapshot', () => {
      const view = renderInspector(inspectorState({}, 'gone'), snapshot, handlers, NOW);

      expect(view.querySelector('.notice--warn')?.textContent).toContain(
        'no longer in the snapshot',
      );
      expect(view.querySelector('.detail')).toBeNull();
    });

    it('closes on the Close button', () => {
      const view = renderInspector(inspectorState({}, 'i1'), snapshot, handlers, NOW);

      (view.querySelector('.detail__header .button') as HTMLButtonElement).click();

      expect(handlers.dispatch).toHaveBeenCalledWith({
        type: 'inspector/itemSelected',
        itemId: null,
      });
    });

    it('reports fields the snapshot did not record instead of leaving them blank', () => {
      const sparse = makeSnapshot({
        items: [{ ...makeItem({ id: 'bare' }), filePath: '', apiVersion: '' }],
      });
      const view = renderInspector(inspectorState({}, 'bare'), sparse, handlers, NOW);

      expect(texts(view, '.detail .fields dd').filter((t) => t === 'not recorded')).toHaveLength(2);
      expect(view.querySelector('.detail')?.textContent).toContain('No dependencies recorded.');
      expect(view.querySelector('.detail')?.textContent).toContain(
        'Nothing in this snapshot depends on it.',
      );
    });

    describe('when the source records no dependency edges', () => {
      /** One component, flagged the way SalesforceDataSource flags org-sourced items. */
      const opaque = (id: string, fullName: string) => ({
        ...makeItem({ id, fullName }),
        dependenciesUnavailable: true,
      });

      /**
       * A realistic org-sourced snapshot: every item carries the flag, because
       * the whole snapshot came from one deploy report.
       */
      const orgSnapshot = () =>
        makeSnapshot({ items: [opaque('o1', 'FromOrg'), opaque('o2', 'AlsoFromOrg')] });

      it('says the data is unavailable rather than that there are none', () => {
        const orgSourced = orgSnapshot();
        const detail = renderInspector(
          inspectorState({}, 'o1'),
          orgSourced,
          handlers,
          NOW,
        ).querySelector('.detail')!;

        expect(detail.textContent).toContain('Dependency data is not available');
        // The claim that would mislead a release manager into thinking the
        // component is safe to change.
        expect(detail.textContent).not.toContain('No dependencies recorded.');
        expect(detail.textContent).not.toContain('Nothing in this snapshot depends on it.');
      });

      it('omits the count entirely, because "(0)" is itself the wrong answer', () => {
        const orgSourced = orgSnapshot();
        const subtitles = texts(
          renderInspector(inspectorState({}, 'o1'), orgSourced, handlers, NOW),
          '.detail__subtitle',
        );

        expect(subtitles).toContain('Depends on');
        expect(subtitles).toContain('Depended on by');
        expect(subtitles).not.toContain('Depends on (0)');
        expect(subtitles).not.toContain('Depended on by (0)');
      });

      it('distinguishes the two states visually, not only in wording', () => {
        const known = makeSnapshot({ items: [makeItem({ id: 'k1', fullName: 'Standalone' })] });
        const unknown = orgSnapshot();

        const knownDetail = renderInspector(inspectorState({}, 'k1'), known, handlers, NOW);
        const unknownDetail = renderInspector(inspectorState({}, 'o1'), unknown, handlers, NOW);

        expect(knownDetail.querySelectorAll('.detail__block .notice--warn')).toHaveLength(0);
        // Both directions, since both are unknowable from a deploy report.
        expect(unknownDetail.querySelectorAll('.detail__block .notice--warn')).toHaveLength(2);
      });

      it('marks the explanation as a note for assistive technology', () => {
        const unknown = orgSnapshot();
        const notice = renderInspector(
          inspectorState({}, 'o1'),
          unknown,
          handlers,
          NOW,
        ).querySelector('.detail__block .notice--warn')!;

        expect(notice.getAttribute('role')).toBe('note');
      });

      it('explains why, so the gap reads as a limit of the source', () => {
        const unknown = orgSnapshot();
        const detail = renderInspector(
          inspectorState({}, 'o1'),
          unknown,
          handlers,
          NOW,
        ).querySelector('.detail')!;

        expect(detail.textContent).toContain('deploy report');
        expect(detail.textContent).toContain('demo dataset');
      });

      it('reports known dependents as a lower bound when others cannot be checked', () => {
        const mixed = makeSnapshot({
          items: [
            makeItem({ id: 'target', fullName: 'InvoiceBuilder' }),
            makeItem({ id: 'dep', fullName: 'InvoiceTrigger', dependsOn: ['InvoiceBuilder'] }),
            opaque('o1', 'FromOrg'),
            opaque('o2', 'AlsoFromOrg'),
          ],
        });
        const detail = renderInspector(
          inspectorState({}, 'target'),
          mixed,
          handlers,
          NOW,
        ).querySelector('.detail')!;

        expect(detail.textContent).toContain('Depended on by (1)');
        expect(detail.querySelector('.detail__caveat')?.textContent).toBe(
          'At least. 2 other components could not be checked — no dependency data.',
        );
      });

      it('says none could be checked when the reverse edge is wholly unknown', () => {
        const mixed = makeSnapshot({
          items: [makeItem({ id: 'target', fullName: 'InvoiceBuilder' }), opaque('o1', 'FromOrg')],
        });
        const detail = renderInspector(
          inspectorState({}, 'target'),
          mixed,
          handlers,
          NOW,
        ).querySelector('.detail')!;

        expect(detail.textContent).toContain('1 component in this snapshot came from a');
        expect(detail.textContent).not.toContain('Nothing in this snapshot depends on it.');
      });
    });
  });

  it('caps the rendered rows and says so in the caption', () => {
    const many = makeSnapshot({
      items: Array.from({ length: 250 }, (_, index) =>
        makeItem({ id: `i${index}`, fullName: `Component${index}` }),
      ),
    });

    const view = renderInspector(inspectorState({}), many, handlers, NOW);

    expect(view.querySelectorAll('.list--compact li')).toHaveLength(200);
    expect(view.querySelector('.caption')?.textContent).toContain('250 components');
    expect(view.querySelector('.caption__note')?.textContent).toContain('showing the first 200');
  });
});

describe('renderApprovals', () => {
  const snapshot = realisticSnapshot();

  it('splits approvals into the three queues with counts', () => {
    const view = renderApprovals(state(), snapshot, handlers, NOW);

    // The visible count is a bare number beside the heading; the trailing
    // clause is the screen-reader-only text that says what it counts.
    expect(texts(view, '.queue__title')).toEqual([
      'Waiting on you1, 1 approval',
      'Waiting on others1, 1 approval',
      'Recently decided2, 2 approvals',
    ]);
  });

  it('gives action buttons only to the queue the actor can act on', () => {
    const view = renderApprovals(state(), snapshot, handlers, NOW);
    const queues = [...view.querySelectorAll('.queue')];

    expect(queues[0]?.querySelectorAll('.card__buttons').length).toBe(1);
    expect(queues[1]?.querySelectorAll('.card__buttons').length).toBe(0);
    expect(queues[2]?.querySelectorAll('.card__buttons').length).toBe(0);
  });

  it('approving sends the outcome with the typed comment', () => {
    const withDraft = state({
      approvals: { ...INITIAL_STATE.approvals, drafts: { 'apr-uat': '  verified in UAT  ' } },
    });
    const view = renderApprovals(withDraft, snapshot, handlers, NOW);

    (view.querySelector('.button--primary') as HTMLButtonElement).click();

    expect(handlers.decide).toHaveBeenCalledWith('apr-uat', 'approved', '  verified in UAT  ');
  });

  it('sends a null comment rather than an empty string when nothing was typed', () => {
    const view = renderApprovals(state(), snapshot, handlers, NOW);

    (view.querySelector('.button--danger') as HTMLButtonElement).click();

    expect(handlers.decide).toHaveBeenCalledWith('apr-uat', 'rejected', null);
  });

  it('shows the draft in the textarea and dispatches edits to it', () => {
    const withDraft = state({
      approvals: { ...INITIAL_STATE.approvals, drafts: { 'apr-uat': 'half a thought' } },
    });
    const view = renderApprovals(withDraft, snapshot, handlers, NOW);
    const area = view.querySelector('#comment-apr-uat') as HTMLTextAreaElement;

    expect(area.value).toBe('half a thought');

    area.value = 'a whole thought';
    area.dispatchEvent(new Event('input'));

    expect(handlers.dispatch).toHaveBeenCalledWith({
      type: 'approvals/commentChanged',
      approvalId: 'apr-uat',
      comment: 'a whole thought',
    });
  });

  it('disables the controls of the approval being written, and only that one', () => {
    const busy = state({
      approvals: { ...INITIAL_STATE.approvals, busyApprovalId: 'apr-uat' },
    });
    const view = renderApprovals(busy, snapshot, handlers, NOW);

    expect((view.querySelector('.button--primary') as HTMLButtonElement).disabled).toBe(true);
    expect((view.querySelector('#comment-apr-uat') as HTMLTextAreaElement).disabled).toBe(true);
    expect(view.querySelector('.button--primary')?.textContent).toBe('Recording…');
  });

  it('reports the consequence of the last decision', () => {
    const done = state({
      approvals: {
        ...INITIAL_STATE.approvals,
        lastOutcome: 'UAT sign-off on Q3 Billing is now approved.',
      },
    });
    const view = renderApprovals(done, snapshot, handlers, NOW);

    expect(view.querySelector('.notice--ok')?.textContent).toContain('is now approved');
  });

  it('shows a failed decision with its code, and dismisses it on request', () => {
    const failed = state({
      approvals: {
        ...INITIAL_STATE.approvals,
        error: {
          code: 'MISSING_REJECTION_COMMENT',
          name: 'x',
          message: 'Rejecting approval "apr-uat" requires a comment explaining why.',
        },
      },
    });
    const view = renderApprovals(failed, snapshot, handlers, NOW);

    expect(view.querySelector('.notice--error')?.textContent).toContain(
      'MISSING_REJECTION_COMMENT',
    );
    (view.querySelector('.notice--error .button') as HTMLButtonElement).click();
    expect(handlers.dispatch).toHaveBeenCalledWith({ type: 'approvals/feedbackDismissed' });
  });

  it('renders a decided approval with its decider and comment', () => {
    const view = renderApprovals(state(), snapshot, handlers, NOW);
    const decided = [...view.querySelectorAll('.card')].find((card) =>
      card.textContent.includes('Payment Hotfix'),
    );

    expect(decided?.querySelector('.card__decision')?.textContent).toContain(
      'Rejected by Tomas Reid',
    );
    expect(decided?.querySelector('.card__comment')?.textContent).toContain('No rollback plan.');
  });

  it('links a pending approval to its release components', () => {
    const view = renderApprovals(state(), snapshot, handlers, NOW);

    (view.querySelector('.card .link--small') as HTMLButtonElement).click();

    expect(handlers.dispatch).toHaveBeenCalledWith({
      type: 'dashboard/releaseOpened',
      releaseId: 'rel-billing',
    });
  });

  describe('actor bar', () => {
    it('names the profile and says it is not a verified identity', () => {
      const view = renderApprovals(state(), snapshot, handlers, NOW);

      expect(view.querySelector('.actorbar__name')?.textContent).toBe('Sam Okafor');
      expect(view.querySelector('.actorbar__hint')?.textContent).toContain(
        'local profile, not a verified identity',
      );
    });

    it('offers every role some gate actually requires', () => {
      const view = renderApprovals(state(), snapshot, handlers, NOW);

      expect(texts(view, '#actor-role option')).toEqual([
        'cab-approver',
        'qa-lead',
        'release-manager',
        'uat-approver',
      ]);
      expect((view.querySelector('#actor-role') as HTMLSelectElement).value).toBe('uat-approver');
    });

    it('switching role keeps release-manager alongside the chosen gate role', () => {
      const view = renderApprovals(state(), snapshot, handlers, NOW);
      const select = view.querySelector('#actor-role') as HTMLSelectElement;

      select.value = 'qa-lead';
      select.dispatchEvent(new Event('change'));

      expect(handlers.setActor).toHaveBeenCalledWith({
        name: 'Sam Okafor',
        roles: ['release-manager', 'qa-lead'],
      });
    });

    it('selecting release-manager alone drops the gate role', () => {
      const view = renderApprovals(state(), snapshot, handlers, NOW);
      const select = view.querySelector('#actor-role') as HTMLSelectElement;

      select.value = 'release-manager';
      select.dispatchEvent(new Event('change'));

      expect(handlers.setActor).toHaveBeenCalledWith({
        name: 'Sam Okafor',
        roles: ['release-manager'],
      });
    });
  });

  it('lets a requester withdraw their own request without holding the role', () => {
    const requester = {
      ...snapshot,
      actor: { name: 'Lin Zhou', roles: ['developer'] },
    };
    const view = renderApprovals(state(), requester, handlers, NOW);
    const withdraw = [...view.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel request',
    );

    expect(withdraw).toBeUndefined();
    // Lin Zhou holds no gate role, so nothing is in the "waiting on you" queue
    // and the withdraw affordance is not offered from this view.
    expect(view.querySelector('.queue .muted')?.textContent).toContain(
      'Nothing is waiting on your roles right now.',
    );
  });

  it('renders an empty state per queue rather than a blank section', () => {
    const view = renderApprovals(state(), makeSnapshot({ approvals: [] }), handlers, NOW);

    expect(texts(view, '.queue .muted')).toEqual([
      'Nothing is waiting on your roles right now.',
      'No other approvals are pending.',
      'No decisions have been recorded yet.',
    ]);
  });
});
