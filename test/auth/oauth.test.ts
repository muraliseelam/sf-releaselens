/**
 * OAuth + PKCE. docs/DATASOURCE.md §4 Option B.
 *
 * `chrome.identity` and `fetch` are both injected, so no browser and no network
 * are involved. The security assertions are the point of this file: where each
 * token lives, that it is never written to disk, and that no token value can
 * reach an error message.
 */

import { describe, expect, it, vi } from 'vitest';

import { OrgAuthExpiredError, OrgNotConnectedError } from '../../src/core/errors.js';
import {
  createOrgSession,
  OAUTH_SCOPES,
  OrgConnectFailedError,
  SESSION_KEY,
  type IdentityApi,
  type OrgSessionDeps,
} from '../../src/auth/oauth.js';
import { containsSecret } from '../../src/core/redact.js';
import { createMemoryStorageArea, type StorageArea } from '../../src/data/storage.js';

/**
 * Token-shaped test values, composed rather than written out.
 *
 * A literal that looks like a Salesforce credential blocks a push: GitHub's
 * secret scanner cannot tell a fake from a real one, and it is right not to
 * try. The shape is what these tests need; a literal is only how it got written
 * down. `test/fixtures/org/no-secrets.test.ts` fails if one reappears.
 */
const LOGIN_URL = 'https://login.salesforce.com';
const CLIENT_ID = `3MVG9${'_CONSUMER_KEY'}_EXAMPLE`;
const REDIRECT_URI = 'https://abcdefghijklmnop.chromiumapp.org/';
const INSTANCE_URL = 'https://acme.my.salesforce.com';

/** Realistic token shapes — the access token matches the redaction pattern. */
const ACCESS_TOKEN = `00D5f000000ABCDE!AQEAQ${'NaGmY_fake'}AccessTokenValue_0123456789`;
const REFRESH_TOKEN = `5Aep861${'fakeRefresh'}TokenValue_abcdefghijklmnopqrstuvwxyz`;
const NEW_ACCESS_TOKEN = `00D5f000000ABCDE!AQEAQ${'PpZzZ_second'}AccessToken_9876543210`;
const AUTH_CODE = 'aPrxfakeAuthorizationCodeValue123';

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      instance_url: INSTANCE_URL,
      id: `${LOGIN_URL}/id/00D5f000000ABCDEAO/0055f000000USERAAO`,
      token_type: 'Bearer',
      issued_at: '1789000000000',
      ...overrides,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function redirectWith(params: Record<string, string>): (state: string) => string {
  return (state) => {
    const url = new URL(REDIRECT_URI);
    for (const [k, v] of Object.entries({ state, ...params })) url.searchParams.set(k, v);
    return url.toString();
  };
}

/**
 * Builds a session whose identity stub echoes back the `state` the flow chose,
 * which is what a well-behaved authorization server does.
 */
function build(
  options: {
    redirect?: (state: string) => string;
    fetchImpl?: typeof fetch;
    sessionStorage?: StorageArea;
    identity?: IdentityApi;
  } = {},
) {
  const sessionStorage = options.sessionStorage ?? createMemoryStorageArea();
  const launchWebAuthFlow = vi.fn((details: { url: string; interactive: boolean }) => {
    const state = new URL(details.url).searchParams.get('state') ?? '';
    const make = options.redirect ?? redirectWith({ code: AUTH_CODE });
    return Promise.resolve(make(state));
  });
  const identity: IdentityApi = options.identity ?? {
    launchWebAuthFlow,
    getRedirectURL: () => REDIRECT_URI,
  };
  const fetchImpl = options.fetchImpl ?? vi.fn<typeof fetch>(() => Promise.resolve(tokenResponse()));

  const deps: OrgSessionDeps = { identity, sessionStorage, fetchImpl };
  return { session: createOrgSession(deps), sessionStorage, fetchImpl, launchWebAuthFlow, identity };
}

