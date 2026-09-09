/**
 * Metadata inspector: search, facet, select, and see what a component is
 * connected to.
 *
 * The list is capped at {@link MAX_ROWS} rendered rows. A release payload can
 * run to thousands of components, and building thousands of DOM nodes for a
 * 400px panel is time spent on something nobody scrolls to; the cap is stated in
 * the caption rather than applied silently.
 */

import {
  highestSeverity,
  resolveDependencies,
  searchMetadata,
  type FacetCount,
} from '../../core/metadata.js';
import { findItem } from '../../core/metadata.js';
import type { MetadataItem, Snapshot } from '../../core/types.js';
import { METADATA_OPERATIONS } from '../../core/types.js';
import { el } from '../dom.js';
import {
  absoluteTime,
  coverageLabel,
  operationLabel,
  pluralise,
  relativeTime,
} from '../format.js';
import type { Handlers } from '../handlers.js';
import { hasActiveFilters, type ViewState } from '../state.js';

const MAX_ROWS = 200;
/** Facet chips beyond this are noise in a narrow panel. */
const MAX_TYPE_FACETS = 10;

export function renderInspector(
  state: ViewState,
  snapshot: Snapshot,
  handlers: Handlers,
  now: number,
): HTMLElement {
  const { query, selectedItemId } = state.inspector;
  const result = searchMetadata(snapshot.items, query);
  const selected = selectedItemId === null ? undefined : findItem(snapshot.items, selectedItemId);
  const visible = result.items.slice(0, MAX_ROWS);

  return el('section', { className: 'view', attrs: { 'aria-label': 'Metadata inspector' } }, [
    renderControls(state, snapshot, result.facets, handlers),

    el('p', { className: 'caption' }, [
      `${result.items.length} of ${result.totalBeforeFilters} components`,
      result.items.length > visible.length
        ? el('span', { className: 'caption__note', text: ` · showing the first ${MAX_ROWS}` })
        : null,
    ]),

    result.items.length === 0
      ? renderEmpty(hasActiveFilters(query), snapshot.items.length, handlers)
      : el(
          'ul',
          { className: 'list list--compact', attrs: { 'aria-label': 'Metadata components' } },
          visible.map((item) => renderItemRow(item, item.id === selectedItemId, handlers)),
        ),

    selectedItemId !== null && selected === undefined
      ? el('div', { className: 'notice notice--warn' }, [
          el('p', {
            text: 'The selected component is no longer in the snapshot. It may have been replaced by an import.',
          }),
        ])
      : null,

    selected === undefined ? null : renderDetail(selected, snapshot, handlers, now),
  ]);
}

