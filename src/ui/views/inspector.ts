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
            facetChip(facet.value, facet.count, query.types.includes(facet.value), () =>
              handlers.dispatch({ type: 'inspector/typeToggled', value: facet.value }),
            ),
          ),
        // A selected type that has dropped out of the top facets must stay
        // visible, or its filter becomes impossible to switch off.
        ...query.types
          .filter((type) => !facets.types.slice(0, MAX_TYPE_FACETS).some((f) => f.value === type))
          .map((type) =>
            facetChip(type, 0, true, () =>
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
            attrs: { type: 'button' },
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
        attrs: { type: 'button', 'aria-pressed': String(selected) },
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
  const { resolved, external, dependents } = resolveDependencies(snapshot.items, item);
  const release = snapshot.releases.find((candidate) => candidate.id === item.releaseId);

  return el('section', { className: 'detail', attrs: { 'aria-label': 'Component detail' } }, [
    el('header', { className: 'detail__header' }, [
      el('h2', { className: 'detail__title', text: item.fullName }),
      el('button', {
        className: 'button button--quiet',
        text: 'Close',
        attrs: { type: 'button', 'aria-label': 'Close component detail' },
        on: { click: () => handlers.dispatch({ type: 'inspector/itemSelected', itemId: null }) },
      }),
    ]),

    el('dl', { className: 'fields' }, [
      ...field('Type', item.type),
      ...field('Operation', operationLabel(item.operation)),
      ...field('Release', release === undefined ? item.releaseId : `${release.name} (${release.version})`),
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
      el('h3', { className: 'detail__subtitle', text: `Depends on (${resolved.length + external.length})` }),
      resolved.length === 0 && external.length === 0
        ? el('p', { className: 'muted', text: 'No recorded dependencies.' })
        : el('ul', { className: 'links' }, [
            ...resolved.map((dependency) => dependencyLink(dependency, handlers)),
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
      el('h3', { className: 'detail__subtitle', text: `Depended on by (${dependents.length})` }),
      dependents.length === 0
        ? el('p', { className: 'muted', text: 'Nothing in this snapshot depends on it.' })
        : el(
            'ul',
            { className: 'links' },
            dependents.map((dependent) => dependencyLink(dependent, handlers)),
          ),
    ]),
  ]);
}

function dependencyLink(item: MetadataItem, handlers: Handlers): HTMLElement {
  return el('li', {}, [
    el('button', {
      className: 'link',
      text: item.fullName,
      attrs: { type: 'button' },
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
  label: string,
  count: number,
  selected: boolean,
  onClick: () => void,
): HTMLElement {
  return el(
    'button',
    {
      className: `chip${selected ? ' chip--on' : ''}${count === 0 && !selected ? ' chip--zero' : ''}`,
      attrs: { type: 'button', 'aria-pressed': String(selected) },
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
        attrs: { type: 'button' },
        on: { click: () => handlers.dispatch({ type: 'inspector/filtersCleared' }) },
      }),
    ]);
  }
  return el('div', { className: 'empty' }, [el('p', { text: 'No components to show.' })]);
}
