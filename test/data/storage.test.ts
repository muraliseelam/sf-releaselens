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
