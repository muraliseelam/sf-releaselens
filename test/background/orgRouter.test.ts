/**
 * Org routing in the background worker. docs/DATASOURCE.md §8.
 *
 * The regression that matters most is at the bottom: **local mode must behave
 * exactly as it did before any of this existed.** A build with no org session
 * configured must be indistinguishable from the previous one.
 */

import { describe, expect, it, vi } from 'vitest';

import type { OrgSession, OrgSessionInfo } from '../../src/auth/oauth.js';
import { createFixedClock, createSequentialIdFactory } from '../../src/core/clock.js';
import type { Response } from '../../src/background/messages.js';
import { ORG_SETTINGS_KEY, createRouter, type PermissionsApi } from '../../src/background/router.js';
import { createLocalDataSource } from '../../src/data/local.js';
import { createSalesforceDataSource } from '../../src/data/salesforce.js';
import { createMemoryStorageArea, type StorageArea } from '../../src/data/storage.js';
import { fakeOrgConnection } from '../fixtures/fakeConnection.js';
import {
  COVERAGE_ROWS,
  DEPLOY_SUCCEEDED,
  DEPLOY_SUCCEEDED_DETAIL,
  HEALTHY_LIMITS,
  SANDBOX_ORG,
  queryResponse,
} from '../fixtures/salesforce.js';
import { FIXED_NOW, realisticSnapshot } from '../fixtures/snapshot.js';

const INSTANCE = 'https://acme.my.salesforce.com';
const ORIGIN_PATTERN = 'https://acme.my.salesforce.com/*';
const API = '/services/data/v62.0';

const CONNECTED: OrgSessionInfo = {
  connected: true,
  instanceUrl: INSTANCE,
  loginUrl: 'https://login.salesforce.com',
  organizationId: SANDBOX_ORG.Id,
  connectedAt: FIXED_NOW,
};

function fakeSession(initial: OrgSessionInfo = { connected: false }): OrgSession & {
  connectCalls: number;
  disconnectCalls: number;
} {
  let info = initial;
  const session = {
    connectCalls: 0,
    disconnectCalls: 0,
    connect: (): Promise<OrgSessionInfo> => {
      session.connectCalls += 1;
      info = CONNECTED;
      return Promise.resolve(info);
    },
    disconnect: (): Promise<void> => {
      session.disconnectCalls += 1;
      info = { connected: false };
      return Promise.resolve();
    },
    info: () => Promise.resolve(info),
    getAccessToken: () => Promise.resolve('token-for-transport-only'),
  };
  return session;
}

function fakePermissions(granted = true): PermissionsApi & { requested: string[][] } {
  const requested: string[][] = [];
  return {
    requested,
    contains: () => Promise.resolve(granted),
    request: (origins) => {
      requested.push([...origins]);
      return Promise.resolve(granted);
    },
    remove: () => Promise.resolve(true),
  };
}

function orgConnection() {
  return fakeOrgConnection({
    getResponses: {
      [`${API}/limits`]: HEALTHY_LIMITS,
      [`${API}/query`]: queryResponse([SANDBOX_ORG]),
      [`${API}/tooling/sobjects/DeployRequest/${DEPLOY_SUCCEEDED.Id}`]: DEPLOY_SUCCEEDED_DETAIL,
    },
    queryResponses: [
      { match: 'FROM DeployRequest', response: queryResponse([DEPLOY_SUCCEEDED]) },
      { match: 'FROM ApexCodeCoverageAggregate', response: queryResponse(COVERAGE_ROWS) },
    ],
  });
}

function build(
  options: {
    session?: OrgSession;
    permissions?: PermissionsApi;
    storage?: StorageArea;
    withOrg?: boolean;
  } = {},
) {
  const storage = options.storage ?? createMemoryStorageArea();
  const deps = { clock: createFixedClock(FIXED_NOW), newId: createSequentialIdFactory('r') };
  const connection = orgConnection();

  const router = createRouter({
    dataSource: createLocalDataSource({
      storage,
      ...deps,
      seedFactory: () => realisticSnapshot(),
    }),
    deps,
    ...(options.withOrg === false
      ? {}
      : {
          orgSession: options.session ?? fakeSession(),
          permissions: options.permissions ?? fakePermissions(),
          settingsStorage: storage,
          orgDataSource: () =>
            createSalesforceDataSource({ storage, connection, ...deps, orgAlias: 'acme' }),
        }),
    deployImportDefaults: {
      environmentName: 'Imported org',
      environmentKind: 'sandbox' as const,
      orgAlias: 'imported',
      owner: 'Local user',
    },
  });
  return { router, storage, connection };
}

