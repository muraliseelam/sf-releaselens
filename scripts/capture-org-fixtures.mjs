/**
 * Captures real Salesforce responses and turns them into committable fixtures.
 *
 *   node scripts/capture-org-fixtures.mjs --target-org <alias> [--label <name>]
 *
 * ## What a fixture keeps, and what it cannot
 *
 * The value of a fixture from a real org is its **shape**: which keys exist,
 * which are null, which are nested, which are arrays, and what the enum values
 * actually are. That is exactly what the hand-written fixtures got wrong — they
 * invented a `createdByName` on components that no real component has, and
 * modelled a `TestLevel` that is null in every real row.
 *
 * So the scrubber preserves the shape exactly and replaces the content. Every
 * key, every null, every type and every nesting level survives; every string
 * that could identify an org, a person, a customer's metadata or a session is
 * synthesised. Numbers, booleans and nulls pass through unchanged — a component
 * count and a `checkOnly` flag identify nobody.
 *
 * That is a **deny-by-default** rule for strings: a string is replaced unless
 * its field is on `KEEP_STRING`, which holds only Salesforce's own vocabulary
 * (`ApexClass`, `Succeeded`, `INVALID_TYPE`). A new field that appears in a
 * future capture is scrubbed without anybody remembering to add it.
 *
 * `test/fixtures/org/no-secrets.test.ts` then re-checks the committed result
 * from the other direction, so a mistake here has to get past both.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deployReport, describeOrg } from './org-harness.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(projectRoot, 'test', 'fixtures', 'org');

/**
 * Field names whose string values are Salesforce's own vocabulary rather than
 * anybody's data, and are therefore part of the contract under test.
 */
const KEEP_STRING = new Set([
  'componentType',
  'Status',
  'status',
  'problemType',
  'OrganizationType',
  'type',
  'label',
  'version',
  'errorCode',
  'errorStatusCode',
  // Our own error code and message for a failed call. Both are the contract
  // being recorded — `INVALID_TYPE: sObject type 'ApexCodeCoverageAggregate' is
  // not supported` is the whole reason one of these fixtures exists.
  'code',
  'message',
]);

/**
 * Arrays whose *elements* are Salesforce schema rather than data.
 *
 * `toolingDetailKeys.keys` is a list of field names, and scrubbing it to
 * `synthetic-1, synthetic-2` would erase the finding it records: that the
 * Tooling record has no `DeployResult` field.
 */
const KEEP_STRING_ARRAY = new Set(['keys']);

const SYNTHETIC_DATES = [
  '2026-09-01T09:00:00.000+0000',
  '2026-09-01T09:04:12.000+0000',
  '2026-09-02T14:20:00.000+0000',
];

const DATE_FIELD = /date$/i;

/** Field names replaced with a shape-preserving synthetic value. */
const SYNTHESISE = {
  InstanceName: () => 'USA000',
  createdByName: () => 'Alex Fixture',
  // Kept short on purpose: a longer synthetic path trips the product
  // redactor's opaque-run rule, and `no-secrets.test.ts` asserts a fixture is a
  // fixed point of that redactor.
  fullName: (index) => `SynthComp${index}`,
  fileName: (index) => `synth/C${index}.xml`,
  problem: () => 'Synthesised problem text for a fixture.',
};

/** Salesforce key prefixes, so a synthetic id still looks like the right object. */
const ID_PREFIX = {
  Organization: '00D',
  User: '005',
  DeployRequest: '0Af',
  ApexClass: '01p',
  ApexCodeCoverageAggregate: '710',
};

/**
 * Replaces content while preserving structure.
 *
 * `ownerType` is the enclosing record's `attributes.type` when there is one, so
 * a `Name` under a User becomes a person and a `Name` under an Organization
 * becomes an org — the fixture stays readable, and an id keeps the key prefix
 * its object would really have.
 *
 * @param counter a mutable box, so synthesised values are distinct across a
 *        whole payload rather than repeating per object.
 */
function scrub(value, key, counter, ownerType) {
  if (value === null) return null;

  if (Array.isArray(value)) {
    if (key !== undefined && KEEP_STRING_ARRAY.has(key)) return [...value];
    return value.map((entry) => scrub(entry, key, counter, ownerType));
  }

  if (typeof value === 'object') {
    const type = typeof value['attributes']?.type === 'string' ? value.attributes.type : ownerType;
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = scrub(childValue, childKey, counter, type);
    }
    return out;
  }

  // Numbers and booleans are counts and flags. They identify nothing, and
  // changing them would destroy the contract the fixture exists to record.
  if (typeof value !== 'string') return value;

  /*
   * A record URL carries its own id in the path. Replaced wholesale rather than
   * patched: a regex over a path also eats the object name, and a
   * realistic-looking synthetic path is long enough that the product's own
   * redactor flags it as an opaque credential run — which fails the fixed-point
   * check in `no-secrets.test.ts` for no good reason. Nothing reads
   * `attributes`; what matters is that the key is present and ignored.
   */
  if (key === 'url') return `synthetic/${ownerType ?? 'Unknown'}`;

  if (DATE_FIELD.test(key ?? '')) {
    return SYNTHETIC_DATES[counter.dates++ % SYNTHETIC_DATES.length];
  }

  /*
   * Ids are stable per original value, not per occurrence.
   *
   * The captures cross-reference each other: a `DeployRequest` row's `Id` is
   * the key used to fetch that deploy's details, and the details echo it back
   * as `deployResult.id`. Minting a fresh synthetic id at every occurrence
   * silently broke that join — the fixture server then found no details for any
   * deploy and the browser test saw "0 of 0 components", which is precisely the
   * bug this whole session is about. A fixture that cannot be joined is worse
   * than no fixture: it reproduces a failure that is not real.
   */
  if (key === 'Id' || key === 'id' || key === 'CreatedById') {
    const existing = counter.ids.get(value);
    if (existing !== undefined) return existing;
    const prefix = ID_PREFIX[ownerType ?? ''] ?? (key === 'CreatedById' ? '005' : '0Af');
    const minted = `${prefix}SYNTH0000${String(counter.values++).padStart(4, '0')}AAA`;
    counter.ids.set(value, minted);
    return minted;
  }

  if (key === 'Name') {
    return ownerType === 'Organization'
      ? 'Contoso Test Org'
      : ownerType === 'User'
        ? 'Alex Fixture'
        : `SynthName${counter.values++}`;
  }

  if (key in SYNTHESISE) return SYNTHESISE[key](counter.values++);
  if (KEEP_STRING.has(key ?? '')) return value;

  // Deny by default.
  return `synthetic-${counter.values++}`;
}

