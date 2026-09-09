/**
 * The diagnostic report, and the promise printed on its face.
 *
 * The report says "no org data". These tests are what makes that a claim rather
 * than a hope: a snapshot and an org status stuffed with every kind of secret
 * and identifier the product handles go in, and the serialised report is
 * searched for every one of them.
 *
 * The negative assertions matter more than the positive ones. A field that
 * stops being reported is a smaller problem than a field that starts.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildDiagnostics, diagnosticsFilename } from '../../src/core/diagnostics.js';
import type { DiagnosticInput } from '../../src/core/diagnostics.js';
import { makeApproval, makeItem, makeRelease, makeSnapshot } from '../fixtures/snapshot.js';

const NOW = '2026-09-08T12:00:00.000Z';

const ENVIRONMENT = {
  extensionVersion: '0.4.0',
  browserMajorVersion: '131',
  platform: 'Windows',
  apiVersion: '62.0',
};

/**
 * Every secret and identifier the product can hold, in one payload.
 *
 * These are fictional strings shaped like the real thing: a Salesforce access
 * token, a refresh token, a Consumer Key, a My Domain URL, an org id, a
 * username, a deploy id, and the human-written text that goes into a release
 * name, a component name and an approval comment.
 */
const SECRETS = {
  accessToken: `00Dxx0000001gPF!AQEAQ${'L9fake'.repeat(6)}1234567890`,
  refreshToken: `5Aep${'861fake'.repeat(6)}0987654321abcdef`,
  clientId: `3MVG9${'_fake'.repeat(9)}`,
  instanceUrl: 'https://acmecorp-finance.my.salesforce.com',
  loginUrl: 'https://acmecorp-finance.my.salesforce.com',
  organizationId: '00Dxx0000001gPFEAY',
  userId: '005xx000001SvpAAAS',
  username: 'release.manager@acmecorp.com.uat',
  deployId: '0AfWs00000abcDEFG',
  releaseName: 'ACME Q3 Billing Enhancements',
  componentName: 'AcmeInvoiceBuilderHandler',
  filePath: 'force-app/main/default/classes/AcmeInvoiceBuilderHandler.cls',
  ticketRef: 'ACME-14901',
  comment: 'Signed off by Priya on the finance call',
  approver: 'Priya Raghunathan',
};

function loadedSnapshot() {
  return makeSnapshot({
    releases: [
      makeRelease({
        id: SECRETS.deployId,
        name: SECRETS.releaseName,
        owner: SECRETS.approver,
        ticketRefs: [SECRETS.ticketRef],
        status: 'blocked',
        notes: SECRETS.comment,
      }),
    ],
    items: [
      {
        ...makeItem({ id: 'i1', fullName: SECRETS.componentName }),
        releaseId: SECRETS.deployId,
        filePath: SECRETS.filePath,
        lastModifiedBy: SECRETS.approver,
        testCoverage: 0.55,
        dependenciesUnavailable: true,
      },
    ],
    approvals: [
      {
        ...makeApproval({ id: 'a1', status: 'approved' }),
        releaseId: SECRETS.deployId,
        requestedBy: SECRETS.approver,
        decision: { by: SECRETS.approver, at: NOW, comment: SECRETS.comment },
      },
    ],
    auditLog: [
      {
        id: 'aud-1',
        at: '2026-09-08T11:30:00.000Z',
        by: SECRETS.approver,
        action: 'snapshot.refreshed',
        detail: `Refreshed from ${SECRETS.instanceUrl}: 1 deployment`,
        releaseId: SECRETS.deployId,
      },
    ],
    actor: { name: SECRETS.approver, roles: ['release-manager'] },
  });
}

function input(overrides: Partial<DiagnosticInput> = {}): DiagnosticInput {
  return {
    now: NOW,
    environment: ENVIRONMENT,
    org: {
      connected: true,
      hasHostPermission: true,
      loginUrl: SECRETS.loginUrl,
      instanceUrl: SECRETS.instanceUrl,
      connectedAt: '2026-09-08T10:00:00.000Z',
      hasClientId: true,
    },
    snapshot: loadedSnapshot(),
    storage: [
      { key: 'sf-releaselens.snapshot.v1', bytes: 41_233 },
      { key: 'sf-releaselens.org-settings.v1', bytes: 92 },
    ],
    ...overrides,
  };
}

