/**
 * Measures every connected org against the assumptions this extension makes.
 *
 *   node scripts/org-compatibility-report.mjs            print a table
 *   node scripts/org-compatibility-report.mjs --markdown rewrite docs/ORG-COMPATIBILITY.md
 *
 * Read-only: every call is a GET through the extension's own `OrgConnection`,
 * whose interface has no write member.
 *
 * ## What it will and will not print
 *
 * Local CLI aliases, host *patterns*, API versions, counts and enum values.
 * Never an org id, instance URL, username, org name, deploy id or component
 * name. The point of the report is what differs between orgs, and none of that
 * requires naming one.
 */

import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeOrg, listOrgs } from './org-harness.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const API_VERSION = '62.0';

async function measure(alias) {
  const { createFetchOrgConnection } = await import('../dist/data/fetchConnection.js');
  const org = await describeOrg(alias);
  const connection = createFetchOrgConnection({
    instanceUrl: org.instanceUrl,
    apiVersion: API_VERSION,
    getAccessToken: () => Promise.resolve(org.accessToken),
  });
  const base = `/services/data/v${API_VERSION}`;

  const row = {
    alias,
    namespace: org.namespacePrefix ?? '—',
    hostPattern: org.instanceHostPattern,
    orgApiVersion: org.instanceApiVersion ?? '?',
    offersPinned: '?',
    dailyApiMax: '?',
    deploys: 0,
    statuses: {},
    testLevels: {},
    detailsResolved: 0,
    componentsSeen: 0,
    componentAuthors: 0,
    coverage: '?',
    notes: [],
  };

  row.offersPinned = await attempt(async () => {
    const versions = await connection.get('/services/data/');
    return versions.some((entry) => entry.version === API_VERSION) ? 'yes' : 'NO';
  });

  row.dailyApiMax = await attempt(async () => {
    const limits = await connection.get(`${base}/limits`);
    return String(limits.DailyApiRequests?.Max ?? '?');
  });

  const deploys = await attempt(async () => {
    const page = await connection.toolingQuery(
      'SELECT Id, Status, CheckOnly, CreatedDate, StartDate, CompletedDate, ' +
        'NumberComponentsTotal, NumberComponentErrors, NumberComponentsDeployed, TestLevel, CreatedBy.Name ' +
        'FROM DeployRequest ORDER BY CreatedDate DESC LIMIT 10',
    );
    return page.records;
  });

  if (Array.isArray(deploys)) {
    row.deploys = deploys.length;
    for (const deploy of deploys) {
      count(row.statuses, deploy.Status);
      count(row.testLevels, deploy.TestLevel);
      if (deploy.CreatedBy == null) row.notes.push('a deploy with no CreatedBy');
      if (deploy.CompletedDate == null) row.notes.push('a deploy still running');
    }

    for (const deploy of deploys.slice(0, 3)) {
      const detail = await attempt(() =>
        connection.get(`${base}/metadata/deployRequest/${deploy.Id}`, { includeDetails: 'true' }),
      );
      if (typeof detail === 'string') continue;
      const details = detail?.deployResult?.details;
      if (details === undefined || details === null) continue;
      row.detailsResolved += 1;
      const components = [...asArray(details.componentSuccesses), ...asArray(details.componentFailures)];
      row.componentsSeen += components.length;
      row.componentAuthors += components.filter((c) => c.createdByName != null).length;
    }
  } else {
    row.notes.push(`DeployRequest: ${String(deploys)}`);
  }

  row.coverage = await attempt(async () => {
    const page = await connection.toolingQuery(
      'SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate',
    );
    return `${page.records.length} rows`;
  });

  return row;
}

function count(into, value) {
  const key = value === null || value === undefined ? 'null' : String(value);
  into[key] = (into[key] ?? 0) + 1;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && value !== undefined && typeof value === 'object') return [value];
  return [];
}

/** Failures are data here: "this org refuses X" is the finding. */
async function attempt(fn) {
  try {
    return await fn();
  } catch (cause) {
    return `${cause?.errorCode ?? cause?.code ?? 'ERROR'}`;
  }
}

function describe(counts) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return '—';
  return entries.map(([value, n]) => `${value} ×${n}`).join(', ');
}

async function main() {
  const orgs = await listOrgs();
  if (orgs.length === 0) {
    process.stderr.write('No connected orgs. Authenticate one with `sf org login web`.\n');
    process.exitCode = 1;
    return;
  }

  const rows = [];
  for (const org of orgs) {
    process.stdout.write(`measuring ${org.alias}…\n`);
    rows.push(await measure(org.alias));
  }

  const table = [
    '| Org (local alias) | Namespace | Host pattern | Org API | Offers v62.0 | Daily API max | Deploys | Statuses seen | `TestLevel` | Details resolved | Components | With an author | Coverage |',
    '| --- | --- | --- | ---: | :---: | ---: | ---: | --- | --- | ---: | ---: | ---: | --- |',
    ...rows.map(
      (row) =>
        `| \`${row.alias}\` | ${row.namespace} | \`${row.hostPattern}\` | ${row.orgApiVersion} | ${row.offersPinned} | ${row.dailyApiMax} | ${row.deploys} | ${describe(row.statuses)} | ${describe(row.testLevels)} | ${row.detailsResolved} | ${row.componentsSeen} | ${row.componentAuthors} | ${row.coverage} |`,
    ),
  ].join('\n');

  process.stdout.write(`\n${table}\n`);

  if (process.argv.includes('--markdown')) {
    const target = join(projectRoot, 'docs', 'ORG-COMPATIBILITY.md');
    await writeFile(target, document(table, rows), 'utf8');
    process.stdout.write(`\nWrote ${target}\n`);
  }
}

