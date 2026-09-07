/**
 * The demo snapshot shipped for first run.
 *
 * It exists so that an evaluator who installs the extension sees a working
 * dashboard in one click instead of an empty state, and so the UI has realistic
 * shapes to be designed against — long Salesforce names, mixed metadata types,
 * a blocked release, a failed release. Every string here is fictional.
 *
 * Deterministic given a clock and an id factory, so tests can assert on it.
 */

import type { SnapshotDeps } from '../core/snapshot.js';
import {
  CURRENT_SCHEMA_VERSION,
  type Approval,
  type Environment,
  type MetadataItem,
  type MetadataOperation,
  type MetadataWarning,
  type Release,
  type Snapshot,
} from '../core/types.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Compact source rows, expanded into {@link MetadataItem}s below. */
interface ItemSpec {
  readonly fullName: string;
  readonly type: string;
  readonly operation: MetadataOperation;
  readonly by: string;
  readonly daysAgo: number;
  readonly dependsOn?: readonly string[];
  readonly coverage?: number;
  readonly warnings?: readonly MetadataWarning[];
}

const NO_COVERAGE: MetadataWarning = {
  code: 'NO_TEST_COVERAGE',
  message: 'No Apex test covers this class; a production deploy will fail the 75% gate.',
  severity: 'error',
};

const HARDCODED_ID: MetadataWarning = {
  code: 'HARDCODED_ID',
  message: 'Contains a hard-coded 18-character record id, which will not exist in the target org.',
  severity: 'warning',
};

const DESTRUCTIVE: MetadataWarning = {
  code: 'DESTRUCTIVE_CHANGE',
  message: 'Deletion is irreversible in production and is not covered by a rollback plan.',
  severity: 'error',
};

const API_VERSION_DRIFT: MetadataWarning = {
  code: 'API_VERSION_DRIFT',
  message: 'API version is more than four releases behind the org default.',
  severity: 'info',
};

