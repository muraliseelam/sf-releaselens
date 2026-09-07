/**
 * Metadata inspector logic: searching, faceting and dependency resolution.
 *
 * Complexity note: this is O(n) per filter pass over one release payload —
 * hundreds to low thousands of components. No index is built, because building
 * and invalidating one would cost more than the scan it replaces at this size.
 */

import {
  METADATA_OPERATIONS,
  type MetadataItem,
  type MetadataOperation,
  type MetadataType,
  type ReleaseId,
} from './types.js';

export interface MetadataQuery {
  /**
   * Free text. Split on whitespace; every token must match somewhere in the
   * item (AND), so `flow account` narrows rather than widens.
   */
  readonly text: string;
  /** Empty means "no type filter", not "no types". */
  readonly types: readonly MetadataType[];
  readonly operations: readonly MetadataOperation[];
  /** `null` means every release. */
  readonly releaseId: ReleaseId | null;
  readonly onlyWithWarnings: boolean;
}

export const EMPTY_QUERY: MetadataQuery = {
  text: '',
  types: [],
  operations: [],
  releaseId: null,
  onlyWithWarnings: false,
};

export interface FacetCount {
  readonly value: string;
  readonly count: number;
}

export interface MetadataSearchResult {
  readonly items: readonly MetadataItem[];
  /**
   * Counts computed with every *other* active filter applied but this facet's
   * own filter lifted. That is what makes a facet chip trustworthy: clicking one
   * can never produce an empty list.
   */
  readonly facets: {
    readonly types: readonly FacetCount[];
    readonly operations: readonly FacetCount[];
  };
  /** Size of the candidate set before any filter, for "12 of 340" captions. */
  readonly totalBeforeFilters: number;
}

export function searchMetadata(
  items: readonly MetadataItem[],
  query: MetadataQuery,
): MetadataSearchResult {
  const tokens = tokenise(query.text);

  const matchesEverythingBut = (item: MetadataItem, lifted: 'types' | 'operations' | null) =>
    matchesRelease(item, query.releaseId) &&
    matchesWarnings(item, query.onlyWithWarnings) &&
    matchesTokens(item, tokens) &&
    (lifted === 'types' || matchesTypes(item, query.types)) &&
    (lifted === 'operations' || matchesOperations(item, query.operations));

  const matched = items.filter((item) => matchesEverythingBut(item, null));

  const typeCandidates = items.filter((item) => matchesEverythingBut(item, 'types'));
  const operationCandidates = items.filter((item) => matchesEverythingBut(item, 'operations'));

  return {
    items: matched,
    facets: {
      types: countBy(typeCandidates, (item) => item.type).sort(byCountThenValue),
      operations: METADATA_OPERATIONS.map((operation) => ({
        value: operation,
        count: operationCandidates.filter((item) => item.operation === operation).length,
      })),
    },
    totalBeforeFilters: items.length,
  };
}

/** Case- and punctuation-insensitive token split. Empty text matches everything. */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function matchesTokens(item: MetadataItem, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${item.fullName} ${item.type} ${item.filePath} ${item.lastModifiedBy}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function matchesTypes(item: MetadataItem, types: readonly MetadataType[]): boolean {
  return types.length === 0 || types.includes(item.type);
}

function matchesOperations(item: MetadataItem, operations: readonly MetadataOperation[]): boolean {
  return operations.length === 0 || operations.includes(item.operation);
}

function matchesRelease(item: MetadataItem, releaseId: ReleaseId | null): boolean {
  return releaseId === null || item.releaseId === releaseId;
}

function matchesWarnings(item: MetadataItem, onlyWithWarnings: boolean): boolean {
  return !onlyWithWarnings || item.warnings.length > 0;
}

function countBy(
  items: readonly MetadataItem[],
  key: (item: MetadataItem) => string,
): FacetCount[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].map(([value, count]) => ({ value, count }));
}

function byCountThenValue(a: FacetCount, b: FacetCount): number {
  return b.count - a.count || a.value.localeCompare(b.value);
}

// --- Dependencies ------------------------------------------------------------

export interface DependencyView {
  /** Dependencies that are themselves in the snapshot. */
  readonly resolved: readonly MetadataItem[];
  /**
   * Dependency names with no matching component here. Shown plainly rather than
   * hidden: depending on something outside the release is the normal case and
   * often the risky one.
   */
  readonly external: readonly string[];
  /** Components in the snapshot that depend on this one. */
  readonly dependents: readonly MetadataItem[];
}

/**
 * Resolves both directions of the dependency edge for one item.
 *
 * A self-reference is dropped from both lists — an item is not its own
 * dependency, and rendering it as one is noise. Cycles need no special handling
 * because this walks exactly one hop.
 */
export function resolveDependencies(
  items: readonly MetadataItem[],
  item: MetadataItem,
): DependencyView {
  const byFullName = new Map<string, MetadataItem>();
  for (const candidate of items) {
    if (!byFullName.has(candidate.fullName)) {
      byFullName.set(candidate.fullName, candidate);
    }
  }

  const resolved: MetadataItem[] = [];
  const external: string[] = [];
  for (const name of item.dependsOn) {
    if (name === item.fullName) continue;
    const found = byFullName.get(name);
    if (found === undefined) {
      external.push(name);
    } else {
      resolved.push(found);
    }
  }

  const dependents = items.filter(
    (candidate) => candidate.id !== item.id && candidate.dependsOn.includes(item.fullName),
  );

  return { resolved, external, dependents };
}

export function findItem(
  items: readonly MetadataItem[],
  id: string,
): MetadataItem | undefined {
  return items.find((item) => item.id === id);
}

/** Highest severity present on an item, or `null` when it is clean. */
export function highestSeverity(item: MetadataItem): 'info' | 'warning' | 'error' | null {
  if (item.warnings.some((warning) => warning.severity === 'error')) return 'error';
  if (item.warnings.some((warning) => warning.severity === 'warning')) return 'warning';
  if (item.warnings.some((warning) => warning.severity === 'info')) return 'info';
  return null;
}
