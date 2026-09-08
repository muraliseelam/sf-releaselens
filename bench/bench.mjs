/**
 * What the panel costs, at three sizes of org.
 *
 * Measures the whole path a user waits on — validate the stored snapshot,
 * render a surface, search it, merge a refresh — rather than only the pure
 * functions, because the pure functions were never the risk. Runs against
 * `dist/`, so `npm run build` must have happened first.
 *
 *   npm run bench                      print a table
 *   npm run bench -- --markdown        rewrite docs/BENCHMARKS.md
 *
 * Every number here is synthetic. See the honesty section in BENCHMARKS.md.
 */

import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';

import { EMPTY_QUERY, resolveDependencies, searchMetadata } from '../dist/core/metadata.js';
import { summariseByStatus } from '../dist/core/releases.js';
import { parseSnapshot } from '../dist/core/validate.js';
import { mergeIntoCache } from '../dist/data/salesforce.js';
import { toExportJson } from '../dist/data/transfer.js';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * A real Salesforce deploy is usually tens to low hundreds of components. 1,000
 * is a large quarterly release; 10,000 is a full-org retrieve, well past what
 * this tool is for — included because the interesting question is not "is it
 * fast at the expected size" but "does it fall over past it".
 */
const SCALES = [
  { items: 100, releases: 5, label: '100' },
  { items: 1_000, releases: 20, label: '1,000' },
  { items: 10_000, releases: 60, label: '10,000' },
];

const TYPES = ['ApexClass', 'ApexTrigger', 'CustomObject', 'CustomField', 'Flow', 'PermissionSet'];
const OPERATIONS = ['add', 'modify', 'delete'];
const STATUSES = ['draft', 'awaiting_approval', 'scheduled', 'in_progress', 'deployed', 'blocked'];

function buildSnapshot(itemCount, releaseCount) {
  const environments = [{ id: 'env-1', name: 'Production', kind: 'production', orgAlias: 'prod' }];

  const releases = Array.from({ length: releaseCount }, (_, index) => ({
    id: `rel-${index}`,
    name: `Release ${index}`,
    version: `2026.09.${index}`,
    status: STATUSES[index % STATUSES.length],
    targetEnvironmentId: 'env-1',
    owner: 'Bench',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    ticketRefs: [],
    riskLevel: 'medium',
  }));

  const items = Array.from({ length: itemCount }, (_, index) => ({
    id: `item-${index}`,
    releaseId: `rel-${index % releaseCount}`,
    fullName: `Component${index}Handler`,
    type: TYPES[index % TYPES.length],
    operation: OPERATIONS[index % OPERATIONS.length],
    filePath: `force-app/main/default/classes/Component${index}Handler.cls`,
    apiVersion: '62.0',
    lastModifiedBy: `dev${index % 20}`,
    lastModifiedAt: '2026-09-03T00:00:00.000Z',
    dependsOn: index === 0 ? [] : [`Component${index - 1}Handler`],
    warnings: index % 17 === 0 ? [{ code: 'X', message: 'y', severity: 'warning' }] : [],
  }));

  // One pending approval per release, because the approvals surface is the one
  // that renders per-release state and a snapshot with none is not the shape
  // anyone actually has.
  const approvals = releases.map((release, index) => ({
    id: `apr-${index}`,
    releaseId: release.id,
    stage: 'UAT sign-off',
    requiredRole: 'release-manager',
    requestedBy: 'Bench',
    requestedAt: '2026-09-02T00:00:00.000Z',
    status: 'pending',
  }));

  return {
    schemaVersion: 1,
    actor: { name: 'Bench', roles: ['release-manager'] },
    environments,
    releases,
    items,
    approvals,
    auditLog: [],
    isDemoData: false,
  };
}

/**
 * @returns p50 and p95 in milliseconds.
 *
 * The mean is deliberately not reported. One 40ms garbage collection in a
 * hundred 1ms runs moves the mean by 40% and tells you nothing about what a
 * user experiences; p95 is the frame they actually notice.
 */
function measure(runs, fn) {
  fn(); // warm the JIT, so the first run does not dominate

  /*
   * Collect before measuring, when the runner allows it.
   *
   * Without this the numbers depend on what the *previous* measurement left on
   * the heap: scoping the 10 MB export string away from the render
   * measurements moved "parse a stored snapshot" at 10,000 components from
   * 18.5ms to 4.0ms without touching a line of product code. A benchmark that
   * sensitive to its own ordering is not measuring the code.
   */
  globalThis.gc?.();

  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    p50: samples[Math.floor(samples.length * 0.5)],
    p95: samples[Math.floor(samples.length * 0.95)],
  };
}

/**
 * A DOM for the render measurements.
 *
 * The panel's views are pure functions of state that return detached elements,
 * so a jsdom document is enough to measure the element construction — which is
 * the part this project controls. Chrome's layout and paint are not measured
 * here and are not comparable; the e2e suite is where real browser timing
 * lives.
 */
function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  return dom;
}

