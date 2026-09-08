/**
 * The one file permitted to call `fetch`.
 *
 * Everything else reaches the org through `OrgConnection`, so the entire data
 * layer stays testable in Node with no network, and every outbound request in
 * the product is visible in this one file during review.
 *
 * The access token arrives through a **provider function**, never as a stored
 * string: the transport asks for it per request and never keeps a copy, so
 * there is no field on this object that a serialiser or a debugger could pick
 * a token out of.
 */

import {
  OrgAuthExpiredError,
  OrgRequestFailedError,
  OrgResponseInvalidError,
  OrgUnreachableError,
} from '../core/errors.js';
import { redact } from '../core/redact.js';
import type { OrgConnection, QueryPage } from './connection.js';
import { asArray, asRecord, optionalNumber, optionalString } from './connection.js';

export interface FetchConnectionOptions {
  instanceUrl: string;
  apiVersion: string;
  /**
   * Returns a currently-valid access token. Called per request, so a refresh
   * that happened in between is picked up without rebuilding the connection.
   *
   * @param forceRefresh when true, the provider must obtain a *new* token
   *        rather than return a cached one. Used exactly once per request,
   *        after a 401 — never in a loop.
   */
  getAccessToken(forceRefresh?: boolean): Promise<string>;
  /** Injected so tests never touch the network. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Abort a request that hangs. Default 30s. */
  timeoutMs?: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function createFetchOrgConnection(options: FetchConnectionOptions): OrgConnection {
  const instanceUrl = options.instanceUrl.replace(/\/+$/, '');
  const apiVersion = options.apiVersion;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  /**
   * Issues one GET.
   *
   * On 401 the token is refreshed and the request retried **exactly once**. A
   * second 401 is terminal: looping would mean re-prompting a user whose
   * session is genuinely gone, over and over, with no explanation.
   */
  async function request<T>(
    path: string,
    params?: Readonly<Record<string, string>>,
  ): Promise<T> {
    const url = buildUrl(instanceUrl, path, params);

    let response = await send(url, await options.getAccessToken());
    if (response.status === 401) {
      let refreshed: string;
      try {
        refreshed = await options.getAccessToken(true);
      } catch (cause) {
        throw new OrgAuthExpiredError(
          cause instanceof Error ? cause.message : 'the token could not be renewed',
        );
      }
      response = await send(url, refreshed);
      if (response.status === 401) {
        throw new OrgAuthExpiredError('the org rejected a freshly renewed token');
      }
    }

    if (!response.ok) {
      throw await toRequestFailure(response);
    }
    return (await readJson(response, path)) as T;
  }

  async function send(url: string, accessToken: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, {
        method: 'GET',
        headers: {
          // The token exists only as an argument here. It is never assigned to
          // a variable that outlives this call.
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
        signal: controller.signal,
        // No cookies. The extension authenticates with its own token and must
        // not silently ride an ambient browser session.
        credentials: 'omit',
      });
    } catch (cause) {
      throw new OrgUnreachableError(describeNetworkFailure(cause, timeoutMs));
    } finally {
      clearTimeout(timer);
    }
  }

  function toQueryPage<T>(payload: unknown, path: string): QueryPage<T> {
    const record = asRecord(payload, path);
    const records = asArray(record['records'], `${path}.records`) as T[];
    const nextRecordsUrl = optionalString(record['nextRecordsUrl']);

    return {
      records,
      // Salesforce always sends `done`; treat a missing one as "there may be
      // more" rather than assuming completeness.
      done: record['done'] === true,
      totalSize: optionalNumber(record['totalSize']) ?? records.length,
      ...(nextRecordsUrl === undefined ? {} : { nextRecordsUrl }),
    };
  }

