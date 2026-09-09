import { describe, expect, it } from 'vitest';

import { createFixedClock, createSequentialIdFactory } from '../../src/core/clock.js';
import { createRouter, serialiseError } from '../../src/background/router.js';
import type { Response } from '../../src/background/messages.js';
import { createLocalDataSource } from '../../src/data/local.js';
import { createMemoryStorageArea, type StorageArea } from '../../src/data/storage.js';
import type { Snapshot } from '../../src/core/types.js';
import { FIXED_NOW, realisticSnapshot } from '../fixtures/snapshot.js';

function build(injectedStorage?: StorageArea) {
  const storage = injectedStorage ?? createMemoryStorageArea();
  const deps = {
    clock: createFixedClock(FIXED_NOW),
    newId: createSequentialIdFactory('gen'),
  };
  const dataSource = createLocalDataSource({
    storage,
    ...deps,
    seedFactory: () => realisticSnapshot(),
  });
  return createRouter({
    dataSource,
    deps,
    deployImportDefaults: {
      environmentName: 'Imported org',
      environmentKind: 'sandbox',
      orgAlias: 'imported',
      owner: 'Local user',
    },
    diagnosticEnvironment: {
      // A manifest-shaped version. Chrome forbids prerelease suffixes, and the
      // sanitiser refuses anything else — see the fail-closed test below.
      extensionVersion: '0.5.3',
      browserMajorVersion: '131',
      platform: 'Linux',
      apiVersion: '62.0',
    },
    diagnosticStorage: storage,
    settingsStorage: storage,
  });
}

describe('telemetry is off until somebody turns it on', () => {
  it('reports disabled on a fresh install, with no id anywhere', async () => {
    const storage = createMemoryStorageArea();
    const router = build(storage);

    const info = expectOk<{ enabled: boolean; hasInstallId: boolean; destination: string }>(
      await router.handle({ type: 'telemetry.info' }),
    );

    expect(info.enabled).toBe(false);
    expect(info.hasInstallId).toBe(false);
    // A user who never opts in has no identifier generated, stored or written.
    expect(await storage.read('sf-releaselens.telemetry.v1')).toBeUndefined();
    expect(info.destination).toMatch(/no endpoint/i);
  });

  it('records nothing while it is off, and says so rather than pretending', async () => {
    const router = build();

    const result = expectOk<{ recorded: boolean }>(
      await router.handle({ type: 'telemetry.record', event: { name: 'view.opened', view: 'inspector' } }),
    );

    expect(result.recorded).toBe(false);
  });

  it('creates an id only when enabled, and deletes it when disabled', async () => {
    const storage = createMemoryStorageArea();
    const router = build(storage);

    const enabled = expectOk<{ enabled: boolean; hasInstallId: boolean }>(
      await router.handle({ type: 'telemetry.setEnabled', enabled: true }),
    );
    expect(enabled).toMatchObject({ enabled: true, hasInstallId: true });
    const stored = await storage.read('sf-releaselens.telemetry.v1');
    expect(stored).toMatchObject({ enabled: true });

    const disabled = expectOk<{ enabled: boolean; hasInstallId: boolean }>(
      await router.handle({ type: 'telemetry.setEnabled', enabled: false }),
    );
    expect(disabled).toMatchObject({ enabled: false, hasInstallId: false });
    // Deleted, not merely unused: re-enabling yields a different id, so two
    // opt-in periods cannot be joined.
    expect(await storage.read('sf-releaselens.telemetry.v1')).toBeUndefined();
  });

  it('records once it is on', async () => {
    const router = build();
    await router.handle({ type: 'telemetry.setEnabled', enabled: true });

    const result = expectOk<{ recorded: boolean }>(
      await router.handle({ type: 'telemetry.record', event: { name: 'view.opened', view: 'approvals' } }),
    );

    expect(result.recorded).toBe(true);
  });

  it('fails closed when the version is not manifest-shaped', async () => {
    const storage = createMemoryStorageArea();
    const router = createRouter({
      dataSource: createLocalDataSource({
        storage,
        clock: createFixedClock(FIXED_NOW),
        newId: createSequentialIdFactory('gen'),
        seedFactory: () => realisticSnapshot(),
      }),
      deps: { clock: createFixedClock(FIXED_NOW), newId: createSequentialIdFactory('gen') },
      deployImportDefaults: {
        environmentName: 'Imported org',
        environmentKind: 'sandbox',
        orgAlias: 'imported',
        owner: 'Local user',
      },
      diagnosticEnvironment: {
        extensionVersion: '0.0.0-not-a-manifest-version',
        browserMajorVersion: '131',
        platform: 'Linux',
        apiVersion: '62.0',
      },
      diagnosticStorage: storage,
      settingsStorage: storage,
    });
    await router.handle({ type: 'telemetry.setEnabled', enabled: true });

    const result = expectOk<{ recorded: boolean }>(
      await router.handle({ type: 'telemetry.record', event: { name: 'view.opened', view: 'dashboard' } }),
    );

    // Nothing goes out that the allow-list cannot vouch for, including a field
    // this build supplied itself.
    expect(result.recorded).toBe(false);
  });

  it('refuses an event it does not know, even while enabled', async () => {
    const router = build();
    await router.handle({ type: 'telemetry.setEnabled', enabled: true });

    const result = expectOk<{ recorded: boolean }>(
      await router.handle({
        type: 'telemetry.record',
        // A shape a future contributor might add without thinking.
        event: { name: 'org.refreshed', releases: 12 },
      }),
    );

    expect(result.recorded).toBe(false);
  });
});

