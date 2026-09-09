/**
 * @vitest-environment jsdom
 *
 * The org strip and its failure states. docs/DATASOURCE.md §8.
 *
 * Every failure mode in §8 gets its own test, because each needs a *different*
 * action: an exhausted API budget must not offer a retry, a revoked permission
 * must offer Grant, and an unreachable org must keep the cache on screen.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrgStatus, SerialisedError } from '../../src/background/messages.js';
import type { Handlers } from '../../src/ui/handlers.js';
import { INITIAL_STATE, isStale, lastRefreshedAt, STALE_AFTER_MS, type ViewState } from '../../src/ui/state.js';
import { renderOrgBar } from '../../src/ui/views/orgbar.js';
import { makeSnapshot } from '../fixtures/snapshot.js';

const NOW = Date.parse('2026-09-07T12:00:00.000Z');
const INSTANCE = 'https://acme.my.salesforce.com';

const CONNECTED: OrgStatus = {
  connected: true,
  instanceUrl: INSTANCE,
  hasHostPermission: true,
  organizationId: '00D5f000000ABCDEAO',
};

function stubHandlers() {
  return {
    dispatch: vi.fn(),
    reload: vi.fn(),
    refreshOrg: vi.fn(),
    connectOrg: vi.fn(),
    disconnectOrg: vi.fn(),
    grantOrgPermission: vi.fn(),
    decide: vi.fn(),
    exportSnapshot: vi.fn(),
    exportRawSnapshot: vi.fn(),
    importSnapshot: vi.fn(),
    reset: vi.fn(),
    setActor: vi.fn(),
  } satisfies Handlers;
}

let handlers: ReturnType<typeof stubHandlers>;

beforeEach(() => {
  handlers = stubHandlers();
});

function state(org: Partial<ViewState['org']> = {}): ViewState {
  return { ...INITIAL_STATE, org: { ...INITIAL_STATE.org, ...org } };
}

function render(
  org: Partial<ViewState['org']> = {},
  lastRefreshed: string | null = null,
): HTMLElement {
  return renderOrgBar({ state: state(org), lastRefreshed, now: NOW, handlers });
}

const $ = (root: HTMLElement, selector: string) => root.querySelector(selector);
const buttons = (root: HTMLElement) =>
  [...root.querySelectorAll('button')].map((button) => button.textContent);
const byLabel = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll('button')].find((button) => button.textContent === label);

describe('local mode', () => {
  it('says the data is local and offers Connect', () => {
    const view = render({ status: { connected: false, hasHostPermission: false } });

    expect($(view, '.orgbar__name')?.textContent).toBe('Local data');
    expect($(view, '.orgbar__meta')?.textContent).toBe('no org connected');
    expect(buttons(view)).toContain('Connect org…');
  });

  it('disables Refresh with a reason rather than hiding it', () => {
    // A control that silently is not there reads as a missing feature.
    const view = render({ status: { connected: false, hasHostPermission: false } });
    const refresh = byLabel(view, 'Refresh')!;

    expect(refresh.disabled).toBe(true);
    expect(refresh.title).toMatch(/Connect an org first/);
  });

  it('shows no staleness banner, because nothing is stale in local mode', () => {
    const view = render({ status: { connected: false, hasHostPermission: false } });

    expect($(view, '.notice')).toBeNull();
  });

  it('renders before the status has loaded, rather than blocking the panel', () => {
    const view = render({ status: null });

    expect($(view, '.orgbar__name')?.textContent).toBe('Local data');
  });
});

describe('connect form', () => {
  it('opens on request and explains what a Consumer Key is', () => {
    const view = render({ status: { connected: false, hasHostPermission: false }, showConnectForm: true });

    expect($(view, '#org-login-url')).not.toBeNull();
    expect($(view, '#org-client-id')).not.toBeNull();
    expect(view.textContent).toContain('not a secret');
    expect(view.textContent).toContain('No client secret is used or accepted');
  });

  it('links to the Connected App instructions rather than naming a file path', () => {
    /*
     * This was the text "See docs/CONNECTED-APP.md." — unreachable from a side
     * panel, where there is no checkout and possibly no repository the reader
     * has ever seen, and it is the one thing that has to happen before anything
     * else works.
     */
    const view = render({ showConnectForm: true });
    const link = $(view, '#org-connected-app-help') as HTMLAnchorElement | null;

    expect(link).not.toBeNull();
    const href = link?.getAttribute('href') ?? '';
    expect(href.startsWith('https://github.com/')).toBe(true);
    expect(href.endsWith('/docs/CONNECTED-APP.md')).toBe(true);
    expect(link?.getAttribute('target')).toBe('_blank');
    // A referrer out of an extension page names the extension id.
    expect(link?.getAttribute('rel')).toBe('noreferrer');
    expect(view.textContent).not.toContain('docs/CONNECTED-APP.md');
  });

  it('keeps Sign in disabled until both fields are filled', () => {
    const empty = render({ showConnectForm: true, clientIdDraft: '' });
    const filled = render({ showConnectForm: true, clientIdDraft: '3MVG9' });

    expect(byLabel(empty, 'Sign in')!.disabled).toBe(true);
    expect(byLabel(filled, 'Sign in')!.disabled).toBe(false);
  });

  it('submits the trimmed values', () => {
    const view = render({
      showConnectForm: true,
      loginUrlDraft: '  https://test.salesforce.com  ',
      clientIdDraft: '  3MVG9  ',
    });

    $(view, '.connectform')!.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(handlers.connectOrg).toHaveBeenCalledWith('https://test.salesforce.com', '3MVG9');
  });

  it('does not submit when a field is empty', () => {
    const view = render({ showConnectForm: true, clientIdDraft: '' });

    $(view, '.connectform')!.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(handlers.connectOrg).not.toHaveBeenCalled();
  });
});

