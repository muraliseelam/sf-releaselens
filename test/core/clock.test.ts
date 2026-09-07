import { describe, expect, it } from 'vitest';

import {
  createFixedClock,
  createSequentialIdFactory,
  systemClock,
  systemIdFactory,
} from '../../src/core/clock.js';

describe('systemClock', () => {
  it('returns a parseable ISO-8601 UTC string', () => {
    const now = systemClock.now();

    expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(now))).toBe(false);
  });

  it('does not go backwards between calls', () => {
    const first = systemClock.now();
    const second = systemClock.now();

    expect(Date.parse(second)).toBeGreaterThanOrEqual(Date.parse(first));
  });
});

describe('systemIdFactory', () => {
  it('produces distinct ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => systemIdFactory()));

    expect(ids.size).toBe(100);
  });
});

describe('createFixedClock', () => {
  it('always returns the same instant, which is the point of injecting time', () => {
    const clock = createFixedClock('2026-09-07T09:00:00.000Z');

    expect(clock.now()).toBe('2026-09-07T09:00:00.000Z');
    expect(clock.now()).toBe(clock.now());
  });
});

describe('createSequentialIdFactory', () => {
  it('counts from one with the given prefix', () => {
    const newId = createSequentialIdFactory('audit');

    expect([newId(), newId(), newId()]).toEqual(['audit-1', 'audit-2', 'audit-3']);
  });

  it('gives each factory its own counter, so tests do not interfere', () => {
    const first = createSequentialIdFactory('a');
    const second = createSequentialIdFactory('b');
    first();

    expect(second()).toBe('b-1');
  });
});
