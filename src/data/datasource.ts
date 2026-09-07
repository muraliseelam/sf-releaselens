/**
 * The data port — and the exact seam a Salesforce-backed implementation would
 * plug into. See docs/DESIGN.md §6.
 *
 * Every method returns the *whole* resulting snapshot rather than a patch. At
 * this data size that costs nothing measurable, and it means the UI can never
 * render a half-applied mutation: it either has the new snapshot or it has an
 * error.
 */

import type { DecisionCommand, DecisionResult } from '../core/snapshot.js';
import type { Actor, Snapshot } from '../core/types.js';

export type SeedKind = 'empty' | 'demo';

export interface DataSource {
  /**
   * Reads the current snapshot, seeding demo data on genuine first run.
   *
   * @throws SnapshotValidationError / UnsupportedSchemaVersionError when stored
   *         data exists but cannot be understood. It is deliberately *not*
   *         swallowed and replaced with a fresh snapshot — see {@link readRaw}.
   */
  load(): Promise<Snapshot>;

  /**
   * Returns whatever is actually stored, unvalidated, so a corrupt snapshot can
   * be exported for rescue before the user is offered a reset.
   */
  readRaw(): Promise<unknown>;

  /** Applies one approval decision. Re-reads before writing; never last-write-wins. */
  decide(command: DecisionCommand): Promise<DecisionResult>;

  /** Replaces the whole snapshot from untrusted JSON. All-or-nothing. */
  importSnapshot(raw: unknown): Promise<Snapshot>;

  /** Same as {@link load}, named for intent at the call site. */
  exportSnapshot(): Promise<Snapshot>;

  /** Discards the current snapshot for a fresh empty or demo one. */
  reset(seed: SeedKind): Promise<Snapshot>;

  /** Changes the local profile used for approval permission checks. */
  setActor(actor: Actor): Promise<Snapshot>;
}
