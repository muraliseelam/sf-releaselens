/**
 * Time and identity as injected ports. Nothing in this codebase calls `Date.now`
 * or `crypto.randomUUID` directly, so every test asserts on exact timestamps and
 * exact ids instead of matching shapes.
 */

export interface Clock {
  /** Current time as an ISO-8601 UTC string. */
  now(): string;
}

/** Produces a new unique id. Injected so tests get `id-1`, `id-2`, ... */
export type IdFactory = () => string;

export const systemClock: Clock = {
  now(): string {
    return new Date().toISOString();
  },
};

export const systemIdFactory: IdFactory = () => crypto.randomUUID();

/** Fixed clock for tests and for deterministic seeding. */
export function createFixedClock(iso: string): Clock {
  return { now: () => iso };
}

/** Deterministic id factory for tests and for deterministic seeding. */
export function createSequentialIdFactory(prefix: string): IdFactory {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}-${next}`;
  };
}
