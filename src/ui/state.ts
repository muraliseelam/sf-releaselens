/**
 * All panel state and the pure reducer over it.
 *
 * The controller in `main.ts` owns exactly one mutable variable — the current
 * `ViewState` — and every change to it goes through `reduce`. That keeps the
 * interesting behaviour (which tab a click lands on, when a filter is cleared,
 * what an error replaces) testable in Node with no DOM.
 */

import { EMPTY_QUERY, type MetadataQuery } from '../core/metadata.js';
import type { DecisionResult } from '../core/snapshot.js';
import type { MetadataOperation, ReleaseId, ReleaseStatus, Snapshot } from '../core/types.js';
import type { TelemetryInfo } from '../core/telemetry.js';
import type { OrgStatus, SerialisedError } from '../background/messages.js';

export const TABS = ['dashboard', 'inspector', 'approvals'] as const;
export type Tab = (typeof TABS)[number];

/**
 * Load state is per-panel rather than global-boolean, so "never loaded" and
 * "failed to load" cannot be confused with "loaded and empty".
 */
export type LoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly snapshot: Snapshot }
  | { readonly status: 'error'; readonly error: SerialisedError };

export interface InspectorState {
  readonly query: MetadataQuery;
  readonly selectedItemId: string | null;
}

export interface ApprovalsState {
  /** The approval currently being written; its buttons are disabled while set. */
  readonly busyApprovalId: string | null;
  /** Failure of the last decision, shown next to the approval it belongs to. */
  readonly error: SerialisedError | null;
  /** Success feedback: what changed as a result of the last decision. */
  readonly lastOutcome: string | null;
  /**
   * Comment text per approval id. Held in state rather than left in the DOM so
   * that a rejected-without-comment error does not discard what was typed when
   * the panel re-renders.
   */
  readonly drafts: Readonly<Record<string, string>>;
}

/**
 * The org connection, as the panel sees it.
 *
 * `status` is what the worker reports; `busy` and `error` are this panel's view
 * of an in-flight action. A failed refresh never clears the snapshot — that is
 * the rule behind "org unreachable keeps the cache on screen" (DATASOURCE §8).
 */
export interface OrgState {
  readonly status: OrgStatus | null;
  readonly busy: 'connecting' | 'refreshing' | 'disconnecting' | null;
  readonly error: SerialisedError | null;
  /** Whether the connect form is open. */
  readonly showConnectForm: boolean;
  readonly loginUrlDraft: string;
  readonly clientIdDraft: string;
}

export const DEFAULT_LOGIN_URL = 'https://login.salesforce.com';

export interface ViewState {
  readonly tab: Tab;
  /** Absent until the worker answers; the footer renders nothing until it does. */
  readonly telemetry: TelemetryInfo | null;
  readonly org: OrgState;
  readonly load: LoadState;
  readonly dashboard: { readonly statusFilter: ReleaseStatus | 'all' };
  readonly inspector: InspectorState;
  readonly approvals: ApprovalsState;
}

export const INITIAL_STATE: ViewState = {
  tab: 'dashboard',
  telemetry: null,
  load: { status: 'idle' },
  dashboard: { statusFilter: 'all' },
  inspector: { query: EMPTY_QUERY, selectedItemId: null },
  approvals: { busyApprovalId: null, error: null, lastOutcome: null, drafts: {} },
  org: {
    status: null,
    busy: null,
    error: null,
    showConnectForm: false,
    loginUrlDraft: DEFAULT_LOGIN_URL,
    clientIdDraft: '',
  },
};