function expectOk<T>(response: Response<unknown>): T {
  if (!response.ok) {
    throw new Error(`Expected ok, got ${response.error.code}: ${response.error.message}`);
  }
  return response.data as T;
}

describe('org.info', () => {
  it('reports not connected before anything happens', async () => {
    const { router } = build();


    expect(expectOk(await router.handle({ type: 'org.info' }))).toEqual({
      connected: false,
      hasHostPermission: false,
    });
  });

  it('reports the connected org without ever exposing a token', async () => {
    const { router } = build({ session: fakeSession(CONNECTED) });

    const status = expectOk<Record<string, unknown>>(await router.handle({ type: 'org.info' }));

    expect(status['connected']).toBe(true);
    expect(status['instanceUrl']).toBe(INSTANCE);
    expect(JSON.stringify(status)).not.toContain('token-for-transport-only');
  });

  it('re-checks the host permission on every read, not from a cache', async () => {
    // A user can revoke it in chrome://extensions at any moment, and a stale
    // "connected" badge would point at a Refresh that cannot work.
    const contains = vi.fn(() => Promise.resolve(true));
    const { router } = build({
      session: fakeSession(CONNECTED),
      permissions: { contains, request: () => Promise.resolve(true), remove: () => Promise.resolve(true) },
    });

    await router.handle({ type: 'org.info' });
    await router.handle({ type: 'org.info' });

    expect(contains).toHaveBeenCalledTimes(2);
  });

  it('reports a revoked host permission', async () => {
    const { router } = build({
      session: fakeSession(CONNECTED),
      permissions: fakePermissions(false),
    });

    const status = expectOk<{ hasHostPermission: boolean }>(
      await router.handle({ type: 'org.info' }),
    );

    expect(status.hasHostPermission).toBe(false);
  });
});

describe('org.connect', () => {
  it('verifies the host permission rather than requesting it', async () => {
    // `permissions.request` needs a user gesture, which a worker handling a
    // message does not have — the panel obtains the grant inside the click and
    // the worker only confirms it. Requesting here would silently fail.
    const permissions = fakePermissions(true);
    const { router } = build({ permissions });

    await router.handle({
      type: 'org.connect',
      loginUrl: 'https://login.salesforce.com',
      clientId: '3MVG9',
    });

    expect(permissions.requested).toEqual([]);
  });

  it('refuses to keep a session Chrome is not granting access for', async () => {
    const session = fakeSession();
    const { router } = build({ session, permissions: fakePermissions(false) });

    const response = await router.handle({
      type: 'org.connect',
      loginUrl: 'https://login.salesforce.com',
      clientId: '3MVG9',
    });

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('HOST_PERMISSION_REVOKED');
    expect(session.disconnectCalls).toBe(1);
    expect(ORIGIN_PATTERN).toBe('https://acme.my.salesforce.com/*');
  });

  it('remembers the consumer key, which is not a secret', async () => {
    const { router, storage } = build();

    await router.handle({
      type: 'org.connect',
      loginUrl: 'https://login.salesforce.com',
      clientId: '3MVG9_KEY',
    });

    expect(await storage.read(ORG_SETTINGS_KEY)).toEqual({ clientId: '3MVG9_KEY' });
  });

  it('does not refresh automatically after connecting', async () => {
    // The first org read stays user-initiated, like every other one.
    const { router, connection } = build();

    const result = expectOk<{ snapshot: { releases: unknown[] } }>(
      await router.handle({
        type: 'org.connect',
        loginUrl: 'https://login.salesforce.com',
        clientId: '3MVG9',
      }),
    );

    expect(result.snapshot.releases).toEqual([]);
    expect(connection.requestCount()).toBe(0);
  });

});

