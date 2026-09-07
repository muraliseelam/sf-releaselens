import { describe, expect, it } from 'vitest';

import {
  EMPTY_QUERY,
  findItem,
  highestSeverity,
  resolveDependencies,
  searchMetadata,
  type MetadataQuery,
} from '../../src/core/metadata.js';
import { makeItem } from '../fixtures/snapshot.js';

const items = [
  makeItem({ id: '1', fullName: 'InvoiceBuilder', type: 'ApexClass', operation: 'add', lastModifiedBy: 'Lin Zhou' }),
  makeItem({ id: '2', fullName: 'UsageAggregator', type: 'ApexClass', operation: 'add', lastModifiedBy: 'Marco Bellini' }),
  makeItem({
    id: '3',
    fullName: 'Invoice_Approval_Routing',
    type: 'Flow',
    operation: 'modify',
    filePath: 'force-app/main/default/flows/Invoice_Approval_Routing.flow-meta.xml',
    lastModifiedBy: 'Lin Zhou',
    warnings: [{ code: 'HARDCODED_ID', message: 'Hard-coded id.', severity: 'warning' }],
  }),
  makeItem({
    id: '4',
    releaseId: 'rel-2',
    fullName: 'LegacyTaxCalculator',
    type: 'ApexClass',
    operation: 'delete',
    lastModifiedBy: 'Marco Bellini',
    warnings: [{ code: 'DESTRUCTIVE_CHANGE', message: 'Irreversible.', severity: 'error' }],
  }),
];

function query(patch: Partial<MetadataQuery> = {}): MetadataQuery {
  return { ...EMPTY_QUERY, ...patch };
}

describe('searchMetadata', () => {
  it('returns everything for an empty query', () => {
    const result = searchMetadata(items, EMPTY_QUERY);

    expect(result.items).toHaveLength(4);
    expect(result.totalBeforeFilters).toBe(4);
  });

  it('matches on full name, case-insensitively', () => {
    expect(searchMetadata(items, query({ text: 'invoicebuilder' })).items.map((i) => i.id)).toEqual([
      '1',
    ]);
  });

  it.each([
    ['type', 'flow', ['3']],
    ['file path', 'flow-meta', ['3']],
    ['author', 'marco', ['2', '4']],
  ])('matches on %s', (_field, text, expected) => {
    expect(searchMetadata(items, query({ text })).items.map((i) => i.id)).toEqual(expected);
  });

  it('ANDs multiple tokens rather than ORing them', () => {
    // "invoice" alone matches two items; adding "flow" must narrow to one.
    expect(searchMetadata(items, query({ text: 'invoice' })).items).toHaveLength(2);
    expect(searchMetadata(items, query({ text: 'invoice flow' })).items.map((i) => i.id)).toEqual([
      '3',
    ]);
  });

  it('combines text with type, operation, release and warning filters', () => {
    const result = searchMetadata(
      items,
      query({ types: ['ApexClass'], operations: ['add'], releaseId: 'rel-1' }),
    );

    expect(result.items.map((i) => i.id)).toEqual(['1', '2']);
  });

  it('filters to items with warnings only', () => {
    expect(searchMetadata(items, query({ onlyWithWarnings: true })).items.map((i) => i.id)).toEqual([
      '3',
      '4',
    ]);
  });

  it('returns no matches for text that appears nowhere', () => {
    expect(searchMetadata(items, query({ text: 'zzz' })).items).toEqual([]);
  });

  describe('facets', () => {
    it('counts types with the type filter lifted but other filters applied', () => {
      // With ApexClass selected, the Flow facet must still show its real count —
      // otherwise the user could never switch to it.
      const result = searchMetadata(items, query({ types: ['ApexClass'] }));
      const flow = result.facets.types.find((facet) => facet.value === 'Flow');

      expect(flow?.count).toBe(1);
      expect(result.items.every((item) => item.type === 'ApexClass')).toBe(true);
    });

    it('narrows type facets by the active text and operation filters', () => {
      const result = searchMetadata(items, query({ operations: ['add'] }));

      expect(result.facets.types).toEqual([{ value: 'ApexClass', count: 2 }]);
    });

    it('lists every operation, including zero counts, in a stable order', () => {
      const result = searchMetadata(items, query({ text: 'invoicebuilder' }));

      expect(result.facets.operations).toEqual([
        { value: 'add', count: 1 },
        { value: 'modify', count: 0 },
        { value: 'delete', count: 0 },
      ]);
    });

    it('orders type facets by count then name', () => {
      const result = searchMetadata(items, EMPTY_QUERY);

      expect(result.facets.types).toEqual([
        { value: 'ApexClass', count: 3 },
        { value: 'Flow', count: 1 },
      ]);
    });
  });
});

describe('resolveDependencies', () => {
  const graph = [
    makeItem({ id: 'a', fullName: 'InvoiceBuilder', dependsOn: ['UsageAggregator', 'Ledger__c'] }),
    makeItem({ id: 'b', fullName: 'UsageAggregator', dependsOn: ['InvoiceBuilder'] }),
    makeItem({ id: 'c', fullName: 'InvoiceTrigger', dependsOn: ['InvoiceBuilder'] }),
  ];

  it('splits dependencies into those present and those outside the snapshot', () => {
    const view = resolveDependencies(graph, graph[0]!);

    expect(view.resolved.map((item) => item.fullName)).toEqual(['UsageAggregator']);
    expect(view.external).toEqual(['Ledger__c']);
  });

  it('finds reverse edges', () => {
    const view = resolveDependencies(graph, graph[0]!);

    expect(view.dependents.map((item) => item.id).sort()).toEqual(['b', 'c']);
  });

  it('walks one hop only, so a cycle terminates', () => {
    const view = resolveDependencies(graph, graph[1]!);

    expect(view.resolved.map((item) => item.id)).toEqual(['a']);
    expect(view.dependents.map((item) => item.id)).toEqual(['a']);
  });

  it('drops self-references from both directions', () => {
    const selfish = makeItem({ id: 'self', fullName: 'Loop', dependsOn: ['Loop'] });
    const view = resolveDependencies([selfish], selfish);

    expect(view.resolved).toEqual([]);
    expect(view.external).toEqual([]);
    expect(view.dependents).toEqual([]);
  });

  it('reports an item with no dependencies as empty rather than throwing', () => {
    const lonely = makeItem({ id: 'lonely', fullName: 'Standalone' });
    const view = resolveDependencies([lonely], lonely);

    expect(view).toEqual({ resolved: [], external: [], dependents: [] });
  });
});

describe('highestSeverity', () => {
  it('reports the worst severity present, and null when clean', () => {
    expect(highestSeverity(makeItem({}))).toBeNull();
    expect(
      highestSeverity(
        makeItem({
          warnings: [
            { code: 'A', message: 'a', severity: 'info' },
            { code: 'B', message: 'b', severity: 'error' },
            { code: 'C', message: 'c', severity: 'warning' },
          ],
        }),
      ),
    ).toBe('error');
    expect(
      highestSeverity(makeItem({ warnings: [{ code: 'A', message: 'a', severity: 'info' }] })),
    ).toBe('info');
  });
});

describe('findItem', () => {
  it('finds by id, or returns undefined', () => {
    expect(findItem(items, '3')?.fullName).toBe('Invoice_Approval_Routing');
    expect(findItem(items, 'nope')).toBeUndefined();
  });
});