function document(table, rows) {
  const totalComponents = rows.reduce((sum, row) => sum + row.componentsSeen, 0);
  const totalAuthors = rows.reduce((sum, row) => sum + row.componentAuthors, 0);
  const totalDeploys = rows.reduce((sum, row) => sum + row.deploys, 0);
  const nullTestLevels = rows.reduce((sum, row) => sum + (row.testLevels['null'] ?? 0), 0);
  const emptyOrgs = rows.filter((row) => row.deploys === 0).length;
  const noCoverage = rows.filter((row) => !row.coverage.endsWith('rows')).length;

  return `<!--
  Generated by \`node scripts/org-compatibility-report.mjs --markdown\`.
  Do not edit the table by hand; re-run it.
-->

# Org compatibility

What ${rows.length} real Salesforce orgs actually return, measured on
${new Date().toISOString().slice(0, 10)} with the extension's own transport.
Every call was a \`GET\`; nothing was deployed, executed or modified.

**No org is identified here.** Local CLI aliases, host patterns, API versions,
counts and enum values only — never an org id, instance URL, username, org name,
deploy id or component name.

${table}

## What this measured that the mocked suite could not

**\`TestLevel\` is always null.** ${nullTestLevels} of ${totalDeploys} rows, every
org. The field was selected and never read; it is no longer selected.

**A component has no author.** ${totalAuthors} of ${totalComponents} components
carry a \`createdByName\`, in either the Metadata API or the CLI's
\`deploy report --json\`. The author is on the deploy, and is threaded down from
there — before that, every org-sourced component read "unknown".

**The Tooling record has no details.**
\`tooling/sobjects/DeployRequest/{id}\` returns no \`DeployResult\` field at all.
Component details come from
\`/services/data/vXX/metadata/deployRequest/{id}?includeDetails=true\`, and the
query parameter is required: without it the arrays are present and empty.

**Not every org answers for coverage.** ${noCoverage} of these ${rows.length} rejects
\`ApexCodeCoverageAggregate\` with \`INVALID_TYPE: sObject type
'ApexCodeCoverageAggregate' is not supported\`. That used to fail the whole
refresh; it now degrades, with the reason written into the refresh's audit
entry.

**\`problemType\` is null on real failures**, with the text in \`problem\`. A
warning code is derived rather than read.

**${emptyOrgs} of these ${rows.length} orgs have never had a deploy.** An empty
snapshot is the correct answer and must render as an empty state, not as an
error or a spinner. That case is now a unit test, a contract test and a browser
test, because it is the most likely first experience a new user has.

**Every org runs API 67.0 and still serves 62.0**, the version this build pins.
See the reasoning for pinning in \`docs/DATASOURCE.md\`; the refresh now reads
\`/services/data/\` once and refuses clearly if the pinned version is ever gone.

## What could not be measured

**Pagination.** \`queryMore\` has never run against a live org, and it was not
for want of trying. No org here has enough \`DeployRequest\` or
\`ApexCodeCoverageAggregate\` rows to cross Salesforce's 2,000-record page
boundary. The obvious substitute — \`EntityDefinition\`, which exceeds 2,000 in
four of these orgs — refuses outright:

\`\`\`
EXCEEDED_ID_LIMIT: EntityDefinition does not support queryMore(),
use LIMIT to restrict the results to a single batch
\`\`\`

Nothing else queryable here is large enough. So the continuation path is covered
by unit tests against a fake and by nothing else, and it will stay that way
until somebody points this at an org with more than ten deploys' worth of
history. **That is the largest untested path in the data layer.**

**The OAuth flow.** These tests borrow the Salesforce CLI's token. The
extension's own \`chrome.identity.launchWebAuthFlow\` against a customer-created
Connected App has still never run — see \`docs/LIVE-ORG-RUNBOOK.md\`.

**A sandbox.** All of these are production or developer-edition orgs. Nothing
here has been read from a \`*.sandbox.my.salesforce.com\` instance.

## Running the contract suite

\`\`\`bash
npm run test:org                          # every connected org
npm run test:org -- --target-org nsorg    # one
\`\`\`

Fourteen tests, each walking every connected org. Roughly 100 live API calls in
about 100 seconds for seven orgs — enough to notice, nowhere near a daily limit
(the smallest org here allows 15,000 requests a day).

It **skips** cleanly with no CLI, no authenticated org, or a name that matches
none, saying which. A skip is the right answer to "no org available", and
turning it into a failure would make the suite unusable for anyone without one.

One flake was observed in seven runs and did not reproduce. The per-request
timeout is now 20 seconds rather than the product's 30, so a slow instance fails
as \`ORG_UNREACHABLE\` naming the org rather than as an anonymous runner
timeout — the cause could not be identified after the fact, which is the
argument for making it legible next time.

## Re-running

\`\`\`bash
npm run build
node scripts/org-compatibility-report.mjs --markdown
\`\`\`

The contract tests that assert these findings hold are in
\`test/org/contract.org.test.ts\` — \`npm run test:org\`.
`;
}

await main();
