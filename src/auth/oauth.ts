/**
 * OAuth 2.0 authorization code + PKCE against a customer-created Connected App.
 * docs/DATASOURCE.md §4 Option B, and docs/CONNECTED-APP.md for the setup.
 *
 * SECURITY MODEL — the whole point of this file:
 *
 *  - The **access token lives in memory only**, in this module's closure. It is
 *    never written to any storage area, never returned from a message handler,
 *    and never put in an error.
 *  - The **refresh token lives in `chrome.storage.session` only**. That area is
 *    cleared when the browser closes and is never written to disk, unlike
 *    `chrome.storage.local`. It is never read into any object that gets
 *    serialised across the message boundary.
 *  - Every error message this module produces is passed through `redact` before
 *    it reaches an `Error`, so a token cannot leak through a diagnostic.
 *  - Nothing here logs. There is no `console` call in this file, on purpose.
 *
 * This file and `data/fetchConnection.ts` are the only two network call sites in
 * the codebase; eslint enforces that. This one exists separately because the
 * token endpoint requires POST, and `OrgConnection` is deliberately GET-only.
 */

import { OrgAuthExpiredError, OrgNotConnectedError, ReleaseLensError } from '../core/errors.js';
import type { StorageArea } from '../data/storage.js';
import { createPkcePair, createState, type CryptoLike } from './pkce.js';
import { redact } from '../core/redact.js';

/** Session-storage key holding the refresh token and org coordinates. */
export const SESSION_KEY = 'sf-releaselens.org-session.v1';

/**
 * Scopes requested. `api` to read, `refresh_token` so the panel keeps working
 * after the access token expires without prompting again. Nothing else — no
 * `full`, no `web`, no `chatter_api`.
 */
export const OAUTH_SCOPES = 'api refresh_token';

/** Access tokens are refreshed this long before their stated expiry. */
const EXPIRY_SKEW_MS = 60_000;

export class OrgConnectFailedError extends ReleaseLensError {
  override readonly code = 'ORG_CONNECT_FAILED';

  constructor(detail: string) {
    super(`Connecting the Salesforce org failed: ${detail}`);
  }
}

/** Everything needed to start a flow. No secrets: a PKCE client has none. */
export interface ConnectRequest {
  /** `https://login.salesforce.com` or a My Domain / test login URL. */
  loginUrl: string;
  /** The Consumer Key of the customer's Connected App. Not a secret. */
  clientId: string;
}

/** What the panel is allowed to know about the connection. Never a token. */
export interface OrgSessionInfo {
  connected: boolean;
  instanceUrl?: string;
  loginUrl?: string;
  /** Salesforce user id from the identity URL, for display only. */
  userId?: string;
  organizationId?: string;
  connectedAt?: string;
}

/** The `chrome.identity` surface used, injected so tests need no browser. */
export interface IdentityApi {
  launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined>;
  getRedirectURL(path?: string): string;
}

export interface OrgSessionDeps {
  identity: IdentityApi;
  /** MUST be backed by `chrome.storage.session`. See the file comment. */
  sessionStorage: StorageArea;
  /** Injected; this file is one of two permitted network call sites. */
  fetchImpl?: typeof fetch;
  cryptoImpl?: CryptoLike;
  now?: () => number;
}

export interface OrgSession {
  /** Runs the interactive flow and stores the resulting session. */
  connect(request: ConnectRequest): Promise<OrgSessionInfo>;
  /** Revokes at the org and clears every trace locally. */
  disconnect(): Promise<void>;
  /** Never includes a token. Safe to send to the panel. */
  info(): Promise<OrgSessionInfo>;
  /**
   * A currently-valid access token, for the transport only.
   *
   * @throws OrgNotConnectedError when no session exists.
   * @throws OrgAuthExpiredError when the refresh token is rejected. Terminal:
   *         the session is cleared, and the user must reconnect deliberately.
   */
  getAccessToken(forceRefresh?: boolean): Promise<string>;
}

/** Persisted in session storage. The refresh token never leaves this shape. */
interface StoredSession {
  refreshToken: string;
  instanceUrl: string;
  loginUrl: string;
  clientId: string;
  userId?: string;
  organizationId?: string;
  connectedAt: string;
}

