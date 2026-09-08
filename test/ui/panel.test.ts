/**
 * @vitest-environment jsdom
 *
 * Panel controller. Driven through a stub `Client`, so these assert the shell:
 * which message each affordance sends, what is on screen in each load state,
 * and that a decision disables its own control while it is in flight.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SerialisedError } from '../../src/background/messages.js';
import { RemoteError } from '../../src/ui/client.js';
import type { Client } from '../../src/ui/client.js';
import { start } from '../../src/ui/panel.js';
import { makeApproval, makeRelease, makeSnapshot, realisticSnapshot } from '../fixtures/snapshot.js';

type SentRequest = { type: string; [key: string]: unknown };

/**
 * A client whose every response is set per test. A value is resolved as-is; a
 * function is called, which is how a test controls timing or forces a rejection.
 */
type StubResponse = unknown;

/**
 * The panel asks for `org.info` on every start. Answering it by default keeps
 * these tests about the surface they are actually testing; a test that cares
 * about the org overrides it.
 */
const DEFAULT_RESPONSES: Record<string, StubResponse> = {
  'org.info': { connected: false, hasHostPermission: false },
};

function stubClient(responses: Record<string, StubResponse>) {
  const sent: SentRequest[] = [];
  // The panel asks for `org.info` on every start; answering it by default keeps
  // these tests about the surface they are actually testing. A test that cares
  // about the org overrides it.
  const client: Client = {
    send: ((request: SentRequest) => {
      sent.push(request);
      // Looked up per call, not copied up front: several tests swap a response
      // in after `start` to simulate the world changing underneath the panel.
      const response = responses[request.type] ?? DEFAULT_RESPONSES[request.type];
      if (typeof response === 'function') return (response as () => Promise<unknown>)();
      if (response === undefined) {
        return Promise.reject(new Error(`stub client has no response for ${request.type}`));
      }
      return Promise.resolve(response);
    }) as Client['send'],
  };
  return { client, sent };
}

