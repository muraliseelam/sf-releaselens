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

import {
  HostPermissionRevokedError,
  OrgNotConnectedError,
  isReleaseLensError,
} from '../core/errors.js';
import type { OrgSession } from '../auth/oauth.js';
import {
  buildDiagnostics,
  type DiagnosticEnvironment,
} from '../core/diagnostics.js';
import {
  TELEMETRY_COLLECTS,
  createNoopTransport,
  newInstallId,
  parseSettings,
  sanitiseEnvelope,
  type TelemetryEvent,
  type TelemetryInfo,
  type TelemetrySettings,
  type TelemetryTransport,
} from '../core/telemetry.js';
import type { StorageArea } from '../data/storage.js';
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
import type { Snapshot } from '../core/types.js';
import { clampDeployLimit } from '../data/salesforce.js';
import type { OrgStatus } from './messages.js';
import {
  isRequest,
  type PayloadFor,
  type Request,
  type RequestType,
  type Response,
  type SerialisedError,
} from './messages.js';

/**
 * Chrome's optional-permission surface, injected so the router is testable.
 *
 * The extension installs requesting no host permissions at all (decision 4) and
 * asks per-origin only when someone connects an org.
 */
export interface PermissionsApi {
  contains(origins: readonly string[]): Promise<boolean>;
  request(origins: readonly string[]): Promise<boolean>;
  remove(origins: readonly string[]): Promise<boolean>;
}

/** Builds the org-backed data source once a session exists. */
export type OrgDataSourceFactory = (input: {
  instanceUrl: string;
  getAccessToken: (forceRefresh?: boolean) => Promise<string>;
  orgAlias: string;
  /** How many recent deployments to read. Absent means the default. */
  deployLimit?: number;
}) => DataSource;

export interface RouterOptions {
  /** Used whenever no org is connected. Local mode is the default, always. */
  readonly dataSource: DataSource;
  readonly deps: SnapshotDeps;
  /** Absent in a local-only build; the org features then report not-connected. */
  readonly orgSession?: OrgSession;
  readonly permissions?: PermissionsApi;
  readonly orgDataSource?: OrgDataSourceFactory;
  /** Remembers the Connected App consumer key across reconnects. Not a secret. */
  readonly settingsStorage?: StorageArea;
  /**
   * Defaults applied when an imported deploy report does not say which org it
   * targeted — a deploy report carries a deploy id, not an org name.
   */
  readonly deployImportDefaults: Omit<DeployReportOptions, 'actor'>;
  /** Versions the worker can see and this module cannot. */
  readonly diagnosticEnvironment: DiagnosticEnvironment;
  /**
   * The local storage area, read only to measure key sizes for a diagnostic
   * report. Separate from the data source on purpose: this must never become a
   * second read path for snapshot data.
   */
  readonly diagnosticStorage?: StorageArea;
  /**
   * Where telemetry events would go. The shipped build passes a no-op; a build
   * that passed anything else would be making a promise this project has not
   * made. Absent is treated as the no-op.
   */
  readonly telemetryTransport?: TelemetryTransport;
  /** Injected so a test can make the install id deterministic. */
  readonly cryptoImpl?: Pick<Crypto, 'getRandomValues'>;
}

export interface Router {
  handle(message: unknown): Promise<Response<unknown>>;
}

/** Where the Connected App consumer key is remembered. Never a token. */
export const ORG_SETTINGS_KEY = 'sf-releaselens.org-settings.v1';

/** Where the opt-in flag and the install id live. Documented in SECURITY.md. */
export const TELEMETRY_KEY = 'sf-releaselens.telemetry.v1';

/**
 * The local-storage keys a diagnostic report measures the size of.
 *
 * Deliberately a literal list rather than `storage.get(null)`: an enumeration
 * would pick up a key some future version writes, and a report that grows new
 * fields on its own is a report nobody can promise anything about. The session
 * area — where the refresh token lives — is absent by construction.
 */
