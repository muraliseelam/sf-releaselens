/**
 * Typed wrapper around `chrome.runtime.sendMessage`.
 *
 * The router returns failures as data rather than rejecting, so this is where
 * they become throwable again: callers get either the payload or a `RemoteError`
 * carrying a message written for display.
 */

import type {
  PayloadFor,
  RequestFor,
  RequestType,
  Response,
  SerialisedError,
} from '../background/messages.js';

/** An error the background worker reported, already worded for a human. */
export class RemoteError extends Error {
  constructor(readonly serialised: SerialisedError) {
    super(serialised.message);
    this.name = 'RemoteError';
  }
}

export interface Client {
  send<T extends RequestType>(request: RequestFor<T>): Promise<PayloadFor<T>>;
}

export function createChromeClient(): Client {
  return {
    async send<T extends RequestType>(request: RequestFor<T>): Promise<PayloadFor<T>> {
      // Typed as possibly undefined on purpose: a listener that returns
      // without calling sendResponse resolves the promise with `undefined`,
      // which the declared chrome types do not admit.
      let response: Response<PayloadFor<T>> | undefined;
      try {
        response = await chrome.runtime.sendMessage<
          RequestFor<T>,
          Response<PayloadFor<T>> | undefined
        >(request);
      } catch (cause) {
        // The worker was evicted or the extension was reloaded mid-flight.
        // Re-opening the panel re-wakes it, which is the actionable advice.
        throw new RemoteError({
          code: 'WORKER_UNAVAILABLE',
          name: 'WorkerUnavailable',
          message:
            'The extension background worker did not respond. Close and reopen the side panel, ' +
            `then try again. (${cause instanceof Error ? cause.message : String(cause)})`,
        });
      }

      if (response === undefined) {
        throw new RemoteError({
          code: 'EMPTY_RESPONSE',
          name: 'EmptyResponse',
          message: 'The background worker returned no response. Reopen the side panel and retry.',
        });
      }
      if (!response.ok) {
        throw new RemoteError(response.error);
      }
      return response.data;
    },
  };
}

/** Flattens any thrown value into the shape the views render. */
export function toSerialisedError(cause: unknown): SerialisedError {
  if (cause instanceof RemoteError) return cause.serialised;
  if (cause instanceof Error) {
    return { code: 'UNEXPECTED', name: cause.name, message: cause.message };
  }
  return { code: 'UNEXPECTED', name: 'Error', message: String(cause) };
}