export type Action =
  | { readonly type: 'load/started' }
  | { readonly type: 'load/succeeded'; readonly snapshot: Snapshot }
  | { readonly type: 'load/failed'; readonly error: SerialisedError }
  | { readonly type: 'tab/selected'; readonly tab: Tab }
  | { readonly type: 'dashboard/statusFiltered'; readonly status: ReleaseStatus | 'all' }
  | { readonly type: 'dashboard/releaseOpened'; readonly releaseId: ReleaseId }
  | { readonly type: 'inspector/textChanged'; readonly text: string }
  | { readonly type: 'inspector/typeToggled'; readonly value: string }
  | { readonly type: 'inspector/operationToggled'; readonly value: MetadataOperation }
  | { readonly type: 'inspector/warningsToggled' }
  | { readonly type: 'inspector/releaseFiltered'; readonly releaseId: ReleaseId | null }
  | { readonly type: 'inspector/itemSelected'; readonly itemId: string | null }
  | { readonly type: 'inspector/filtersCleared' }
  | {
      readonly type: 'approvals/commentChanged';
      readonly approvalId: string;
      readonly comment: string;
    }
  | { readonly type: 'approvals/decisionStarted'; readonly approvalId: string }
  | { readonly type: 'approvals/decisionSucceeded'; readonly result: DecisionResult }
  | { readonly type: 'approvals/decisionFailed'; readonly error: SerialisedError }
  | { readonly type: 'approvals/feedbackDismissed' }
  | { readonly type: 'org/statusLoaded'; readonly status: OrgStatus }
  | { readonly type: 'telemetry/loaded'; readonly info: TelemetryInfo }
  | { readonly type: 'org/actionStarted'; readonly action: 'connecting' | 'refreshing' | 'disconnecting' }
  | {
      readonly type: 'org/actionSucceeded';
      readonly status: OrgStatus;
      readonly snapshot: Snapshot | null;
    }
  | { readonly type: 'org/actionFailed'; readonly error: SerialisedError }
  | { readonly type: 'org/errorDismissed' }
  | { readonly type: 'org/connectFormToggled'; readonly open: boolean }
  | { readonly type: 'org/loginUrlChanged'; readonly value: string }
  | { readonly type: 'org/clientIdChanged'; readonly value: string };

export function reduce(state: ViewState, action: Action): ViewState {
  switch (action.type) {
    case 'load/started':
      // The previous snapshot is intentionally dropped: showing stale releases
      // under a spinner is how someone acts on data that no longer exists.
      return { ...state, load: { status: 'loading' } };

    case 'load/succeeded':
      return {
        ...state,
        load: { status: 'ready', snapshot: action.snapshot },
        inspector: {
          ...state.inspector,
          // Drop a selection that the new snapshot no longer contains.
          selectedItemId: action.snapshot.items.some(
            (item) => item.id === state.inspector.selectedItemId,
          )
            ? state.inspector.selectedItemId
            : null,
        },
      };

    case 'load/failed':
      return { ...state, load: { status: 'error', error: action.error } };

    case 'tab/selected':
      return { ...state, tab: action.tab };

    case 'dashboard/statusFiltered':
      return { ...state, dashboard: { statusFilter: action.status } };

    case 'dashboard/releaseOpened':
      // One click answers "what is in this release?" — switch tab and scope the
      // inspector, rather than making the user re-find the release there.
      return {
        ...state,
        tab: 'inspector',
        inspector: {
          query: { ...state.inspector.query, releaseId: action.releaseId },
          selectedItemId: null,
        },
      };

    case 'inspector/textChanged':
      return withQuery(state, { text: action.text });

    case 'inspector/typeToggled':
      return withQuery(state, { types: toggle(state.inspector.query.types, action.value) });

    case 'inspector/operationToggled':
      return withQuery(state, {
        operations: toggle(state.inspector.query.operations, action.value),
      });

    case 'inspector/warningsToggled':
      return withQuery(state, { onlyWithWarnings: !state.inspector.query.onlyWithWarnings });

    case 'inspector/releaseFiltered':
      return withQuery(state, { releaseId: action.releaseId });

    case 'inspector/itemSelected':
      return { ...state, inspector: { ...state.inspector, selectedItemId: action.itemId } };

    case 'inspector/filtersCleared':
      return { ...state, inspector: { query: EMPTY_QUERY, selectedItemId: null } };

    case 'approvals/commentChanged':
      return {
        ...state,
        approvals: {
          ...state.approvals,
          drafts: { ...state.approvals.drafts, [action.approvalId]: action.comment },
        },
      };

    case 'approvals/decisionStarted':
      return {
        ...state,
        approvals: {
          ...state.approvals,
          busyApprovalId: action.approvalId,
          error: null,
          lastOutcome: null,
        },
      };

    case 'approvals/decisionSucceeded':
      return {
        ...state,
        load: { status: 'ready', snapshot: action.result.snapshot },
        approvals: {
          busyApprovalId: null,
          error: null,
          lastOutcome: describeDecision(action.result),
          // The decision landed, so the draft it came from is spent.
          drafts: withoutKey(state.approvals.drafts, action.result.approval.id),
        },
      };

    case 'approvals/decisionFailed':
      // The draft is deliberately kept: the usual failure is "rejection needs a
      // comment", and discarding the half-written one would be perverse.
      return {
        ...state,
        approvals: { ...state.approvals, busyApprovalId: null, error: action.error, lastOutcome: null },
      };

    case 'approvals/feedbackDismissed':
      return { ...state, approvals: { ...state.approvals, error: null, lastOutcome: null } };

    case 'telemetry/loaded':
      return { ...state, telemetry: action.info };

    case 'org/statusLoaded':
      return {
        ...state,
        org: {
          ...state.org,
          status: action.status,
          clientIdDraft:
            state.org.clientIdDraft.length > 0
              ? state.org.clientIdDraft
              : (action.status.clientId ?? ''),
        },
      };

    case 'org/actionStarted':
      return { ...state, org: { ...state.org, busy: action.action, error: null } };

    case 'org/actionSucceeded':
      return {
        ...state,
        // A null snapshot means "keep what is on screen" — used by actions that
        // change only the connection, and by a refresh that failed.
        load:
          action.snapshot === null ? state.load : { status: 'ready', snapshot: action.snapshot },
        org: {
          ...state.org,
          status: action.status,
          busy: null,
          error: null,
          showConnectForm: false,
        },
      };

    case 'org/actionFailed':
      // Deliberately does NOT touch `load`. Losing the org must never blank the
      // panel: the cached snapshot stays on screen under a banner.
      return { ...state, org: { ...state.org, busy: null, error: action.error } };

    case 'org/errorDismissed':
      return { ...state, org: { ...state.org, error: null } };

    case 'org/connectFormToggled':
      return { ...state, org: { ...state.org, showConnectForm: action.open, error: null } };

    case 'org/loginUrlChanged':
      return { ...state, org: { ...state.org, loginUrlDraft: action.value } };

    case 'org/clientIdChanged':
      return { ...state, org: { ...state.org, clientIdDraft: action.value } };
  }
}

