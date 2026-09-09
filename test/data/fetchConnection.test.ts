/**
 * The fetch transport. docs/DATASOURCE.md §5, §8.
 *
 * `fetch` is injected throughout, so nothing here touches a network. The token
 * provider is a spy in every test, which is how the "refresh exactly once"
 * rule is asserted rather than assumed.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  OrgAuthExpiredError,
  OrgRequestFailedError,
  OrgResponseInvalidError,
  OrgUnreachableError,
} from '../../src/core/errors.js';
import { collectAllPages, createFetchOrgConnection } from '../../src/data/fetchConnection.js';
import { queryResponse, salesforceError, SANDBOX_ORG } from '../fixtures/salesforce.js';

const INSTANCE = 'https://acme.my.salesforce.com';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The URL a recorded fetch call was given, whatever form it took. */
function urlOf(call: Parameters<typeof fetch> | undefined): string {
  const target = call?.[0];
  if (typeof target === 'string') return target;
  if (target instanceof URL) return target.href;
  if (target instanceof Request) return target.url;
  throw new Error('fetch was called with no recognisable URL');
}

function build(
  fetchImpl: typeof fetch,
  getAccessToken: (force?: boolean) => Promise<string> = () => Promise.resolve('tok-1'),
) {
  return createFetchOrgConnection({
    instanceUrl: INSTANCE,
    apiVersion: '62.0',
    getAccessToken,
    fetchImpl,
  });
}

describe('request construction', () => {
  it('builds an absolute URL from the instance and path', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ ok: true })));
    await build(fetchImpl).get('/services/data/v62.0/limits');

    expect(urlOf(fetchImpl.mock.calls[0])).toBe(`${INSTANCE}/services/data/v62.0/limits`);
  });

  it('tolerates a trailing slash on the instance URL and a path without a leading slash', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({})));
    const connection = createFetchOrgConnection({
      instanceUrl: `${INSTANCE}//`,
      apiVersion: '62.0',
      getAccessToken: () => Promise.resolve('tok'),
      fetchImpl,
    });
    await connection.get('services/data/v62.0/limits');

    expect(urlOf(fetchImpl.mock.calls[0])).toBe(`${INSTANCE}/services/data/v62.0/limits`);
  });

  it('appends query parameters', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({})));
    await build(fetchImpl).get('/services/data/v62.0/query', { q: 'SELECT Id FROM Account' });

    expect(urlOf(fetchImpl.mock.calls[0])).toContain('q=SELECT+Id+FROM+Account');
  });

  it('sends the bearer token and never sends cookies', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({})));
    await build(fetchImpl).get('/services/data/v62.0/limits');

    const init = fetchImpl.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok-1');
    // Riding an ambient browser session would be Option A, which was rejected.
    expect(init.credentials).toBe('omit');
    expect(init.method).toBe('GET');
  });

  it('asks the provider for a token on every request, keeping no copy', async () => {
    const tokens = ['first', 'second'];
    const getAccessToken = vi.fn(() => Promise.resolve(tokens.shift() ?? 'exhausted'));
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({})));
    const connection = build(fetchImpl, getAccessToken);

    await connection.get('/a');
    await connection.get('/b');

    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls[1]![1]!.headers as Record<string, string>)['authorization']).toBe(
      'Bearer second',
    );
  });
});

describe('token refresh (exactly once)', () => {
  it('refreshes and retries after a 401', async () => {
    const responses = [jsonResponse({}, 401), jsonResponse({ Id: '00D' })];
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(responses.shift()!));
    const getAccessToken = vi.fn((force?: boolean) => Promise.resolve(force === true ? 'fresh' : 'stale'));

    const result = await build(fetchImpl, getAccessToken).get<{ Id: string }>('/x');

    expect(result.Id).toBe('00D');
    expect(getAccessToken).toHaveBeenNthCalledWith(1);
    expect(getAccessToken).toHaveBeenNthCalledWith(2, true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after a second 401 rather than looping', async () => {
    // A silent re-prompt loop is how an extension ends up asking for
    // credentials over and over with no explanation.
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({}, 401)));
    const getAccessToken = vi.fn(() => Promise.resolve('always-stale'));

    await expect(build(fetchImpl, getAccessToken).get('/x')).rejects.toThrow(OrgAuthExpiredError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('surfaces ORG_AUTH_EXPIRED when the refresh itself fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({}, 401)));
    const getAccessToken = vi.fn((force?: boolean) =>
      force === true ? Promise.reject(new Error('refresh token revoked')) : Promise.resolve('stale'),
    );

    const attempt = build(fetchImpl, getAccessToken).get('/x');

    await expect(attempt).rejects.toThrow(OrgAuthExpiredError);
    await expect(attempt).rejects.toThrow(/refresh token revoked/);
  });
});