const DIAGNOSTIC_STORAGE_KEYS = [
  'sf-releaselens.snapshot.v1',
  'sf-releaselens.org-snapshot.v1',
  'sf-releaselens.release-overlay.v1',
  ORG_SETTINGS_KEY,
  TELEMETRY_KEY,
] as const;

export function createRouter(options: RouterOptions): Router {
  const { deps } = options;
  const transport = options.telemetryTransport ?? createNoopTransport();

  /** `https://acme.my.salesforce.com/*` — the single origin we ever request. */
  function originPatternFor(instanceUrl: string): string {
    return `${new URL(instanceUrl).origin}/*`;
  }

  async function readSettings(): Promise<Record<string, unknown>> {
    const raw = await options.settingsStorage?.read(ORG_SETTINGS_KEY);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    return raw as Record<string, unknown>;
  }

  /** The remembered deploy window, or undefined for the default. */
  async function readDeployLimit(): Promise<number | undefined> {
    const value = (await readSettings())['deployLimit'];
    return typeof value === 'number' ? value : undefined;
  }

  async function writeDeployLimit(limit: number): Promise<void> {
    await options.settingsStorage?.write(ORG_SETTINGS_KEY, {
      ...(await readSettings()),
      deployLimit: limit,
    });
  }

  /** Settings are read fresh each time: consent can be withdrawn at any moment. */
  async function readTelemetrySettings(): Promise<TelemetrySettings> {
    return parseSettings(await options.settingsStorage?.read(TELEMETRY_KEY));
  }

  async function telemetryInfo(): Promise<TelemetryInfo> {
    const settings = await readTelemetrySettings();
    return {
      enabled: settings.enabled,
      // Whether an id exists, never the id. The panel has no use for it, and
      // a value the UI never sees is a value the UI cannot leak.
      hasInstallId: settings.installId !== undefined,
      destination: transport.describe,
      collects: TELEMETRY_COLLECTS,
    };
  }

  /**
   * Sends one event, or does not.
   *
   * Everything between here and the transport is refusal: off means the
   * transport is not called at all, and an envelope that cannot be rebuilt from
   * the allow-list is dropped rather than sent in whatever shape it arrived.
   */
  async function record(event: TelemetryEvent): Promise<boolean> {
    // Read fresh rather than cached: consent can be withdrawn between two
    // events, and a cached `true` would outlive it.
    const settings = await readTelemetrySettings();
    if (!settings.enabled || settings.installId === undefined) return false;

    const envelope = sanitiseEnvelope({
      installId: settings.installId,
      extensionVersion: options.diagnosticEnvironment.extensionVersion,
      event,
      at: deps.clock.now(),
    });
    if (envelope === undefined) return false;

    transport.send(envelope);
    return true;
  }

  async function readClientId(): Promise<string | undefined> {
    const raw = await options.settingsStorage?.read(ORG_SETTINGS_KEY);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
    const value = (raw as Record<string, unknown>)['clientId'];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  /**
   * The org status, including whether Chrome still grants the host permission.
   *
   * The permission is checked on every status read rather than cached: a user
   * can revoke it in chrome://extensions at any moment, and a stale "connected"
   * badge would send them to a Refresh button that cannot work.
   */
  /** The snapshot, or null when it cannot be loaded — which is itself a finding. */
  async function loadSnapshotOrNull(): Promise<Snapshot | null> {
    try {
      return await (await currentDataSource()).load();
    } catch (cause) {
      void cause;
      return null;
    }
  }

  /**
   * Which storage keys exist and roughly how big each is.
   *
   * Sizes come from re-serialising, which is an approximation of what Chrome
   * stores; it is enough to answer "is the cache enormous" without reading a
   * single value into the report.
   */
  async function measureStorage(): Promise<{ key: string; bytes: number }[]> {
    const measured: { key: string; bytes: number }[] = [];
    for (const key of DIAGNOSTIC_STORAGE_KEYS) {
      const area = key === ORG_SETTINGS_KEY ? options.settingsStorage : options.diagnosticStorage;
      if (area === undefined) continue;
      const value = await area.read(key).catch(() => undefined);
      if (value === undefined) continue;
      measured.push({ key, bytes: JSON.stringify(value).length });
    }
    return measured;
  }

  async function orgStatus(): Promise<OrgStatus> {
    const info = await options.orgSession?.info();
    const clientId = await readClientId();

    if (info === undefined || !info.connected || info.instanceUrl === undefined) {
      return {
        connected: false,
        hasHostPermission: false,
        ...(clientId === undefined ? {} : { clientId }),
      };
    }

    const hasHostPermission =
      (await options.permissions?.contains([originPatternFor(info.instanceUrl)])) ?? false;

    return {
      connected: true,
      instanceUrl: info.instanceUrl,
      hasHostPermission,
      ...(info.loginUrl === undefined ? {} : { loginUrl: info.loginUrl }),
      ...(info.organizationId === undefined ? {} : { organizationId: info.organizationId }),
      ...(info.userId === undefined ? {} : { userId: info.userId }),
      ...(info.connectedAt === undefined ? {} : { connectedAt: info.connectedAt }),
      ...(clientId === undefined ? {} : { clientId }),
    };
  }

  /**
   * The data source for the current state: org-backed when a session exists and
   * Chrome still grants the origin, local otherwise.
   *
   * Falling back to local rather than erroring is deliberate — losing the org
   * must never take the panel with it.
   */
  async function currentDataSource(): Promise<DataSource> {
    const status = await orgStatus();
    if (
      !status.connected ||
      status.instanceUrl === undefined ||
      options.orgSession === undefined ||
      options.orgDataSource === undefined
    ) {
      return options.dataSource;
    }
    if (!status.hasHostPermission) {
      throw new HostPermissionRevokedError(new URL(status.instanceUrl).origin);
    }
    const session = options.orgSession;
    const deployLimit = await readDeployLimit();
    return options.orgDataSource({
      instanceUrl: status.instanceUrl,
      getAccessToken: (forceRefresh) => session.getAccessToken(forceRefresh),
      orgAlias: new URL(status.instanceUrl).hostname.split('.')[0] ?? 'org',
      ...(deployLimit === undefined ? {} : { deployLimit }),
    });
  }

  async function dispatch(request: Request): Promise<unknown> {
    // Resolved lazily, per case. Building it up front would make `org.info`
    // check the host permission twice, and would make it *fail* when the
    // permission is revoked — which is exactly the state the panel needs to be
    // able to read in order to offer a Grant button.
    switch (request.type) {
      case 'snapshot.load':
        return (await currentDataSource()).load();

      case 'snapshot.refresh': {
        /*
         * A widened window is remembered, not per-request.
         *
         * Otherwise "load more" would be undone by the next plain Refresh, and
         * the user would watch their history shrink for no reason they could
         * see. Clamped on the way in, so a malformed message cannot ask the org
         * for an unbounded read.
         */
        if (request.deployLimit !== undefined) {
          await writeDeployLimit(clampDeployLimit(request.deployLimit));
        }
        const snapshot = await (await currentDataSource()).refresh();
        return { snapshot, org: await orgStatus() } satisfies PayloadFor<'snapshot.refresh'>;
      }

      case 'org.info':
        return orgStatus();

      case 'org.connect': {
        if (options.orgSession === undefined) {
          throw new OrgNotConnectedError('connect an org in this build');
        }
        const info = await options.orgSession.connect({
          loginUrl: request.loginUrl,
          clientId: request.clientId,
        });
        if (info.instanceUrl === undefined) {
          throw new OrgNotConnectedError('determine the org instance URL');
        }

        // The panel already obtained the grant inside the user's click —
        // `permissions.request` needs a gesture, which a worker handling a
        // message does not have. Verify rather than request, and refuse to keep
        // a session Chrome will not let us use.
        const granted =
          (await options.permissions?.contains([originPatternFor(info.instanceUrl)])) ?? false;
        if (!granted) {
          await options.orgSession.disconnect();
          throw new HostPermissionRevokedError(new URL(info.instanceUrl).origin);
        }

        await options.settingsStorage?.write(ORG_SETTINGS_KEY, { clientId: request.clientId });

        // No automatic refresh: the first read stays user-initiated.
        return {
          snapshot: await (await currentDataSource()).load(),
          org: await orgStatus(),
        } satisfies PayloadFor<'org.connect'>;
      }

      case 'org.disconnect': {
        const previous = await options.orgSession?.info();
        await options.orgSession?.disconnect();
        if (previous?.instanceUrl !== undefined) {
          // Hand the permission back too; keeping it would leave the extension
          // with access it no longer has any use for.
          await options.permissions?.remove([originPatternFor(previous.instanceUrl)]);
        }
        return {
          snapshot: await options.dataSource.load(),
          org: await orgStatus(),
        } satisfies PayloadFor<'org.disconnect'>;
      }

      case 'org.grantPermission': {
        const info = await options.orgSession?.info();
        if (info?.instanceUrl === undefined) {
          throw new OrgNotConnectedError('grant access to an org');
        }
        await options.permissions?.request([originPatternFor(info.instanceUrl)]);
        return orgStatus();
      }

      case 'snapshot.readRaw':
        return { raw: await (await currentDataSource()).readRaw() } satisfies PayloadFor<'snapshot.readRaw'>;

      /*
       * A report that is safe to paste into a public issue: counts, versions,
       * shapes and durations, built field by field in `core/diagnostics.ts`
       * rather than copied from org data. See that file for what it excludes
       * and why an allow-list is the only version of this worth shipping.
       */
      case 'diagnostics.collect': {
        const status = await orgStatus();
        return buildDiagnostics({
          now: deps.clock.now(),
          environment: options.diagnosticEnvironment,
          org: {
            connected: status.connected,
            hasHostPermission: status.hasHostPermission,
            loginUrl: status.loginUrl,
            instanceUrl: status.instanceUrl,
            connectedAt: status.connectedAt,
            hasClientId: status.clientId !== undefined,
          },
          // Deliberately the *loaded* snapshot rather than the raw stored bytes:
          // a report about a snapshot too corrupt to load is still useful, and
          // is the case where `snapshot.present: false` is the finding.
          snapshot: await loadSnapshotOrNull(),
          storage: await measureStorage(),
        }) satisfies PayloadFor<'diagnostics.collect'>;
      }

      case 'telemetry.info':
        return (await telemetryInfo()) satisfies PayloadFor<'telemetry.info'>;

      case 'telemetry.setEnabled': {
        /*
         * The id is created here and nowhere else, on the way in — and deleted
         * on the way out rather than merely left unused. A user who never
         * turns this on has no identifier anywhere, and a user who turns it off
         * and on again is a different one, so the two periods cannot be joined.
         */
        if (request.enabled) {
          const installId = newInstallId(options.cryptoImpl ?? crypto);
          await options.settingsStorage?.write(TELEMETRY_KEY, { enabled: true, installId });
          await record({ name: 'telemetry.enabled' });
        } else {
          await options.settingsStorage?.remove(TELEMETRY_KEY);
        }
        return (await telemetryInfo()) satisfies PayloadFor<'telemetry.setEnabled'>;
      }

      case 'telemetry.record':
        return { recorded: await record(request.event) } satisfies PayloadFor<'telemetry.record'>;

      case 'snapshot.export': {
        const snapshot = await (await currentDataSource()).exportSnapshot();
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
        return (await currentDataSource()).importSnapshot({ ...parsed, actor });
      }

      case 'snapshot.reset':
        return (await currentDataSource()).reset(request.seed);

      case 'actor.set':
        return (await currentDataSource()).setActor(request.actor);

      case 'approval.decide':
        return (await currentDataSource()).decide({
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
      return (await (await currentDataSource()).load()).actor;
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
  'snapshot.refresh',
  'org.info',
  'org.connect',
  'org.disconnect',
  'org.grantPermission',
  'snapshot.readRaw',
  'diagnostics.collect',
  'telemetry.info',
  'telemetry.setEnabled',
  'telemetry.record',
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
