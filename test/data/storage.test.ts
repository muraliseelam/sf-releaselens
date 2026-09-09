import { describe, expect, it } from 'vitest';

import { StorageQuotaExceededError, StorageUnavailableError } from '../../src/core/errors.js';
import { createChromeStorageArea, createMemoryStorageArea } from '../../src/data/storage.js';

/** Minimal stand-in for `chrome.storage.StorageArea`, driven per test. */
function fakeArea(behaviour: {
  get?: () => Promise<Record<string, unknown>>;
  set?: () => Promise<void>;
  remove?: () => Promise<void>;
}) {
  return {
    get: behaviour.get ?? (() => Promise.resolve({})),
    set: behaviour.set ?? (() => Promise.resolve()),
    remove: behaviour.remove ?? (() => Promise.resolve()),
  } as unknown as chrome.storage.StorageArea;
}

describe('MemoryStorageArea', () => {
  it('reads back what it wrote, and undefined for an unknown key', async () => {
    const storage = createMemoryStorageArea();
    await storage.write('k', { a: 1 });

    expect(await storage.read('k')).toEqual({ a: 1 });
    expect(await storage.read('other')).toBeUndefined();
  });

  it('does not hand back the same object reference, as chrome.storage would not', async () => {
    const storage = createMemoryStorageArea();
    const written = { nested: { value: 1 } };
    await storage.write('k', written);

    const read = (await storage.read('k')) as typeof written;
    read.nested.value = 2;

    expect(((await storage.read('k')) as typeof written).nested.value).toBe(1);
  });

  it('removes a key', async () => {
    const storage = createMemoryStorageArea();
    await storage.write('k', 1);
    await storage.remove('k');

    expect(await storage.read('k')).toBeUndefined();
  });

  it('enforces an optional quota so the quota path is reachable in tests', async () => {
    const storage = createMemoryStorageArea({ quotaBytes: 5 });

    await expect(storage.write('k', 'a much longer value')).rejects.toThrow(
      StorageQuotaExceededError,
    );
  });
});

describe('ChromeStorageArea', () => {
  it('unwraps the keyed result object chrome.storage returns', async () => {
    const storage = createChromeStorageArea(
      fakeArea({ get: () => Promise.resolve({ k: 'value' }) }),
    );

    expect(await storage.read('k')).toBe('value');
  });

  it('converts a QUOTA_BYTES failure into a typed quota error naming the size', async () => {
    const storage = createChromeStorageArea(
      fakeArea({ set: () => Promise.reject(new Error('QUOTA_BYTES quota exceeded')) }),
    );

    await expect(storage.write('k', { some: 'value' })).rejects.toThrow(StorageQuotaExceededError);
    // {"some":"value"} serialises to 16 characters.
    await expect(storage.write('k', { some: 'value' })).rejects.toThrow(/16 bytes/);
  });

  it('wraps any other storage failure with the operation that caused it', async () => {
    const storage = createChromeStorageArea(
      fakeArea({ set: () => Promise.reject(new Error('disk on fire')) }),
    );

    await expect(storage.write('k', 1)).rejects.toThrow(StorageUnavailableError);
    await expect(storage.write('k', 1)).rejects.toThrow(/writing "k".*disk on fire/s);
  });

  it('wraps read and remove failures too', async () => {
    const reader = createChromeStorageArea(
      fakeArea({ get: () => Promise.reject(new Error('nope')) }),
    );
    const remover = createChromeStorageArea(
      fakeArea({ remove: () => Promise.reject(new Error('nope')) }),
    );

    await expect(reader.read('k')).rejects.toThrow(/reading "k"/);
    await expect(remover.remove('k')).rejects.toThrow(/removing "k"/);
  });
});

/*
 * Quota exhaustion is the failure a large org actually hits, and it arrives as
 * a string match on a Chrome error message. The size in the error is a courtesy
 * — but measuring it must not become a second failure on top of the first.
 */
describe('a quota failure survives a value that cannot be measured', () => {
  const quotaArea = fakeArea({ set: () => Promise.reject(new Error('QUOTA_BYTES quota exceeded')) });

  it('reports zero bytes rather than throwing on an unserialisable value', async () => {
    // A cycle is what a real one looks like: a snapshot holding a reference
    // back to something that holds it.
    const circular: Record<string, unknown> = { releases: [] };
    circular['self'] = circular;
    const storage = createChromeStorageArea(quotaArea);

    await expect(storage.write('k', circular)).rejects.toThrow(StorageQuotaExceededError);
    await expect(storage.write('k', circular)).rejects.toThrow(/0 bytes/);
  });

  it('reports zero for undefined, which JSON.stringify does not return a string for', async () => {
    const storage = createChromeStorageArea(quotaArea);

    await expect(storage.write('k', undefined)).rejects.toThrow(/0 bytes/);
  });

  it('still says it was a quota failure, which is the actionable part', async () => {
    const storage = createChromeStorageArea(quotaArea);

    try {
      await storage.write('k', undefined);
      expect.unreachable('the write should have failed');
    } catch (cause) {
      expect((cause as { code: string }).code).toBe('STORAGE_QUOTA_EXCEEDED');
    }
  });

  it('is not confused by a failure that merely mentions storage', async () => {
    // Only QUOTA_BYTES means quota. Anything else is unavailability, and
    // telling a user to delete data when the profile is locked would be wrong.
    const storage = createChromeStorageArea(
      fakeArea({ set: () => Promise.reject(new Error('storage is not available in this context')) }),
    );

    await expect(storage.write('k', 1)).rejects.toThrow(StorageUnavailableError);
  });

  it('treats a non-Error rejection as unavailability rather than quota', async () => {
    // Chrome usually rejects with an Error. "Usually" is the interesting word.
    const storage = createChromeStorageArea(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is exactly what is under test
      fakeArea({ set: () => Promise.reject('QUOTA_BYTES') }),
    );

    await expect(storage.write('k', 1)).rejects.toThrow(StorageUnavailableError);
  });
});
