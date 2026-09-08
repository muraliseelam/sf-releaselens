/**
 * The v1 DataSource: everything in one `chrome.storage` key, no network.
 *
 * The single-writer discipline lives here. Every mutation re-reads the stored
 * snapshot immediately before writing, so a decision made in a second open panel
 * loses to a typed transition error rather than to last-write-wins.
 */

import type { Clock, IdFactory } from '../core/clock.js';
import {
  applyApprovalDecision,
  appendAudit,
  withActor,
  type DecisionCommand,
  type DecisionResult,
  type SnapshotDeps,
} from '../core/snapshot.js';
import { emptySnapshot, type Actor, type Snapshot } from '../core/types.js';
import { parseSnapshot } from '../core/validate.js';
import type { DataSource, SeedKind } from './datasource.js';
import { createDemoSnapshot } from './seed.js';
import type { StorageArea } from './storage.js';

export const SNAPSHOT_STORAGE_KEY = 'sf-releaselens.snapshot.v1';

export interface LocalDataSourceOptions {
  readonly storage: StorageArea;
  readonly clock: Clock;
  readonly newId: IdFactory;
  /** Overridable so tests can seed a small fixture instead of the demo dataset. */
  readonly seedFactory?: (deps: SnapshotDeps) => Snapshot;
  readonly storageKey?: string;
}

export function createLocalDataSource(options: LocalDataSourceOptions): DataSource {
  const { storage, clock, newId } = options;
  const key = options.storageKey ?? SNAPSHOT_STORAGE_KEY;
  const deps: SnapshotDeps = { clock, newId };
  const seed = options.seedFactory ?? createDemoSnapshot;

  /**
   * Reads and validates. On genuine first run (nothing stored at all) it seeds
   * and persists demo data. It never seeds over data that exists but fails to
   * validate — that path throws, so the UI can offer a raw export first.
   */
  async function read(): Promise<Snapshot> {
    const raw = await storage.read(key);
    if (raw === undefined) {
      const seeded = seed(deps);
      await storage.write(key, seeded);
      return seeded;
    }
    return parseSnapshot(raw);
  }

  async function write(snapshot: Snapshot): Promise<Snapshot> {
    await storage.write(key, snapshot);
    return snapshot;
  }

  return {
    load: read,

    /**
     * There is nothing to refetch in local mode, so this is `load`. Keeping the
     * method rather than throwing means the panel's Refresh path needs no
     * "is this local?" branch.
     */
    refresh: read,

    readRaw() {
      return storage.read(key);
    },

    async decide(command: DecisionCommand): Promise<DecisionResult> {
      const current = await read();
      const result = applyApprovalDecision(current, command, deps);
      await write(result.snapshot);
      return result;
    },

    async importSnapshot(raw: unknown): Promise<Snapshot> {
      // Validate before touching storage: a malformed import must leave the
      // existing snapshot exactly as it was.
      const parsed = parseSnapshot(raw);
      const imported = appendAudit(
        { ...parsed, isDemoData: false },
        {
          action: 'snapshot.imported',
          detail:
            `Imported ${parsed.releases.length} release(s), ${parsed.items.length} component(s) ` +
            `and ${parsed.approvals.length} approval(s), replacing the previous snapshot`,
        },
        deps,
      );
      return write(imported);
    },

    exportSnapshot: read,

    async reset(kind: SeedKind): Promise<Snapshot> {
      const current = await readActorOrDefault();
      const fresh = kind === 'demo' ? seed(deps) : emptySnapshot(current);
      return write(
        appendAudit(
          fresh,
          { action: 'snapshot.reset', detail: `Reset to ${kind} data` },
          deps,
        ),
      );
    },

    async setActor(actor: Actor): Promise<Snapshot> {
      const current = await read();
      return write(withActor(current, actor));
    },
  };

  /**
   * Resetting must work even when the stored snapshot is the thing that is
   * broken, so this deliberately tolerates a validation failure and falls back
   * to a default profile rather than propagating the error.
   */
  async function readActorOrDefault(): Promise<Actor> {
    try {
      return (await read()).actor;
    } catch (cause) {
      void cause;
      return { name: 'Local user', roles: ['release-manager'] };
    }
  }
}
