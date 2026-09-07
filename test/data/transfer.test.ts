import { describe, expect, it } from 'vitest';

import { ImportFormatError } from '../../src/core/errors.js';
import {
  parseImportText,
  snapshotFromDeployReport,
  suggestedExportFilename,
  toExportJson,
} from '../../src/data/transfer.js';
import type { DeployReportOptions } from '../../src/data/transfer.js';
import { ACTOR, FIXED_NOW, realisticSnapshot, testDeps } from '../fixtures/snapshot.js';

const IMPORT_OPTIONS: DeployReportOptions = {
  actor: ACTOR,
  environmentName: 'Production',
  environmentKind: 'production',
  orgAlias: 'prod',
  owner: 'Sam Okafor',
};

/** Shaped after a real `sf project deploy report --json` payload. */
const DEPLOY_REPORT = {
  status: 0,
  result: {
    id: '0AfWs00000abcDEFG',
    status: 'Failed',
    checkOnly: false,
    createdDate: '2026-09-05T08:00:00.000Z',
    completedDate: '2026-09-05T08:07:31.000Z',
    numberComponentsTotal: 3,
    details: {
      componentSuccesses: [
        {
          fullName: 'InvoiceBuilder',
          componentType: 'ApexClass',
          fileName: 'classes/InvoiceBuilder.cls',
          created: true,
          changed: false,
          deleted: false,
          createdByName: 'Lin Zhou',
        },
        {
          fullName: 'package.xml',
          componentType: '',
          fileName: 'package.xml',
          created: false,
          changed: true,
          deleted: false,
        },
      ],
      componentFailures: [
        {
          fullName: 'LegacyTaxCalculator',
          componentType: 'ApexClass',
          fileName: 'classes/LegacyTaxCalculator.cls',
          problem: 'Dependent class is invalid and needs recompilation.',
          problemType: 'Error',
          deleted: true,
        },
      ],
    },
  },
};

describe('toExportJson', () => {
  it('pretty-prints and ends with a newline so the file diffs cleanly', () => {
    const json = toExportJson(realisticSnapshot());

    expect(json.endsWith('}\n')).toBe(true);
    expect(json).toContain('\n  "schemaVersion": 1');
  });
});

describe('suggestedExportFilename', () => {
  it('builds a filesystem-safe name from the timestamp', () => {
    expect(suggestedExportFilename(FIXED_NOW)).toBe('sf-releaselens-2026-09-07T09-00-00-000Z.json');
  });
});

describe('parseImportText', () => {
  it('accepts a snapshot export', () => {
    const text = toExportJson(realisticSnapshot());

    expect(parseImportText(text, testDeps(), IMPORT_OPTIONS).releases).toHaveLength(3);
  });

  it('accepts a deploy report', () => {
    const snapshot = parseImportText(JSON.stringify(DEPLOY_REPORT), testDeps(), IMPORT_OPTIONS);

    expect(snapshot.releases).toHaveLength(1);
    expect(snapshot.environments[0]?.name).toBe('Production');
  });

  it('rejects text that is not JSON, naming the parse failure', () => {
    expect(() => parseImportText('{not json', testDeps(), IMPORT_OPTIONS)).toThrow(ImportFormatError);
    expect(() => parseImportText('{not json', testDeps(), IMPORT_OPTIONS)).toThrow(
      /existing snapshot is untouched/,
    );
  });

  it('rejects JSON of no recognised shape, saying what it looked for', () => {
    expect(() => parseImportText('{"hello":"world"}', testDeps(), IMPORT_OPTIONS)).toThrow(
      /neither a sf-releaselens export.*nor an/s,
    );
  });
});

