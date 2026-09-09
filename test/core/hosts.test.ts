/**
 * The host classifier, and the ordering bug it was extracted to fix.
 *
 * `core/diagnostics.ts` used to hold its own copy that tested
 * `.my.salesforce.com` **before** `.sandbox.` and `.develop.`, which made both
 * of those branches unreachable: every sandbox, develop and scratch org was
 * reported as a plain My Domain org, and the two implementations — this one and
 * the harness's — disagreed with each other.
 *
 * So the assertions here are mostly about **specificity**, because that is what
 * broke and what will break again if somebody appends a pattern to the list
 * rather than inserting it.
 */

import { describe, expect, it } from 'vitest';

import { classifyInstanceHost, classifyLoginHost, isInstanceHostCovered } from '../../src/core/hosts.js';

describe('classifyInstanceHost', () => {
  it.each([
    ['https://acme.scratch.my.salesforce.com', '*.scratch.my.salesforce.com'],
    ['https://acme--uat.sandbox.my.salesforce.com', '*.sandbox.my.salesforce.com'],
    ['https://acme.develop.my.salesforce.com', '*.develop.my.salesforce.com'],
    ['https://acme.my.salesforce.com', '*.my.salesforce.com'],
    ['https://login.salesforce.com', '*.salesforce.com'],
    ['https://acme.my.force.com', '*.force.com (not covered by the manifest)'],
    ['https://acme.cloudforce.com', 'other (not covered by the manifest)'],
  ])('classifies %s as %s', (url, expected) => {
    expect(classifyInstanceHost(url)).toBe(expected);
  });

  /*
   * The regression. Every host on the left is *also* a `.my.salesforce.com`
   * host, so a general pattern placed before a specific one swallows it
   * silently — no error, just a wrong label on every scratch org in the
   * compatibility report.
   */
  it.each([
    'https://acme.scratch.my.salesforce.com',
    'https://acme--uat.sandbox.my.salesforce.com',
    'https://acme.develop.my.salesforce.com',
  ])('%s is not reported as a plain My Domain host', (url) => {
    expect(classifyInstanceHost(url)).not.toBe('*.my.salesforce.com');
  });

  it('reports every specific pattern as reachable, so none is dead code', () => {
    const reachable = new Set(
      [
        'https://a.scratch.my.salesforce.com',
        'https://a.sandbox.my.salesforce.com',
        'https://a.develop.my.salesforce.com',
        'https://a.my.salesforce.com',
        'https://a.salesforce.com',
        'https://a.force.com',
      ].map((url) => classifyInstanceHost(url)),
    );

    // Six inputs, six distinct answers. A collision means a branch below it can
    // never be reached.
    expect(reachable.size).toBe(6);
  });

  it('says "none" for an absent URL and "unparseable" for a broken one', () => {
    expect(classifyInstanceHost(undefined)).toBe('none');
    expect(classifyInstanceHost('')).toBe('none');
    // A stored URL that will not parse is worth knowing about; saying so leaks
    // nothing.
    expect(classifyInstanceHost('not a url')).toBe('unparseable');
  });

  it('ignores case, because a host is case-insensitive', () => {
    expect(classifyInstanceHost('https://ACME.Scratch.My.Salesforce.com')).toBe(
      '*.scratch.my.salesforce.com',
    );
  });

  it('names no org, whatever it is given', () => {
    // The entire reason this function exists rather than the host being
    // reported directly.
    expect(classifyInstanceHost('https://acme-finance-prod.my.salesforce.com')).not.toContain(
      'acme',
    );
  });
});

describe('isInstanceHostCovered', () => {
  it.each([
    'https://acme.scratch.my.salesforce.com',
    'https://acme--uat.sandbox.my.salesforce.com',
    'https://acme.develop.my.salesforce.com',
    'https://acme.my.salesforce.com',
  ])('%s is reachable by the manifest', (url) => {
    // Chrome's `*.my.salesforce.com` matches any subdomain of
    // `my.salesforce.com`, which is what makes the three specific forms
    // reachable. Confirmed against Chrome itself in `e2e/org.spec.ts`; this
    // records the expectation so a manifest change has to break a test.
    expect(isInstanceHostCovered(url)).toBe(true);
  });

  it.each([
    'https://acme.my.force.com',
    'https://acme.cloudforce.com',
    'https://example.com',
  ])('%s is not reachable by the manifest', (url) => {
    expect(isInstanceHostCovered(url)).toBe(false);
  });

  it('is false for an absent or unparseable URL', () => {
    expect(isInstanceHostCovered(undefined)).toBe(false);
    expect(isInstanceHostCovered('not a url')).toBe(false);
  });
});

describe('classifyLoginHost', () => {
  it('names the two published endpoints', () => {
    expect(classifyLoginHost('https://login.salesforce.com')).toBe('login.salesforce.com');
    expect(classifyLoginHost('https://test.salesforce.com')).toBe('test.salesforce.com');
  });

  it('refuses to name a My Domain login host, which carries the org name', () => {
    expect(classifyLoginHost('https://acme-finance.my.salesforce.com')).toBe('other (My Domain)');
  });

  it('says "none" when no login URL is stored', () => {
    expect(classifyLoginHost(undefined)).toBe('none');
  });
});