describe('the report carries no org data', () => {
  it('contains none of the secrets or identifiers it was given', () => {
    const serialised = JSON.stringify(buildDiagnostics(input()));

    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(serialised, `${name} leaked into the report`).not.toContain(secret);
    }
  });

  it('contains no fragment of the org name either', () => {
    const serialised = JSON.stringify(buildDiagnostics(input())).toLowerCase();

    // The host classifier could report `acmecorp-finance.my.salesforce.com`
    // while passing the exact-match test above if it lower-cased it, so the
    // distinctive fragment is checked on its own.
    expect(serialised).not.toContain('acmecorp');
    expect(serialised).not.toContain('acme');
    expect(serialised).not.toContain('priya');
  });

  it('reports the instance host as a pattern, not a value', () => {
    const report = buildDiagnostics(input());

    expect(report.org.instanceHostPattern).toBe('*.my.salesforce.com');
  });

  it('names the two published login endpoints, and only those', () => {
    const production = buildDiagnostics(
      input({ org: { ...input().org, loginUrl: 'https://login.salesforce.com' } }),
    );
    const sandbox = buildDiagnostics(
      input({ org: { ...input().org, loginUrl: 'https://test.salesforce.com' } }),
    );

    expect(production.org.loginHost).toBe('login.salesforce.com');
    expect(sandbox.org.loginHost).toBe('test.salesforce.com');
    // A My Domain login host embeds the customer's org name.
    expect(buildDiagnostics(input()).org.loginHost).toBe('other (My Domain)');
  });

  it('reports whether a Consumer Key is stored, never the key', () => {
    const report = buildDiagnostics(input());

    expect(report.org.hasClientId).toBe(true);
    expect(JSON.stringify(report)).not.toContain(SECRETS.clientId);
  });

  it('lists what it excludes, so the promise is on the report itself', () => {
    const report = buildDiagnostics(input());

    expect(report.excludes.join(' ')).toMatch(/access tokens/);
    expect(report.excludes.join(' ')).toMatch(/instance URL/);
    expect(report.excludes.join(' ')).toMatch(/component names/);
  });

  it('leaks nothing for any snapshot at all', () => {
    /*
     * The tests above use one hand-written payload. This one asserts the
     * structural property: the report is built from counts and enums, so no
     * generated string can reach it. If someone adds a field by copying, this
     * fails on the first run that generates a value with a rare character.
     */
    const identifier = fc.string({ minLength: 6, maxLength: 24 }).filter((v) => v.trim().length > 5);

    fc.assert(
      fc.property(identifier, identifier, identifier, (releaseName, componentName, person) => {
        const snapshot = makeSnapshot({
          releases: [makeRelease({ id: 'r1', name: releaseName, owner: person })],
          items: [{ ...makeItem({ id: 'i1', fullName: componentName }), releaseId: 'r1' }],
          actor: { name: person, roles: ['release-manager'] },
        });
        const serialised = JSON.stringify(buildDiagnostics(input({ snapshot })));

        expect(serialised).not.toContain(releaseName);
        expect(serialised).not.toContain(componentName);
        expect(serialised).not.toContain(person);
      }),
      { numRuns: Number(process.env['FC_RUNS'] ?? 200) },
    );
  });
});

describe('the report is worth having', () => {
  it('reports the shape of the snapshot in counts', () => {
    const report = buildDiagnostics(input());

    expect(report.snapshot.present).toBe(true);
    expect(report.snapshot.counts['releases']).toBe(1);
    expect(report.snapshot.counts['items']).toBe(1);
    expect(report.snapshot.releasesByStatus.blocked).toBe(1);
    expect(report.snapshot.approvalsByStatus['approved']).toBe(1);
    expect(report.snapshot.itemsWithCoverage).toBe(1);
    expect(report.snapshot.itemsWithUnavailableDependencies).toBe(1);
    expect(report.snapshot.distinctMetadataTypes).toBe(1);
  });

  it('says how long ago the org was connected and last refreshed', () => {
    const report = buildDiagnostics(input());

    expect(report.org.connectedMinutesAgo).toBe(120);
    expect(report.org.lastRefreshMinutesAgo).toBe(30);
  });

  it('reports recent activity as actions and ages, never their detail', () => {
    const report = buildDiagnostics(input());

    expect(report.recentActivity).toEqual([{ action: 'snapshot.refreshed', minutesAgo: 30 }]);
  });

  it('reports storage sizes without reading a value', () => {
    const report = buildDiagnostics(input());

    expect(report.storage).toEqual([
      { key: 'sf-releaselens.snapshot.v1', bytes: 41_233 },
      { key: 'sf-releaselens.org-settings.v1', bytes: 92 },
    ]);
  });

  it('is useful when the snapshot could not be loaded at all', () => {
    // The case a bug report is most likely to be about.
    const report = buildDiagnostics(input({ snapshot: null }));

    expect(report.snapshot.present).toBe(false);
    expect(report.snapshot.schemaVersion).toBeNull();
    expect(report.org.connected).toBe(true);
    expect(report.storage).toHaveLength(2);
  });

  it('handles a disconnected org without inventing fields', () => {
    const report = buildDiagnostics(
      input({ org: { connected: false, hasHostPermission: false, hasClientId: false } }),
    );

    expect(report.org.loginHost).toBe('none');
    expect(report.org.instanceHostPattern).toBe('none');
    expect(report.org.connectedMinutesAgo).toBeNull();
  });

  it('says so when a stored URL will not parse, rather than hiding it', () => {
    const report = buildDiagnostics(
      input({ org: { ...input().org, instanceUrl: 'not a url at all' } }),
    );

    // "unparseable" rather than "other": a stored URL that will not parse is a
    // different problem from one on an unsupported host, and telling them apart
    // is the whole point of a diagnostic.
    expect(report.org.instanceHostPattern).toBe('unparseable');
  });

  it('flags an instance host the manifest does not cover', () => {
    const report = buildDiagnostics(
      input({ org: { ...input().org, instanceUrl: 'https://acme--uat.sandbox.my.force.com' } }),
    );

    // The likeliest first-contact failure: an instance on a host no optional
    // permission pattern matches.
    expect(report.org.instanceHostPattern).toMatch(/not covered by the manifest/);
  });
});

describe('diagnosticsFilename', () => {
  it('is timestamped, so two attempts do not overwrite each other', () => {
    expect(diagnosticsFilename(NOW)).toBe(
      'sf-releaselens-diagnostics-2026-09-08T12-00-00-000Z.json',
    );
  });
});
