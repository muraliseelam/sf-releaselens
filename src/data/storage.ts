/**
 * The storage port and its two implementations.
 *
 * Everything above this file talks to `StorageArea`, never to `chrome.storage`,
 * which is what lets the entire data layer be tested in Node with no browser and
 * no mocking framework.
 */

import { StorageQuotaExceededError, StorageUnavailableError } from '../core/errors.js';

export interface StorageArea {
  /** Resolves to `undefined` when the key has never been written. */
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * `chrome.storage.local` behind the port.
 *
 * Chrome reports a full quota as a rejected promise whose message contains
 * `QUOTA_BYTES`; that string is the only signal available, so it is matched here
 * and converted once, rather than leaking a raw Chrome message into the UI.
 */
export function createChromeStorageArea(area: chrome.storage.StorageArea): StorageArea {
  return {
    async read(key) {
      try {
        const result = await area.get(key);
        return result[key];
      } catch (cause) {
        throw new StorageUnavailableError(`reading "${key}"`, cause);
      }
    },

    async write(key, value) {
      try {
        await area.set({ [key]: value });
      } catch (cause) {
        if (isQuotaError(cause)) {
          throw new StorageQuotaExceededError(approximateBytes(value));
        }
        throw new StorageUnavailableError(`writing "${key}"`, cause);
      }
    },

    async remove(key) {
      try {
        await area.remove(key);
      } catch (cause) {
        throw new StorageUnavailableError(`removing "${key}"`, cause);
      }
    },
  };
}

/**
 * In-memory storage for tests and for a future "preview an import without
 * committing it" flow. `quotaBytes` makes the quota path reachable in a test.
 */
export function createMemoryStorageArea(options: { quotaBytes?: number } = {}): StorageArea {
  const entries = new Map<string, string>();

  return {
    read(key) {
      const stored = entries.get(key);
      // Round-tripped through JSON so callers cannot accidentally rely on
      // holding the same object reference they wrote, which chrome.storage
      // would never give them.
      return Promise.resolve(stored === undefined ? undefined : (JSON.parse(stored) as unknown));
    },

    write(key, value) {
      const serialised = JSON.stringify(value);
      if (options.quotaBytes !== undefined && serialised.length > options.quotaBytes) {
        return Promise.reject(new StorageQuotaExceededError(serialised.length));
      }
      entries.set(key, serialised);
      return Promise.resolve();
    },

    remove(key) {
      entries.delete(key);
      return Promise.resolve();
    },
  };
}

function isQuotaError(cause: unknown): boolean {
  return cause instanceof Error && cause.message.includes('QUOTA_BYTES');
}

function approximateBytes(value: unknown): number {
  // `JSON.stringify` really returns `undefined` for `undefined` at runtime,
  // whatever the lib types promise; the guard is cheaper than finding out.
  if (value === undefined) return 0;
  try {
    return JSON.stringify(value).length;
  } catch (cause) {
    // A value we cannot even measure is still a real quota failure; report 0
    // rather than masking the original error with a serialisation one.
    void cause;
    return 0;
  }
}
