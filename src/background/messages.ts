/**
 * The panel-to-worker protocol.
 *
 * Two rules make this seam safe:
 *
 *  1. Requests are a discriminated union and responses are keyed to the request
 *     type, so a handler that returns the wrong payload will not compile.
 *  2. Errors cross as plain data. `chrome.runtime.sendMessage` serialises with a
 *     JSON-shaped algorithm, and an `Error` arrives at the other end as `{}` —
 *     which is exactly how "something went wrong" with no detail happens.
 */

import type { DiagnosticReport } from '../core/diagnostics.js';
import type { DecisionResult } from '../core/snapshot.js';
import type { SeedKind } from '../data/datasource.js';
import type { Actor, ApprovalDecisionOutcome, Snapshot } from '../core/types.js';

export type Request =
  | { readonly type: 'snapshot.load' }
  | { readonly type: 'snapshot.refresh' }
  | { readonly type: 'org.info' }
  | { readonly type: 'org.connect'; readonly loginUrl: string; readonly clientId: string }
  | { readonly type: 'org.disconnect' }
  | { readonly type: 'org.grantPermission' }
  | { readonly type: 'snapshot.readRaw' }
  | { readonly type: 'diagnostics.collect' }
  | { readonly type: 'snapshot.export' }
  | { readonly type: 'snapshot.import'; readonly text: string }
  | { readonly type: 'snapshot.reset'; readonly seed: SeedKind }
  | { readonly type: 'actor.set'; readonly actor: Actor }
  | {
      readonly type: 'approval.decide';
      readonly approvalId: string;
      readonly outcome: ApprovalDecisionOutcome;
      readonly comment: string | null;
    };

export type RequestType = Request['type'];

export interface ExportPayload {
  readonly filename: string;
  readonly json: string;
}

/**
 * What the panel knows about the org connection.
 *
 * Re-declared here rather than imported from the auth module so the message
 * layer cannot accidentally widen to a shape that carries a token: this type has
 * no token field and never will.
 */
export interface OrgStatus {
  readonly connected: boolean;
  readonly instanceUrl?: string;
  readonly loginUrl?: string;
  readonly organizationId?: string;
  readonly userId?: string;
  readonly connectedAt?: string;
  /** Whether Chrome still grants access to the org's origin. */
  readonly hasHostPermission: boolean;
  /** Consumer key of the Connected App, remembered for reconnecting. Not secret. */
  readonly clientId?: string;
}

/** A snapshot plus the org status that produced it. */
export interface SnapshotWithStatus {
  readonly snapshot: Snapshot;
  readonly org: OrgStatus;
}

/** Response payload for each request type. */
export interface ResponsePayloads {
  'snapshot.load': Snapshot;
  'snapshot.refresh': SnapshotWithStatus;
  'org.info': OrgStatus;
  'org.connect': SnapshotWithStatus;
  'org.disconnect': SnapshotWithStatus;
  'org.grantPermission': OrgStatus;
  'snapshot.readRaw': { readonly raw: unknown };
  'diagnostics.collect': DiagnosticReport;
  'snapshot.export': ExportPayload;
  'snapshot.import': Snapshot;
  'snapshot.reset': Snapshot;
  'actor.set': Snapshot;
  'approval.decide': DecisionResult;
}

export type PayloadFor<T extends RequestType> = ResponsePayloads[T];
export type RequestFor<T extends RequestType> = Extract<Request, { type: T }>;

/** An error flattened to data that survives extension messaging. */
export interface SerialisedError {
  /** Stable code from `core/errors.ts`, or `UNEXPECTED` for anything unforeseen. */
  readonly code: string;
  readonly name: string;
  readonly message: string;
}

export type Response<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: SerialisedError };

/** Message the worker broadcasts when storage changed underneath an open panel. */
export interface SnapshotChangedEvent {
  readonly type: 'snapshot.changed';
}

export function isSnapshotChangedEvent(value: unknown): value is SnapshotChangedEvent {
  return isRecord(value) && value['type'] === 'snapshot.changed';
}

/** Narrows an untrusted message without asserting its full shape. */
export function isRequest(value: unknown): value is Request {
  return isRecord(value) && typeof value['type'] === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