export function createDemoSnapshot(deps: SnapshotDeps): Snapshot {
  const now = Date.parse(deps.clock.now());
  const at = (daysAgo: number): string => new Date(now - daysAgo * DAY_MS).toISOString();

  const environments: Environment[] = [
    { id: 'env-dev', name: 'Dev Integration', kind: 'sandbox', orgAlias: 'dev' },
    { id: 'env-uat', name: 'UAT', kind: 'sandbox', orgAlias: 'uat' },
    { id: 'env-prod', name: 'Production', kind: 'production', orgAlias: 'prod' },
  ];

  const releases: Release[] = [
    {
      id: 'rel-billing-q3',
      name: 'Q3 Billing Enhancements',
      version: '2026.09.3',
      status: 'awaiting_approval',
      targetEnvironmentId: 'env-uat',
      owner: 'Sam Okafor',
      createdAt: at(9),
      updatedAt: at(1),
      scheduledFor: at(-3),
      ticketRefs: ['W-14822', 'W-14830', 'REL-118'],
      riskLevel: 'medium',
      notes: 'Adds usage-based invoicing. Needs QA sign-off before the UAT window closes.',
    },
    {
      id: 'rel-payment-hotfix',
      name: 'Payment Retry Hotfix',
      version: '2026.09.2',
      status: 'blocked',
      targetEnvironmentId: 'env-prod',
      owner: 'Lin Zhou',
      createdAt: at(4),
      updatedAt: at(1),
      ticketRefs: ['W-14901'],
      riskLevel: 'high',
      notes: 'Change board rejected: no rollback plan for the removed validation rule.',
    },
    {
      id: 'rel-console-refresh',
      name: 'Service Console Refresh',
      version: '2026.09.1',
      status: 'deployed',
      targetEnvironmentId: 'env-prod',
      owner: 'Sam Okafor',
      createdAt: at(21),
      updatedAt: at(11),
      ticketRefs: ['W-14655', 'REL-112'],
      riskLevel: 'low',
    },
    {
      id: 'rel-tax-migration',
      name: 'Tax Engine Migration',
      version: '2026.08.4',
      status: 'failed',
      targetEnvironmentId: 'env-prod',
      owner: 'Marco Bellini',
      createdAt: at(33),
      updatedAt: at(26),
      ticketRefs: ['W-14401', 'W-14402'],
      riskLevel: 'high',
      notes: 'Deploy failed on row-lock contention against TaxRate__c. Re-plan for a quiet window.',
    },
    {
      id: 'rel-partner-portal',
      name: 'Partner Portal Pilot',
      version: '2026.10.0',
      status: 'draft',
      targetEnvironmentId: 'env-dev',
      owner: 'Ada Kensington',
      createdAt: at(2),
      updatedAt: at(0),
      ticketRefs: ['W-15003'],
      riskLevel: 'medium',
    },
  ];

  const itemsByRelease: Record<string, readonly ItemSpec[]> = {
    'rel-billing-q3': [
      { fullName: 'InvoiceBuilder', type: 'ApexClass', operation: 'add', by: 'Lin Zhou', daysAgo: 3, dependsOn: ['UsageAggregator', 'Invoice__c'], coverage: 0.91 },
      { fullName: 'UsageAggregator', type: 'ApexClass', operation: 'add', by: 'Lin Zhou', daysAgo: 3, dependsOn: ['UsageRecord__c'], coverage: 0.88 },
      { fullName: 'InvoiceBuilderTest', type: 'ApexClass', operation: 'add', by: 'Lin Zhou', daysAgo: 3, dependsOn: ['InvoiceBuilder'] },
      { fullName: 'UsageAggregatorTest', type: 'ApexClass', operation: 'add', by: 'Lin Zhou', daysAgo: 3, dependsOn: ['UsageAggregator'] },
      { fullName: 'BillingScheduleHandler', type: 'ApexClass', operation: 'modify', by: 'Sam Okafor', daysAgo: 2, dependsOn: ['InvoiceBuilder', 'BillingSchedule__c'], coverage: 0.62, warnings: [API_VERSION_DRIFT] },
      { fullName: 'ProrationCalculator', type: 'ApexClass', operation: 'add', by: 'Marco Bellini', daysAgo: 5, dependsOn: [], warnings: [NO_COVERAGE] },
      { fullName: 'InvoiceTrigger', type: 'ApexTrigger', operation: 'modify', by: 'Lin Zhou', daysAgo: 2, dependsOn: ['InvoiceBuilder'], coverage: 0.84 },
      { fullName: 'Invoice__c', type: 'CustomObject', operation: 'modify', by: 'Ada Kensington', daysAgo: 6, dependsOn: [] },
      { fullName: 'Invoice__c.UsageTotal__c', type: 'CustomField', operation: 'add', by: 'Ada Kensington', daysAgo: 6, dependsOn: ['Invoice__c'] },
      { fullName: 'Invoice__c.ProrationBasis__c', type: 'CustomField', operation: 'add', by: 'Ada Kensington', daysAgo: 6, dependsOn: ['Invoice__c'] },
      { fullName: 'UsageRecord__c', type: 'CustomObject', operation: 'add', by: 'Ada Kensington', daysAgo: 7, dependsOn: [] },
      { fullName: 'UsageRecord__c.MeteredAt__c', type: 'CustomField', operation: 'add', by: 'Ada Kensington', daysAgo: 7, dependsOn: ['UsageRecord__c'] },
      { fullName: 'BillingSchedule__c', type: 'CustomObject', operation: 'modify', by: 'Sam Okafor', daysAgo: 4, dependsOn: [] },
      { fullName: 'Invoice_Approval_Routing', type: 'Flow', operation: 'modify', by: 'Sam Okafor', daysAgo: 1, dependsOn: ['Invoice__c', 'Billing_Approvers'], warnings: [HARDCODED_ID] },
      { fullName: 'Usage_Rollup_Nightly', type: 'Flow', operation: 'add', by: 'Marco Bellini', daysAgo: 4, dependsOn: ['UsageRecord__c'] },
      { fullName: 'invoiceSummaryCard', type: 'LightningComponentBundle', operation: 'add', by: 'Ada Kensington', daysAgo: 2, dependsOn: ['InvoiceBuilder'] },
      { fullName: 'usageMeterChart', type: 'LightningComponentBundle', operation: 'add', by: 'Ada Kensington', daysAgo: 2, dependsOn: ['UsageAggregator'] },
      { fullName: 'Billing_Approvers', type: 'PermissionSet', operation: 'modify', by: 'Sam Okafor', daysAgo: 5, dependsOn: ['Invoice__c'] },
      { fullName: 'Invoice__c.Usage_Total_Not_Negative', type: 'ValidationRule', operation: 'add', by: 'Lin Zhou', daysAgo: 3, dependsOn: ['Invoice__c.UsageTotal__c'] },
      { fullName: 'Invoice__c-Invoice Layout', type: 'Layout', operation: 'modify', by: 'Ada Kensington', daysAgo: 6, dependsOn: ['Invoice__c.UsageTotal__c', 'Invoice__c.ProrationBasis__c'] },
      { fullName: 'Billing_Usage_Help_Text', type: 'CustomLabel', operation: 'add', by: 'Ada Kensington', daysAgo: 6, dependsOn: [] },
    ],
    'rel-payment-hotfix': [
      { fullName: 'PaymentRetryScheduler', type: 'ApexClass', operation: 'modify', by: 'Lin Zhou', daysAgo: 4, dependsOn: ['PaymentGatewayAdapter', 'Payment__c'], coverage: 0.79 },
      { fullName: 'PaymentGatewayAdapter', type: 'ApexClass', operation: 'modify', by: 'Lin Zhou', daysAgo: 4, dependsOn: [], coverage: 0.55, warnings: [HARDCODED_ID] },
      { fullName: 'PaymentRetrySchedulerTest', type: 'ApexClass', operation: 'modify', by: 'Lin Zhou', daysAgo: 4, dependsOn: ['PaymentRetryScheduler'] },
      { fullName: 'PaymentTrigger', type: 'ApexTrigger', operation: 'modify', by: 'Marco Bellini', daysAgo: 3, dependsOn: ['PaymentRetryScheduler'], coverage: 0.81 },
      { fullName: 'Payment__c.RetryCount__c', type: 'CustomField', operation: 'add', by: 'Lin Zhou', daysAgo: 4, dependsOn: ['Payment__c'] },
      { fullName: 'Payment__c.LastRetryAt__c', type: 'CustomField', operation: 'add', by: 'Lin Zhou', daysAgo: 4, dependsOn: ['Payment__c'] },
      { fullName: 'Payment__c', type: 'CustomObject', operation: 'modify', by: 'Lin Zhou', daysAgo: 4, dependsOn: [] },
      { fullName: 'Payment__c.Retry_Limit_Guard', type: 'ValidationRule', operation: 'delete', by: 'Marco Bellini', daysAgo: 3, dependsOn: ['Payment__c'], warnings: [DESTRUCTIVE] },
      { fullName: 'Payment_Retry_Notification', type: 'Flow', operation: 'modify', by: 'Marco Bellini', daysAgo: 3, dependsOn: ['Payment__c.RetryCount__c'] },
      { fullName: 'Payment_Ops', type: 'PermissionSet', operation: 'modify', by: 'Sam Okafor', daysAgo: 3, dependsOn: ['Payment__c.RetryCount__c'] },
      { fullName: 'paymentRetryBanner', type: 'LightningComponentBundle', operation: 'add', by: 'Ada Kensington', daysAgo: 2, dependsOn: ['PaymentRetryScheduler'] },
    ],
    'rel-console-refresh': [
      { fullName: 'CaseConsoleController', type: 'ApexClass', operation: 'modify', by: 'Ada Kensington', daysAgo: 14, dependsOn: ['Case'], coverage: 0.93 },
      { fullName: 'CaseConsoleControllerTest', type: 'ApexClass', operation: 'modify', by: 'Ada Kensington', daysAgo: 14, dependsOn: ['CaseConsoleController'] },
      { fullName: 'caseTimeline', type: 'LightningComponentBundle', operation: 'modify', by: 'Ada Kensington', daysAgo: 13, dependsOn: ['CaseConsoleController'] },
      { fullName: 'casePrioritySelector', type: 'LightningComponentBundle', operation: 'add', by: 'Ada Kensington', daysAgo: 13, dependsOn: ['Case.Priority'] },
      { fullName: 'agentWorkloadTile', type: 'LightningComponentBundle', operation: 'add', by: 'Sam Okafor', daysAgo: 12, dependsOn: [] },
      { fullName: 'Case-Service Console Layout', type: 'Layout', operation: 'modify', by: 'Sam Okafor', daysAgo: 12, dependsOn: ['Case'] },
      { fullName: 'Case_Escalation_Router', type: 'Flow', operation: 'modify', by: 'Marco Bellini', daysAgo: 15, dependsOn: ['Case'] },
      { fullName: 'Service_Agent', type: 'PermissionSet', operation: 'modify', by: 'Sam Okafor', daysAgo: 15, dependsOn: [] },
      { fullName: 'Console_Refresh_Banner', type: 'CustomLabel', operation: 'add', by: 'Ada Kensington', daysAgo: 13, dependsOn: [] },
      { fullName: 'Case.Console_Theme__c', type: 'CustomField', operation: 'add', by: 'Ada Kensington', daysAgo: 14, dependsOn: [] },
    ],
    'rel-tax-migration': [
      { fullName: 'TaxRateSynchroniser', type: 'ApexClass', operation: 'add', by: 'Marco Bellini', daysAgo: 30, dependsOn: ['TaxRate__c'], coverage: 0.72, warnings: [API_VERSION_DRIFT] },
      { fullName: 'TaxRateSynchroniserTest', type: 'ApexClass', operation: 'add', by: 'Marco Bellini', daysAgo: 30, dependsOn: ['TaxRateSynchroniser'] },
      { fullName: 'LegacyTaxCalculator', type: 'ApexClass', operation: 'delete', by: 'Marco Bellini', daysAgo: 29, dependsOn: [], warnings: [DESTRUCTIVE] },
      { fullName: 'TaxRate__c', type: 'CustomObject', operation: 'modify', by: 'Marco Bellini', daysAgo: 31, dependsOn: [] },
      { fullName: 'TaxRate__c.Jurisdiction__c', type: 'CustomField', operation: 'add', by: 'Marco Bellini', daysAgo: 31, dependsOn: ['TaxRate__c'] },
      { fullName: 'TaxRate__c.EffectiveFrom__c', type: 'CustomField', operation: 'add', by: 'Marco Bellini', daysAgo: 31, dependsOn: ['TaxRate__c'] },
      { fullName: 'Tax_Rate_Nightly_Sync', type: 'Flow', operation: 'add', by: 'Lin Zhou', daysAgo: 28, dependsOn: ['TaxRateSynchroniser'] },
      { fullName: 'TaxRate__c.Effective_Range_Valid', type: 'ValidationRule', operation: 'add', by: 'Marco Bellini', daysAgo: 29, dependsOn: ['TaxRate__c.EffectiveFrom__c'] },
      { fullName: 'Tax_Administrator', type: 'PermissionSet', operation: 'modify', by: 'Sam Okafor', daysAgo: 28, dependsOn: ['TaxRate__c'] },
    ],
    'rel-partner-portal': [
      { fullName: 'PartnerOnboardingController', type: 'ApexClass', operation: 'add', by: 'Ada Kensington', daysAgo: 2, dependsOn: ['PartnerAccount__c'], warnings: [NO_COVERAGE] },
      { fullName: 'PartnerAccount__c', type: 'CustomObject', operation: 'add', by: 'Ada Kensington', daysAgo: 2, dependsOn: [] },
      { fullName: 'PartnerAccount__c.TierLevel__c', type: 'CustomField', operation: 'add', by: 'Ada Kensington', daysAgo: 2, dependsOn: ['PartnerAccount__c'] },
      { fullName: 'partnerOnboardingWizard', type: 'LightningComponentBundle', operation: 'add', by: 'Ada Kensington', daysAgo: 1, dependsOn: ['PartnerOnboardingController'] },
      { fullName: 'Partner_Welcome_Email', type: 'Flow', operation: 'add', by: 'Ada Kensington', daysAgo: 1, dependsOn: ['PartnerAccount__c'] },
      { fullName: 'Partner_Community_User', type: 'PermissionSet', operation: 'add', by: 'Sam Okafor', daysAgo: 1, dependsOn: ['PartnerAccount__c'] },
    ],
  };

  const items: MetadataItem[] = Object.entries(itemsByRelease).flatMap(([releaseId, specs]) =>
    specs.map((spec) => toMetadataItem(spec, releaseId, deps.newId(), at)),
  );

  const approvals: Approval[] = [
    {
      id: 'apr-billing-uat',
      releaseId: 'rel-billing-q3',
      stage: 'UAT sign-off',
      requiredRole: 'uat-approver',
      requestedBy: 'Lin Zhou',
      requestedAt: at(2),
      status: 'pending',
    },
    {
      id: 'apr-billing-qa',
      releaseId: 'rel-billing-q3',
      stage: 'QA regression sign-off',
      requiredRole: 'qa-lead',
      requestedBy: 'Lin Zhou',
      requestedAt: at(2),
      status: 'pending',
    },
    {
      id: 'apr-hotfix-security',
      releaseId: 'rel-payment-hotfix',
      stage: 'Security review',
      requiredRole: 'security-reviewer',
      requestedBy: 'Lin Zhou',
      requestedAt: at(3),
      status: 'approved',
      decision: { by: 'Nadia Fischer', at: at(2), comment: 'No new external callouts. Approved.' },
    },
    {
      id: 'apr-hotfix-cab',
      releaseId: 'rel-payment-hotfix',
      stage: 'Production change board',
      requiredRole: 'cab-approver',
      requestedBy: 'Lin Zhou',
      requestedAt: at(3),
      status: 'rejected',
      decision: {
        by: 'Tomas Reid',
        at: at(1),
        comment: 'Deleting Retry_Limit_Guard needs a documented rollback plan first.',
      },
    },
    {
      id: 'apr-console-cab',
      releaseId: 'rel-console-refresh',
      stage: 'Production change board',
      requiredRole: 'cab-approver',
      requestedBy: 'Sam Okafor',
      requestedAt: at(13),
      status: 'approved',
      decision: { by: 'Tomas Reid', at: at(12), comment: 'UI-only change. Approved for Thursday.' },
    },
    {
      id: 'apr-tax-cab',
      releaseId: 'rel-tax-migration',
      stage: 'Production change board',
      requiredRole: 'cab-approver',
      requestedBy: 'Marco Bellini',
      requestedAt: at(28),
      status: 'approved',
      decision: { by: 'Tomas Reid', at: at(27) },
    },
    {
      id: 'apr-tax-uat',
      releaseId: 'rel-tax-migration',
      stage: 'UAT sign-off',
      requiredRole: 'uat-approver',
      requestedBy: 'Marco Bellini',
      requestedAt: at(29),
      status: 'approved',
      decision: { by: 'Sam Okafor', at: at(28), comment: 'Verified against the tax fixture set.' },
    },
  ];

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    actor: { name: 'Sam Okafor', roles: ['release-manager', 'uat-approver'] },
    environments,
    releases,
    items,
    approvals,
    auditLog: [],
    isDemoData: true,
  };
}

