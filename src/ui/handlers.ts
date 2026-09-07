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
  decide(approvalId: string, outcome: ApprovalDecisionOutcome, comment: string | null): void;
  exportSnapshot(): void;
  importSnapshot(): void;
  reset(seed: SeedKind): void;
  setActor(actor: Actor): void;
}
