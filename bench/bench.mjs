/**
 * Measures the two operations that run on every keystroke and every render,
 * against payloads larger than a real Salesforce release usually is.
 *
 * Runs against `dist/`, so `npm run build` must have happened first. Numbers in
 * the README come from this script — re-run it rather than editing them.
 *
 *   npm run build && node bench/bench.mjs
 */

import { performance } from 'node:perf_hooks';

import { EMPTY_QUERY, resolveDependencies, searchMetadata } from '../dist/core/metadata.js';
import { summariseByStatus } from '../dist/core/releases.js';
import { parseSnapshot } from '../dist/core/validate.js';

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

  return {
    schemaVersion: 1,
    actor: { name: 'Bench', roles: ['release-manager'] },
    environments,
    releases,
    items,
    approvals: [],
    auditLog: [],
    isDemoData: false,
  };
}

function measure(label, runs, fn) {
  fn(); // warm up the JIT so the first run does not dominate
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  console.log(`${label.padEnd(46)} p50 ${p50.toFixed(2)}ms   p95 ${p95.toFixed(2)}ms`);
}

const snapshot = buildSnapshot(5000, 40);
const stored = JSON.parse(JSON.stringify(snapshot));

console.log(`Node ${process.version}, ${snapshot.items.length} components, ${snapshot.releases.length} releases\n`);

measure('searchMetadata, no filters', 200, () => searchMetadata(snapshot.items, EMPTY_QUERY));
measure('searchMetadata, text + type + operation', 200, () =>
  searchMetadata(snapshot.items, {
    ...EMPTY_QUERY,
    text: 'handler dev3',
    types: ['ApexClass'],
    operations: ['add'],
  }),
);
measure('resolveDependencies, one component', 200, () =>
  resolveDependencies(snapshot.items, snapshot.items[2500]),
);
measure('summariseByStatus', 500, () => summariseByStatus(snapshot.releases));
measure('parseSnapshot, whole payload', 50, () => parseSnapshot(stored));
