/**
 * What a view is allowed to ask the controller to do.
 *
 * Views receive this and nothing else — no client, no data source. A view can
 * therefore be rendered in isolation with a stub, and cannot start its own I/O.
 */

import type { Actor, ApprovalDecisionOutcome } from '../core/types.js';
import type { SeedKind } from '../data/datasource.js';
import type { Action } from './state.js';

export interface Handlers {
  dispatch(action: Action): void;
  reload(): void;
  /** Reads the org now. Only ever called from a user gesture. */
  refreshOrg(): void;
  connectOrg(loginUrl: string, clientId: string): void;
  disconnectOrg(): void;
  /** Re-requests the host permission Chrome is currently withholding. */
  grantOrgPermission(): void;
  decide(approvalId: string, outcome: ApprovalDecisionOutcome, comment: string | null): void;
  exportSnapshot(): void;
  /**
   * Downloads exactly what is in storage, without validating it.
   *
   * Separate from {@link exportSnapshot} on purpose: the normal export
   * validates on its way out, so it fails on precisely the corrupt data this
   * is for. Offered only from the load-error state.
   */
  exportRawSnapshot(): void;
  importSnapshot(): void;
  reset(seed: SeedKind): void;
  setActor(actor: Actor): void;
}