describe('non-2xx handling', () => {
  it('reports the Salesforce errorCode and message', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse(salesforceError('INVALID_FIELD', "No such column 'Bogus__c'"), 400)),
    );

    const attempt = build(fetchImpl).get('/x');

    await expect(attempt).rejects.toThrow(OrgRequestFailedError);
    await expect(attempt).rejects.toThrow(/HTTP 400, INVALID_FIELD/);
    await expect(attempt).rejects.toThrow(/No such column/);
  });

  it('falls back to the status when the error body is not JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('<html>502 Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' })),
    );

    await expect(build(fetchImpl).get('/x')).rejects.toThrow(/HTTP 502.*Bad Gateway/s);
  });

  it.each([403, 404, 500, 503])('rejects on HTTP %s', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({}, status)));

    await expect(build(fetchImpl).get('/x')).rejects.toThrow(OrgRequestFailedError);
  });
});

describe('network failure', () => {
  it('reports an unreachable org rather than leaking a fetch error', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('Failed to fetch')));

    const attempt = build(fetchImpl).get('/x');

    await expect(attempt).rejects.toThrow(OrgUnreachableError);
    await expect(attempt).rejects.toThrow(/Failed to fetch/);
  });

  it('names a timeout as a timeout', async () => {
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(abortError));

    await expect(build(fetchImpl).get('/x')).rejects.toThrow(/timed out after 30s/);
  });

  it('passes an abort signal so a hung request cannot hang the panel', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({})));
    await build(fetchImpl).get('/x');

    expect(fetchImpl.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('malformed JSON', () => {
  it('names an HTML body as a probable login redirect', async () => {
    // The most likely cause in practice, and the least obvious from a raw
    // "unexpected token <" parse error.
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('<!DOCTYPE html><html>login</html>', { status: 200 })),
    );

    const attempt = build(fetchImpl).get('/x');

    await expect(attempt).rejects.toThrow(OrgResponseInvalidError);
    await expect(attempt).rejects.toThrow(/redirected to a login page/);
  });

  it('quotes the start of a non-JSON body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('not json at all', { status: 200 })),
    );

    await expect(build(fetchImpl).get('/x')).rejects.toThrow(/not JSON \(starts with "not json/);
  });

  it('rejects an empty body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status: 200 })));

    await expect(build(fetchImpl).get('/x')).rejects.toThrow(/empty body/);
  });
});

describe('toolingQuery', () => {
  it('issues a Tooling query and unwraps the page', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse(queryResponse([SANDBOX_ORG]))),
    );

    const page = await build(fetchImpl).toolingQuery<typeof SANDBOX_ORG>('SELECT Id FROM Organization');

    expect(urlOf(fetchImpl.mock.calls[0])).toContain('/services/data/v62.0/tooling/query');
    expect(page.records).toEqual([SANDBOX_ORG]);
    expect(page.done).toBe(true);
    expect(page.totalSize).toBe(1);
  });

  it('treats a missing `done` as "there may be more" rather than complete', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ records: [], totalSize: 0 })),
    );

    expect((await build(fetchImpl).toolingQuery('SELECT Id FROM X')).done).toBe(false);
  });

  it('rejects a response with no records array', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ done: true })));

    await expect(build(fetchImpl).toolingQuery('SELECT Id FROM X')).rejects.toThrow(
      /toolingQuery\.records/,
    );
  });
});

