/**
 * @vitest-environment jsdom
 *
 * The accessibility contract, asserted rather than assumed.
 *
 * These are not "does it have an aria attribute" tests. Each one pins a
 * property that breaks silently: focus surviving a full re-render, ids staying
 * unique, one live region rather than a new one per render, and the tab strip
 * behaving the way the ARIA tabs pattern says it does. All of them are
 * invisible on screen, which is exactly why they need a test.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { Client } from '../../src/ui/client.js';
import { start } from '../../src/ui/panel.js';
import { describeAnnouncement } from '../../src/ui/announce.js';
import { INITIAL_STATE, reduce, type ViewState } from '../../src/ui/state.js';
import {
  makeApproval,
  makeRelease,
  makeSnapshot,
  realisticSnapshot,
} from '../fixtures/snapshot.js';

const DEFAULT_RESPONSES: Record<string, unknown> = {
  'org.info': { connected: false, hasHostPermission: false },
  'snapshot.load': realisticSnapshot(),
};

/** Marks a message type as one the worker refuses, rather than one left unstubbed. */
const FAILS = Symbol('fails');

function stubClient(responses: Record<string, unknown> = {}) {
  return {
    send: ((request: { type: string }) => {
      const response = Object.hasOwn(responses, request.type)
        ? responses[request.type]
        : DEFAULT_RESPONSES[request.type];
      if (response === FAILS) {
        return Promise.reject(new Error('the stored snapshot is not valid'));
      }
      if (response === undefined) {
        return Promise.reject(new Error(`no stub response for ${request.type}`));
      }
      return Promise.resolve(response);
    }) as Client['send'],
  };
}

/** The shape `approval.decide` resolves with, so a decision can succeed. */
const DECISION = {
  approval: makeApproval({ id: 'apr-1', status: 'approved' }),
  release: makeRelease({ id: 'rel-1', status: 'scheduled' }),
  statusChange: { from: 'awaiting_approval', to: 'scheduled' },
};

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById('root')!;
});

async function openPanel(responses: Record<string, unknown> = {}): Promise<void> {
  start(root, stubClient(responses));
  await settle();
}

function focusable(): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]'),
  ].filter((node) => !node.hasAttribute('data-focus-fallback') && node.tabIndex !== -1);
}