/** Narrows a response, failing the test with the real message when it is not ok. */
function expectOk<T>(response: Response<unknown>): T {
  if (!response.ok) {
    throw new Error(`Expected an ok response, got ${response.error.code}: ${response.error.message}`);
  }
  return response.data as T;
}

describe('router', () => {
  it('loads a snapshot', async () => {
    const snapshot = expectOk<Snapshot>(await build().handle({ type: 'snapshot.load' }));

    expect(snapshot.releases).toHaveLength(3);
  });

  it('records a decision and returns the consequence for the release', async () => {
    const router = build();

    const result = expectOk<{
      approval: { status: string };
      statusChange: { from: string; to: string } | null;
    }>(
      await router.handle({
        type: 'approval.decide',
        approvalId: 'apr-uat',
        outcome: 'approved',
        comment: 'Checked in UAT.',
      }),
    );

    expect(result.approval.status).toBe('approved');
    // apr-qa is still pending on the same release, so nothing moves yet.
    expect(result.statusChange).toBeNull();
  });

  it('returns failures as data rather than rejecting', async () => {
    const response = await build().handle({
      type: 'approval.decide',
      approvalId: 'apr-cab',
      outcome: 'approved',
      comment: null,
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_APPROVAL_TRANSITION');
      expect(response.error.message).toMatch(/already rejected/);
    }
  });

  it('reports an unknown message type by name', async () => {
    const response = await build().handle({ type: 'launch.rockets' });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('UNKNOWN_MESSAGE');
      expect(response.error.message).toMatch(/launch\.rockets/);
    }
  });

  it.each([[null], [42], ['hello'], [{ notAType: true }]])(
    'rejects a malformed message (%s) without throwing',
    async (message) => {
      const response = await build().handle(message);

      expect(response.ok).toBe(false);
    },
  );

  it('exports a filename and JSON body', async () => {
    const payload = expectOk<{ filename: string; json: string }>(
      await build().handle({ type: 'snapshot.export' }),
    );

    expect(payload.filename).toBe('sf-releaselens-2026-09-07T09-00-00-000Z.json');
    expect((JSON.parse(payload.json) as Snapshot).releases).toHaveLength(3);
  });

  it('imports an export and keeps the current local profile', async () => {
    const router = build();
    await router.handle({ type: 'actor.set', actor: { name: 'Lin Zhou', roles: ['qa-lead'] } });

    const foreign = { ...realisticSnapshot(), actor: { name: 'Someone Else', roles: ['admin'] } };
    const imported = expectOk<Snapshot>(
      await router.handle({ type: 'snapshot.import', text: JSON.stringify(foreign) }),
    );

    expect(imported.actor).toEqual({ name: 'Lin Zhou', roles: ['qa-lead'] });
  });

  it('reports an import format failure with the code the panel branches on', async () => {
    const response = await build().handle({ type: 'snapshot.import', text: 'definitely not json' });

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('IMPORT_FORMAT');
  });

  it('resets to empty', async () => {
    const snapshot = expectOk<Snapshot>(
      await build().handle({ type: 'snapshot.reset', seed: 'empty' }),
    );

    expect(snapshot.releases).toEqual([]);
  });

  it('returns raw stored data for rescue', async () => {
    const router = build();
    await router.handle({ type: 'snapshot.load' });

    const payload = expectOk<{ raw: unknown }>(await router.handle({ type: 'snapshot.readRaw' }));

    expect(payload.raw).toHaveProperty('schemaVersion', 1);
  });
});

describe('serialiseError', () => {
  it('keeps the code of a known error', () => {
    const error = serialiseError(new RangeError('out of range'));

    expect(error).toEqual({ code: 'UNEXPECTED', name: 'RangeError', message: 'out of range' });
  });

  it('handles a thrown non-error', () => {
    expect(serialiseError('just a string')).toEqual({
      code: 'UNEXPECTED',
      name: 'Error',
      message: 'just a string',
    });
  });
});
