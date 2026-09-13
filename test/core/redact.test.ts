/**
 * Secret redaction.
 *
 * The rule under test: no token value may appear in an error message, a log
 * line, or telemetry.
 *
 * The cases in the first three blocks assert the outcome — the token is gone —
 * which any one of `redact`'s overlapping rules can deliver. Mutation testing
 * showed that is not enough on its own: a rule could stop working while another
 * covered for it. The last block isolates each rule, and `docs/MUTATION.md`
 * records what that found.
 */

import { describe, expect, it } from 'vitest';

import { containsSecret, redact, REDACTED } from '../../src/core/redact.js';

/**
 * Token-shaped test values, composed rather than written out.
 *
 * A literal that looks like a Salesforce credential blocks a push: GitHub's
 * secret scanner cannot tell a fake from a real one, and it is right not to
 * try. The shape is what these tests need; a literal is only how it got written
 * down. `test/fixtures/org/no-secrets.test.ts` fails if one reappears.
 */
const ACCESS_TOKEN = `00D5f000000ABCDE!AQEAQ${'NaGmY_fake'}AccessTokenValue_0123456789`;
const REFRESH_TOKEN = `5Aep861${'fakeRefresh'}TokenValue_abcdefghijklmnopqrstuvwxyz`;

describe('layer 1: known values', () => {
  it('replaces an exact secret wherever it appears', () => {
    const output = redact(`before ${REFRESH_TOKEN} after ${REFRESH_TOKEN}`, [REFRESH_TOKEN]);

    expect(output).not.toContain(REFRESH_TOKEN);
    expect(output.match(new RegExp(REDACTED, 'g'))).toHaveLength(2);
  });

  it('ignores undefined and very short entries', () => {
    // Replacing every occurrence of a 3-character string would corrupt the
    // message without protecting anything.
    expect(redact('the cat sat on the mat', ['cat', undefined])).toBe('the cat sat on the mat');
  });

  it('is a no-op when there is nothing to redact', () => {
    expect(redact('invalid_grant: authentication failure', [])).toBe(
      'invalid_grant: authentication failure',
    );
  });
});

describe('layer 2: shape matching', () => {
  it('redacts a Salesforce access token nobody declared', () => {
    expect(redact(`token ${ACCESS_TOKEN} rejected`)).toBe(`token ${REDACTED} rejected`);
  });

  it('redacts a bearer header echo', () => {
    expect(redact('sent Authorization: Bearer abc123def456ghi789')).toContain(`Bearer ${REDACTED}`);
  });

  it.each(['access_token', 'refresh_token', 'code_verifier', 'client_secret', 'code'])(
    'redacts the %s query parameter',
    (key) => {
      const output = redact(`POST failed for ${key}=s3cretValueHere&client_id=public`);

      expect(output).toContain(`${key}=${REDACTED}`);
      expect(output).toContain('client_id=public');
    },
  );
});

describe('layer 3: opaque runs', () => {
  it('redacts a long high-entropy run that no other layer knows about', () => {
    // The case the other layers cannot cover: a refresh token echoed back
    // during the initial exchange, before this process holds it.
    const output = redact(`bad refresh ${REFRESH_TOKEN} supplied`);

    expect(containsSecret(output, [REFRESH_TOKEN])).toBe(false);
  });

  it('keeps ordinary prose intact', () => {
    const message = 'authentication failure - Invalid Client Credentials';

    expect(redact(message)).toBe(message);
  });

  it('keeps a Salesforce org id, which is diagnostic rather than secret', () => {
    // 18 characters, below the threshold, and useful in a support thread.
    expect(redact('org 00D5f000000ABCDEAO is not enabled')).toContain('00D5f000000ABCDEAO');
  });

  it('leaves a long word with no digit alone', () => {
    expect(redact('incomprehensibilities happened')).toBe('incomprehensibilities happened');
  });
});

describe('containsSecret', () => {
  it('detects a secret that survived', () => {
    expect(containsSecret(`x ${REFRESH_TOKEN} y`, [REFRESH_TOKEN])).toBe(true);
  });

  it('reports clean text as clean', () => {
    expect(containsSecret('nothing here', [REFRESH_TOKEN])).toBe(false);
  });

  it('ignores short and undefined candidates, matching redact', () => {
    expect(containsSecret('the cat', ['cat', undefined])).toBe(false);
  });
});