function renderControls(
  state: ViewState,
  snapshot: Snapshot,
  facets: { readonly types: readonly FacetCount[]; readonly operations: readonly FacetCount[] },
  handlers: Handlers,
): HTMLElement {
  const { query } = state.inspector;

  const releaseSelect = el(
    'select',
    {
      className: 'select',
      attrs: { id: 'inspector-release', 'aria-label': 'Filter by release' },
      on: {
        change: (event) => {
          const value = (event.currentTarget as HTMLSelectElement).value;
          handlers.dispatch({
            type: 'inspector/releaseFiltered',
            releaseId: value === '' ? null : value,
          });
        },
      },
    },
    [
      option('', 'All releases', query.releaseId === null),
      ...snapshot.releases.map((release) =>
        option(release.id, `${release.name} (${release.version})`, query.releaseId === release.id),
      ),
    ],
  );

  return el('div', { className: 'controls' }, [
    el('input', {
      className: 'input',
      attrs: {
        id: 'inspector-search',
        type: 'search',
        placeholder: 'Search name, type, path or author',
        value: query.text,
        'aria-label': 'Search components',
      },
      on: {
        input: (event) =>
          handlers.dispatch({
            type: 'inspector/textChanged',
            text: (event.currentTarget as HTMLInputElement).value,
          }),
      },
    }),

    releaseSelect,

    el(
      'div',
      { className: 'chips', attrs: { role: 'group', 'aria-label': 'Filter by operation' } },
      METADATA_OPERATIONS.map((operation) =>
        facetChip(
          'operation',
          operation,
          operationLabel(operation),
          facets.operations.find((facet) => facet.value === operation)?.count ?? 0,
          query.operations.includes(operation),
          () =>
            handlers.dispatch({ type: 'inspector/operationToggled', value: operation }),
        ),
      ),
    ),

    el(
      'div',
      { className: 'chips', attrs: { role: 'group', 'aria-label': 'Filter by metadata type' } },
      [
        ...facets.types
          .slice(0, MAX_TYPE_FACETS)
          .map((facet) =>
            facetChip('type', facet.value, facet.value, facet.count, query.types.includes(facet.value), () =>
              handlers.dispatch({ type: 'inspector/typeToggled', value: facet.value }),
            ),
          ),
        // A selected type that has dropped out of the top facets must stay
        // visible, or its filter becomes impossible to switch off.
        ...query.types
          .filter((type) => !facets.types.slice(0, MAX_TYPE_FACETS).some((f) => f.value === type))
          .map((type) =>
            facetChip('type', type, type, 0, true, () =>
              handlers.dispatch({ type: 'inspector/typeToggled', value: type }),
            ),
          ),
      ],
    ),

    el('div', { className: 'controls__row' }, [
      el(
        'label',
        { className: 'toggle', attrs: { for: 'inspector-warnings' } },
        [
          el('input', {
            attrs: {
              id: 'inspector-warnings',
              type: 'checkbox',
              ...(query.onlyWithWarnings ? { checked: 'checked' } : {}),
            },
            on: { change: () => handlers.dispatch({ type: 'inspector/warningsToggled' }) },
          }),
          'Only components with warnings',
        ],
      ),
      hasActiveFilters(query)
        ? el('button', {
            className: 'button button--quiet',
            text: 'Clear filters',
            attrs: { id: 'inspector-clear-filters', type: 'button' },
            on: { click: () => handlers.dispatch({ type: 'inspector/filtersCleared' }) },
          })
        : null,
    ]),
  ]);
}

function renderItemRow(item: MetadataItem, selected: boolean, handlers: Handlers): HTMLElement {
  const severity = highestSeverity(item);
  return el('li', {}, [
    el(
      'button',
      {
        className: `row row--compact${selected ? ' row--selected' : ''}`,
        attrs: {
          id: `item-${item.id}`,
          type: 'button',
          'aria-pressed': String(selected),
          // The row is a toggle, and which way it will go is not visible from
          // the name alone.
          'aria-label': [
            item.fullName,
            item.type,
            operationLabel(item.operation),
            severity === null ? null : `${severity} warning`,
            selected ? 'selected, activate to close the detail' : 'activate to open the detail',
          ]
            .filter((part) => part !== null)
            .join(', '),
        },
        on: {
          click: () =>
            handlers.dispatch({
              type: 'inspector/itemSelected',
              itemId: selected ? null : item.id,
            }),
        },
      },
      [
        el('div', { className: 'row__main' }, [
          el('span', { className: 'row__title', text: item.fullName }),
          severity === null
            ? null
            : el('span', {
                className: `flag flag--${severity}`,
                text: severity === 'error' ? 'error' : severity,
                title: item.warnings.map((warning) => warning.message).join('\n'),
              }),
        ]),
        el('div', { className: 'row__meta row__meta--dim' }, [
          el('span', { className: 'type', text: item.type }),
          el('span', { className: `op op--${item.operation}`, text: operationLabel(item.operation) }),
        ]),
      ],
    ),
  ]);
}