function toMetadataItem(
  spec: ItemSpec,
  releaseId: string,
  id: string,
  at: (daysAgo: number) => string,
): MetadataItem {
  return {
    id,
    releaseId,
    fullName: spec.fullName,
    type: spec.type,
    operation: spec.operation,
    filePath: filePathFor(spec),
    apiVersion: spec.warnings?.includes(API_VERSION_DRIFT) === true ? '58.0' : '62.0',
    lastModifiedBy: spec.by,
    lastModifiedAt: at(spec.daysAgo),
    dependsOn: spec.dependsOn ?? [],
    warnings: spec.warnings ?? [],
    ...(spec.coverage === undefined ? {} : { testCoverage: spec.coverage }),
  };
}

/** Mirrors the conventional sfdx source layout closely enough to be recognisable. */
function filePathFor(spec: ItemSpec): string {
  const root = 'force-app/main/default';
  switch (spec.type) {
    case 'ApexClass':
      return `${root}/classes/${spec.fullName}.cls`;
    case 'ApexTrigger':
      return `${root}/triggers/${spec.fullName}.trigger`;
    case 'Flow':
      return `${root}/flows/${spec.fullName}.flow-meta.xml`;
    case 'LightningComponentBundle':
      return `${root}/lwc/${spec.fullName}/${spec.fullName}.js`;
    case 'PermissionSet':
      return `${root}/permissionsets/${spec.fullName}.permissionset-meta.xml`;
    case 'CustomLabel':
      return `${root}/labels/CustomLabels.labels-meta.xml`;
    case 'CustomObject':
      return `${root}/objects/${spec.fullName}/${spec.fullName}.object-meta.xml`;
    case 'CustomField': {
      const [object, field] = spec.fullName.split('.');
      return `${root}/objects/${object ?? 'Unknown'}/fields/${field ?? spec.fullName}.field-meta.xml`;
    }
    case 'ValidationRule': {
      const [object, rule] = spec.fullName.split('.');
      return `${root}/objects/${object ?? 'Unknown'}/validationRules/${rule ?? spec.fullName}.validationRule-meta.xml`;
    }
    case 'Layout':
      return `${root}/layouts/${spec.fullName}.layout-meta.xml`;
    default:
      return `${root}/${spec.type}/${spec.fullName}`;
  }
}
