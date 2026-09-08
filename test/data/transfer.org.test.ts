/**
 * The import path, against a real `sf project deploy report --json`.
 *
 * `test/data/transfer.test.ts` covers the mapping with a hand-written payload.
 * This runs it over reports captured from live orgs — the same files the
 * browser tests replay — because the hand-written one was wrong in two ways
 * that mattered, and neither was visible until a real report was read.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createFixedClock, createSequentialIdFactory } from '../../src/core/clock.js';
import { parseSnapshot } from '../../src/core/validate.js';
import { parseImportText } from '../../src/data/transfer.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/org/', import.meta.url));

interface Capture {
  cliDeployReport: { ok: boolean; value?: unknown };
}

/** Every capture that actually holds a report; an org with no deploys has none. */
const REPORTS = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.json'))
  .map((name) => ({
    name,
    capture: JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Capture,
  }))
  .filter((entry) => entry.capture.cliDeployReport.ok)
  .map((entry) => ({ name: entry.name, report: entry.capture.cliDeployReport.value }));

const DEPS = {
  clock: createFixedClock('2026-09-08T12:00:00.000Z'),
  newId: createSequentialIdFactory('import'),
};

const OPTIONS = {
  actor: { name: 'Sam Okafor', roles: ['release-manager'] },
  environmentName: 'Imported org',
  environmentKind: 'sandbox' as const,
  orgAlias: 'imported',
  owner: 'Sam Okafor',
};

describe('importing a real CLI deploy report', () => {
  it('there are captured reports to import', () => {
    expect(REPORTS.length).toBeGreaterThan(0);
  });

  it.each(REPORTS.map((entry) => entry.name))('%s parses into a valid snapshot', (name) => {
    const { report } = REPORTS.find((entry) => entry.name === name)!;

    const snapshot = parseImportText(JSON.stringify(report), DEPS, OPTIONS);

    expect(() => parseSnapshot(JSON.parse(JSON.stringify(snapshot)))).not.toThrow();
    expect(snapshot.releases).toHaveLength(1);
    expect(snapshot.environments).toHaveLength(1);
    expect(snapshot.isDemoData).toBe(false);
  });

  it.each(REPORTS.map((entry) => entry.name))(
    '%s attributes components to the deploy author, not to "unknown"',
    (name) => {
      const { report } = REPORTS.find((entry) => entry.name === name)!;

      const snapshot = parseImportText(JSON.stringify(report), DEPS, OPTIONS);

      // No real component carries an author. Reading one off the component made
      // every imported component say "unknown"; the deploy's author is used.
      for (const item of snapshot.items) {
        expect(item.lastModifiedBy).not.toBe('unknown');
      }
    },
  );

  it.each(REPORTS.map((entry) => entry.name))(
    '%s marks every component as having no dependency data',
    (name) => {
      const { report } = REPORTS.find((entry) => entry.name === name)!;

      const snapshot = parseImportText(JSON.stringify(report), DEPS, OPTIONS);

      for (const item of snapshot.items) {
        expect(item.dependsOn).toEqual([]);
        expect(item.dependenciesUnavailable).toBe(true);
      }
    },
  );

  it.each(REPORTS.map((entry) => entry.name))('%s invents no approvals', (name) => {
    const { report } = REPORTS.find((entry) => entry.name === name)!;

    expect(parseImportText(JSON.stringify(report), DEPS, OPTIONS).approvals).toEqual([]);
  });

  it.each(REPORTS.map((entry) => entry.name))(
    '%s drops package.xml, which a real report returns as a component',
    (name) => {
      const { report } = REPORTS.find((entry) => entry.name === name)!;

      const snapshot = parseImportText(JSON.stringify(report), DEPS, OPTIONS);

      expect(snapshot.items.map((item) => item.fullName)).not.toContain('package.xml');
      // Its empty componentType is what identifies it, and no item may keep one.
      expect(snapshot.items.every((item) => item.type.length > 0)).toBe(true);
    },
  );
});
