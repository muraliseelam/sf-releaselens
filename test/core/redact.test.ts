/**
 * Secret redaction.
 *
 * The rule under test: no token value may appear in an error message, a log
 * line, or telemetry. Three layers, and each is exercised on its own so a
 * regression names which one broke.
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
