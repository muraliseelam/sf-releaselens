/**
 * `FakeOrgConnection` — the test double for the org network port.
 *
 * The project has no live Salesforce org and does not need one: this replays
 * canned responses keyed by request, records every call, and can be told to
 * fail in each of the ways `docs/DATASOURCE.md` §8 specifies. Anything that can
 * only be checked against a real org is listed in the "requires a live org"
 * section of `docs/QA-CHECKLIST.md` rather than faked into a false pass.
 */

import type { OrgConnection, QueryPage } from '../../src/data/connection.js';

export interface FakeConnectionOptions {
  instanceUrl?: string;
  apiVersion?: string;
  /**
   * REST responses keyed by path, e.g. `/services/data/v62.0/limits`.
   * A path with no entry rejects, which is what an unknown endpoint does.
   */
  getResponses?: Readonly<Record<string, unknown>>;
  /**
   * Tooling query responses. Keyed by a substring of the SOQL, so a test can
   * key on `FROM DeployRequest` without restating the whole query.
   *
   * `reject` fails that one query while the others succeed — the shape of a
   * real org that answers for deploys but not for
   * `ApexCodeCoverageAggregate`, which is one of the five measured.
   */
  queryResponses?: readonly (
    | { match: string; response: unknown; reject?: undefined }
    | { match: string; response?: undefined; reject: Error }
  )[];
  /** `queryMore` responses keyed by `nextRecordsUrl`. */
  queryMoreResponses?: Readonly<Record<string, unknown>>;
  /** Thrown by whichever member is named, to exercise a single failure. */
  failures?: Readonly<Partial<Record<'get' | 'toolingQuery' | 'queryMore', Error>>>;
}

export interface FakeOrgConnection extends OrgConnection {
  /** Every call, in order, so a test can assert the call count and shape. */
  readonly calls: { kind: 'get' | 'toolingQuery' | 'queryMore'; argument: string }[];
  /** Count of network round trips, for asserting `load()` makes none. */
  readonly requestCount: () => number;
}

export function fakeOrgConnection(options: FakeConnectionOptions = {}): FakeOrgConnection {
  const calls: { kind: 'get' | 'toolingQuery' | 'queryMore'; argument: string }[] = [];

  function fail(kind: 'get' | 'toolingQuery' | 'queryMore'): void {
    const failure = options.failures?.[kind];
    if (failure !== undefined) throw failure;
  }

  function toPage<T>(payload: unknown, what: string): QueryPage<T> {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error(`FakeOrgConnection has no response for ${what}`);
    }
    const record = payload as Record<string, unknown>;
    const records = (record['records'] ?? []) as T[];
    const nextRecordsUrl = record['nextRecordsUrl'];
    return {
      records,
      done: record['done'] !== false,
      totalSize: typeof record['totalSize'] === 'number' ? record['totalSize'] : records.length,
      ...(typeof nextRecordsUrl === 'string' ? { nextRecordsUrl } : {}),
    };
  }

  return {
    instanceUrl: options.instanceUrl ?? 'https://acme.my.salesforce.com',
    apiVersion: options.apiVersion ?? '62.0',
    calls,
    requestCount: () => calls.length,

    get<T>(path: string): Promise<T> {
      calls.push({ kind: 'get', argument: path });
      try {
        fail('get');
      } catch (cause) {
        return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
      const response = options.getResponses?.[path];
      if (response === undefined) {
        return Promise.reject(new Error(`FakeOrgConnection has no GET response for "${path}"`));
      }
      return Promise.resolve(response as T);
    },

    toolingQuery<T>(soql: string): Promise<QueryPage<T>> {
      calls.push({ kind: 'toolingQuery', argument: soql });
      try {
        fail('toolingQuery');
      } catch (cause) {
        return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
      const entry = options.queryResponses?.find((candidate) => soql.includes(candidate.match));
      if (entry === undefined) {
        return Promise.reject(
          new Error(`FakeOrgConnection has no query response matching: ${soql.slice(0, 80)}`),
        );
      }
      if (entry.reject !== undefined) return Promise.reject(entry.reject);
      return Promise.resolve(toPage<T>(entry.response, soql.slice(0, 40)));
    },

    queryMore<T>(nextRecordsUrl: string): Promise<QueryPage<T>> {
      calls.push({ kind: 'queryMore', argument: nextRecordsUrl });
      try {
        fail('queryMore');
      } catch (cause) {
        return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
      const response = options.queryMoreResponses?.[nextRecordsUrl];
      if (response === undefined) {
        return Promise.reject(
          new Error(`FakeOrgConnection has no queryMore response for "${nextRecordsUrl}"`),
        );
      }
      return Promise.resolve(toPage<T>(response, nextRecordsUrl));
    },
  };
}
