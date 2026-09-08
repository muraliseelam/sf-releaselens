/**
 * The org connection strip and its failure states. docs/DATASOURCE.md §8.
 *
 * Every failure in §8 gets a distinct state here, because they need distinct
 * actions: a revoked permission needs a Grant button, an expired token needs
 * Reconnect, an exhausted API budget needs neither and must not offer a retry
 * that would spend more of it.
 *
 * The rule underneath all of them: **the panel is never blanked.** A refresh
 * that fails leaves the cached snapshot on screen with a banner explaining what
 * it is looking at.
 */

import type { OrgStatus, SerialisedError } from '../../background/messages.js';
import { el } from '../dom.js';
import { absoluteTime, relativeTime } from '../format.js';
import type { Handlers } from '../handlers.js';
import { isStale, type ViewState } from '../state.js';

export interface OrgBarInput {
  state: ViewState;
  lastRefreshed: string | null;
  now: number;
  handlers: Handlers;
}

export function renderOrgBar(input: OrgBarInput): HTMLElement {
  const { state, handlers } = input;
  const org = state.org;
  const status = org.status;

  return el('div', { className: 'orgstrip' }, [
    status?.connected === true
      ? renderConnected(status, input)
      : renderDisconnected(org.busy === 'connecting', handlers),
    org.showConnectForm ? renderConnectForm(input) : null,
    org.error === null ? null : renderOrgError(org.error, status, handlers),
    renderStaleness(input),
  ]);
}

function renderConnected(status: OrgStatus, input: OrgBarInput): HTMLElement {
  const { state, lastRefreshed, now, handlers } = input;
  const busy = state.org.busy;
  const host = status.instanceUrl === undefined ? 'unknown org' : hostOf(status.instanceUrl);

  return el('div', { className: 'orgbar' }, [
    el('span', { className: 'orgbar__dot orgbar__dot--on', attrs: { 'aria-hidden': 'true' } }),
    el('span', { className: 'orgbar__name', text: host, title: status.instanceUrl ?? '' }),

    el('span', {
      className: 'orgbar__meta',
      text:
        lastRefreshed === null
          ? 'never refreshed'
          : `refreshed ${relativeTime(lastRefreshed, now)}`,
      ...(lastRefreshed === null ? {} : { title: absoluteTime(lastRefreshed) }),
    }),

    el('div', { className: 'orgbar__actions' }, [
      el('button', {
        className: 'button button--primary',
        text: busy === 'refreshing' ? 'Refreshing…' : 'Refresh',
        title: 'Read the org now. Nothing refreshes on its own.',
        attrs: {
          id: 'org-refresh',
          type: 'button',
          'aria-label': `Refresh from ${host}. Reads the org now; nothing refreshes on its own.`,
          ...(busy !== null || !status.hasHostPermission ? { disabled: 'disabled' } : {}),
        },
        on: { click: () => handlers.refreshOrg() },
      }),
      el('button', {
        className: 'button button--quiet',
        text: busy === 'disconnecting' ? 'Disconnecting…' : 'Disconnect',
        title: 'Revoke the token and return to local data',
        attrs: {
          id: 'org-disconnect',
          type: 'button',
          'aria-label': `Disconnect from ${host}. Revokes the token and returns to local data.`,
          ...(busy !== null ? { disabled: 'disabled' } : {}),
        },
        on: { click: () => handlers.disconnectOrg() },
      }),
      diagnosticsButton(handlers),
    ]),
  ]);
}

function renderDisconnected(connecting: boolean, handlers: Handlers): HTMLElement {
  return el('div', { className: 'orgbar' }, [
    el('span', { className: 'orgbar__dot', attrs: { 'aria-hidden': 'true' } }),
    el('span', { className: 'orgbar__name', text: 'Local data' }),
    el('span', {
      className: 'orgbar__meta',
      text: 'no org connected',
      title: 'Everything on screen is stored on this machine. Nothing reaches a Salesforce org.',
    }),
    el('div', { className: 'orgbar__actions' }, [
      // Disabled with a reason rather than hidden: a Refresh that silently is
      // not there reads as a missing feature.
      el('button', {
        className: 'button',
        text: 'Refresh',
        title: 'Connect an org first. There is nothing to refresh from in local mode.',
        attrs: {
          id: 'org-refresh',
          type: 'button',
          disabled: 'disabled',
          // A disabled control gives no reason on its own; say it in the name.
          'aria-label': 'Refresh, unavailable: connect an org first.',
        },
      }),
      el('button', {
        className: 'button button--primary',
        text: connecting ? 'Connecting…' : 'Connect org…',
        attrs: {
          id: 'org-connect',
          type: 'button',
          'aria-expanded': 'false',
          ...(connecting ? { disabled: 'disabled' } : {}),
        },
        on: { click: () => handlers.dispatch({ type: 'org/connectFormToggled', open: true }) },
      }),
      diagnosticsButton(handlers),
    ]),
  ]);
}