describe('queryMore', () => {
  it('follows a nextRecordsUrl on the same instance', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(queryResponse([]))));
    await build(fetchImpl).queryMore('/services/data/v62.0/query/01g5f-2000');

    expect(urlOf(fetchImpl.mock.calls[0])).toBe(`${INSTANCE}/services/data/v62.0/query/01g5f-2000`);
  });

  it.each([
    ['an absolute URL to another host', 'https://evil.example.com/steal'],
    ['a protocol-relative URL', '//evil.example.com/steal'],
    ['an unrelated path', '/admin/whoami'],
  ])('refuses to follow %s', async (_label, url) => {
    // The locator comes back inside a response body; following an arbitrary one
    // would let a compromised or spoofed response redirect the token.
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(queryResponse([]))));

    await expect(build(fetchImpl).queryMore(url)).rejects.toThrow(OrgResponseInvalidError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the org cannot leak a token through an error', () => {
  // The org controls these strings and they reach the panel. `oauth.ts` always
  // redacted its equivalents; this transport did not, which was a real gap
  // found in self-review rather than by a failing test.
  // Token shape composed rather than written out, so no committed line
  // looks like a credential. See `test/fixtures/org/no-secrets.test.ts`.
  const TOKEN = `00D5f000000ABCDE!AQEAQ${'NaGmY_fake'}AccessTokenValue_0123456789`;

  it('redacts a token echoed in a Salesforce error message', async () => {
    // A 400 rather than a 401: a 401 goes down the refresh path, and this is
    // about the request-failed path.
    const failing = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse(salesforceError('INVALID_FIELD', `bad token ${TOKEN}`), 400)),
    );

    try {
      await build(failing).get('/x');
      expect.unreachable('should have thrown');
    } catch (cause) {
      expect((cause as Error).message).not.toContain(TOKEN);
      expect((cause as Error).message).toContain('INVALID_FIELD');
    }
  });

  it('redacts a token in a non-JSON body it quotes back', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(`token=${TOKEN}`, { status: 200 })),
    );

    try {
      await build(fetchImpl).get('/x');
      expect.unreachable('should have thrown');
    } catch (cause) {
      expect((cause as Error).message).not.toContain(TOKEN);
    }
  });

  it('redacts a token echoed in a network failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error(`connect failed with Bearer ${TOKEN}`)),
    );

    try {
      await build(fetchImpl).get('/x');
      expect.unreachable('should have thrown');
    } catch (cause) {
      expect((cause as Error).message).not.toContain(TOKEN);
    }
  });
});

describe('collectAllPages', () => {
  it('walks every page and concatenates the records', async () => {
    const connection = build(
      vi.fn<typeof fetch>(() =>
        Promise.resolve(jsonResponse(queryResponse([{ Id: 'b' }, { Id: 'c' }]))),
      ),
    );
    const first = {
      records: [{ Id: 'a' }],
      done: false,
      totalSize: 3,
      nextRecordsUrl: '/services/data/v62.0/query/01g-2000',
    };

    const result = await collectAllPages(connection, first);

    expect(result.records.map((r) => r.Id)).toEqual(['a', 'b', 'c']);
    expect(result.truncated).toBe(false);
  });

  it('returns immediately when the first page is complete', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await collectAllPages(build(fetchImpl), {
      records: [{ Id: 'a' }],
      done: true,
      totalSize: 1,
    });

    expect(result).toEqual({ records: [{ Id: 'a' }], truncated: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops at maxPages and says it truncated, rather than looping forever', async () => {
    // A paging bug against a large org would otherwise spend the whole daily
    // API budget in a loop.
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse(queryResponse([{ Id: 'x' }], '/services/data/v62.0/query/01g-next')),
      ),
    );

    const result = await collectAllPages(
      build(fetchImpl),
      { records: [], done: false, totalSize: 9999, nextRecordsUrl: '/services/data/v62.0/query/01g-0' },
      3,
    );

    expect(result.truncated).toBe(true);
    // `maxPages` counts the caller-supplied first page, so a cap of 3 fetches
    // two more and then stops.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.records).toHaveLength(2);
  });
});
