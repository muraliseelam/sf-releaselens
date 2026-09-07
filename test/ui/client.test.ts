/**
 * The panel side of the message boundary. Every failure mode here ends as a
 * message a user reads, so each is asserted for content, not just for throwing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteError, createChromeClient, toSerialisedError } from '../../src/ui/client.js';
import { makeSnapshot } from '../fixtures/snapshot.js';

/** Installs a stub `chrome.runtime.sendMessage` and returns the spy. */
function stubSendMessage(implementation: (message: unknown) => Promise<unknown>) {
  const sendMessage = vi.fn(implementation);
  (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage } };
  return sendMessage;
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe('createChromeClient', () => {
  it('forwards the request verbatim and unwraps a successful response', async () => {
    const snapshot = makeSnapshot();
    const sendMessage = stubSendMessage(() => Promise.resolve({ ok: true, data: snapshot }));

    const result = await createChromeClient().send({ type: 'snapshot.load' });

    expect(sendMessage).toHaveBeenCalledWith({ type: 'snapshot.load' });
    expect(result).toEqual(snapshot);
  });

  it('turns a failure response back into a throwable carrying its code', async () => {
    stubSendMessage(() =>
      Promise.resolve({
        ok: false,
        error: {
          code: 'INVALID_APPROVAL_TRANSITION',
          name: 'InvalidApprovalTransitionError',
          message: 'Approval "apr-1" is already approved and cannot become rejected.',
        },
      }),
    );

    const send = createChromeClient().send({
      type: 'approval.decide',
      approvalId: 'apr-1',
      outcome: 'rejected',
      comment: 'no',
    });

    await expect(send).rejects.toThrow(RemoteError);
    await expect(send).rejects.toThrow(/already approved/);
    await expect(send).rejects.toMatchObject({
      serialised: { code: 'INVALID_APPROVAL_TRANSITION' },
    });
  });

  it('explains an evicted worker in terms of what to do, keeping the original cause text', async () => {
    stubSendMessage(() =>
      Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
    );

    const send = createChromeClient().send({ type: 'snapshot.load' });

    await expect(send).rejects.toMatchObject({ serialised: { code: 'WORKER_UNAVAILABLE' } });
    await expect(send).rejects.toThrow(/Close and reopen the side panel/);
    await expect(send).rejects.toThrow(/Receiving end does not exist/);
  });

  it('describes a rejected non-Error without printing [object Object]', async () => {
    // A rejection that is not an Error is exactly what is under test here.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    stubSendMessage(() => Promise.reject('just a string'));

    await expect(createChromeClient().send({ type: 'snapshot.load' })).rejects.toThrow(
      /just a string/,
    );
  });

  it('reports an empty response rather than handing undefined to a view', async () => {
    // A listener that returns without calling sendResponse resolves undefined.
    stubSendMessage(() => Promise.resolve(undefined));

    const send = createChromeClient().send({ type: 'snapshot.load' });

    await expect(send).rejects.toMatchObject({ serialised: { code: 'EMPTY_RESPONSE' } });
    await expect(send).rejects.toThrow(/Reopen the side panel and retry/);
  });
});

describe('RemoteError', () => {
  it('is a real Error whose message is the serialised one', () => {
    const error = new RemoteError({ code: 'X', name: 'XError', message: 'something specific' });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RemoteError');
    expect(error.message).toBe('something specific');
  });
});

describe('toSerialisedError', () => {
  it('keeps the code a RemoteError already carries', () => {
    const remote = new RemoteError({ code: 'IMPORT_FORMAT', name: 'x', message: 'bad file' });

    expect(toSerialisedError(remote)).toEqual({
      code: 'IMPORT_FORMAT',
      name: 'x',
      message: 'bad file',
    });
  });

  it('flattens an unexpected Error', () => {
    expect(toSerialisedError(new TypeError('boom'))).toEqual({
      code: 'UNEXPECTED',
      name: 'TypeError',
      message: 'boom',
    });
  });

  it('flattens a thrown non-error', () => {
    expect(toSerialisedError(404)).toEqual({
      code: 'UNEXPECTED',
      name: 'Error',
      message: '404',
    });
  });
});