/** Reads the form body a recorded POST was given. */
function formOf(call: Parameters<typeof fetch> | undefined): URLSearchParams {
  const body = call?.[1]?.body;
  // Every POST this module makes sends a urlencoded string body; anything else
  // means the request was built wrong, and an empty result would hide that.
  if (typeof body !== 'string') {
    throw new Error(`Expected a urlencoded string body, received ${typeof body}`);
  }
  return new URLSearchParams(body);
}

describe('the authorize request', () => {
  it('is a PKCE S256 code flow with the extension redirect URI', async () => {
    const { session, launchWebAuthFlow } = build();
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    const url = new URL((launchWebAuthFlow.mock.calls[0]![0] as { url: string }).url);
    expect(url.origin + url.pathname).toBe(`${LOGIN_URL}/services/oauth2/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
  });

  it('requests only the api and refresh_token scopes', async () => {
    // Not `full`, not `web`. A read-only tool should not ask for more.
    const { session, launchWebAuthFlow } = build();
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    const url = new URL((launchWebAuthFlow.mock.calls[0]![0] as { url: string }).url);
    expect(url.searchParams.get('scope')).toBe(OAUTH_SCOPES);
    expect(OAUTH_SCOPES).toBe('api refresh_token');
  });

  it('never puts the code verifier in the authorize URL, only its challenge', async () => {
    const { session, launchWebAuthFlow, fetchImpl } = build();
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    const authorizeUrl = (launchWebAuthFlow.mock.calls[0]![0] as { url: string }).url;
    const verifier = formOf(fetchImpl.mock.calls[0]).get('code_verifier')!;

    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(authorizeUrl).not.toContain(verifier);
  });

  it('uses a fresh verifier and state on every connect', async () => {
    const { session, fetchImpl } = build();
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    expect(formOf(fetchImpl.mock.calls[0]).get('code_verifier')).not.toBe(
      formOf(fetchImpl.mock.calls[1]).get('code_verifier'),
    );
  });

  it('tolerates a trailing slash on the login URL', async () => {
    const { session, launchWebAuthFlow } = build();
    await session.connect({ loginUrl: `${LOGIN_URL}/`, clientId: CLIENT_ID });

    expect((launchWebAuthFlow.mock.calls[0]![0] as { url: string }).url).toContain(
      `${LOGIN_URL}/services/oauth2/authorize`,
    );
  });
});

describe('the redirect back', () => {
  it('exchanges the code with the verifier', async () => {
    const { session, fetchImpl } = build();
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    expect(fetchImpl.mock.calls[0]![0]).toBe(`${LOGIN_URL}/services/oauth2/token`);
    const form = formOf(fetchImpl.mock.calls[0]);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe(AUTH_CODE);
    expect(form.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(fetchImpl.mock.calls[0]![1]!.credentials).toBe('omit');
  });

  it('rejects a mismatched state', async () => {
    // Without this check a crafted redirect could hand us a code the user never
    // approved, and we would exchange it as though they had.
    const { session, fetchImpl } = build({
      redirect: () => {
        const url = new URL(REDIRECT_URI);
        url.searchParams.set('code', AUTH_CODE);
        url.searchParams.set('state', 'not-the-state-we-sent');
        return url.toString();
      },
    });

    await expect(session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID })).rejects.toThrow(
      /did not match the request that started it/,
    );
    // And critically: no exchange was attempted.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces an error returned in the redirect', async () => {
    const { session } = build({
      redirect: redirectWith({ error: 'access_denied', error_description: 'end-user denied' }),
    });

    await expect(session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID })).rejects.toThrow(
      /access_denied: end-user denied/,
    );
  });

  it('reports a closed sign-in window plainly', async () => {
    const { session } = build({
      identity: { launchWebAuthFlow: () => Promise.resolve(undefined), getRedirectURL: () => REDIRECT_URI },
    });

    await expect(session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID })).rejects.toThrow(
      /closed before it completed/,
    );
  });

  it('rejects a redirect with neither code nor error', async () => {
    const { session } = build({ redirect: redirectWith({}) });

    await expect(session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID })).rejects.toThrow(
      /no authorization code/,
    );
  });
});

describe('where the tokens live', () => {
  it('stores the refresh token in session storage and nothing else anywhere', async () => {
    const sessionStorage = createMemoryStorageArea();
    const { session } = build({ sessionStorage });
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    const stored = (await sessionStorage.read(SESSION_KEY)) as Record<string, unknown>;
    expect(stored['refreshToken']).toBe(REFRESH_TOKEN);
    // The access token must never be written to any storage area.
    expect(JSON.stringify(stored)).not.toContain(ACCESS_TOKEN);
  });

  it('keeps the access token in memory only, reused across calls without refetching', async () => {
    const { session, fetchImpl } = build();
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    expect(await session.getAccessToken()).toBe(ACCESS_TOKEN);
    expect(await session.getAccessToken()).toBe(ACCESS_TOKEN);
    // One call for the code exchange, none for the two reads.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never exposes a token through info()', async () => {
    const { session } = build();
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    const info = await session.info();
    const serialised = JSON.stringify(info);

    expect(info.connected).toBe(true);
    expect(info.instanceUrl).toBe(INSTANCE_URL);
    expect(info.organizationId).toBe('00D5f000000ABCDEAO');
    expect(info.userId).toBe('0055f000000USERAAO');
    expect(containsSecret(serialised, [ACCESS_TOKEN, REFRESH_TOKEN])).toBe(false);
  });

  it('reports not-connected before any connect', async () => {
    const { session } = build();

    expect(await session.info()).toEqual({ connected: false });
    await expect(session.getAccessToken()).rejects.toThrow(OrgNotConnectedError);
  });

  it('ignores a malformed stored session rather than trusting it', async () => {
    const sessionStorage = createMemoryStorageArea();
    await sessionStorage.write(SESSION_KEY, { refreshToken: 42 });
    const { session } = build({ sessionStorage });

    expect(await session.info()).toEqual({ connected: false });
  });
});

describe('refresh', () => {
  it('refreshes when forced, and sends the refresh grant', async () => {
    const responses = [tokenResponse(), tokenResponse({ access_token: NEW_ACCESS_TOKEN })];
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(responses.shift()!));
    const { session } = build({ fetchImpl });
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    expect(await session.getAccessToken(true)).toBe(NEW_ACCESS_TOKEN);
    const form = formOf(fetchImpl.mock.calls[1]);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe(REFRESH_TOKEN);
    expect(form.get('client_id')).toBe(CLIENT_ID);
  });

  it('clears the session and reports ORG_AUTH_EXPIRED when the refresh is rejected', async () => {
    const responses = [
      tokenResponse(),
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'expired access/refresh token' }), {
        status: 400,
      }),
    ];
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(responses.shift()!));
    const sessionStorage = createMemoryStorageArea();
    const { session } = build({ fetchImpl, sessionStorage });
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    await expect(session.getAccessToken(true)).rejects.toThrow(OrgAuthExpiredError);

    // Terminal: the stored token is gone, so nothing can retry in a loop.
    expect(await sessionStorage.read(SESSION_KEY)).toBeUndefined();
    expect(await session.info()).toEqual({ connected: false });
  });

  it('does not retry the refresh itself', async () => {
    const responses = [tokenResponse(), new Response('{"error":"invalid_grant"}', { status: 400 })];
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(responses.shift()!));
    const { session } = build({ fetchImpl });
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    await expect(session.getAccessToken(true)).rejects.toThrow(OrgAuthExpiredError);
    // One exchange + exactly one refresh attempt.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refreshes proactively once the token is near expiry', async () => {
    let clock = 1_000_000;
    const responses = [
      tokenResponse({ expires_in: 120 }),
      tokenResponse({ access_token: NEW_ACCESS_TOKEN, expires_in: 120 }),
    ];
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(responses.shift()!));
    const session = createOrgSession({
      identity: {
        launchWebAuthFlow: (details) =>
          Promise.resolve(
            redirectWith({ code: AUTH_CODE })(new URL(details.url).searchParams.get('state') ?? ''),
          ),
        getRedirectURL: () => REDIRECT_URI,
      },
      sessionStorage: createMemoryStorageArea(),
      fetchImpl,
      now: () => clock,
    });
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    expect(await session.getAccessToken()).toBe(ACCESS_TOKEN);
    clock += 70_000; // inside the 60s skew of a 120s token
    expect(await session.getAccessToken()).toBe(NEW_ACCESS_TOKEN);
  });

  it('rejects a token response with no access token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(tokenResponse({ access_token: undefined })),
    );
    const { session } = build({ fetchImpl });

    await expect(session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID })).rejects.toThrow(
      /did not return an access token/,
    );
  });

  it('refuses to connect when the org returns no refresh token', async () => {
    // Without one the session cannot survive, and silently degrading to a
    // one-shot token would surprise the user an hour later.
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(tokenResponse({ refresh_token: undefined })),
    );
    const sessionStorage = createMemoryStorageArea();
    const { session } = build({ fetchImpl, sessionStorage });

    await expect(session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID })).rejects.toThrow(
      /"refresh_token" scope/,
    );
    expect(await sessionStorage.read(SESSION_KEY)).toBeUndefined();
  });
});

describe('disconnect', () => {
  it('revokes at the org and clears every trace locally', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(tokenResponse()));
    const sessionStorage = createMemoryStorageArea();
    const { session } = build({ fetchImpl, sessionStorage });
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    await session.disconnect();

    expect(fetchImpl.mock.calls[1]![0]).toBe(`${LOGIN_URL}/services/oauth2/revoke`);
    expect(formOf(fetchImpl.mock.calls[1]).get('token')).toBe(REFRESH_TOKEN);
    expect(await sessionStorage.read(SESSION_KEY)).toBeUndefined();
    expect(await session.info()).toEqual({ connected: false });
  });

  it('clears locally even when the revoke call fails', async () => {
    // The remote revoke is best-effort; the local clear is the part we control
    // and the part that matters for this machine.
    // Thunks, not eager promises: an eagerly-created rejection is unhandled
    // until the code under test reaches it, which vitest reports as an error.
    const responses: (() => Promise<Response>)[] = [
      () => Promise.resolve(tokenResponse()),
      () => Promise.reject(new Error('network down')),
    ];
    const fetchImpl = vi.fn<typeof fetch>(() => (responses.shift() ?? (() => Promise.resolve(tokenResponse())))());
    const sessionStorage = createMemoryStorageArea();
    const { session } = build({ fetchImpl, sessionStorage });
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    await expect(session.disconnect()).resolves.toBeUndefined();
    expect(await sessionStorage.read(SESSION_KEY)).toBeUndefined();
  });

  it('drops the in-memory access token too', async () => {
    const { session } = build();
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });
    await session.disconnect();

    await expect(session.getAccessToken()).rejects.toThrow(OrgNotConnectedError);
  });

  it('is safe to call when nothing is connected', async () => {
    const { session, fetchImpl } = build();

    await expect(session.disconnect()).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('no token can reach an error message', () => {
  /** Every secret in play during these flows. */
  const SECRETS = [ACCESS_TOKEN, REFRESH_TOKEN, AUTH_CODE];

  /** Serialises an error the way a log, a message payload or telemetry would. */
  function serialise(error: unknown): string {
    const asError = error as Error & { code?: string };
    return JSON.stringify({
      name: asError.name,
      message: asError.message,
      code: asError.code,
      stack: asError.stack,
      own: Object.getOwnPropertyNames(asError).map((key) => [
        key,
        String((asError as unknown as Record<string, unknown>)[key]),
      ]),
    });
  }

  it('redacts a token echoed in a token-endpoint error body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: 'invalid_grant',
            // A hostile or careless authorization server echoing the secrets.
            error_description: `token ${ACCESS_TOKEN} and refresh ${REFRESH_TOKEN} rejected`,
          }),
          { status: 400 },
        ),
      ),
    );
    const { session } = build({ fetchImpl });

    try {
      await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });
      expect.unreachable('connect should have failed');
    } catch (cause) {
      expect(containsSecret(serialise(cause), SECRETS)).toBe(false);
      expect((cause as Error).message).toContain('invalid_grant');
    }
  });

  it('redacts a token echoed in a refresh failure', async () => {
    const responses = [
      tokenResponse(),
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: `bad ${REFRESH_TOKEN}` }),
        { status: 400 },
      ),
    ];
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(responses.shift()!));
    const { session } = build({ fetchImpl });
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    try {
      await session.getAccessToken(true);
      expect.unreachable('refresh should have failed');
    } catch (cause) {
      expect(containsSecret(serialise(cause), SECRETS)).toBe(false);
    }
  });

  it('redacts a code echoed in a network failure during the exchange', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error(`POST failed for code=${AUTH_CODE}`)),
    );
    const { session } = build({ fetchImpl });

    try {
      await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });
      expect.unreachable('connect should have failed');
    } catch (cause) {
      expect(containsSecret(serialise(cause), SECRETS)).toBe(false);
    }
  });

  it('redacts a token echoed by the identity flow itself', async () => {
    const { session } = build({
      identity: {
        launchWebAuthFlow: () => Promise.reject(new Error(`flow failed: ${ACCESS_TOKEN}`)),
        getRedirectURL: () => REDIRECT_URI,
      },
    });

    try {
      await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });
      expect.unreachable('connect should have failed');
    } catch (cause) {
      expect(containsSecret(serialise(cause), SECRETS)).toBe(false);
    }
  });

  it('never echoes a non-JSON error body, which could be anything', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(`<html>${REFRESH_TOKEN}</html>`, { status: 500 })),
    );
    const { session } = build({ fetchImpl });

    try {
      await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });
      expect.unreachable('connect should have failed');
    } catch (cause) {
      expect(containsSecret(serialise(cause), SECRETS)).toBe(false);
      expect((cause as Error).message).toContain('HTTP 500');
    }
  });
});

/*
 * The paths that could leave a credential behind.
 *
 * Every one of these runs *after* the org has handed over a refresh token, so
 * the assertion that matters is on session storage after the throw — not on the
 * error. A test that only checks the error type passes just as happily on a
 * version that keeps the token, which is the whole reason these exist.
 *
 * They were found by measuring src/auth for the first time: it had never been
 * in the coverage include list, so the riskiest file in the repository was the
 * one nobody had a number for.
 */
describe('a connection that cannot complete leaves nothing behind', () => {
  it('refuses an org that returns tokens but no instance URL', async () => {
    // Salesforce always sends one. An org that does not is either broken or not
    // Salesforce, and there is nowhere to send the API calls either way — but
    // by this point a refresh token is already in hand.
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(tokenResponse({ instance_url: undefined })),
    );
    const sessionStorage = createMemoryStorageArea();
    const { session } = build({ fetchImpl, sessionStorage });

    await expect(session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID })).rejects.toThrow(
      /did not return an instance URL/,
    );

    expect(await sessionStorage.read(SESSION_KEY)).toBeUndefined();
    expect(await session.info()).toEqual({ connected: false });
  });

  it('refuses an empty instance URL as firmly as a missing one', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(tokenResponse({ instance_url: '' })));
    const sessionStorage = createMemoryStorageArea();
    const { session } = build({ fetchImpl, sessionStorage });

    await expect(session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID })).rejects.toThrow(
      /instance URL/,
    );
    expect(await sessionStorage.read(SESSION_KEY)).toBeUndefined();
  });

  it('stores nothing when the token response carries no access token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(tokenResponse({ access_token: undefined })),
    );
    const sessionStorage = createMemoryStorageArea();
    const { session } = build({ fetchImpl, sessionStorage });

    await expect(session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID })).rejects.toThrow(
      /did not return an access token/,
    );
    expect(await sessionStorage.read(SESSION_KEY)).toBeUndefined();
  });

  it('reports the reason the org gave when sign-in is denied', async () => {
    const { session } = build({
      redirect: redirectWith({
        error: 'access_denied',
        error_description: 'end-user denied authorization',
      }),
    });

    await expect(session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID })).rejects.toThrow(
      /access_denied: end-user denied authorization/,
    );
  });

  it('reports a denial with no description without inventing one', async () => {
    const { session } = build({ redirect: redirectWith({ error: 'access_denied' }) });

    try {
      await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });
      expect.unreachable('connect should have failed');
    } catch (cause) {
      // No trailing colon, no "undefined": the message is exactly what came back.
      expect((cause as Error).message).toContain('access_denied');
      expect((cause as Error).message).not.toContain('undefined');
      expect((cause as Error).message).not.toMatch(/:\s*$/);
    }
  });

  it('connects without ids when the identity URL is not a string', async () => {
    // `id` is documented as a URL. A number is a malformed response, and the
    // right answer is a connection with no ids rather than a refusal — the ids
    // are for display, and nothing depends on them.
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(tokenResponse({ id: 12345 })));
    const { session } = build({ fetchImpl });

    const info = await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    expect(info.connected).toBe(true);
    expect(info.userId).toBeUndefined();
    expect(info.organizationId).toBeUndefined();
  });
});

describe('a refresh that cannot be adopted is terminal', () => {
  it('clears the session when the refresh returns 200 with an unusable body', async () => {
    /*
     * The dangerous shape: HTTP 200, so nothing upstream treats it as a
     * failure, and a body with no access token. This runs unattended when a
     * token expires mid-session, and the wrong behaviour is to keep the refresh
     * token and try again — a silent re-prompt loop against the user's org.
     */
    const responses = [tokenResponse(), tokenResponse({ access_token: undefined })];
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(responses.shift()!));
    const sessionStorage = createMemoryStorageArea();
    const { session } = build({ fetchImpl, sessionStorage });
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    await expect(session.getAccessToken(true)).rejects.toThrow(OrgAuthExpiredError);

    expect(await sessionStorage.read(SESSION_KEY)).toBeUndefined();
    expect(await session.info()).toEqual({ connected: false });
    // Exactly two calls: the exchange and the one refresh. No retry.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('names the reason rather than reporting a bare failure', async () => {
    const responses = [tokenResponse(), tokenResponse({ access_token: '' })];
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(responses.shift()!));
    const { session } = build({ fetchImpl });
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    await expect(session.getAccessToken(true)).rejects.toThrow(/did not return an access token/);
  });

  it('says nothing about the refresh token when the request itself fails', async () => {
    const responses: (() => Promise<Response>)[] = [
      () => Promise.resolve(tokenResponse()),
      () => Promise.reject(new Error(`socket hang up while sending ${REFRESH_TOKEN}`)),
    ];
    const fetchImpl = vi.fn<typeof fetch>(() => (responses.shift() ?? (() => Promise.resolve(tokenResponse())))());
    const sessionStorage = createMemoryStorageArea();
    const { session } = build({ fetchImpl, sessionStorage });
    await session.connect({ loginUrl: LOGIN_URL, clientId: CLIENT_ID });

    try {
      await session.getAccessToken(true);
      expect.unreachable('the refresh should have failed');
    } catch (cause) {
      expect(cause).toBeInstanceOf(OrgAuthExpiredError);
      const everything = `${(cause as Error).message} ${(cause as Error).stack ?? ''}`;
      expect(containsSecret(everything, [REFRESH_TOKEN, ACCESS_TOKEN])).toBe(false);
      // The network's own words survive; only the token is taken out.
      expect((cause as Error).message).toContain('socket hang up');
    }
    expect(await sessionStorage.read(SESSION_KEY)).toBeUndefined();
  });
});

describe('OrgConnectFailedError', () => {
  it('carries a stable code the panel can branch on', () => {
    expect(new OrgConnectFailedError('x').code).toBe('ORG_CONNECT_FAILED');
  });
});