export function createOrgSession(deps: OrgSessionDeps): OrgSession {
  const doFetch = deps.fetchImpl ?? fetch;
  const cryptoImpl = deps.cryptoImpl ?? crypto;
  const now = deps.now ?? (() => Date.now());

  /**
   * The access token. Module-closure memory, never storage.
   *
   * MV3 evicts an idle service worker, which drops this — and that is correct
   * behaviour, not a bug: the next request refreshes from the session-scoped
   * refresh token.
   */
  let accessToken: string | undefined;
  let accessTokenExpiresAt = 0;

  async function readStored(): Promise<StoredSession | undefined> {
    const raw = await deps.sessionStorage.read(SESSION_KEY);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
    const record = raw as Record<string, unknown>;
    if (typeof record['refreshToken'] !== 'string' || typeof record['instanceUrl'] !== 'string') {
      return undefined;
    }
    return record as unknown as StoredSession;
  }

  async function clearEverything(): Promise<void> {
    accessToken = undefined;
    accessTokenExpiresAt = 0;
    await deps.sessionStorage.remove(SESSION_KEY);
  }

  async function postForm(
    url: string,
    body: Record<string, string>,
    secrets: readonly (string | undefined)[],
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(body).toString(),
        credentials: 'omit',
      });
    } catch (cause) {
      throw new OrgConnectFailedError(
        redact(cause instanceof Error ? cause.message : String(cause), secrets),
      );
    }

    const text = await response.text().catch(() => '');
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === 'object' && parsed !== null) payload = parsed as Record<string, unknown>;
    } catch (cause) {
      void cause;
      // Fall through: a non-JSON body is reported by status, never echoed —
      // echoing it is how a token in a redirect body reaches a log.
    }

    if (!response.ok) {
      const code = typeof payload['error'] === 'string' ? payload['error'] : `HTTP ${response.status}`;
      const description =
        typeof payload['error_description'] === 'string' ? payload['error_description'] : '';
      throw new OrgConnectFailedError(redact(`${code}${description ? `: ${description}` : ''}`, secrets));
    }
    return payload;
  }

  /** Adopts a token response. The only place `accessToken` is assigned. */
  function adoptTokens(payload: Record<string, unknown>): string {
    const token = payload['access_token'];
    if (typeof token !== 'string' || token.length === 0) {
      throw new OrgConnectFailedError('the org did not return an access token');
    }
    accessToken = token;
    // Salesforce omits `expires_in`; fall back to a conservative 30 minutes so
    // a stale token is refreshed proactively rather than after a 401.
    const expiresInSeconds =
      typeof payload['expires_in'] === 'number' ? payload['expires_in'] : 30 * 60;
    accessTokenExpiresAt = now() + expiresInSeconds * 1000;
    return token;
  }

  return {
    async connect(request: ConnectRequest): Promise<OrgSessionInfo> {
      const loginUrl = request.loginUrl.replace(/\/+$/, '');
      const redirectUri = deps.identity.getRedirectURL();
      const pkce = await createPkcePair(cryptoImpl);
      const state = createState(cryptoImpl);

      const authorizeUrl = new URL(`${loginUrl}/services/oauth2/authorize`);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('client_id', request.clientId);
      authorizeUrl.searchParams.set('redirect_uri', redirectUri);
      authorizeUrl.searchParams.set('scope', OAUTH_SCOPES);
      authorizeUrl.searchParams.set('code_challenge', pkce.challenge);
      authorizeUrl.searchParams.set('code_challenge_method', pkce.method);
      authorizeUrl.searchParams.set('state', state);

      let redirected: string | undefined;
      try {
        redirected = await deps.identity.launchWebAuthFlow({
          url: authorizeUrl.toString(),
          interactive: true,
        });
      } catch (cause) {
        throw new OrgConnectFailedError(
          redact(cause instanceof Error ? cause.message : String(cause), [pkce.verifier]),
        );
      }
      if (redirected === undefined || redirected.length === 0) {
        throw new OrgConnectFailedError('the sign-in window was closed before it completed');
      }

      const returned = new URL(redirected);
      const params = returned.searchParams;
      const error = params.get('error');
      if (error !== null) {
        const description = params.get('error_description') ?? '';
        throw new OrgConnectFailedError(
          redact(`${error}${description ? `: ${description}` : ''}`, [pkce.verifier]),
        );
      }

      // Without this, a crafted redirect could hand us a code the user never
      // approved and we would exchange it as though they had.
      if (params.get('state') !== state) {
        throw new OrgConnectFailedError(
          'the sign-in response did not match the request that started it, so it was rejected',
        );
      }

      const code = params.get('code');
      if (code === null || code.length === 0) {
        throw new OrgConnectFailedError('the sign-in response contained no authorization code');
      }

      const payload = await postForm(
        `${loginUrl}/services/oauth2/token`,
        {
          grant_type: 'authorization_code',
          code,
          client_id: request.clientId,
          redirect_uri: redirectUri,
          code_verifier: pkce.verifier,
        },
        [pkce.verifier, code],
      );

      adoptTokens(payload);

      const refreshToken = payload['refresh_token'];
      if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
        await clearEverything();
        throw new OrgConnectFailedError(
          'the org did not return a refresh token, so the session could not be kept. ' +
            'Check the Connected App requests the "refresh_token" scope.',
        );
      }
      const instanceUrl = payload['instance_url'];
      if (typeof instanceUrl !== 'string' || instanceUrl.length === 0) {
        await clearEverything();
        throw new OrgConnectFailedError('the org did not return an instance URL');
      }

      const identity = parseIdentityUrl(payload['id']);
      const stored: StoredSession = {
        refreshToken,
        instanceUrl: instanceUrl.replace(/\/+$/, ''),
        loginUrl,
        clientId: request.clientId,
        connectedAt: new Date(now()).toISOString(),
        ...(identity.userId === undefined ? {} : { userId: identity.userId }),
        ...(identity.organizationId === undefined
          ? {}
          : { organizationId: identity.organizationId }),
      };
      await deps.sessionStorage.write(SESSION_KEY, stored);

      return toInfo(stored);
    },

    async disconnect(): Promise<void> {
      const stored = await readStored();
      if (stored !== undefined) {
        try {
          // Revoke at the org so the token dies there too, not just here.
          await postForm(
            `${stored.loginUrl}/services/oauth2/revoke`,
            { token: stored.refreshToken },
            [stored.refreshToken],
          );
        } catch (cause) {
          // A revoke that fails must not leave the token sitting in storage:
          // clearing locally is the part we control, and it is the part that
          // matters for this machine.
          void cause;
        }
      }
      await clearEverything();
    },

    async info(): Promise<OrgSessionInfo> {
      const stored = await readStored();
      return stored === undefined ? { connected: false } : toInfo(stored);
    },

    async getAccessToken(forceRefresh = false): Promise<string> {
      const stored = await readStored();
      if (stored === undefined) {
        throw new OrgNotConnectedError('reach the org');
      }

      if (!forceRefresh && accessToken !== undefined && now() < accessTokenExpiresAt - EXPIRY_SKEW_MS) {
        return accessToken;
      }

      let payload: Record<string, unknown>;
      try {
        payload = await postForm(
          `${stored.loginUrl}/services/oauth2/token`,
          {
            grant_type: 'refresh_token',
            refresh_token: stored.refreshToken,
            client_id: stored.clientId,
          },
          [stored.refreshToken, accessToken],
        );
      } catch (cause) {
        // Terminal, and the session is cleared. Retrying here would be the
        // silent re-prompt loop the design forbids.
        await clearEverything();
        throw new OrgAuthExpiredError(
          redact(cause instanceof Error ? cause.message : String(cause), [stored.refreshToken]),
        );
      }

      try {
        return adoptTokens(payload);
      } catch (cause) {
        await clearEverything();
        throw new OrgAuthExpiredError(
          cause instanceof Error ? cause.message : 'the refresh response was unusable',
        );
      }
    },
  };
}

function toInfo(stored: StoredSession): OrgSessionInfo {
  // Constructed field by field rather than spread, so adding a field to
  // `StoredSession` cannot accidentally publish it — including the token.
  return {
    connected: true,
    instanceUrl: stored.instanceUrl,
    loginUrl: stored.loginUrl,
    connectedAt: stored.connectedAt,
    ...(stored.userId === undefined ? {} : { userId: stored.userId }),
    ...(stored.organizationId === undefined ? {} : { organizationId: stored.organizationId }),
  };
}

/** `https://login.salesforce.com/id/<orgId>/<userId>` → its two ids. */
function parseIdentityUrl(value: unknown): { organizationId?: string; userId?: string } {
  if (typeof value !== 'string') return {};
  const match = /\/id\/([^/]+)\/([^/?#]+)/.exec(value);
  const organizationId = match?.[1];
  const userId = match?.[2];
  return {
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(userId === undefined ? {} : { userId }),
  };
}