describe('connected', () => {
  it('shows the org host and when it was last read', () => {
    const view = render({ status: CONNECTED }, '2026-09-07T11:30:00.000Z');

    expect($(view, '.orgbar__name')?.textContent).toBe('acme.my.salesforce.com');
    expect($(view, '.orgbar__meta')?.textContent).toBe('refreshed 30m ago');
  });

  it('says so when the org has never been read, and does not imply it is empty', () => {
    const view = render({ status: CONNECTED }, null);

    expect($(view, '.orgbar__meta')?.textContent).toBe('never refreshed');
    expect($(view, '.notice--info')?.textContent).toContain('never been read');
  });

  it('refreshes on request', () => {
    const view = render({ status: CONNECTED }, '2026-09-07T11:59:00.000Z');

    byLabel(view, 'Refresh')!.click();

    expect(handlers.refreshOrg).toHaveBeenCalledOnce();
  });

  it('disables both controls while an action is in flight', () => {
    const view = render({ status: CONNECTED, busy: 'refreshing' }, '2026-09-07T11:59:00.000Z');

    expect(byLabel(view, 'Refreshing…')!.disabled).toBe(true);
    expect(byLabel(view, 'Disconnect')!.disabled).toBe(true);
  });

  it('disconnects on request', () => {
    const view = render({ status: CONNECTED }, '2026-09-07T11:59:00.000Z');

    byLabel(view, 'Disconnect')!.click();

    expect(handlers.disconnectOrg).toHaveBeenCalledOnce();
  });

  it('disables Refresh when Chrome is withholding the host permission', () => {
    const view = render(
      { status: { ...CONNECTED, hasHostPermission: false } },
      '2026-09-07T11:59:00.000Z',
    );

    expect(byLabel(view, 'Refresh')!.disabled).toBe(true);
  });
});

describe('staleness', () => {
  it('warns when the cached data is older than the threshold', () => {
    const old = new Date(NOW - STALE_AFTER_MS - 60_000).toISOString();
    const view = render({ status: CONNECTED }, old);

    expect($(view, '.notice--warn')?.textContent).toMatch(/may be out of date/);
  });

  it('stays quiet when the data is fresh', () => {
    const view = render({ status: CONNECTED }, new Date(NOW - 60_000).toISOString());

    expect($(view, '.notice--warn')).toBeNull();
  });

  it('isStale treats "never refreshed" as not stale', () => {
    expect(isStale(null, NOW)).toBe(false);
  });

  it('isStale ignores an unparseable timestamp rather than crying stale', () => {
    expect(isStale('not a date', NOW)).toBe(false);
  });
});