/**
 * Runs one scale and returns its measurements.
 *
 * Each scale runs in its own process, spawned by `runAll`. Sharing one process
 * made every number depend on what the previous scale had left on the heap:
 * moving a 10 MB string out of scope changed an unrelated measurement by 4x.
 * A fresh heap per scale costs a second of start-up and buys numbers that mean
 * something.
 */
async function runScale(scale) {
  installDom();

  // Imported after the DOM exists: the view modules are pure, but `el()` calls
  // `document.createElement` the moment a render runs.
  const { renderDashboard } = await import('../dist/ui/views/dashboard.js');
  const { renderInspector } = await import('../dist/ui/views/inspector.js');
  const { renderApprovals } = await import('../dist/ui/views/approvals.js');
  const { INITIAL_STATE } = await import('../dist/ui/state.js');

  const handlers = new Proxy(
    {},
    {
      // The views only ever attach these as listeners; nothing is invoked
      // during a render, so a no-op for every name is enough.
      get: () => () => undefined,
    },
  );

  {
    const snapshot = buildSnapshot(scale.items, scale.releases);
    const now = Date.parse('2026-09-08T12:00:00.000Z');

    // Half the releases refreshed, half kept from cache: the shape of a real
    // refresh, where the recent-deploys window covers only part of the cache.
    const half = Math.ceil(scale.releases / 2);
    const fresh = {
      environment: snapshot.environments[0],
      releases: snapshot.releases.slice(0, half),
      items: snapshot.items.filter((item) =>
        snapshot.releases.slice(0, half).some((release) => release.id === item.releaseId),
      ),
    };

    const inspectorState = { ...INITIAL_STATE, tab: 'inspector' };

    /*
     * The serialisation measurements are scoped so their intermediates — at
     * 10,000 components, a second copy of the snapshot and a 10 MB string — are
     * collectable before the renders run. Holding them across the whole scale
     * put the renders under garbage-collection pressure no real panel has, and
     * tripled the number they reported.
     */
    const serialisation = (() => {
      const stored = JSON.parse(JSON.stringify(snapshot));
      const json = toExportJson(snapshot);
      return {
        'Parse a stored snapshot': measure(runsFor(scale.items, 60), () => parseSnapshot(stored)),
        'Serialise for export': measure(runsFor(scale.items, 60), () => toExportJson(snapshot)),
        'Read an exported file': measure(runsFor(scale.items, 60), () =>
          parseSnapshot(JSON.parse(json)),
        ),
      };
    })();

    const measurements = {
      ...serialisation,
      'Render the dashboard': measure(runsFor(scale.items, 100), () =>
        renderDashboard(INITIAL_STATE, snapshot, handlers, now),
      ),
      'Render the inspector, unfiltered': measure(runsFor(scale.items, 100), () =>
        renderInspector(inspectorState, snapshot, handlers, now),
      ),
      'Render the approvals queues': measure(runsFor(scale.items, 100), () =>
        renderApprovals(INITIAL_STATE, snapshot, handlers, now),
      ),
      'Search, no filters': measure(runsFor(scale.items, 200), () =>
        searchMetadata(snapshot.items, EMPTY_QUERY),
      ),
      'Search, text + type + operation': measure(runsFor(scale.items, 200), () =>
        searchMetadata(snapshot.items, {
          ...EMPTY_QUERY,
          text: 'handler dev3',
          types: ['ApexClass'],
          operations: ['add'],
        }),
      ),
      'Resolve one component’s dependencies': measure(runsFor(scale.items, 200), () =>
        resolveDependencies(snapshot.items, snapshot.items[Math.floor(scale.items / 2)]),
      ),
      'Summarise releases by status': measure(runsFor(scale.items, 500), () =>
        summariseByStatus(snapshot.releases),
      ),
      'Merge a refresh into the cache': measure(runsFor(scale.items, 200), () =>
        mergeIntoCache(snapshot, fresh),
      ),
    };

    return measurements;
  }
}

async function runAll() {
  const rows = SCALES.map((scale) => ({
    scale,
    measurements: JSON.parse(
      execFileSync(
        process.execPath,
        ['--expose-gc', fileURLToPath(import.meta.url), '--scale', String(scale.items), '--json'],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      ),
    ),
  }));

  const report = format(rows);
  process.stdout.write(report.text);

  if (process.argv.includes('--markdown')) {
    const target = join(projectRoot, 'docs', 'BENCHMARKS.md');
    await writeFile(target, report.markdown, 'utf8');
    process.stdout.write(`\nWrote ${target}\n`);
  }
}

/** Fewer repetitions at the sizes where one repetition is already slow. */
function runsFor(itemCount, base) {
  // A p50 over ten samples is a coin toss, so the floor is 30 even where one
  // repetition is slow.
  if (itemCount >= 10_000) return Math.max(30, Math.round(base / 4));
  if (itemCount >= 1_000) return Math.max(50, Math.round(base / 2));
  return base;
}

