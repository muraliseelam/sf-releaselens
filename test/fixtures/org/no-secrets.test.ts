/**
 * The guard on the captured fixtures.
 *
 * `scripts/capture-org-fixtures.mjs` scrubs by allow-list, which is the right
 * design but is still one code path. This checks the committed result from the
 * other direction, so a mistake has to get past both — and, more importantly,
 * so that a fixture edited by hand later is checked too.
 *
 * Every assertion here is about what must **not** be in the repository. If one
 * fails, do not weaken it: re-capture, or hand-edit the value out, and work out
 * how it got past the scrubber.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { redact } from '../../../src/core/redact.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const FIXTURES = readdirSync(HERE)
  .filter((name) => name.endsWith('.json'))
  .map((name) => ({ name, text: readFileSync(join(HERE, name), 'utf8') }));

/**
 * Patterns that must never appear. Each one is a thing that would actually be
 * damaging, not a thing that merely looks technical.
 */
const FORBIDDEN: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  // A Salesforce session or access token: an org id, `!`, then an opaque blob.
  { label: 'a Salesforce access token', pattern: /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._\-+=]{10,}/ },
  { label: 'a bearer token', pattern: /\bBearer\s+[A-Za-z0-9._\-!+=/]{8,}/i },
  { label: 'an OAuth secret parameter', pattern: /\b(access_token|refresh_token|client_secret|code_verifier)\b/i },
  // A refresh token from the Salesforce CLI's own store.
  { label: 'a refresh-token-shaped value', pattern: /\b5Aep[0-9A-Za-z._-]{20,}/ },
  { label: 'a Connected App consumer key', pattern: /\b3MVG9[0-9A-Za-z._-]{10,}/ },
  { label: 'an email address', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  // Any real Salesforce host. Every URL in a fixture is a synthetic path.
  { label: 'a Salesforce hostname', pattern: /[A-Za-z0-9-]+\.(my\.)?salesforce\.com/i },
  { label: 'a force.com hostname', pattern: /[A-Za-z0-9-]+\.force\.com/i },
  { label: 'an absolute URL', pattern: /https?:\/\// },
];

/**
 * Salesforce ids that are not obviously synthetic.
 *
 * Real ids are 15 or 18 characters of mixed case and digits. The scrubber emits
 * ids containing `SYNTH`, so anything id-shaped without that marker came from
 * an org.
 */
const ID_SHAPE = /\b[0-9a-zA-Z]{15}(?:[0-9a-zA-Z]{3})?\b/g;

describe('the captured org fixtures carry nothing real', () => {
  it('there are fixtures to check', () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(FIXTURES.length).toBeGreaterThan(0);
  });

  it.each(FIXTURES.map((fixture) => fixture.name))('%s contains no credential shape', (name) => {
    const fixture = FIXTURES.find((entry) => entry.name === name)!;

    for (const { label, pattern } of FORBIDDEN) {
      const match = pattern.exec(fixture.text);
      expect(
        match,
        `${name} contains ${label}: ${match?.[0]?.slice(0, 24) ?? ''}`,
      ).toBeNull();
    }
  });

  it.each(FIXTURES.map((fixture) => fixture.name))('%s contains no real record id', (name) => {
    const fixture = FIXTURES.find((entry) => entry.name === name)!;

    const suspicious = [...fixture.text.matchAll(ID_SHAPE)]
      .map((match) => match[0])
      .filter((candidate) => !candidate.includes('SYNTH'))
      // Words are id-shaped too if they are long enough; a real id has digits.
      .filter((candidate) => /[0-9]/.test(candidate) && /[a-z]/.test(candidate) && /[A-Z]/.test(candidate));

    expect(suspicious, `${name} contains id-shaped values: ${suspicious.join(', ')}`).toEqual([]);
  });

  it.each(FIXTURES.map((fixture) => fixture.name))(
    '%s is a fixed point of the product redactor',
    (name) => {
      const fixture = FIXTURES.find((entry) => entry.name === name)!;

      // The strongest available check, and the one that costs nothing to keep
      // current: whatever the extension considers a secret in an error message,
      // it must find none of in a fixture.
      expect(redact(fixture.text)).toBe(fixture.text);
    },
  );

  it.each(FIXTURES.map((fixture) => fixture.name))(
    '%s still has the shape it was captured for',
    (name) => {
      const fixture = FIXTURES.find((entry) => entry.name === name)!;
      const parsed = JSON.parse(fixture.text) as Record<string, unknown>;

      // Scrubbing must not have hollowed the fixture out. These are the keys
      // the contract tests read.
      expect(Object.keys(parsed)).toEqual(
        expect.arrayContaining([
          'apiVersion',
          'orgApiVersion',
          'versions',
          'limits',
          'organization',
          'deployRequests',
          'coverage',
          'deployDetails',
          'toolingDetailKeys',
        ]),
      );
    },
  );
});