/**
 * Downloads a report that is safe to attach to a public issue.
 *
 * Present in both org states, because half the questions worth asking are about
 * a connection that never completed. The title says what it contains, so nobody
 * has to take "safe to share" on trust before clicking it — `core/diagnostics.ts`
 * builds it field by field from counts and versions rather than filtering org
 * data out afterwards.
 */
function diagnosticsButton(handlers: Handlers): HTMLElement {
  return el('button', {
    className: 'button button--quiet',
    text: 'Diagnostics',
    title:
      'Download a report for a bug: versions, counts and shapes. No org name, ' +
      'URL, token, release name or component name is included.',
    attrs: {
      id: 'org-diagnostics',
      type: 'button',
      'aria-label': 'Download a diagnostic report. Contains no org data.',
    },
    on: { click: () => handlers.downloadDiagnostics() },
  });
}

function renderConnectForm(input: OrgBarInput): HTMLElement {
  const { state, handlers } = input;
  const { loginUrlDraft, clientIdDraft, busy } = state.org;
  const ready = loginUrlDraft.trim().length > 0 && clientIdDraft.trim().length > 0;

  return el('form', {
    className: 'connectform',
    on: {
      submit: (event) => {
        event.preventDefault();
        if (ready) handlers.connectOrg(loginUrlDraft.trim(), clientIdDraft.trim());
      },
    },
  }, [
    el('p', {
      className: 'connectform__intro',
      text: 'Sign in with a Connected App you create in your own org. See docs/CONNECTED-APP.md.',
    }),

    el('label', { className: 'connectform__label', attrs: { for: 'org-login-url' } }, [
      'Login URL',
      el('input', {
        className: 'input',
        attrs: {
          id: 'org-login-url',
          type: 'url',
          value: loginUrlDraft,
          placeholder: 'https://login.salesforce.com',
        },
        on: {
          input: (event) =>
            handlers.dispatch({
              type: 'org/loginUrlChanged',
              value: (event.currentTarget as HTMLInputElement).value,
            }),
        },
      }),
    ]),

    el('label', { className: 'connectform__label', attrs: { for: 'org-client-id' } }, [
      'Consumer Key',
      el('input', {
        className: 'input',
        attrs: {
          id: 'org-client-id',
          type: 'text',
          value: clientIdDraft,
          placeholder: '3MVG9...',
          autocomplete: 'off',
          spellcheck: 'false',
        },
        on: {
          input: (event) =>
            handlers.dispatch({
              type: 'org/clientIdChanged',
              value: (event.currentTarget as HTMLInputElement).value,
            }),
        },
      }),
    ]),

    el('p', {
      className: 'connectform__note muted',
      text:
        'The Consumer Key is not a secret and is stored locally. No client secret is used or ' +
        'accepted — this is a PKCE public client.',
    }),

    el('div', { className: 'connectform__actions' }, [
      el('button', {
        className: 'button button--primary',
        text: busy === 'connecting' ? 'Opening sign-in…' : 'Sign in',
        attrs: {
          id: 'org-signin',
          type: 'submit',
          ...(ready && busy === null ? {} : { disabled: 'disabled' }),
        },
      }),
      el('button', {
        className: 'button button--quiet',
        text: 'Cancel',
        attrs: { id: 'org-connect-cancel', type: 'button', 'aria-label': 'Cancel connecting an org' },
        on: { click: () => handlers.dispatch({ type: 'org/connectFormToggled', open: false }) },
      }),
    ]),
  ]);
}

/**
 * One notice per failure mode, each with the action that actually helps.
 *
 * The API-limit case deliberately offers no Retry: retrying is precisely the
 * thing that would spend the budget we are refusing to spend.
 */