describe('snapshotFromDeployReport', () => {
  it('maps successes and failures into one release', () => {
    const snapshot = snapshotFromDeployReport(DEPLOY_REPORT, testDeps(), IMPORT_OPTIONS);
    const release = snapshot.releases[0]!;

    expect(release.version).toBe('0AfWs00000abcDEFG');
    expect(release.name).toBe('Deploy 0AfWs00000abcDEFG');
    expect(release.status).toBe('failed');
    expect(release.riskLevel).toBe('high');
    expect(snapshot.items.map((item) => item.fullName).sort()).toEqual([
      'InvoiceBuilder',
      'LegacyTaxCalculator',
    ]);
  });

  it('drops the package.xml pseudo-component rather than listing it as metadata', () => {
    const snapshot = snapshotFromDeployReport(DEPLOY_REPORT, testDeps(), IMPORT_OPTIONS);

    expect(snapshot.items.some((item) => item.fullName === 'package.xml')).toBe(false);
  });

  it('turns a component failure into an error warning on that component', () => {
    const snapshot = snapshotFromDeployReport(DEPLOY_REPORT, testDeps(), IMPORT_OPTIONS);
    const failed = snapshot.items.find((item) => item.fullName === 'LegacyTaxCalculator')!;

    expect(failed.operation).toBe('delete');
    expect(failed.warnings).toEqual([
      {
        code: 'ERROR',
        message: 'Dependent class is invalid and needs recompilation.',
        severity: 'error',
      },
    ]);
  });

  it('leaves coverage absent rather than inventing zero, and records no dependencies', () => {
    const snapshot = snapshotFromDeployReport(DEPLOY_REPORT, testDeps(), IMPORT_OPTIONS);

    expect(snapshot.items.every((item) => !('testCoverage' in item))).toBe(true);
    expect(snapshot.items.every((item) => item.dependsOn.length === 0)).toBe(true);
  });

  it('invents no approvals, because a deploy report cannot see a human gate', () => {
    expect(snapshotFromDeployReport(DEPLOY_REPORT, testDeps(), IMPORT_OPTIONS).approvals).toEqual([]);
  });

  it('maps a successful check-only deploy to scheduled, not deployed', () => {
    const validation = {
      result: {
        ...DEPLOY_REPORT.result,
        status: 'Succeeded',
        checkOnly: true,
      },
    };

    expect(snapshotFromDeployReport(validation, testDeps(), IMPORT_OPTIONS).releases[0]?.status).toBe(
      'scheduled',
    );
  });

  it.each([
    ['Succeeded', 'deployed'],
    ['Failed', 'failed'],
    ['SucceededPartial', 'failed'],
    ['InProgress', 'in_progress'],
    ['Pending', 'in_progress'],
    ['Canceled', 'blocked'],
    ['Something new', 'draft'],
  ])('maps deploy status %s to release status %s', (deployStatus, expected) => {
    const report = { result: { ...DEPLOY_REPORT.result, status: deployStatus, checkOnly: false } };

    expect(snapshotFromDeployReport(report, testDeps(), IMPORT_OPTIONS).releases[0]?.status).toBe(
      expected,
    );
  });

  it('accepts a bare report body without the sf "result" wrapper', () => {
    const snapshot = snapshotFromDeployReport(DEPLOY_REPORT.result, testDeps(), IMPORT_OPTIONS);

    expect(snapshot.items).toHaveLength(2);
  });

  it('accepts a single-component report where sf emits an object instead of an array', () => {
    const single = {
      result: {
        id: '0AfSingle',
        status: 'Succeeded',
        createdDate: '2026-09-05T08:00:00.000Z',
        details: {
          componentSuccesses: {
            fullName: 'OnlyClass',
            componentType: 'ApexClass',
            fileName: 'classes/OnlyClass.cls',
            created: true,
          },
        },
      },
    };

    const snapshot = snapshotFromDeployReport(single, testDeps(), IMPORT_OPTIONS);
    expect(snapshot.items.map((item) => item.fullName)).toEqual(['OnlyClass']);
    expect(snapshot.items[0]?.operation).toBe('add');
  });

  it('rejects a payload with no details section', () => {
    expect(() => snapshotFromDeployReport({ result: {} }, testDeps(), IMPORT_OPTIONS)).toThrow(
      /no "details" section/,
    );
  });

  it('rejects a non-object payload', () => {
    expect(() => snapshotFromDeployReport('nope', testDeps(), IMPORT_OPTIONS)).toThrow(
      /not a JSON object/,
    );
  });

  it('produces a snapshot the validator accepts', () => {
    // The mapper round-trips through parseSnapshot itself, so this asserts the
    // contract rather than re-testing the validator: a mapping bug must fail
    // here rather than in storage.
    expect(() => snapshotFromDeployReport(DEPLOY_REPORT, testDeps(), IMPORT_OPTIONS)).not.toThrow();
  });
});