  return {
    instanceUrl,
    apiVersion,

    get<T>(path: string, params?: Readonly<Record<string, string>>): Promise<T> {
      return request<T>(path, params);
    },

    async toolingQuery<T>(soql: string): Promise<QueryPage<T>> {
      const path = `/services/data/v${apiVersion}/tooling/query`;
      return toQueryPage<T>(await request<unknown>(path, { q: soql }), 'toolingQuery');
    },

    async queryMore<T>(nextRecordsUrl: string): Promise<QueryPage<T>> {
      // `nextRecordsUrl` comes back from the org as an absolute path on the same
      // instance. Refuse anything else rather than following a redirect an
      // attacker-controlled response could have planted.
      if (!nextRecordsUrl.startsWith('/services/data/')) {
        throw new OrgResponseInvalidError(
          'nextRecordsUrl',
          `expected a path under /services/data/, received "${nextRecordsUrl}"`,
        );
      }
      return toQueryPage<T>(await request<unknown>(nextRecordsUrl), 'queryMore');
    },
  };
}

/**
 * Walks every page of a query and returns all records.
 *
 * `maxPages` is a hard stop, not a suggestion: a paging bug against a large org
 * would otherwise spend the whole daily API budget in a loop.
 */
export async function collectAllPages<T>(
  connection: OrgConnection,
  first: QueryPage<T>,
  maxPages = 20,
): Promise<{ records: T[]; truncated: boolean }> {
  const records = [...first.records];
  let page = first;
  let pages = 1;

  while (!page.done && page.nextRecordsUrl !== undefined) {
    if (pages >= maxPages) return { records, truncated: true };
    page = await connection.queryMore<T>(page.nextRecordsUrl);
    records.push(...page.records);
    pages += 1;
  }
  return { records, truncated: false };
}

function buildUrl(
  instanceUrl: string,
  path: string,
  params?: Readonly<Record<string, string>>,
): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, instanceUrl);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function readJson(response: Response, path: string): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new OrgUnreachableError(
      `the response body could not be read (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }

  if (text.trim().length === 0) {
    throw new OrgResponseInvalidError(path, 'the org returned an empty body');
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    void cause;
    // A Salesforce login redirect returns HTML, and that is the most likely
    // cause here — so say what it looked like rather than "unexpected token".
    const looksLikeHtml = /^\s*</.test(text);
    throw new OrgResponseInvalidError(
      path,
      looksLikeHtml
        ? 'the org returned HTML rather than JSON, which usually means the request was redirected to a login page'
        : // Redacted: this is an arbitrary body we are quoting back, and a
          // token could be anywhere in it.
          `the org returned a body that is not JSON (starts with "${redact(text.slice(0, 40))}")`,
    );
  }
}

/**
 * Turns a non-2xx into a typed error.
 *
 * Salesforce returns `[{errorCode, message}]` for most failures; anything else
 * is reported by status alone rather than guessed at.
 */
async function toRequestFailure(response: Response): Promise<OrgRequestFailedError> {
  let errorCode = '';
  let detail = response.statusText || 'no detail was provided';

  try {
    const body = JSON.parse(await response.text()) as unknown;
    // `Array.isArray` narrows `unknown` to `any[]`, so the element type is
    // restated as `unknown` rather than inherited as `any`.
    const first: unknown = Array.isArray(body) ? (body as unknown[])[0] : body;
    const record = typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : {};
    errorCode = optionalString(record['errorCode']) ?? '';
    // The org controls this string and it reaches the panel. `oauth.ts` has
    // always redacted its equivalent; this path did not, which was a gap.
    detail = redact(optionalString(record['message']) ?? detail);
  } catch (cause) {
    // A non-JSON error body is normal for 5xx and gateway pages. The status is
    // the useful part; keep it rather than replacing it with a parse error.
    void cause;
  }

  return new OrgRequestFailedError(response.status, errorCode, detail);
}

function describeNetworkFailure(cause: unknown, timeoutMs: number): string {
  if (cause instanceof Error && cause.name === 'AbortError') {
    return `the request timed out after ${timeoutMs / 1000}s`;
  }
  if (cause instanceof Error) return redact(cause.message);
  return redact(String(cause));
}
