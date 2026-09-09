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

/**
 * Source files that legitimately talk about token shapes.
 *
 * They must *describe* the shapes without *containing* them: GitHub's push
 * protection cannot tell a fake from a real one, and it is right not to try. A
 * literal that looks like a Salesforce refresh token blocks a push, which is
 * how this rule was learned.
 */
const SOURCE_ROOTS = ['src', 'test', 'e2e', 'scripts', 'docs'];

const CREDENTIAL_SHAPES: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'a Salesforce access token', pattern: /00D[A-Za-z0-9]{12,15}![A-Za-z0-9._\-+=]{20,}/ },
  { label: 'a Salesforce refresh token', pattern: /5Aep[0-9A-Za-z._-]{25,}/ },
  { label: 'a Connected App consumer key', pattern: /3MVG9[0-9A-Za-z._-]{20,}/ },
];

/**
 * Every source file under a root, or a named failure.
 *
 * A missing directory used to surface as a raw ENOENT from `readdirSync`. A
 * directory that is absent and one that is clean are different facts, and only
 * one of them means what a green test appears to mean — so this says which root
 * and why rather than leaving a filesystem error to be interpreted.
 */
function sourceFiles(directory: string, into: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (cause) {
    throw new Error(
      `${directory} does not exist, so this guard covered nothing there. ` +
        'A root that is absent and a root that is clean are different facts, and only one of ' +
        'them means what a passing test appears to mean. Fix the path in SOURCE_ROOTS, or ' +
        'remove the root deliberately.',
      { cause },
    );
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      sourceFiles(path, into);
    } else if (/\.(ts|mjs|js|md|json)$/.test(entry.name)) {
      into.push(path);
    }
  }
  return into;
}

describe('no committed file contains a credential-shaped literal', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));

  it.each(SOURCE_ROOTS)('%s/ is clean', (directory) => {
    const offenders: string[] = [];

    for (const file of sourceFiles(join(root, directory))) {
      const text = readFileSync(file, 'utf8');
      for (const { label, pattern } of CREDENTIAL_SHAPES) {
        const match = pattern.exec(text);
        if (match !== null) {
          offenders.push(`${file.slice(root.length)}: ${label} — ${match[0].slice(0, 20)}…`);
        }
      }
    }

    /*
     * Build the shape at runtime instead. A test that must exercise a token
     * shape can compose one from parts — the shape is what is under test, and
     * a literal is only how it got written down.
     */
    expect(offenders, offenders.join('; ')).toEqual([]);
  });
});

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
