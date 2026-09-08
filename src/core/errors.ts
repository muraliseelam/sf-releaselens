/**
 * Typed errors. Every message here is written to be shown to a human in the side
 * panel, so it names the offending record or field and says what to do next.
 */

import type { ApprovalId, ApprovalStatus } from './types.js';

/** Base class so a handler can distinguish "our fault, explainable" from a crash. */
export abstract class ReleaseLensError extends Error {
  /** Stable machine code; the UI may branch on it, logs may be grepped by it. */
  abstract readonly code: string;

  protected constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export function isReleaseLensError(value: unknown): value is ReleaseLensError {
  return value instanceof ReleaseLensError;
}

/**
 * Stored or imported JSON did not match the schema. Carries the failing path so
 * the panel can say *which* field, rather than "invalid data".
 */
export class SnapshotValidationError extends ReleaseLensError {
  override readonly code = 'SNAPSHOT_VALIDATION';

  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`Snapshot is not valid at "${path}": ${detail}`);
  }
}

/** Snapshot parsed, but was written by a different version of the extension. */
export class UnsupportedSchemaVersionError extends ReleaseLensError {
  override readonly code = 'UNSUPPORTED_SCHEMA_VERSION';

  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `Stored data uses schema version ${found}, but this build understands version ${supported}. ` +
        'Export the raw data before resetting so nothing is lost.',
    );
  }
}

/** A referenced record does not exist. */
export class RecordNotFoundError extends ReleaseLensError {
  override readonly code = 'RECORD_NOT_FOUND';

  constructor(
    readonly kind: string,
    readonly id: string,
  ) {
    super(`No ${kind} with id "${id}" exists in the current snapshot.`);
  }
}

/**
 * The approval cannot move to the requested status — almost always because it
 * was already decided, often in another open panel.
 */
export class InvalidApprovalTransitionError extends ReleaseLensError {
  override readonly code = 'INVALID_APPROVAL_TRANSITION';

  constructor(
    readonly approvalId: ApprovalId,
    readonly from: ApprovalStatus,
    readonly to: ApprovalStatus,
    decidedBy?: string,
  ) {
    super(
      `Approval "${approvalId}" is already ${from} and cannot become ${to}` +
        (decidedBy === undefined ? '.' : ` (decided by ${decidedBy}).`) +
        ' Reload the panel to see the current state.',
    );
  }
}

/**
 * The approval *could* be decided, but not by this actor. Kept distinct from
 * {@link InvalidApprovalTransitionError} so the panel never tells someone to
 * reload when the real problem is that they lack the role.
 */
export class ApprovalNotPermittedError extends ReleaseLensError {
  override readonly code = 'APPROVAL_NOT_PERMITTED';

  constructor(
    readonly approvalId: ApprovalId,
    readonly requiredRole: string,
    readonly actorName: string,
  ) {
    super(
      `${actorName} does not hold the "${requiredRole}" role required to decide approval "${approvalId}".`,
    );
  }
}

/** Rejecting without a reason is not allowed — the reason is the whole value. */
export class MissingRejectionCommentError extends ReleaseLensError {
  override readonly code = 'MISSING_REJECTION_COMMENT';

  constructor(readonly approvalId: ApprovalId) {
    super(`Rejecting approval "${approvalId}" requires a comment explaining why.`);
  }
}

/** `chrome.storage` was unreachable or threw. */
export class StorageUnavailableError extends ReleaseLensError {
  override readonly code = 'STORAGE_UNAVAILABLE';

  constructor(operation: string, cause: unknown) {
    super(`Extension storage failed during ${operation}: ${describeCause(cause)}`, { cause });
  }
}

/** The snapshot no longer fits in `chrome.storage.local`. */
export class StorageQuotaExceededError extends ReleaseLensError {
  override readonly code = 'STORAGE_QUOTA_EXCEEDED';

  constructor(readonly attemptedBytes: number) {
    super(
      `Saving ${attemptedBytes.toLocaleString()} bytes exceeded the extension storage quota. ` +
        'Export the snapshot, then remove completed releases before saving again.',
    );
  }
}

/** A message arrived that the router has no handler for. */
export class UnknownMessageError extends ReleaseLensError {
  override readonly code = 'UNKNOWN_MESSAGE';

