/**
 * Salesforce response fixtures, modelled on real API shapes.
 *
 * Field names, casing and nesting match what the REST and Tooling APIs actually
 * return — including the parts that are awkward: `TrialExpirationDate` is
 * `null` rather than absent, `DeployRequest` list queries omit the details,
 * and component rows use `created`/`changed`/`deleted` booleans rather than an
 * operation string.
 *
 * Nothing here is real org data. All ids, names and usernames are fictional.
 */

import type {
  ApexCoverageRow,
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
  TestLevel: 'RunLocalTests',
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
  TestLevel: 'NoTestRun',
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
  TestLevel: 'RunSpecifiedTests',
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
  TestLevel: 'RunLocalTests',
};

/** The same deploy fetched individually — details present. */
export const DEPLOY_SUCCEEDED_DETAIL: DeployRequestRow = {
  ...DEPLOY_SUCCEEDED,
  DeployResult: {
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
          createdDate: '2026-09-05T08:07:00.000+0000',
        },
        {
          fullName: 'Invoice__c.UsageTotal__c',
          componentType: 'CustomField',
          fileName: 'objects/Invoice__c/fields/UsageTotal__c.field-meta.xml',
          created: false,
          changed: true,
          deleted: false,
          createdByName: 'Ada Kensington',
          createdDate: '2026-09-05T08:07:10.000+0000',
        },
        {
          // The package manifest is returned as a component and must be dropped.
          fullName: 'package.xml',
          componentType: '',
          fileName: 'package.xml',
          created: false,
          changed: true,
          deleted: false,
        },
      ],
      componentFailures: [],
    },
  },
};

export const DEPLOY_FAILED_DETAIL: DeployRequestRow = {
  ...DEPLOY_FAILED,
  DeployResult: {
    details: {
      componentSuccesses: [
        {
          fullName: 'PaymentRetryScheduler',
          componentType: 'ApexClass',
          fileName: 'classes/PaymentRetryScheduler.cls',
          created: false,
          changed: true,
          deleted: false,
          createdByName: 'Marco Bellini',
        },
      ],
      componentFailures: [
        {
          fullName: 'LegacyTaxCalculator',
          componentType: 'ApexClass',
          fileName: 'classes/LegacyTaxCalculator.cls',
          deleted: true,
          problem: 'Dependent class is invalid and needs recompilation.',
          problemType: 'Error',
          createdByName: 'Marco Bellini',
        },
      ],
    },
  },
};

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