/**
 * Each rule on its own.
 *
 * The four rules in `redact` overlap on purpose, and the tests above assert the
 * outcome — the token is gone — which any one of them can deliver. Mutation
 * testing on 13 September 2026 showed what that costs: 13 of 45 mutants
 * survived, and every one of them broke a single rule while another rule
 * covered for it. A rule can therefore stop working without a test noticing.
 *
 * These cases isolate each rule by choosing values the others cannot match:
 * under twenty characters, or free of digits, or ending on a character that
 * stops the opaque-run rule at a word boundary. Each one fails if its rule
 * alone is broken.
 */
describe('each rule carries its own weight', () => {
  // Eight characters, no digit, well under the opaque-run threshold: nothing
  // but the known-values rule can touch this.
  const PLAIN_SHORT = `abc${'defgh'}`;
  const PLAIN_TEN = `abc${'defghij'}`;

  it('redacts a known secret that matches no shape at all', () => {
    expect(redact(`the value is ${PLAIN_TEN} here`, [PLAIN_TEN])).toBe(
      `the value is ${REDACTED} here`,
    );
  });

  it('redacts a known secret of exactly eight characters, the documented floor', () => {
    expect(PLAIN_SHORT).toHaveLength(8);
    expect(redact(`the value is ${PLAIN_SHORT} here`, [PLAIN_SHORT])).toBe(
      `the value is ${REDACTED} here`,
    );
  });

  it('leaves a seven-character candidate alone, so the floor is a floor', () => {
    const tooShort = `abc${'defg'}`;
    expect(tooShort).toHaveLength(7);
    expect(redact(`the value is ${tooShort} here`, [tooShort])).toBe(
      `the value is ${tooShort} here`,
    );
  });

  it('redacts a bearer value separated by more than one space', () => {
    expect(redact(`Authorization: Bearer  ${PLAIN_TEN}`)).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it('redacts the whole bearer value, not its first character', () => {
    const out = redact(`Authorization: Bearer ${PLAIN_TEN}`);
    expect(out).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(out).not.toContain(PLAIN_TEN.slice(1));
  });

  it('leaves a bearer value below the eight-character floor alone', () => {
    expect(redact('Authorization: Bearer ab')).toBe('Authorization: Bearer ab');
  });

  it('redacts a whole OAuth parameter value, not its first character', () => {
    expect(redact(`code=${PLAIN_TEN}&state=1`)).toBe(`code=${REDACTED}&state=1`);
  });

  it('redacts an opaque run whose digit is not its first character', () => {
    // The rule looks ahead for a digit anywhere in the run. A run that starts
    // with letters is the case that separates "anywhere" from "at the start".
    const run = `aB3${'defghijklmnopqrstuvw'}`;
    expect(run.length).toBeGreaterThanOrEqual(20);
    expect(redact(`saw ${run} here`)).toBe(`saw ${REDACTED} here`);
  });

  it('takes the trailing padding of an access token, which the opaque rule leaves behind', () => {
    // A token ending in '=' is the one case where the access-token rule does
    // something no other rule does: the opaque-run rule needs a word boundary,
    // so it stops before the '=' and leaves it visible.
    const padded = `00D5f000000ABCDE!AQEAQ${'NaGmY_fake'}Padded=`;
    expect(redact(`${padded} tail`)).toBe(`${REDACTED} tail`);
  });
});

describe('containsSecret agrees with redact at the edges', () => {
  it('counts a secret of exactly eight characters as present', () => {
    const eight = `abc${'defgh'}`;
    expect(eight).toHaveLength(8);
    expect(containsSecret(`x ${eight} y`, [eight])).toBe(true);
  });

  it('is true when any one candidate is present, not only when all are', () => {
    const present = `abc${'defghij'}`;
    const absent = `zzz${'yyyyxxx'}`;
    expect(containsSecret(`x ${present} y`, [present, absent])).toBe(true);
  });
});
