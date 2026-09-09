/**
 * Salesforce response fixtures, with the shapes five real orgs actually return.
 *
 * These were hand-written first, and several details were wrong in ways that
 * mattered — see `test/fixtures/org/*.json` for the captures that corrected
 * them, and `docs/ORG-COMPATIBILITY.md` for the measurements. What changed:
 *
 *  - `TestLevel` was modelled as `'RunLocalTests'`. It is `null` in every one
 *    of twenty real `DeployRequest` rows across five orgs, and is no longer
 *    selected at all.
 *  - Component rows carried a `createdByName`. **No real component has one**,
 *    in either the Metadata API or the CLI's `deploy report --json`. The
 *    author is on the deploy.
 *  - Details were modelled on the Tooling record. That record has no
 *    `DeployResult` field whatsoever; details come from the Metadata REST API
 *    with `includeDetails=true`, and its keys are lower camel case.
 *  - `problemType` was `'Error'` on a failure. It is `null` on real failures,
 *    while `problem` carries the text.
 *
 * Nothing here is real org data. All ids, names and paths are fictional.
 */

import type {
  ApexCoverageRow,
  DeployRequestDetailResponse,
  DeployRequestRow,
  OrganizationRow,
  OrgLimits,
} from '../../src/data/connection.js';

export const SANDBOX_ORG: OrganizationRow = {
  Id: '00D5f000000ABCDEAO',
  IsSandbox: true,
  TrialExpirationDate: null,
  OrganizationType: 'Enterprise Edition',
  InstanceName: 'CS117',
  Name: 'Acme UAT',
};

export const PRODUCTION_ORG: OrganizationRow = {
  Id: '00D5f000000PRODEAO',
  IsSandbox: false,
  TrialExpirationDate: null,
  OrganizationType: 'Enterprise Edition',
  InstanceName: 'NA145',
  Name: 'Acme Production',
};

/**
 * A Developer Edition org: `IsSandbox` is false but the trial date is set.
 * Treating this as production would gate every scratch org — see DESIGN §8.2.
 */
export const DEVELOPER_ORG: OrganizationRow = {
  Id: '00D5f000000DEVEEAO',
  IsSandbox: false,
  TrialExpirationDate: '2026-12-01T00:00:00.000+0000',
  OrganizationType: 'Developer Edition',
  InstanceName: 'NA145',
  Name: 'Acme Dev',
};

/** A succeeded deploy, as a list query returns it — no details. */
export const DEPLOY_SUCCEEDED: DeployRequestRow = {
  Id: '0Af5f00000AbCdEfGH',
  Status: 'Succeeded',
  CheckOnly: false,
  CreatedDate: '2026-09-05T08:00:00.000+0000',
  StartDate: '2026-09-05T08:00:12.000+0000',
  CompletedDate: '2026-09-05T08:07:31.000+0000',
  CreatedBy: { Name: 'Lin Zhou' },
  NumberComponentsTotal: 3,
  NumberComponentErrors: 0,
  NumberComponentsDeployed: 3,
};

/** A failed deploy. */
export const DEPLOY_FAILED: DeployRequestRow = {
  Id: '0Af5f00000FaiLeDXY',
  Status: 'Failed',
  CheckOnly: false,
  CreatedDate: '2026-09-04T11:00:00.000+0000',
  StartDate: '2026-09-04T11:00:09.000+0000',
  CompletedDate: '2026-09-04T11:04:52.000+0000',
  CreatedBy: { Name: 'Marco Bellini' },
  NumberComponentsTotal: 2,
  NumberComponentErrors: 1,
  NumberComponentsDeployed: 1,
};

/** A check-only deploy that succeeded: validated, NOT deployed. */
export const DEPLOY_VALIDATED: DeployRequestRow = {
  Id: '0Af5f00000VaLiDaTe',
  Status: 'Succeeded',
  CheckOnly: true,
  CreatedDate: '2026-09-06T09:30:00.000+0000',
  CompletedDate: '2026-09-06T09:36:10.000+0000',
  CreatedBy: { Name: 'Sam Okafor' },
  NumberComponentsTotal: 1,
  NumberComponentErrors: 0,
};

/** An in-flight deploy: no CompletedDate. */
export const DEPLOY_IN_PROGRESS: DeployRequestRow = {
  Id: '0Af5f00000InProGrs',
  Status: 'InProgress',
  CheckOnly: false,
  CreatedDate: '2026-09-07T10:00:00.000+0000',
  StartDate: '2026-09-07T10:00:05.000+0000',
  CreatedBy: { Name: 'Ada Kensington' },
  NumberComponentsTotal: 12,
  NumberComponentErrors: 0,
};

/**
 * The details for a deploy, as `GET /metadata/deployRequest/{id}?includeDetails=true`
 * returns them.
 *
 * Lower camel case, nested under `deployResult`, and with the author at the
 * deploy level rather than on any component — all three confirmed against four
 * orgs. The extra keys (`warning`, `knownPackagingProblem`,
 * `requiresProductionTestRun`, `lineNumber`) are present because they are
 * present in reality and the mapper must ignore them.
 */