  constructor(readonly received: string) {
    super(`The background worker received an unknown message type: "${received}".`);
  }
}

/** An import payload was not a recognised deployment report. */
export class ImportFormatError extends ReleaseLensError {
  override readonly code = 'IMPORT_FORMAT';

  constructor(detail: string) {
    super(
      `Import failed: ${detail} Nothing was changed — the existing snapshot is untouched.`,
    );
  }
}

/**
 * Chrome rejects with an `Error` most of the time, but not always. A plain
 * object stringifies to "[object Object]", which tells the reader of a panel
 * error nothing at all, so anything that is not an Error is described rather
 * than coerced.
 */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  if (typeof cause === 'number' || typeof cause === 'boolean') return String(cause);
  if (cause === null || cause === undefined) return String(cause);
  if (typeof cause === 'object') {
    try {
      return JSON.stringify(cause);
    } catch (nested) {
      // Circular or otherwise unserialisable. The original failure is what
      // matters; do not replace it with a serialisation error.
      void nested;
      return 'an object that could not be serialised';
    }
  }
  return `a value of type ${typeof cause}`;
}

// --- Org connection ----------------------------------------------------------
//
// These exist because connecting an org introduces failures the local-only
// build could not have: a network, a token with a lifetime, a permission the
// user can revoke, and a daily call budget. Each keeps the project's posture —
// refuse clearly and name the fix, rather than degrade silently.

/** No org is connected. Not an error state in the UI; local mode is normal. */
export class OrgNotConnectedError extends ReleaseLensError {
  override readonly code = 'ORG_NOT_CONNECTED';

  constructor(operation: string) {
    super(
      `Cannot ${operation}: no Salesforce org is connected. The extension works locally without one.`,
    );
  }
}

/**
 * The refresh token is gone or rejected. Deliberately terminal: we refresh once
 * and then stop, because a silent re-prompt loop is how an extension ends up
 * asking for credentials over and over with no explanation.
 */
export class OrgAuthExpiredError extends ReleaseLensError {
  override readonly code = 'ORG_AUTH_EXPIRED';

  constructor(detail: string) {
    super(
      `The Salesforce session has expired and could not be renewed: ${detail}`,
    );
  }
}

/** The user revoked the host permission for the org's origin. */
export class HostPermissionRevokedError extends ReleaseLensError {
  override readonly code = 'HOST_PERMISSION_REVOKED';

  constructor(readonly origin: string) {
    super(
      `Chrome is no longer granting this extension access to ${origin}, so the org cannot be reached.`,
    );
  }
}

/**
 * The org's daily API budget is nearly spent. We refuse rather than "try
 * anyway": the call we are about to make could be the one that breaks a
 * production integration.
 */
export class ApiLimitExhaustedError extends ReleaseLensError {
  override readonly code = 'API_LIMIT_EXHAUSTED';

  constructor(
    readonly used: number,
    readonly max: number,
  ) {
    super(
      `Refusing to refresh: this org has used ${used.toLocaleString()} of ${max.toLocaleString()} daily API calls ` +
        `(${Math.round((used / max) * 100)}%). Refreshing now risks exhausting the budget other integrations depend on.`,
    );
  }
}

/** The org was unreachable. The cached snapshot stays on screen. */
export class OrgUnreachableError extends ReleaseLensError {
  override readonly code = 'ORG_UNREACHABLE';

  constructor(detail: string) {
    super(`Could not reach the Salesforce org: ${detail}`);
  }
}

/** The org answered, but not with anything we can read. */
export class OrgResponseInvalidError extends ReleaseLensError {
  override readonly code = 'ORG_RESPONSE_INVALID';

  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`The org's response was not valid at "${path}": ${detail}`);
  }
}

/** The org rejected the request. Carries the status and Salesforce error code. */
export class OrgRequestFailedError extends ReleaseLensError {
  override readonly code = 'ORG_REQUEST_FAILED';

  constructor(
    readonly status: number,
    readonly errorCode: string,
    detail: string,
  ) {
    super(`The org rejected a request (HTTP ${status}${errorCode ? `, ${errorCode}` : ''}): ${detail}`);
  }
}