describe('failure modes (§8)', () => {
  function errorView(error: SerialisedError, lastRefreshed: string | null = '2026-09-07T11:00:00.000Z') {
    return render({ status: CONNECTED, error }, lastRefreshed);
  }

  it('token expired: offers Reconnect', () => {
    const view = errorView({
      code: 'ORG_AUTH_EXPIRED',
      name: 'OrgAuthExpiredError',
      message: 'The Salesforce session has expired and could not be renewed: invalid_grant',
    });

    expect($(view, '.notice--error')?.textContent).toContain('session expired');
    expect(buttons(view)).toContain('Reconnect');
    byLabel(view, 'Reconnect')!.click();
    expect(handlers.dispatch).toHaveBeenCalledWith({ type: 'org/connectFormToggled', open: true });
  });

  it('host permission revoked: offers Grant access', () => {
    const view = errorView({
      code: 'HOST_PERMISSION_REVOKED',
      name: 'HostPermissionRevokedError',
      message: 'Chrome is no longer granting this extension access to https://acme.my.salesforce.com',
    });

    byLabel(view, 'Grant access')!.click();

    expect(handlers.grantOrgPermission).toHaveBeenCalledOnce();
  });

  it('API limit: shows the usage numbers and offers NO retry', () => {
    // Retrying is precisely the thing that would spend the budget we are
    // refusing to spend.
    const view = errorView({
      code: 'API_LIMIT_EXHAUSTED',
      name: 'ApiLimitExhaustedError',
      message: 'Refusing to refresh: this org has used 14,400 of 15,000 daily API calls (96%).',
    });

    const notice = $(view, '.notice--error') as HTMLElement;
    expect(notice.textContent).toContain('14,400 of 15,000');
    // The notice offers Dismiss and nothing else. The bar's own Refresh stays
    // available for a deliberate retry later — the budget resets daily — but
    // the error itself must not invite one.
    expect(buttons(notice)).toEqual(['Dismiss']);
  });

  it('org unreachable: keeps the cache on screen and says it is not live', () => {
    const view = errorView({
      code: 'ORG_UNREACHABLE',
      name: 'OrgUnreachableError',
      message: 'Could not reach the Salesforce org: Failed to fetch',
    });

    expect(buttons(view)).toContain('Try again');
    expect($(view, '.notice--warn')?.textContent).toMatch(/Showing cached org data from .*not live/s);
  });

  it('unparseable response: names the offending field and keeps the cache', () => {
    const view = errorView({
      code: 'ORG_RESPONSE_INVALID',
      name: 'OrgResponseInvalidError',
      message: 'The org\'s response was not valid at "Organization.Id": expected a non-empty string',
    });

    expect($(view, '.notice--error')?.textContent).toContain('Organization.Id');
    expect($(view, '.notice--warn')?.textContent).toContain('Showing cached org data');
  });

  it('sign-in failure: offers to try again', () => {
    const view = errorView({
      code: 'ORG_CONNECT_FAILED',
      name: 'OrgConnectFailedError',
      message: 'Connecting the Salesforce org failed: access_denied',
    });

    expect($(view, '.notice--error')?.textContent).toContain('Sign-in did not complete');
    expect(buttons(view)).toContain('Try again');
  });

  it('always shows the error code, and always allows dismissing', () => {
    const view = errorView({ code: 'ORG_UNREACHABLE', name: 'x', message: 'y' });

    expect(view.textContent).toContain('Error code: ORG_UNREACHABLE');
    byLabel(view, 'Dismiss')!.click();
    expect(handlers.dispatch).toHaveBeenCalledWith({ type: 'org/errorDismissed' });
  });

  it('does not claim stale cached data when there is no cache yet', () => {
    const view = errorView({ code: 'ORG_UNREACHABLE', name: 'x', message: 'y' }, null);

    expect($(view, '.notice--warn')).toBeNull();
  });
});

describe('lastRefreshedAt', () => {
  it('reads the most recent refresh from the audit log', () => {
    const snapshot = {
      ...makeSnapshot(),
      auditLog: [
        { id: '1', at: '2026-09-07T10:00:00.000Z', by: 'x', action: 'snapshot.refreshed' as const, detail: 'a' },
        { id: '2', at: '2026-09-07T10:05:00.000Z', by: 'x', action: 'approval.approved' as const, detail: 'b' },
        { id: '3', at: '2026-09-07T11:00:00.000Z', by: 'x', action: 'snapshot.refreshed' as const, detail: 'c' },
      ],
    };

    expect(lastRefreshedAt(snapshot)).toBe('2026-09-07T11:00:00.000Z');
  });

  it('returns null when nothing has been refreshed, and for no snapshot', () => {
    expect(lastRefreshedAt(makeSnapshot())).toBeNull();
    expect(lastRefreshedAt(null)).toBeNull();
  });
});