/**
 * When the org data was last refreshed, from the audit log.
 *
 * Derived rather than stored so it cannot drift from what actually happened.
 */
export function lastRefreshedAt(snapshot: Snapshot | null): string | null {
  if (snapshot === null) return null;
  for (let index = snapshot.auditLog.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.auditLog[index];
    if (entry?.action === 'snapshot.refreshed') return entry.at;
  }
  return null;
}

/** Cached org data older than this is called out as stale. */
export const STALE_AFTER_MS = 15 * 60 * 1000;

export function isStale(lastRefreshed: string | null, now: number): boolean {
  if (lastRefreshed === null) return false;
  const at = Date.parse(lastRefreshed);
  return !Number.isNaN(at) && now - at > STALE_AFTER_MS;
}

/** The snapshot when one is loaded, otherwise `null`. */
export function currentSnapshot(state: ViewState): Snapshot | null {
  return state.load.status === 'ready' ? state.load.snapshot : null;
}

/** Whether any inspector filter is narrowing the list, for the empty state. */
export function hasActiveFilters(query: MetadataQuery): boolean {
  return (
    query.text.trim().length > 0 ||
    query.types.length > 0 ||
    query.operations.length > 0 ||
    query.releaseId !== null ||
    query.onlyWithWarnings
  );
}

/**
 * Explains the consequence of a decision in one line, including the release
 * status change when there was one — the point of the approvals tab is that the
 * effect is visible where the action happened.
 */
export function describeDecision(result: DecisionResult): string {
  const base = `${result.approval.stage} on ${result.release.name} is now ${result.approval.status}.`;
  if (result.statusChange === null) {
    return `${base} The release status is unchanged.`;
  }
  return `${base} The release moved from ${result.statusChange.from} to ${result.statusChange.to}.`;
}

function withQuery(state: ViewState, patch: Partial<MetadataQuery>): ViewState {
  return {
    ...state,
    inspector: { ...state.inspector, query: { ...state.inspector.query, ...patch } },
  };
}

function withoutKey(
  drafts: Readonly<Record<string, string>>,
  key: string,
): Readonly<Record<string, string>> {
  const next = { ...drafts };
  delete next[key];
  return next;
}

function toggle<T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}