function scrubPayload(payload) {
  return scrub(payload, undefined, { values: 1, dates: 0, ids: new Map() }, undefined);
}

async function main() {
  const aliasIndex = process.argv.indexOf('--target-org');
  if (aliasIndex === -1) throw new Error('Pass --target-org <alias>.');
  const alias = process.argv[aliasIndex + 1];
  const labelIndex = process.argv.indexOf('--label');
  const label = labelIndex === -1 ? alias : process.argv[labelIndex + 1];

  const { createFetchOrgConnection } = await import('../dist/data/fetchConnection.js');
  const org = await describeOrg(alias);
  const apiVersion = process.env['SFRL_API_VERSION'] ?? '62.0';
  const connection = createFetchOrgConnection({
    instanceUrl: org.instanceUrl,
    apiVersion,
    getAccessToken: async () => org.accessToken,
  });

  const base = `/services/data/v${apiVersion}`;
  /*
   * Header fields, kept out of the scrubber.
   *
   * These are facts about the *capture*, not content from the org: a date, the
   * version this build asked for, the version the org offers, and whether the
   * org has a namespace. The instance host is deliberately not among them — a
   * host pattern is harmless but `no-secrets.test.ts` forbids the string
   * `salesforce.com` outright, and an absolute rule is worth more than one
   * convenient field. Host patterns live in docs/ORG-COMPATIBILITY.md.
   */
  const header = {
    capturedAt: new Date().toISOString().slice(0, 10),
    apiVersion,
    orgApiVersion: org.instanceApiVersion,
    namespaced: org.namespacePrefix !== null,
  };
  const captured = {};

  // Every call below is a GET. There is no write anywhere in this file.
  captured.versions = await attempt(() => connection.get('/services/data/'));
  captured.limits = await attempt(async () => {
    const all = await connection.get(`${base}/limits`);
    // One key of sixty. The rest describe an org's edition and entitlements,
    // which is more than a fixture needs and more than it should carry.
    return { DailyApiRequests: all.DailyApiRequests };
  });
  captured.organization = await attempt(() =>
    connection.get(`${base}/query`, {
      q: 'SELECT Id, Name, IsSandbox, TrialExpirationDate, OrganizationType, InstanceName FROM Organization LIMIT 1',
    }),
  );
  captured.deployRequests = await attempt(() =>
    connection.toolingQuery(
      'SELECT Id, Status, CheckOnly, CreatedDate, StartDate, CompletedDate, ' +
        'NumberComponentsTotal, NumberComponentErrors, NumberComponentsDeployed, TestLevel, CreatedBy.Name ' +
        'FROM DeployRequest ORDER BY CreatedDate DESC LIMIT 10',
    ),
  );
  captured.coverage = await attempt(() =>
    connection.toolingQuery(
      'SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate',
    ),
  );

  const deployIds = (captured.deployRequests?.value?.records ?? [])
    .map((row) => row.Id)
    .filter((id) => typeof id === 'string')
    .slice(0, 3);

  captured.deployDetails = [];
  for (const id of deployIds) {
    captured.deployDetails.push(
      await attempt(() =>
        connection.get(`${base}/metadata/deployRequest/${id}`, { includeDetails: 'true' }),
      ),
    );
  }
  /*
   * The CLI's own report for the same deploy.
   *
   * `data/transfer.ts` maps this when a user imports a file, and its shape had
   * never been checked against a real one either — the hand-written fixture
   * invented a `createdByName` on each component that no real report has.
   */
  captured.cliDeployReport =
    deployIds.length === 0
      ? { ok: false, code: 'NO_DEPLOYS', message: 'this org has no deploy history' }
      : await attempt(() => deployReport(alias, deployIds[0]));

  // The endpoint the code used to read, kept so the fixture records *why* it
  // was wrong rather than only that it changed.
  captured.toolingDetailKeys = await attempt(async () => {
    if (deployIds.length === 0) return null;
    const record = await connection.get(`${base}/tooling/sobjects/DeployRequest/${deployIds[0]}`);
    return { keys: Object.keys(record).sort(), hasDeployResult: 'DeployResult' in record };
  });

  const scrubbed = { ...header, ...scrubPayload(captured) };
  await mkdir(OUT, { recursive: true });
  const file = join(OUT, `${label}.json`);
  await writeFile(file, `${JSON.stringify(scrubbed, null, 2)}\n`, 'utf8');
  process.stdout.write(`Captured ${label} -> ${file}\n`);
}

/** Records a failure as data rather than losing the whole capture to it. */
async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (cause) {
    return {
      ok: false,
      code: cause?.code ?? cause?.name ?? 'UNKNOWN',
      status: cause?.status ?? null,
      errorCode: cause?.errorCode ?? null,
      message: String(cause?.message ?? cause),
    };
  }
}

await main();