function format(rows) {
  const machine = describeMachine();
  const names = Object.keys(rows[0].measurements);

  let text = `${machine.text}\n\n`;
  for (const row of rows) {
    text += `${row.scale.label} components across ${row.scale.releases} releases\n`;
    for (const name of names) {
      const { p50, p95 } = row.measurements[name];
      text += `  ${name.padEnd(38)} p50 ${fixed(p50).padStart(8)}   p95 ${fixed(p95).padStart(8)}\n`;
    }
    text += '\n';
  }

  const header = `| Operation | ${rows.map((row) => `${row.scale.label} p50 | ${row.scale.label} p95`).join(' | ')} |`;
  const divider = `| --- | ${rows.map(() => '---: | ---:').join(' | ')} |`;
  const body = names
    .map(
      (name) =>
        `| ${name} | ${rows
          .map((row) => `${fixed(row.measurements[name].p50)} | ${fixed(row.measurements[name].p95)}`)
          .join(' | ')} |`,
    )
    .join('\n');

  const markdown = `${DOC_HEADER}
${machine.markdown}

| | 100 components | 1,000 components | 10,000 components |
| --- | ---: | ---: | ---: |
| Releases | 5 | 20 | 60 |
| Approvals | 5 | 20 | 60 |
| Export size | ${rows.map((row) => exportSize(row.scale)).join(' | ')} |

All times in milliseconds.

${header}
${divider}
${body}

${DOC_FOOTER}`;

  return { text, markdown };
}

function exportSize(scale) {
  const bytes = Buffer.byteLength(toExportJson(buildSnapshot(scale.items, scale.releases)), 'utf8');
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fixed(ms) {
  if (ms < 0.01) return '<0.01';
  if (ms < 10) return ms.toFixed(2);
  return ms.toFixed(1);
}

function describeMachine() {
  const cpu = cpus()[0]?.model.trim() ?? 'unknown CPU';
  const memory = `${Math.round(totalmem() / 1024 / 1024 / 1024)} GB RAM`;
  const line = `Node ${process.version} on ${process.platform} ${process.arch} — ${cpu}, ${cpus().length} threads, ${memory}`;
  return {
    text: line,
    markdown: `Measured on **${line}**, ${new Date().toISOString().slice(0, 10)}.`,
  };
}

const DOC_HEADER = `<!--
  Generated by \`npm run bench -- --markdown\`. Do not edit by hand; re-run it.
-->

# Benchmarks

`;

const DOC_FOOTER = `## What changed as a result

Two things, both found by running this rather than by reading the code.

**The dashboard was quadratic in (releases x components).** Every row computed
its own component count by filtering the whole item list, so 60 releases over
10,000 components meant 600,000 comparisons per paint — and the panel repaints
on every keystroke. Counting once into a map first took the dashboard render
from **11.6ms to 7.1ms p50** at that size. The measured gain is modest; the
complexity change is the point, because the old cost grew with the *product* of
the two numbers and an org with 200 releases would have paid four times more
again.

**The benchmark itself was measuring its own heap.** Running all three scales in
one process made every number depend on what the previous scale had left
behind: moving a 10 MB export string out of scope changed an unrelated parse
measurement from 18.5ms to 4.0ms without touching a line of product code. Each
scale now runs in its own process. If a number here looks surprising, suspect
the harness before the code — that is what happened the first three times.

## How to read this

**These are synthetic numbers, and they have never been measured against a live
Salesforce org.** The snapshots are generated in \`bench/bench.mjs\`: uniform
component names, one dependency edge per component, a warning on every
seventeenth. Real org data is lumpier — a handful of very large Flows, long
file paths, and dependency edges clustered rather than spread — so treat these
as an upper bound on what the code costs, not a prediction of what a user sees.

p50 and p95, no mean. One 40ms garbage collection in a hundred 1ms runs moves a
mean by 40% and tells you nothing about what anybody experiences; p95 is the
frame a user notices.

**Renders are measured against jsdom, not Chrome.** They cover building the
element tree, which is the part this project controls. Chrome's layout, style
and paint are not included and are not comparable. Real browser timing lives in
the e2e suite.

The size that matters is **1,000 components**: a large quarterly release. 100 is
a normal deploy. 10,000 is a full-org retrieve, well past what this tool is for,
and is here to answer "does it fall over past the expected size" rather than
"is it fast at it".

The inspector caps rendering at 200 rows and says so in its caption, so the
render numbers do not grow with the result count the way the search numbers do.

## Re-running

\`\`\`bash
npm run build
npm run bench                # print
npm run bench -- --markdown  # rewrite this file
\`\`\`

Re-run it rather than editing the table. The numbers are from one run on one
machine and will differ on yours.
`;

const scaleFlag = process.argv.indexOf('--scale');
if (scaleFlag === -1) {
  await runAll();
} else {
  const wanted = Number(process.argv[scaleFlag + 1]);
  const scale = SCALES.find((candidate) => candidate.items === wanted);
  if (scale === undefined) throw new Error(`No such scale: ${wanted}`);
  process.stdout.write(JSON.stringify(await runScale(scale)));
}