function renderDetail(
  item: MetadataItem,
  snapshot: Snapshot,
  handlers: Handlers,
  now: number,
): HTMLElement {
  const { resolved, external, dependents, dependenciesUnavailable, uncheckedDependents } =
    resolveDependencies(snapshot.items, item);
  const edgeCount = resolved.length + external.length;
  const release = snapshot.releases.find((candidate) => candidate.id === item.releaseId);

  return el('section', { className: 'detail', attrs: { 'aria-label': 'Component detail' } }, [
    el('header', { className: 'detail__header' }, [
      el('h2', { className: 'detail__title', text: item.fullName }),
      el('button', {
        className: 'button button--quiet',
        text: 'Close',
        attrs: { id: 'detail-close', type: 'button', 'aria-label': 'Close component detail' },
        on: { click: () => handlers.dispatch({ type: 'inspector/itemSelected', itemId: null }) },
      }),
    ]),

    el('dl', { className: 'fields' }, [
      ...field('Type', item.type),
      ...field('Operation', operationLabel(item.operation)),
      ...field(
        'Release',
        release === undefined ? item.releaseId : `${release.name} (${release.version})`,
        release?.checkOnly === true
          ? 'This release was a check-only run: validated, not deployed.'
          : undefined,
      ),
      // A component that was only ever validated is not a component that is in
      // the org, and the inspector is where somebody checks exactly that.
      ...(release?.checkOnly === true
        ? field('Deployed?', 'No — check-only validation', 'Salesforce compiled and validated this package and deployed nothing.')
        : []),
      ...field('API version', item.apiVersion === '' ? 'not recorded' : item.apiVersion),
      ...field('Coverage', coverageLabel(item.testCoverage)),
      ...field('Last modified', `${item.lastModifiedBy} · ${relativeTime(item.lastModifiedAt, now)}`, absoluteTime(item.lastModifiedAt)),
      ...field('Path', item.filePath === '' ? 'not recorded' : item.filePath),
    ]),

    item.warnings.length === 0
      ? null
      : el('div', { className: 'detail__block' }, [
          el('h3', { className: 'detail__subtitle', text: 'Warnings' }),
          el(
            'ul',
            { className: 'warnings' },
            item.warnings.map((warning) =>
              el('li', { className: `warning warning--${warning.severity}` }, [
                el('span', { className: 'warning__code', text: warning.code }),
                el('span', { text: warning.message }),
              ]),
            ),
          ),
        ]),

    el('div', { className: 'detail__block' }, [
      el('h3', {
        className: 'detail__subtitle',
        // No count when the edges are unknown: "(0)" is itself an answer, and
        // the wrong one.
        text: dependenciesUnavailable ? 'Depends on' : `Depends on (${edgeCount})`,
      }),
      dependenciesUnavailable && edgeCount === 0
        ? unavailableNotice(
            'Dependency data is not available',
            'This component came from a deploy report, which lists what was deployed but ' +
              'not what depends on what. That is a gap in the source, not a finding about ' +
              'this component — it may well have dependencies. Only the demo dataset ' +
              'carries dependency edges.',
          )
        : edgeCount === 0
          ? el('p', {
              className: 'muted',
              text: 'No dependencies recorded. This component stands alone in this snapshot.',
            })
          : el('ul', { className: 'links' }, [
              ...resolved.map((dependency) => dependencyLink(dependency, 'out', handlers)),
              ...external.map((name) =>
                el('li', {}, [
                  el('span', { className: 'link link--external', text: name }),
                  el('span', {
                    className: 'muted',
                    text: ' not in this snapshot',
                    title:
                      'This component depends on something outside the tracked releases. ' +
                      'It is shown rather than hidden because that is often the risk.',
                  }),
                ]),
              ),
            ]),
    ]),

    el('div', { className: 'detail__block' }, [
      el('h3', {
        className: 'detail__subtitle',
        text:
          dependents.length === 0 && uncheckedDependents > 0
            ? 'Depended on by'
            : `Depended on by (${dependents.length})`,
      }),
      dependents.length === 0
        ? uncheckedDependents > 0
          ? unavailableNotice(
              'Dependency data is not available',
              `${countLabel(uncheckedDependents, 'component')} in this snapshot came from a ` +
                'deploy report, which records no dependency edges, so nothing can be ruled ' +
                'out. Do not read this as "safe to change".',
            )
          : el('p', { className: 'muted', text: 'Nothing in this snapshot depends on it.' })
        : el('div', {}, [
            el(
              'ul',
              { className: 'links' },
              dependents.map((dependent) => dependencyLink(dependent, 'in', handlers)),
            ),
            uncheckedDependents === 0
              ? null
              : el('p', {
                  className: 'muted detail__caveat',
                  text: `At least. ${countLabel(uncheckedDependents, 'other component')} could not be checked — no dependency data.`,
                }),
          ]),
    ]),
  ]);
}

