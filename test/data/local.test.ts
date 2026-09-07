import { beforeEach, describe, expect, it } from 'vitest';

import { createFixedClock, createSequentialIdFactory } from '../../src/core/clock.js';
import {
  InvalidApprovalTransitionError,
  StorageQuotaExceededError,
  UnsupportedSchemaVersionError,
} from '../../src/core/errors.js';
import type { DataSource } from '../../src/data/datasource.js';
import { SNAPSHOT_STORAGE_KEY, createLocalDataSource } from '../../src/data/local.js';
import { createMemoryStorageArea, type StorageArea } from '../../src/data/storage.js';
import { FIXED_NOW, realisticSnapshot } from '../fixtures/snapshot.js';

function build(options: { storage?: StorageArea } = {}): {
  storage: StorageArea;
  dataSource: DataSource;
} {
  const storage = options.storage ?? createMemoryStorageArea();
  const dataSource = createLocalDataSource({
    storage,
    clock: createFixedClock(FIXED_NOW),
    newId: createSequentialIdFactory('gen'),
    seedFactory: () => realisticSnapshot(),
  });
  return { storage, dataSource };
}

describe('LocalDataSource', () => {
  let storage: StorageArea;
  let dataSource: DataSource;

  beforeEach(() => {
    ({ storage, dataSource } = build());
  });

  it('seeds on genuine first run and persists what it seeded', async () => {
    const loaded = await dataSource.load();

    expect(loaded.releases).toHaveLength(3);
    expect(await storage.read(SNAPSHOT_STORAGE_KEY)).not.toBeUndefined();
    // The second load reads storage rather than re-seeding.
    expect(await dataSource.load()).toEqual(loaded);
  });

  it('records a decision and persists the result', async () => {
    const result = await dataSource.decide({
      approvalId: 'apr-uat',
      outcome: 'approved',
      comment: 'Verified in UAT.',
    });

    expect(result.approval.status).toBe('approved');
    const reloaded = await dataSource.load();
    expect(reloaded.approvals.find((a) => a.id === 'apr-uat')?.decision?.comment).toBe(
      'Verified in UAT.',
    );
  });

  it('rejects a second decision on the same approval instead of last-write-wins', async () => {
    // Two panels holding the same stale snapshot: the second write must lose.
    await dataSource.decide({ approvalId: 'apr-uat', outcome: 'approved', comment: null });

    await expect(
      dataSource.decide({ approvalId: 'apr-uat', outcome: 'rejected', comment: 'changed my mind' }),
    ).rejects.toThrow(InvalidApprovalTransitionError);

    const reloaded = await dataSource.load();
    expect(reloaded.approvals.find((a) => a.id === 'apr-uat')?.status).toBe('approved');
  });

  it('round-trips export to import without loss', async () => {
    const exported = await dataSource.exportSnapshot();

    const fresh = build().dataSource;
    const imported = await fresh.importSnapshot(JSON.parse(JSON.stringify(exported)));

    expect(imported.releases).toEqual(exported.releases);
    expect(imported.items).toEqual(exported.items);
    expect(imported.approvals).toEqual(exported.approvals);
  });

  it('marks an imported snapshot as no longer demo data and audits the import', async () => {
    const demo = { ...realisticSnapshot(), isDemoData: true };
    const imported = await dataSource.importSnapshot(JSON.parse(JSON.stringify(demo)));

    expect(imported.isDemoData).toBe(false);
    expect(imported.auditLog.at(-1)?.action).toBe('snapshot.imported');
    expect(imported.auditLog.at(-1)?.detail).toMatch(/3 release\(s\), 5 component\(s\)/);
  });

  it('leaves the stored snapshot untouched when an import is invalid', async () => {
    const before = await dataSource.load();

    await expect(dataSource.importSnapshot({ schemaVersion: 42 })).rejects.toThrow(
      UnsupportedSchemaVersionError,
    );

    expect(await dataSource.load()).toEqual(before);
  });

  it('does not seed over stored data that fails validation', async () => {
    await storage.write(SNAPSHOT_STORAGE_KEY, { schemaVersion: 42, oops: true });

    await expect(dataSource.load()).rejects.toThrow(UnsupportedSchemaVersionError);
    // The unreadable data is still there to be exported for rescue.
    expect(await dataSource.readRaw()).toEqual({ schemaVersion: 42, oops: true });
  });

  it('resets to empty while keeping the current profile, and audits it', async () => {
    await dataSource.load();
    const reset = await dataSource.reset('empty');

    expect(reset.releases).toEqual([]);
    expect(reset.items).toEqual([]);
    expect(reset.actor.name).toBe('Sam Okafor');
    expect(reset.auditLog.map((entry) => entry.action)).toEqual(['snapshot.reset']);
  });

  it('resets to demo data even when the stored snapshot is corrupt', async () => {
    await storage.write(SNAPSHOT_STORAGE_KEY, { not: 'a snapshot' });

    const reset = await dataSource.reset('demo');

    // Demo data brings its own profile; the corrupt one is not consulted.
    expect(reset.releases).toHaveLength(3);
    expect(reset.actor.name).toBe('Sam Okafor');
  });

  it('resets to empty over a corrupt snapshot using a fallback profile', async () => {
    // The corrupt snapshot cannot supply an actor, so resetting must still
    // work rather than failing on the data it is there to replace.
    await storage.write(SNAPSHOT_STORAGE_KEY, { not: 'a snapshot' });

    const reset = await dataSource.reset('empty');

    expect(reset.releases).toEqual([]);
    expect(reset.actor).toEqual({ name: 'Local user', roles: ['release-manager'] });
  });

  it('changes the actor and persists it', async () => {
    const updated = await dataSource.setActor({ name: 'Lin Zhou', roles: ['qa-lead'] });

    expect(updated.actor.roles).toEqual(['qa-lead']);
    expect((await dataSource.load()).actor.name).toBe('Lin Zhou');
  });

  it('surfaces a quota failure as a typed error naming the size', async () => {
    const tiny = build({ storage: createMemoryStorageArea({ quotaBytes: 10 }) });

    await expect(tiny.dataSource.load()).rejects.toThrow(StorageQuotaExceededError);
  });

  it('returns undefined raw data before anything is stored', async () => {
    expect(await dataSource.readRaw()).toBeUndefined();
  });
});
