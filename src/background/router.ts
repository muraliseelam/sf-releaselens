/**
 * The single writer.
 *
 * Every mutation in the extension goes through `handle`. Keeping one funnel is
 * what lets `LocalDataSource` re-read before it writes and be sure nothing else
 * wrote in between.
 *
 * `handle` never throws. A thrown error is the normal way the layers below
 * report a refusal, so it is caught here, flattened, and returned as data — the
 * panel then always has either a payload or a message it can display.
 */

import { isReleaseLensError } from '../core/errors.js';
import type { SnapshotDeps } from '../core/snapshot.js';
import type { DataSource } from '../data/datasource.js';
import {
  parseImportText,
  suggestedExportFilename,
  toExportJson,
  type DeployReportOptions,
} from '../data/transfer.js';
import {
  UnknownMessageError,
} from '../core/errors.js';
import {
  isRequest,
  type PayloadFor,
  type Request,
  type RequestType,
  type Response,
  type SerialisedError,
} from './messages.js';

export interface RouterOptions {
  readonly dataSource: DataSource;
  readonly deps: SnapshotDeps;
  /**
   * Defaults applied when an imported deploy report does not say which org it
   * targeted — a deploy report carries a deploy id, not an org name.
   */
  readonly deployImportDefaults: Omit<DeployReportOptions, 'actor'>;
}

export interface Router {
  handle(message: unknown): Promise<Response<unknown>>;
}

export function createRouter(options: RouterOptions): Router {
  const { dataSource, deps } = options;

  async function dispatch(request: Request): Promise<unknown> {
    switch (request.type) {
      case 'snapshot.load':
        return dataSource.load();

      case 'snapshot.readRaw':
        return { raw: await dataSource.readRaw() } satisfies PayloadFor<'snapshot.readRaw'>;

      case 'snapshot.export': {
        const snapshot = await dataSource.exportSnapshot();
        return {
          filename: suggestedExportFilename(deps.clock.now()),
          json: toExportJson(snapshot),
        } satisfies PayloadFor<'snapshot.export'>;
      }

      case 'snapshot.import': {
        const actor = await loadActorForImport();
        const parsed = parseImportText(request.text, deps, {
          ...options.deployImportDefaults,
          actor,
        });
        // The actor is re-applied here as well as passed in, because an
        // exported snapshot carries the profile of whoever exported it and
        // `parseImportText` returns that file verbatim.
        return dataSource.importSnapshot({ ...parsed, actor });
      }

      case 'snapshot.reset':
        return dataSource.reset(request.seed);

      case 'actor.set':
        return dataSource.setActor(request.actor);

      case 'approval.decide':
        return dataSource.decide({
          approvalId: request.approvalId,
          outcome: request.outcome,
          comment: request.comment,
        });
    }
  }

  /**
   * An import replaces the snapshot, including its actor. Carrying the current
   * profile across means importing a colleague's export does not silently
   * change who you are for approval permission checks — which would change
   * which gates you appear able to decide.
   */
  async function loadActorForImport() {
    try {
      return (await dataSource.load()).actor;
    } catch (cause) {
      // A broken current snapshot must not block importing a good one.
      void cause;
      return { name: 'Local user', roles: ['release-manager'] };
    }
  }

  return {
    async handle(message: unknown): Promise<Response<unknown>> {
      try {
        if (!isRequest(message)) {
          throw new UnknownMessageError(describeMessage(message));
        }
        if (!KNOWN_TYPES.has(message.type)) {
          throw new UnknownMessageError(message.type);
        }
        return { ok: true, data: await dispatch(message) };
      } catch (cause) {
        return { ok: false, error: serialiseError(cause) };
      }
    },
  };
}

const KNOWN_TYPES = new Set<RequestType>([
  'snapshot.load',
  'snapshot.readRaw',
  'snapshot.export',
  'snapshot.import',
  'snapshot.reset',
  'actor.set',
  'approval.decide',
]);

export function serialiseError(cause: unknown): SerialisedError {
  if (isReleaseLensError(cause)) {
    return { code: cause.code, name: cause.name, message: cause.message };
  }
  if (cause instanceof Error) {
    return { code: 'UNEXPECTED', name: cause.name, message: cause.message };
  }
  return { code: 'UNEXPECTED', name: 'Error', message: String(cause) };
}

/** Enough of an untrusted message to identify it in an error, and no more. */
function describeMessage(message: unknown): string {
  if (message === null) return 'null';
  if (typeof message === 'string') return message;
  if (typeof message === 'number' || typeof message === 'boolean') return String(message);
  if (typeof message === 'object') return JSON.stringify(message).slice(0, 80);
  return `a ${typeof message}`;
}