function press(target: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('focus survives a re-render', () => {
  /*
   * The panel rebuilds its whole body on every state change and puts focus back
   * by id. A control with no id is therefore a control that drops a keyboard
   * user onto the document body every time they use it — the most disabling bug
   * this UI can have, and completely invisible to a mouse user.
   */
  it('gives every focusable control a stable id', async () => {
    await openPanel();

    for (const tab of ['dashboard', 'inspector', 'approvals']) {
      (root.querySelector(`#tab-${tab}`) as HTMLButtonElement).click();
      const anonymous = focusable().filter((node) => node.id === '');
      expect(
        anonymous.map((node) => `${node.tagName.toLowerCase()}: ${node.textContent}`),
      ).toEqual([]);
    }
  });

  it('keeps ids unique, so restoring focus cannot land on the wrong control', async () => {
    await openPanel();

    for (const tab of ['dashboard', 'inspector', 'approvals']) {
      (root.querySelector(`#tab-${tab}`) as HTMLButtonElement).click();
      const ids = [...root.querySelectorAll<HTMLElement>('[id]')].map((node) => node.id);
      expect(ids).toEqual([...new Set(ids)]);
    }
  });

  it('leaves focus on a dashboard chip after it is activated', async () => {
    await openPanel();
    const chip = root.querySelector('#chip-status-blocked') as HTMLButtonElement;

    chip.focus();
    chip.click();

    expect(document.activeElement?.id).toBe('chip-status-blocked');
  });

  it('leaves focus on a component row after selecting it', async () => {
    await openPanel();
    (root.querySelector('#tab-inspector') as HTMLButtonElement).click();
    const row = root.querySelector('.list--compact .row') as HTMLButtonElement;
    const id = row.id;

    row.focus();
    row.click();

    expect(id).not.toBe('');
    expect(document.activeElement?.id).toBe(id);
  });

  it('moves focus to the notice when the control the user was on disappears', async () => {
    await openPanel({ 'approval.decide': { ...DECISION, snapshot: realisticSnapshot() } });
    (root.querySelector('#tab-approvals') as HTMLButtonElement).click();
    const approve = root.querySelector('.card__buttons .button--primary') as HTMLButtonElement;
    expect(approve).not.toBeNull();

    approve.focus();
    approve.click();
    await settle();

    // The card moved to the decided queue, taking the button with it. Landing
    // on the body would mean tabbing from the top of the panel again.
    expect(document.activeElement?.id).toBe('approvals-feedback');
  });

  it('does not steal focus when nothing had it', async () => {
    await openPanel();

    expect(document.activeElement).toBe(document.body);
  });
});

describe('tab strip follows the ARIA tabs pattern', () => {
  it('exposes exactly one tab in the Tab order, the selected one', async () => {
    await openPanel();
    const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"]')];

    expect(tabs.filter((tab) => tab.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(
      tabs.find((tab) => tab.getAttribute('tabindex') === '0')?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('points every tab at the panel it controls, and labels that panel', async () => {
    await openPanel();
    const body = root.querySelector('#panel-body')!;

    for (const tab of root.querySelectorAll('[role="tab"]')) {
      expect(tab.getAttribute('aria-controls')).toBe('panel-body');
    }
    expect(body.getAttribute('role')).toBe('tabpanel');
    expect(body.getAttribute('aria-labelledby')).toBe('tab-dashboard');
  });

  it('moves between tabs with the arrow keys, wrapping at both ends', async () => {
    await openPanel();

    press(root.querySelector('#tab-dashboard')!, 'ArrowRight');
    expect(root.querySelector('#tab-inspector')?.getAttribute('aria-selected')).toBe('true');

    press(root.querySelector('#tab-inspector')!, 'ArrowLeft');
    expect(root.querySelector('#tab-dashboard')?.getAttribute('aria-selected')).toBe('true');

    press(root.querySelector('#tab-dashboard')!, 'ArrowLeft');
    expect(root.querySelector('#tab-approvals')?.getAttribute('aria-selected')).toBe('true');

    press(root.querySelector('#tab-approvals')!, 'ArrowRight');
    expect(root.querySelector('#tab-dashboard')?.getAttribute('aria-selected')).toBe('true');
  });

  it('supports Home and End', async () => {
    await openPanel();

    press(root.querySelector('#tab-dashboard')!, 'End');
    expect(root.querySelector('#tab-approvals')?.getAttribute('aria-selected')).toBe('true');

    press(root.querySelector('#tab-approvals')!, 'Home');
    expect(root.querySelector('#tab-dashboard')?.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps focus on the tab the arrow key moved to', async () => {
    await openPanel();
    const first = root.querySelector('#tab-dashboard') as HTMLElement;

    first.focus();
    press(first, 'ArrowRight');

    expect(document.activeElement?.id).toBe('tab-inspector');
  });

  it('swallows the arrow key so the panel underneath does not scroll', async () => {
    await openPanel();

    expect(press(root.querySelector('#tab-dashboard')!, 'ArrowRight').defaultPrevented).toBe(true);
  });

  it('ignores keys that are not navigation', async () => {
    await openPanel();

    const event = press(root.querySelector('#tab-dashboard')!, 'a');

    expect(event.defaultPrevented).toBe(false);
    expect(root.querySelector('#tab-dashboard')?.getAttribute('aria-selected')).toBe('true');
  });
});

describe('live regions', () => {
  it('creates them once, outside the subtree the render replaces', async () => {
    await openPanel();
    const polite = root.querySelector('#panel-status')!;

    (root.querySelector('#tab-inspector') as HTMLButtonElement).click();
    (root.querySelector('#tab-approvals') as HTMLButtonElement).click();

    // Same node, not a replacement: a live region that is destroyed and
    // recreated announces nothing dependably.
    expect(root.querySelector('#panel-status')).toBe(polite);
    expect(polite.parentElement).toBe(root);
    expect(root.querySelector('.mount')?.contains(polite)).toBe(false);
  });

  it('announces the load politely, with the counts a sighted user can see', async () => {
    await openPanel();

    expect(root.querySelector('#panel-status')?.textContent).toBe(
      '3 releases loaded, 1 needs attention.',
    );
    expect(root.querySelector('#panel-alert')?.textContent).toBe('');
  });

  it('interrupts with an alert when loading fails, and says nothing politely', async () => {
    start(root, stubClient({ 'snapshot.load': FAILS }));
    await settle();

    expect(root.querySelector('#panel-alert')?.textContent).toBe(
      'Could not load release data. the stored snapshot is not valid',
    );
    // Saying it on both channels means hearing it twice.
    expect(root.querySelector('#panel-status')?.textContent).toBe('');
  });

  it('announces a recorded decision', async () => {
    await openPanel({ 'approval.decide': { ...DECISION, snapshot: realisticSnapshot() } });
    (root.querySelector('#tab-approvals') as HTMLButtonElement).click();
    (root.querySelector('.card__buttons .button--primary') as HTMLButtonElement).click();
    await settle();

    expect(root.querySelector('#panel-status')?.textContent).toContain('Decision recorded');
  });

  it('stays silent when a re-render changes nothing worth saying', async () => {
    await openPanel();
    const polite = root.querySelector('#panel-status')!;
    const before = polite.firstChild;

    (root.querySelector('#tab-inspector') as HTMLButtonElement).click();

    // Rewriting identical text makes some screen readers repeat themselves on
    // every keystroke, so the text node itself must be untouched.
    expect(polite.firstChild).toBe(before);
  });
});

describe('describeAnnouncement', () => {
  const ready = (): ViewState =>
    reduce(INITIAL_STATE, { type: 'load/succeeded', snapshot: realisticSnapshot() });

  it('reports the release counts once loaded', () => {
    expect(describeAnnouncement(ready()).polite).toBe('3 releases loaded, 1 needs attention.');
  });

  it('says so plainly when nothing needs attention', () => {
    const state = reduce(INITIAL_STATE, {
      type: 'load/succeeded',
      snapshot: makeSnapshot({ releases: [] }),
    });

    expect(describeAnnouncement(state).polite).toBe('0 releases loaded, none need attention.');
  });

  it('announces an org refresh while it is in flight', () => {
    const state = reduce(ready(), { type: 'org/actionStarted', action: 'refreshing' });

    expect(describeAnnouncement(state).polite).toBe('Refreshing from the org.');
    expect(describeAnnouncement(state).assertive).toBe('');
  });

  it('puts every failure on the assertive channel and nothing on the polite one', () => {
    const state = reduce(INITIAL_STATE, {
      type: 'load/failed',
      error: { code: 'SNAPSHOT_VALIDATION', message: 'the stored snapshot is not valid' },
    });

    expect(describeAnnouncement(state)).toEqual({
      polite: '',
      assertive: 'Could not load release data. the stored snapshot is not valid',
    });
  });

  it('is quiet before the first load resolves', () => {
    expect(describeAnnouncement(INITIAL_STATE)).toEqual({
      polite: 'Loading release data.',
      assertive: '',
    });
  });
});

describe('accessible names', () => {
  it('names each status chip so its count reads as a count', async () => {
    await openPanel();

    expect(root.querySelector('#chip-status-blocked')?.getAttribute('aria-label')).toBe(
      'Blocked: 1 release',
    );
  });

  it('distinguishes the approve buttons of different approvals', async () => {
    await openPanel();
    (root.querySelector('#tab-approvals') as HTMLButtonElement).click();

    const names = [...root.querySelectorAll('.card__buttons button')].map((button) =>
      button.getAttribute('aria-label'),
    );

    expect(names.every((name) => name !== null && name !== '')).toBe(true);
    expect(names).toEqual([...new Set(names)]);
    expect(names.some((name) => name?.startsWith('Approve ') === true)).toBe(true);
  });

  it('names the toolbar buttons by what they act on', async () => {
    await openPanel();

    expect(root.querySelector('#toolbar-export')?.getAttribute('aria-label')).toBe(
      'Export: Download the current snapshot as JSON',
    );
  });

  it('hides the decorative status bar and badge from the accessibility tree', async () => {
    await openPanel();

    expect(root.querySelector('.bar')?.getAttribute('role')).toBe('img');
    expect(root.querySelector('.bar')?.getAttribute('aria-label')).toContain('Blocked 1');
    expect(root.querySelector('.tab__badge')?.getAttribute('aria-hidden')).toBe('true');
  });
});
