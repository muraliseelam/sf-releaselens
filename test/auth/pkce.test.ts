/**
 * PKCE. Asserted against the RFC 7636 appendix B vector, so this is a
 * correctness test rather than a "looks base64-ish" test.
 */

import { describe, expect, it } from 'vitest';

import {
  base64UrlEncode,
  createPkcePair,
  createState,
  deriveChallenge,
  type CryptoLike,
} from '../../src/auth/pkce.js';

/** Fills the buffer with a repeating counter, so output is deterministic. */
function countingCrypto(seed = 0): CryptoLike {
  let next = seed;
  return {
    getRandomValues<T extends Uint8Array>(array: T): T {
      for (let index = 0; index < array.length; index += 1) {
        array[index] = (next + index) % 256;
      }
      next += array.length;
      return array;
    },
    subtle: crypto.subtle,
  };
}

describe('base64UrlEncode', () => {
  it('uses the URL-safe alphabet and drops padding', () => {
    // 0xFB 0xFF encodes to "+/8=" in standard base64.
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  });

  it('encodes an empty buffer as an empty string', () => {
    expect(base64UrlEncode(new Uint8Array([]))).toBe('');
  });
});

describe('deriveChallenge', () => {
  it('matches the RFC 7636 appendix B test vector', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

    expect(await deriveChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('is deterministic', async () => {
    expect(await deriveChallenge('abc')).toBe(await deriveChallenge('abc'));
  });

  it('changes completely for a one-character difference', async () => {
    expect(await deriveChallenge('abc')).not.toBe(await deriveChallenge('abd'));
  });
});

describe('createPkcePair', () => {
  it('produces an S256 pair whose challenge is the hash of the verifier', async () => {
    const pair = await createPkcePair(countingCrypto());

    expect(pair.method).toBe('S256');
    expect(pair.challenge).toBe(await deriveChallenge(pair.verifier));
  });

  it('produces a verifier within the length RFC 7636 §4.1 requires', async () => {
    const pair = await createPkcePair();

    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.verifier.length).toBeLessThanOrEqual(128);
  });

  it('uses only unreserved URL characters, so it needs no escaping', async () => {
    const pair = await createPkcePair();

    expect(pair.verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('draws fresh randomness each time', async () => {
    const first = await createPkcePair();
    const second = await createPkcePair();

    expect(first.verifier).not.toBe(second.verifier);
  });
});

describe('createState', () => {
  it('produces a URL-safe opaque value', () => {
    expect(createState(countingCrypto())).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('differs between calls', () => {
    expect(createState()).not.toBe(createState());
  });
});
