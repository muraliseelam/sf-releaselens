/**
 * The telemetry guarantee.
 *
 * This feature sits against the security story the whole product rests on, so
 * the tests that matter are the ones that would fail if org data could reach a
 * transport. They are written as attacks: take every kind of value the product
 * handles, try to get it through, and assert that none of it arrives.
 *
 * The negative assertions are the point. A test that only proves a view name
 * survives would pass just as happily on a version that also forwarded the org
 * id.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  TELEMETRY_COLLECTS,
  TELEMETRY_VIEWS,
  createNoopTransport,
  createRecordingTransport,
  newInstallId,
  parseSettings,
  sanitiseEnvelope,
  sanitiseEvent,
} from '../../src/core/telemetry.js';

const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const ENVELOPE = {
  installId: ID,
  extensionVersion: '0.5.3',
  event: { name: 'view.opened', view: 'inspector' },
  at: '2026-09-09T04:00:00.000Z',
};

/** Every kind of value this product touches that must never be transmitted. */
const ORG_DATA = {
  accessToken: `00Dxx0000001gPF!AQEAQ${'L9fake'.repeat(6)}1234567890`,
  refreshToken: `5Aep${'861fake'.repeat(6)}0987654321`,
  clientId: `3MVG9${'_fake'.repeat(9)}`,
  instanceUrl: 'https://acmecorp-finance.my.salesforce.com',
  organizationId: '00Dxx0000001gPFEAY',
  username: 'release.manager@acmecorp.com',
  deployId: '0AfWs00000abcDEFG',
  releaseName: 'ACME Q3 Billing Enhancements',
  componentName: 'AcmeInvoiceBuilderHandler',
  filePath: 'force-app/main/default/classes/AcmeInvoiceBuilderHandler.cls',
  releaseCount: 12,
  componentCount: 57,
};

describe('an envelope carries only what it is allowed to', () => {
  it('passes a well-formed envelope through unchanged', () => {
    expect(sanitiseEnvelope(ENVELOPE)).toEqual(ENVELOPE);
  });

  it('drops every extra field, wherever it is attached', () => {
    const smuggled = sanitiseEnvelope({
      ...ENVELOPE,
      ...ORG_DATA,
      event: { ...ENVELOPE.event, ...ORG_DATA },
      // Nested, in case somebody assumes only top-level keys are checked.
      context: { org: ORG_DATA },
    });

    expect(Object.keys(smuggled ?? {}).sort()).toEqual([
      'at',
      'event',
      'extensionVersion',
      'installId',
    ]);
    expect(Object.keys(smuggled?.event ?? {}).sort()).toEqual(['name', 'view']);
  });

  it('lets none of it through to a transport, by value', () => {
    const transport = createRecordingTransport();
    const smuggled = sanitiseEnvelope({
      ...ENVELOPE,
      ...ORG_DATA,
      event: { ...ENVELOPE.event, ...ORG_DATA },
    });
    if (smuggled !== undefined) transport.send(smuggled);

    const serialised = JSON.stringify(transport.sent);
    for (const [name, value] of Object.entries(ORG_DATA)) {
      expect(serialised, `${name} reached the transport`).not.toContain(String(value));
    }
  });

  it('refuses an event name it does not know', () => {
    expect(sanitiseEnvelope({ ...ENVELOPE, event: { name: 'org.refreshed' } })).toBeUndefined();
    expect(sanitiseEvent({ name: 'anything.else' })).toBeUndefined();
  });

  it('refuses a view outside the three surfaces', () => {
    expect(sanitiseEvent({ name: 'view.opened', view: 'org' })).toBeUndefined();
    expect(
      sanitiseEvent({ name: 'view.opened', view: 'acmecorp-finance.my.salesforce.com' }),
    ).toBeUndefined();
  });

  it('accepts each of the three surfaces and nothing else', () => {
    for (const view of TELEMETRY_VIEWS) {
      expect(sanitiseEvent({ name: 'view.opened', view })).toEqual({ name: 'view.opened', view });
    }
  });

  it('refuses an install id that is not one this build could have made', () => {
    // Otherwise "install id" is a free-form string field, which is exactly the
    // smuggling route the closed event union exists to remove.
    expect(sanitiseEnvelope({ ...ENVELOPE, installId: ORG_DATA.instanceUrl })).toBeUndefined();
    expect(sanitiseEnvelope({ ...ENVELOPE, installId: `${ID}${ID}` })).toBeUndefined();
    expect(sanitiseEnvelope({ ...ENVELOPE, installId: ORG_DATA.organizationId })).toBeUndefined();
  });

  it('refuses a version that is not a version', () => {
    expect(sanitiseEnvelope({ ...ENVELOPE, extensionVersion: ORG_DATA.releaseName })).toBeUndefined();
  });

  it('re-emits the timestamp rather than passing the string through', () => {
    const sanitised = sanitiseEnvelope({ ...ENVELOPE, at: '2026-09-09T04:00:00+00:00' });

    // Parsed and re-serialised, so a "timestamp" cannot carry a payload after
    // a valid prefix.
    expect(sanitised?.at).toBe('2026-09-09T04:00:00.000Z');
  });

  it('lets nothing arbitrary through, for any input at all', () => {
    /*
     * The structural claim, rather than a list of examples: whatever is thrown
     * at the sanitiser, what comes out has exactly the allowed keys or is
     * refused outright. A field added upstream by a future contributor fails
     * here without anybody having to think of it.
     */
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (junk) => {
        const sanitised = sanitiseEnvelope({ ...ENVELOPE, smuggled: junk });
        expect(Object.keys(sanitised ?? {}).sort()).toEqual([
          'at',
          'event',
          'extensionVersion',
          'installId',
        ]);
      }),
      { numRuns: Number(process.env['FC_RUNS'] ?? 300) },
    );
  });
});