/**
 * The "we do not know" state, deliberately styled as a notice rather than as
 * muted body text so it cannot be skimmed as the "nothing here" state.
 */
function unavailableNotice(title: string, explanation: string): HTMLElement {
  return el('div', { className: 'notice notice--warn', attrs: { role: 'note' } }, [
    el('p', { className: 'notice__title', text: title }),
    el('p', { className: 'muted', text: explanation }),
  ]);
}

function countLabel(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

function dependencyLink(
  item: MetadataItem,
  direction: 'out' | 'in',
  handlers: Handlers,
): HTMLElement {
  return el('li', {}, [
    el('button', {
      className: 'link',
      text: item.fullName,
      attrs: {
        // Two lists can name the same component — a cycle puts an item in both
        // "depends on" and "depended on by" — so the id carries the direction,
        // or the two buttons would share one id and focus restoration would
        // land on whichever came first.
        id: `dep-${direction}-${item.id}`,
        type: 'button',
        'aria-label': `${item.fullName}, ${item.type}. Show this component.`,
      },
      title: `Show ${item.fullName}`,
      on: { click: () => handlers.dispatch({ type: 'inspector/itemSelected', itemId: item.id }) },
    }),
    el('span', { className: 'muted', text: ` ${item.type}` }),
  ]);
}

function field(label: string, value: string, title?: string): HTMLElement[] {
  return [
    el('dt', { text: label }),
    el('dd', title === undefined ? { text: value } : { text: value, title }),
  ];
}

function facetChip(
  group: string,
  value: string,
  label: string,
  count: number,
  selected: boolean,
  onClick: () => void,
): HTMLElement {
  return el(
    'button',
    {
      className: `chip${selected ? ' chip--on' : ''}${count === 0 && !selected ? ' chip--zero' : ''}`,
      attrs: {
        // Stable across re-renders so focus survives toggling the chip. The
        // group prefix keeps a type named "add" distinct from the operation.
        id: `chip-${group}-${value}`,
        type: 'button',
        'aria-pressed': String(selected),
        'aria-label': `${label}: ${pluralise(count, 'component')}`,
      },
      on: { click: onClick },
    },
    [label, el('span', { className: 'chip__count', text: String(count) })],
  );
}

function option(value: string, label: string, selected: boolean): HTMLOptionElement {
  return el('option', {
    text: label,
    attrs: { value, ...(selected ? { selected: 'selected' } : {}) },
  });
}

function renderEmpty(filtered: boolean, totalItems: number, handlers: Handlers): HTMLElement {
  if (totalItems === 0) {
    return el('div', { className: 'empty' }, [
      el('p', { text: 'This snapshot has no components.' }),
      el('p', { className: 'empty__hint', text: 'Import a deploy report to inspect one.' }),
    ]);
  }
  if (filtered) {
    return el('div', { className: 'empty' }, [
      el('p', { text: 'No components match the current filters.' }),
      el('button', {
        className: 'button',
        text: 'Clear filters',
        attrs: { id: 'inspector-clear-filters-empty', type: 'button' },
        on: { click: () => handlers.dispatch({ type: 'inspector/filtersCleared' }) },
      }),
    ]);
  }
  return el('div', { className: 'empty' }, [el('p', { text: 'No components to show.' })]);
}