function renderOrgError(
  error: SerialisedError,
  status: OrgStatus | null,
  handlers: Handlers,
): HTMLElement {
  const actions: HTMLElement[] = [];
  let heading = 'The org could not be read';

  switch (error.code) {
    case 'ORG_AUTH_EXPIRED':
      heading = 'The Salesforce session expired';
      actions.push(
        actionButton('Reconnect', 'button--primary', () =>
          handlers.dispatch({ type: 'org/connectFormToggled', open: true }),
        ),
      );
      break;

    case 'HOST_PERMISSION_REVOKED':
      heading = 'Chrome is not granting access to this org';
      actions.push(
        actionButton('Grant access', 'button--primary', () => handlers.grantOrgPermission()),
      );
      break;

    case 'API_LIMIT_EXHAUSTED':
      // No retry button, on purpose.
      heading = 'Refusing to refresh: the org is nearly out of API calls';
      break;

    case 'ORG_UNREACHABLE':
      heading = 'The org could not be reached';
      actions.push(actionButton('Try again', 'button', () => handlers.refreshOrg()));
      break;

    case 'ORG_RESPONSE_INVALID':
      heading = 'The org returned something this build cannot read';
      actions.push(actionButton('Try again', 'button', () => handlers.refreshOrg()));
      break;

    case 'ORG_CONNECT_FAILED':
      heading = 'Sign-in did not complete';
      actions.push(
        actionButton('Try again', 'button--primary', () =>
          handlers.dispatch({ type: 'org/connectFormToggled', open: true }),
        ),
      );
      break;

    default:
      if (status?.connected === true) {
        actions.push(actionButton('Try again', 'button', () => handlers.refreshOrg()));
      }
      break;
  }

  actions.push(
    actionButton('Dismiss', 'button--quiet', () =>
      handlers.dispatch({ type: 'org/errorDismissed' }),
    ),
  );

  return el('div', { className: 'notice notice--error', attrs: { role: 'alert' } }, [
    el('strong', { text: heading }),
    el('p', { text: error.message }),
    el('p', { className: 'muted', text: `Error code: ${error.code}` }),
    el('div', { className: 'notice__actions' }, actions),
  ]);
}

/**
 * Says what the panel is showing when it is not fresh.
 *
 * Two separate cases, and conflating them would be a lie: data that is merely
 * old, and data that is old *because the last refresh failed*.
 */
function renderStaleness(input: OrgBarInput): HTMLElement | null {
  const { state, lastRefreshed, now } = input;
  if (state.org.status?.connected !== true) return null;

  const failed = state.org.error !== null;
  if (failed && lastRefreshed !== null) {
    return el('div', { className: 'notice notice--warn', attrs: { role: 'status' } }, [
      el('p', {
        text: `Showing cached org data from ${relativeTime(lastRefreshed, now)}. It is not live.`,
        title: absoluteTime(lastRefreshed),
      }),
    ]);
  }
  if (failed) return null;

  if (lastRefreshed === null) {
    return el('div', { className: 'notice notice--info', attrs: { role: 'status' } }, [
      el('p', { text: 'This org has never been read. Press Refresh to load its deployments.' }),
    ]);
  }
  if (isStale(lastRefreshed, now)) {
    return el('div', { className: 'notice notice--warn', attrs: { role: 'status' } }, [
      el('p', {
        text: `This data was read ${relativeTime(lastRefreshed, now)} and may be out of date.`,
        title: absoluteTime(lastRefreshed),
      }),
    ]);
  }
  return null;
}

function actionButton(label: string, variant: string, onClick: () => void): HTMLElement {
  return el('button', {
    className: `button ${variant}`,
    text: label,
    // Derived from the label so it survives a re-render: these buttons appear
    // inside error notices, exactly where a keyboard user is most likely to be.
    attrs: { id: `org-action-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`, type: 'button' },
    on: { click: onClick },
  });
}

/** `https://acme.my.salesforce.com` → `acme.my.salesforce.com`. */
function hostOf(instanceUrl: string): string {
  try {
    return new URL(instanceUrl).host;
  } catch (cause) {
    // A stored instance URL that will not parse is worth showing verbatim
    // rather than hiding behind "unknown".
    void cause;
    return instanceUrl;
  }
}