describe('the shipped transport', () => {
  it('sends nothing and says so', () => {
    const transport = createNoopTransport();

    expect(transport.describe).toMatch(/no endpoint/i);
    // Not a throw and not a queue: it discards.
    expect(() => transport.send(ENVELOPE)).not.toThrow();
  });

  it('is what the panel quotes, so the UI cannot claim more than is true', () => {
    // `destination` is read from the transport in use rather than from a
    // constant, so a build wiring something else would say so.
    expect(createNoopTransport().describe).not.toContain('http');
  });
});

describe('settings are read without trusting them', () => {
  it('treats anything unrecognised as off', () => {
    for (const raw of [undefined, null, 'yes', 42, [], {}, { enabled: 'true' }]) {
      expect(parseSettings(raw).enabled).toBe(false);
    }
  });

  it('treats enabled-without-an-id as off rather than minting one', () => {
    // Inventing an id here would be generating an identifier nobody asked for,
    // from a value that is already corrupt.
    expect(parseSettings({ enabled: true }).enabled).toBe(false);
    expect(parseSettings({ enabled: true, installId: 'not-an-id' }).enabled).toBe(false);
  });

  it('accepts a well-formed record', () => {
    expect(parseSettings({ enabled: true, installId: ID })).toEqual({
      enabled: true,
      installId: ID,
    });
  });
});

describe('newInstallId', () => {
  it('is 128 random bits, in the shape the sanitiser accepts', () => {
    const id = newInstallId(crypto);

    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(sanitiseEnvelope({ ...ENVELOPE, installId: id })).toBeDefined();
  });

  it('differs every time, so two opt-in periods cannot be joined', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newInstallId(crypto)));

    expect(ids.size).toBe(50);
  });
});

describe('what the UI is told', () => {
  it('describes the collection in plain words, with no org data in the list', () => {
    const described = TELEMETRY_COLLECTS.join(' ');

    expect(described).toContain('random id');
    expect(described).toContain('extension version');
    expect(described).toContain('tabs you opened');
    expect(described).not.toMatch(/org|release|component|deploy/i);
  });
});

describe('the sanitisers refuse anything that is not an object', () => {
  it.each([null, undefined, 'view.opened', 42, true, []])(
    'refuses %s as an envelope',
    (candidate) => {
      expect(sanitiseEnvelope(candidate)).toBeUndefined();
    },
  );

  it.each([null, undefined, 'view.opened', 42, true, []])('refuses %s as an event', (candidate) => {
    expect(sanitiseEvent(candidate)).toBeUndefined();
  });

  it('refuses a timestamp that is not a string, rather than coercing one', () => {
    // Date.parse accepts a surprising number of strings; a non-string must not
    // get as far as being parsed at all.
    expect(sanitiseEnvelope({ ...ENVELOPE, at: 1_789_000_000_000 })).toBeUndefined();
    expect(sanitiseEnvelope({ ...ENVELOPE, at: 'the day before yesterday' })).toBeUndefined();
  });
});