/** Lets every queued promise callback run, then the re-render that follows. */
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('start', () => {
  it('shows a loading state immediately and requests the snapshot', () => {
    const { sent } = renderPanel({ 'snapshot.load': realisticSnapshot() });

    expect(root.querySelector('.loading')?.textContent).toContain('Loading release data…');
    expect(root.querySelector('.loading')?.getAttribute('aria-live')).toBe('polite');
    expect(sent).toContainEqual({ type: 'snapshot.load' });
  });

  it('renders the dashboard once the snapshot arrives', async () => {
    renderPanel({ 'snapshot.load': realisticSnapshot() });
    await settle();

    expect(root.querySelector('.loading')).toBeNull();
    expect(root.querySelector('[aria-label="Release dashboard"]')).not.toBeNull();
    expect(root.querySelector('.summary__headline')?.textContent).toContain('3 releases tracked');
  });

  it('switches tab on click and keeps only one tab selected', async () => {
    renderPanel({ 'snapshot.load': realisticSnapshot() });
    await settle();

    (root.querySelector('#tab-inspector') as HTMLButtonElement).click();

    expect(root.querySelector('[aria-label="Metadata inspector"]')).not.toBeNull();
    expect(root.querySelectorAll('.tab[aria-selected="true"]')).toHaveLength(1);
    expect(root.querySelector('#tab-inspector')?.getAttribute('aria-selected')).toBe('true');
  });

  it('badges the approvals tab with the count waiting on the actor', async () => {
    renderPanel({ 'snapshot.load': realisticSnapshot() });
    await settle();

    expect(root.querySelector('.tab__badge')?.textContent).toBe('1');
  });

  it('shows no badge when nothing is waiting on the actor', async () => {
    renderPanel({ 'snapshot.load': makeSnapshot() });
    await settle();

    expect(root.querySelector('.tab__badge')).toBeNull();
  });

  it('announces demo data and offers to start empty', async () => {
    const { sent } = renderPanel({
      'snapshot.load': { ...realisticSnapshot(), isDemoData: true },
      'snapshot.reset': makeSnapshot({ releases: [] }),
    });
    await settle();

    expect(root.querySelector('.notice--info')?.textContent).toContain('Demo data');

    (root.querySelector('.notice--info .button') as HTMLButtonElement).click();
    await settle();

    expect(sent).toContainEqual({ type: 'snapshot.reset', seed: 'empty' });
    expect(root.querySelector('.notice--info')).toBeNull();
  });

  it('hides the demo banner for real data', async () => {
    renderPanel({ 'snapshot.load': realisticSnapshot() });
    await settle();

    expect(root.querySelector('.notice--info')).toBeNull();
  });

  describe('error state', () => {
    it('shows the message and code, and retries on request', async () => {
      const { sent } = renderPanel({
        'snapshot.load': () =>
          Promise.reject(
            new RemoteError({
              code: 'STORAGE_UNAVAILABLE',
              name: 'StorageUnavailableError',
              message: 'Extension storage failed during reading "x": disk on fire',
            }),
          ),
      });
      await settle();

      const notice = root.querySelector('.notice--error')!;
      expect(notice.getAttribute('role')).toBe('alert');
      expect(notice.textContent).toContain('disk on fire');
      expect(notice.textContent).toContain('Error code: STORAGE_UNAVAILABLE');

      (notice.querySelector('.button--primary') as HTMLButtonElement).click();
      expect(sent.filter((request) => request.type === 'snapshot.load')).toHaveLength(2);
    });

    it('offers rescue before reset for a snapshot it cannot parse', async () => {
      renderPanel({
        'snapshot.load': () =>
          Promise.reject(
            new RemoteError({
              code: 'SNAPSHOT_VALIDATION',
              name: 'SnapshotValidationError',
              message: 'Snapshot is not valid at "snapshot.releases[0].status"',
            }),
          ),
      });
      await settle();

      const labels = [...root.querySelectorAll('.notice__actions .button')].map(
        (button) => button.textContent,
      );
      // Export must come before the destructive option.
      expect(labels).toEqual(['Retry', 'Export raw data', 'Reset to demo data']);
    });

    it('offers only Retry for a failure that resetting would not fix', async () => {
      renderPanel({
        'snapshot.load': () =>
          Promise.reject(
            new RemoteError({
              code: 'WORKER_UNAVAILABLE',
              name: 'WorkerUnavailable',
              message: 'The extension background worker did not respond.',
            }),
          ),
      });
      await settle();

      expect(
        [...root.querySelectorAll('.notice__actions .button')].map((b) => b.textContent),
      ).toEqual(['Retry']);
    });
  });

  describe('decisions', () => {
    const pending = makeSnapshot({
      releases: [makeRelease({ id: 'rel-1', status: 'awaiting_approval' })],
      approvals: [makeApproval({ id: 'apr-1', requiredRole: 'uat-approver' })],
    });

    it('sends the decision and adopts the snapshot the worker returns', async () => {
      const decided = makeSnapshot({
        releases: [makeRelease({ id: 'rel-1', status: 'scheduled' })],
        approvals: [makeApproval({ id: 'apr-1', status: 'approved' })],
      });
      const { sent } = renderPanel({
        'snapshot.load': pending,
        'approval.decide': {
          snapshot: decided,
          approval: makeApproval({ id: 'apr-1', status: 'approved' }),
          release: makeRelease({ id: 'rel-1', status: 'scheduled' }),
          statusChange: { from: 'awaiting_approval', to: 'scheduled' },
        },
      });
      await settle();

      (root.querySelector('#tab-approvals') as HTMLButtonElement).click();
      (root.querySelector('[aria-label="Approvals"] .button--primary') as HTMLButtonElement).click();
      await settle();

      expect(sent).toContainEqual({
        type: 'approval.decide',
        approvalId: 'apr-1',
        outcome: 'approved',
        comment: null,
      });
      expect(root.querySelector('.notice--ok')?.textContent).toContain(
        'moved from awaiting_approval to scheduled',
      );
      // The decision moved the approval out of the actionable queue.
      expect(root.querySelector('[aria-label="Approvals"] .button--primary')).toBeNull();
    });

    it('disables the control while the decision is in flight', async () => {
      let release: (value: unknown) => void = () => undefined;
      renderPanel({
        'snapshot.load': pending,
        'approval.decide': () => new Promise((resolve) => (release = resolve)),
      });
      await settle();

      (root.querySelector('#tab-approvals') as HTMLButtonElement).click();
      (root.querySelector('[aria-label="Approvals"] .button--primary') as HTMLButtonElement).click();

      const button = root.querySelector(
        '[aria-label="Approvals"] .button--primary',
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe('Recording…');

      release({
        snapshot: pending,
        approval: makeApproval({ id: 'apr-1', status: 'approved' }),
        release: makeRelease({ id: 'rel-1' }),
        statusChange: null,
      });
    });

    it('surfaces a refused decision and keeps the control usable', async () => {
      renderPanel({
        'snapshot.load': pending,
        'approval.decide': () =>
          Promise.reject(
            new RemoteError({
              code: 'MISSING_REJECTION_COMMENT',
              name: 'MissingRejectionCommentError',
              message: 'Rejecting approval "apr-1" requires a comment explaining why.',
            }),
          ),
      });
      await settle();

      (root.querySelector('#tab-approvals') as HTMLButtonElement).click();
      (root.querySelector('.button--danger') as HTMLButtonElement).click();
      await settle();

      expect(root.querySelector('.notice--error')?.textContent).toContain('requires a comment');
      expect((root.querySelector('.button--danger') as HTMLButtonElement).disabled).toBe(false);
    });

    it('keeps the typed comment across the re-render a refusal causes', async () => {
      renderPanel({
        'snapshot.load': pending,
        'approval.decide': () =>
          Promise.reject(
            new RemoteError({
              code: 'MISSING_REJECTION_COMMENT',
              name: 'x',
              message: 'needs a comment',
            }),
          ),
      });
      await settle();
      (root.querySelector('#tab-approvals') as HTMLButtonElement).click();

      const area = root.querySelector('#comment-apr-1') as HTMLTextAreaElement;
      area.value = 'half a thought';
      area.dispatchEvent(new Event('input'));

      (root.querySelector('.button--danger') as HTMLButtonElement).click();
      await settle();

      expect((root.querySelector('#comment-apr-1') as HTMLTextAreaElement).value).toBe(
        'half a thought',
      );
    });
  });

  describe('toolbar', () => {
    it('exports the snapshot as a named downloadable file', async () => {
      const createObjectURL = vi.fn(() => 'blob:fake');
      const revokeObjectURL = vi.fn();
      vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

      // jsdom cannot follow a download, and warns loudly if it tries; capture
      // the anchor instead, which also lets us assert what it was given.
      const anchors: HTMLAnchorElement[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        anchors.push(this);
      });

      const { sent } = renderPanel({
        'snapshot.load': realisticSnapshot(),
        'snapshot.export': { filename: 'sf-releaselens-x.json', json: '{}\n' },
      });
      await settle();

      clickToolbar('Export');
      await settle();

      expect(sent).toContainEqual({ type: 'snapshot.export' });
      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(anchors).toHaveLength(1);
      expect(anchors[0]?.getAttribute('download')).toBe('sf-releaselens-x.json');
      expect(anchors[0]?.getAttribute('href')).toBe('blob:fake');
      // The object URL is released rather than leaked for the panel's lifetime.
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');

      vi.unstubAllGlobals();
    });

    it('reloads on request', async () => {
      const { sent } = renderPanel({ 'snapshot.load': realisticSnapshot() });
      await settle();

      clickToolbar('Reload');

      expect(sent.filter((request) => request.type === 'snapshot.load')).toHaveLength(2);
      expect(root.querySelector('.loading')).not.toBeNull();
    });

    it('reads a chosen file and sends its text to be imported', async () => {
      const imported = makeSnapshot({ releases: [makeRelease({ name: 'Imported' })] });
      const { sent } = renderPanel({
        'snapshot.load': realisticSnapshot(),
        'snapshot.import': imported,
      });
      await settle();

      // The file input is created on demand, so intercept its click.
      const clicked = interceptFilePicker('{"schemaVersion":1}');
      clickToolbar('Import');
      await clicked;
      await settle();

      expect(sent).toContainEqual({ type: 'snapshot.import', text: '{"schemaVersion":1}' });
      expect(root.querySelector('.row__title')?.textContent).toBe('Imported');
    });

    it('reports an import failure without losing what is on screen afterwards', async () => {
      const { sent } = renderPanel({
        'snapshot.load': realisticSnapshot(),
        'snapshot.import': () =>
          Promise.reject(
            new RemoteError({ code: 'IMPORT_FORMAT', name: 'x', message: 'not valid JSON.' }),
          ),
      });
      await settle();

      const clicked = interceptFilePicker('not json');
      clickToolbar('Import');
      await clicked;
      await settle();

      expect(sent).toContainEqual({ type: 'snapshot.import', text: 'not json' });
      expect(root.querySelector('.notice--error')?.textContent).toContain('not valid JSON.');
    });
  });

  describe('onExternalChange', () => {
    it('re-reads without blanking what is already on screen', async () => {
      const updated = makeSnapshot({ releases: [makeRelease({ name: 'Updated elsewhere' })] });
      const responses: Record<string, unknown> = { 'snapshot.load': realisticSnapshot() };
      const { client, sent } = stubClient(responses);
      const panel = start(root, client);
      await settle();

      responses['snapshot.load'] = updated;
      panel.onExternalChange();

      // No loading state: the previous snapshot stays up while the read runs.
      expect(root.querySelector('.loading')).toBeNull();
      expect(root.querySelector('.summary__headline')?.textContent).toContain('3 releases');

      await settle();

      expect(root.querySelector('.row__title')?.textContent).toBe('Updated elsewhere');
      expect(sent.filter((request) => request.type === 'snapshot.load')).toHaveLength(2);
    });
  });

  it('changing the acting role sends the new profile', async () => {
    const snapshot = realisticSnapshot();
    const { sent } = renderPanel({
      'snapshot.load': snapshot,
      'actor.set': { ...snapshot, actor: { name: 'Sam Okafor', roles: ['release-manager', 'qa-lead'] } },
    });
    await settle();

    (root.querySelector('#tab-approvals') as HTMLButtonElement).click();
    const select = root.querySelector('#actor-role') as HTMLSelectElement;
    select.value = 'qa-lead';
    select.dispatchEvent(new Event('change'));
    await settle();

    expect(sent).toContainEqual({
      type: 'actor.set',
      actor: { name: 'Sam Okafor', roles: ['release-manager', 'qa-lead'] },
    });
    // The badge follows the new role: apr-qa is now the actionable one.
    expect(root.querySelector('.tab__badge')?.textContent).toBe('1');
  });

  it('keeps the caret in the search box across the re-render a keystroke causes', async () => {
    renderPanel({ 'snapshot.load': realisticSnapshot() });
    await settle();
    (root.querySelector('#tab-inspector') as HTMLButtonElement).click();

    const input = root.querySelector('#inspector-search') as HTMLInputElement;
    input.focus();
    input.value = 'invoice';
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new Event('input'));

    const rebuilt = root.querySelector('#inspector-search') as HTMLInputElement;
    expect(document.activeElement).toBe(rebuilt);
    expect(rebuilt.selectionStart).toBe(3);
  });

  // --- helpers ---------------------------------------------------------------

  function renderPanel(responses: Record<string, StubResponse>) {
    const { client, sent } = stubClient(responses);
    start(root, client);
    return { sent };
  }

  function clickToolbar(label: string): void {
    const button = [...root.querySelectorAll('.shell__actions .button')].find(
      (candidate) => candidate.textContent === label,
    );
    if (button === undefined) throw new Error(`No toolbar button labelled "${label}"`);
    (button as HTMLButtonElement).click();
  }

  /**
   * The controller creates a detached `<input type="file">` and clicks it, which
   * jsdom cannot fulfil. This stands in for the user choosing a file.
   */
  function interceptFilePicker(contents: string): Promise<void> {
    return new Promise((resolve) => {
      const original = HTMLInputElement.prototype.click;
      vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
        this: HTMLInputElement,
      ) {
        if (this.type !== 'file') {
          original.call(this);
          return;
        }
        Object.defineProperty(this, 'files', {
          value: [{ text: () => Promise.resolve(contents) }],
          configurable: true,
        });
        this.dispatchEvent(new Event('change'));
        resolve();
      });
    });
  }
});

describe('error flattening at the panel boundary', () => {
  it('renders an unexpected thrown value as an UNEXPECTED error rather than crashing', async () => {
    // The point of this test is a rejection that is not an Error.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const { client } = stubClient({ 'snapshot.load': () => Promise.reject('a bare string') });
    start(root, client);
    await settle();

    const notice = root.querySelector('.notice--error')!;
    expect(notice.textContent).toContain('a bare string');
    expect(notice.textContent).toContain('Error code: UNEXPECTED');
  });

  it('accepts a SerialisedError shape from any source', () => {
    const error: SerialisedError = { code: 'X', name: 'X', message: 'y' };

    expect(error.code).toBe('X');
  });
});