export const DEPLOY_SUCCEEDED_DETAIL: DeployRequestDetailResponse = {
  id: DEPLOY_SUCCEEDED.Id,
  deployResult: {
    status: 'Succeeded',
    checkOnly: false,
    createdDate: '2026-09-05T08:00:00.000+0000',
    completedDate: '2026-09-05T08:07:31.000+0000',
    createdByName: 'Lin Zhou',
    numberComponentErrors: 0,
    details: {
      componentSuccesses: [
        {
          componentType: 'ApexClass',
          fileName: 'classes/InvoiceBuilder.cls',
          fullName: 'InvoiceBuilder',
          created: true,
          changed: false,
          deleted: false,
          success: true,
          problem: null,
          problemType: null,
          createdDate: '2026-09-05T08:07:00.000+0000',
        },
        {
          componentType: 'CustomField',
          fileName: 'objects/Invoice__c/fields/UsageTotal__c.field-meta.xml',
          fullName: 'Invoice__c.UsageTotal__c',
          created: false,
          changed: true,
          deleted: false,
          success: true,
          problem: null,
          problemType: null,
          createdDate: '2026-09-05T08:07:10.000+0000',
        },
        {
          // The package manifest is returned as a component with an empty type
          // and must be dropped. Confirmed in real captures.
          componentType: '',
          fileName: 'package.xml',
          fullName: 'package.xml',
          created: false,
          changed: true,
          deleted: false,
          success: true,
        },
      ],
      componentFailures: [],
    },
  },
};

export const DEPLOY_FAILED_DETAIL: DeployRequestDetailResponse = {
  id: DEPLOY_FAILED.Id,
  deployResult: {
    status: 'Failed',
    checkOnly: false,
    createdDate: '2026-09-04T11:00:00.000+0000',
    completedDate: '2026-09-04T11:04:52.000+0000',
    createdByName: 'Marco Bellini',
    numberComponentErrors: 1,
    details: {
      componentSuccesses: [
        {
          componentType: 'ApexClass',
          fileName: 'classes/PaymentRetryScheduler.cls',
          fullName: 'PaymentRetryScheduler',
          created: false,
          changed: true,
          deleted: false,
          success: true,
        },
      ],
      componentFailures: [
        {
          componentType: 'ApexClass',
          fileName: 'classes/LegacyTaxCalculator.cls',
          fullName: 'LegacyTaxCalculator',
          created: false,
          changed: false,
          deleted: true,
          success: false,
          // Null on a real failure, while `problem` carries the text. The
          // warning code has to be derived, not read.
          problemType: null,
          problem: 'Dependent class is invalid and needs recompilation.',
          lineNumber: 34,
          columnNumber: 30,
        },
      ],
    },
  },
};

/** The details for a check-only run that passed: components, but nothing deployed. */
export const DEPLOY_VALIDATED_DETAIL: DeployRequestDetailResponse = {
  id: DEPLOY_VALIDATED.Id,
  deployResult: {
    status: 'Succeeded',
    checkOnly: true,
    createdDate: '2026-09-06T09:30:00.000+0000',
    completedDate: '2026-09-06T09:36:10.000+0000',
    createdByName: 'Sam Okafor',
    numberComponentErrors: 0,
    details: {
      componentSuccesses: [
        {
          componentType: 'ApexClass',
          fileName: 'classes/TaxRateResolver.cls',
          fullName: 'TaxRateResolver',
          created: false,
          changed: true,
          deleted: false,
          success: true,
          problem: null,
          problemType: null,
          createdDate: '2026-09-06T09:36:00.000+0000',
        },
      ],
      componentFailures: [],
    },
  },
};

/** A deploy whose details came back with no components at all. */
export const DEPLOY_EMPTY_DETAIL: DeployRequestDetailResponse = {
  id: DEPLOY_VALIDATED.Id,
  deployResult: {
    status: 'Succeeded',
    checkOnly: true,
    createdByName: 'Sam Okafor',
    details: { componentSuccesses: [], componentFailures: [] },
  },
};

/**
 * `GET /services/data/`, trimmed to the ends of the real list.
 *
 * Every org measured offers 31.0 through 67.0. The pinned 62.0 is present, so
 * the version check passes; `OLD_API_VERSIONS` is the same list without it.
 */
export const API_VERSIONS: readonly { label: string; url: string; version: string }[] = [
  { label: "Summer '14", url: '/services/data/v31.0', version: '31.0' },
  { label: "Winter '25", url: '/services/data/v62.0', version: '62.0' },
  { label: "Spring '25", url: '/services/data/v63.0', version: '63.0' },
  { label: "Summer '26", url: '/services/data/v67.0', version: '67.0' },
];

/** An org that has retired the version this build pins. */
export const API_VERSIONS_WITHOUT_PINNED = API_VERSIONS.filter(
  (entry) => entry.version !== '62.0',
);

export const COVERAGE_ROWS: ApexCoverageRow[] = [
  { ApexClassOrTrigger: { Name: 'InvoiceBuilder' }, NumLinesCovered: 91, NumLinesUncovered: 9 },
  { ApexClassOrTrigger: { Name: 'PaymentRetryScheduler' }, NumLinesCovered: 55, NumLinesUncovered: 45 },
  // Zero lines total: coverage is genuinely unknown, not 0%.
  { ApexClassOrTrigger: { Name: 'EmptyClass' }, NumLinesCovered: 0, NumLinesUncovered: 0 },
];

export const HEALTHY_LIMITS: OrgLimits = {
  DailyApiRequests: { Max: 15_000, Remaining: 14_250 },
  DailyAsyncApexExecutions: { Max: 250_000, Remaining: 249_000 },
};

/** 96% consumed — over the 95% refusal threshold. */
export const EXHAUSTED_LIMITS: OrgLimits = {
  DailyApiRequests: { Max: 15_000, Remaining: 600 },
};

/** Builds a Tooling query response envelope. */
export function queryResponse<T>(records: T[], nextRecordsUrl?: string): unknown {
  return {
    totalSize: records.length,
    done: nextRecordsUrl === undefined,
    records,
    ...(nextRecordsUrl === undefined ? {} : { nextRecordsUrl }),
  };
}

/** The error array shape Salesforce returns for a rejected request. */
export function salesforceError(errorCode: string, message: string): unknown {
  return [{ errorCode, message }];
}