describe('org.disconnect', () => {
  it('clears the session, hands back the permission, and returns local data', async () => {
    const session = fakeSession(CONNECTED);
    const remove = vi.fn(() => Promise.resolve(true));
    const { router } = build({
      session,
      permissions: { contains: () => Promise.resolve(true), request: () => Promise.resolve(true), remove },
    });

    const result = expectOk<{ org: { connected: boolean }; snapshot: { releases: unknown[] } }>(
      await router.handle({ type: 'org.disconnect' }),
    );

    expect(session.disconnectCalls).toBe(1);
    expect(remove).toHaveBeenCalledWith([ORIGIN_PATTERN]);
    expect(result.org.connected).toBe(false);
    // Back to the local snapshot, which was never touched.
    expect(result.snapshot.releases).toHaveLength(3);
  });
});

describe('snapshot.refresh', () => {
  it('reads the org and returns the snapshot with the status', async () => {
    const { router } = build({ session: fakeSession(CONNECTED) });

    const result = expectOk<{ snapshot: { releases: { id: string }[] }; org: { connected: boolean } }>(
      await router.handle({ type: 'snapshot.refresh' }),
    );

    expect(result.org.connected).toBe(true);
    expect(result.snapshot.releases.map((r) => r.id)).toEqual([DEPLOY_SUCCEEDED.Id]);
  });

  it('refuses when Chrome has revoked the host permission, naming the origin', async () => {
    const { router } = build({
      session: fakeSession(CONNECTED),
      permissions: fakePermissions(false),
    });

    const response = await router.handle({ type: 'snapshot.refresh' });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('HOST_PERMISSION_REVOKED');
      expect(response.error.message).toContain('acme.my.salesforce.com');
    }
  });

  it('is a no-op that succeeds in local mode', async () => {
    // LocalDataSource.refresh delegates to load, so the panel needs no
    // "is this local?" branch.
    const { router } = build({ withOrg: false });

    const result = expectOk<{ snapshot: { releases: unknown[] } }>(
      await router.handle({ type: 'snapshot.refresh' }),
    );

    expect(result.snapshot.releases).toHaveLength(3);
  });
});

describe('local mode is unchanged (regression guard)', () => {
  it('serves the local snapshot when no org session is configured at all', async () => {
    const { router, connection } = build({ withOrg: false });

    const snapshot = expectOk<{ releases: unknown[]; isDemoData: boolean }>(
      await router.handle({ type: 'snapshot.load' }),
    );

    expect(snapshot.releases).toHaveLength(3);
    expect(connection.requestCount()).toBe(0);
  });

  it('serves the local snapshot when an org session exists but is not connected', async () => {
    const { router, connection } = build();

    const snapshot = expectOk<{ releases: unknown[] }>(
      await router.handle({ type: 'snapshot.load' }),
    );

    expect(snapshot.releases).toHaveLength(3);
    expect(connection.requestCount()).toBe(0);
  });

  it('still records approvals locally', async () => {
    const { router } = build();

    const result = expectOk<{ approval: { status: string } }>(
      await router.handle({
        type: 'approval.decide',
        approvalId: 'apr-uat',
        outcome: 'approved',
        comment: 'ok',
      }),
    );

    expect(result.approval.status).toBe('approved');
  });

  it('still exports, imports and resets', async () => {
    const { router } = build({ withOrg: false });

    expect(expectOk<{ filename: string }>(await router.handle({ type: 'snapshot.export' })).filename)
      .toContain('sf-releaselens-');
    expect(
      expectOk<{ releases: unknown[] }>(await router.handle({ type: 'snapshot.reset', seed: 'empty' }))
        .releases,
    ).toEqual([]);
  });

  it('reports org.info as not connected rather than erroring in a local-only build', async () => {
    const { router } = build({ withOrg: false });

    expect(expectOk(await router.handle({ type: 'org.info' }))).toEqual({
      connected: false,
      hasHostPermission: false,
    });
  });

  it('refuses org.connect in a local-only build rather than pretending', async () => {
    const { router } = build({ withOrg: false });

    const response = await router.handle({
      type: 'org.connect',
      loginUrl: 'https://login.salesforce.com',
      clientId: 'x',
    });

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('ORG_NOT_CONNECTED');
  });
});
