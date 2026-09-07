/**
 * The two guards on the message boundary. Both receive values from another
 * extension context, so they are tested against hostile shapes rather than only
 * the happy path.
 */

import { describe, expect, it } from 'vitest';

import { isRequest, isSnapshotChangedEvent } from '../../src/background/messages.js';

describe('isRequest', () => {
  it('accepts any object carrying a string type, which is all it claims to check', () => {
    expect(isRequest({ type: 'snapshot.load' })).toBe(true);
    expect(isRequest({ type: 'approval.decide', approvalId: 'a', outcome: 'approved' })).toBe(true);
    // Narrowing to a *known* type is the router's job, not this guard's.
    expect(isRequest({ type: 'anything.at.all' })).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'snapshot.load'],
    ['an array', [{ type: 'snapshot.load' }]],
    ['an object with no type', { approvalId: 'a' }],
    ['an object whose type is not a string', { type: 7 }],
  ])('rejects %s', (_label, value) => {
    expect(isRequest(value)).toBe(false);
  });
});

describe('isSnapshotChangedEvent', () => {
  it('accepts only the broadcast the worker actually sends', () => {
    expect(isSnapshotChangedEvent({ type: 'snapshot.changed' })).toBe(true);
  });

  it.each([
    ['a different message type', { type: 'snapshot.load' }],
    ['a response object', { ok: true, data: {} }],
    ['null', null],
    ['an array', ['snapshot.changed']],
    ['a bare string', 'snapshot.changed'],
  ])('rejects %s', (_label, value) => {
    expect(isSnapshotChangedEvent(value)).toBe(false);
  });
});
