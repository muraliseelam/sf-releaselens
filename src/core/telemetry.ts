/**
 * Opt-in telemetry: off by default, with no endpoint to send anything to.
 *
 * This file exists in tension with the rest of the project, whose whole
 * security story is that no org data leaves the browser. That tension is
 * resolved structurally rather than by good intentions.
 *
 * **There is no field here that org data could go in.** `TelemetryEvent` is a
 * closed union whose every member has literal or enumerated fields only — no
 * `string`, no `unknown`, no `Record`. Adding somewhere to put a release name
 * means editing this file, in a visible diff, in a file whose entire purpose is
 * that it has nowhere to put one.
 *
 * **The runtime does not trust the types either.** `sanitiseEnvelope` rebuilds
 * the envelope key by key from an allow-list before any transport sees it.
 * Types are erased at runtime and the risk is a future contributor, not a
 * present one. Rebuilding beats filtering: a filter has to know what to remove,
 * an allow-list only has to know what to keep.
 *
 * **There is no HTTP transport in this tree.** The shipped build wires
 * `createNoopTransport`, and the project's `no-restricted-globals` rule
 * confines `fetch` to two files, neither of which is this one — so "telemetry
 * cannot make a network call" is enforced by CI rather than promised in a
 * comment.
 */

/** The three surfaces. Nothing else is a valid view. */
export const TELEMETRY_VIEWS = ['dashboard', 'inspector', 'approvals'] as const;
export type TelemetryView = (typeof TELEMETRY_VIEWS)[number];

/**
 * Every event that can exist.
 *
 * A closed union with no free-form field. This is the guarantee; everything
 * else in this file is defence in depth behind it.
 */
export type TelemetryEvent =
  | { readonly name: 'view.opened'; readonly view: TelemetryView }
  | { readonly name: 'telemetry.enabled' };

export const TELEMETRY_EVENT_NAMES = ['view.opened', 'telemetry.enabled'] as const;

/** What a transport would receive, if one existed. */
export interface TelemetryEnvelope {
  /** Random, generated on first enablement, deleted on disablement. */
  readonly installId: string;
  /** From the manifest, e.g. `0.5.3`. */
  readonly extensionVersion: string;
  readonly event: TelemetryEvent;
  readonly at: string;
}

export interface TelemetryTransport {
  /**
   * Where events would go, in words, for the panel to display.
   *
   * Read from the transport actually in use rather than from a constant, so
   * the UI cannot claim "nowhere" while something else is wired in.
   */
  readonly describe: string;
  send(envelope: TelemetryEnvelope): void;
}

/**
 * The shipped transport. It discards.
 *
 * Not a placeholder for something that will quietly become a real endpoint: an
 * endpoint needs a privacy policy, which is a decision for the project owner
 * and not for this file.
 */
export function createNoopTransport(): TelemetryTransport {
  return {
    describe: 'No endpoint is configured. Nothing is sent anywhere.',
    send() {
      // Deliberately empty. See the file comment.
    },
  };
}

/**
 * A transport that keeps what it was given, for tests only.
 *
 * Exported so a test can assert what *would* be sent; never wired into a build.
 */
export function createRecordingTransport(): TelemetryTransport & {
  readonly sent: TelemetryEnvelope[];
} {
  const sent: TelemetryEnvelope[] = [];
  return {
    describe: 'In-memory, for tests. Never wired into a build.',
    sent,
    send(envelope) {
      sent.push(envelope);
    },
  };
}

/**
 * Rebuilds an envelope from an allow-list, or refuses it.
 *
 * Every field is copied by name and coerced by type. Anything else — an extra
 * key on the envelope, an extra key on the event, an event name or view name
 * that is not in the vocabulary — is dropped or refuses the whole envelope.
 *
 * @returns the envelope to send, or `undefined` if it cannot be made safe.
 */
export function sanitiseEnvelope(candidate: unknown): TelemetryEnvelope | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const raw = candidate as Record<string, unknown>;

  const installId = asShortId(raw['installId']);
  const extensionVersion = asVersion(raw['extensionVersion']);
  const at = asTimestamp(raw['at']);
  const event = sanitiseEvent(raw['event']);

  if (installId === undefined || extensionVersion === undefined || at === undefined) {
    return undefined;
  }
  if (event === undefined) return undefined;

  // Constructed fresh, never spread from the input: a spread would carry
  // whatever else happened to be there.
  return { installId, extensionVersion, event, at };
}

/** @returns the event, or `undefined` when it is not one this build knows. */
export function sanitiseEvent(candidate: unknown): TelemetryEvent | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const raw = candidate as Record<string, unknown>;
  const name = raw['name'];

  if (name === 'telemetry.enabled') return { name: 'telemetry.enabled' };
  if (name === 'view.opened') {
    const view = raw['view'];
    return isView(view) ? { name: 'view.opened', view } : undefined;
  }
  return undefined;
}

function isView(value: unknown): value is TelemetryView {
  return typeof value === 'string' && (TELEMETRY_VIEWS as readonly string[]).includes(value);
}

/**
 * An id this build could have generated: 32 lower-case hex characters.
 *
 * Bounded and shaped, so an id field cannot be used to carry a payload — a
 * 4 KB "install id" would otherwise be a perfectly good smuggling route.
 */
function asShortId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) ? value : undefined;
}

/** `1.2.3`, and nothing else. */
function asVersion(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{1,4}(\.\d{1,4}){0,3}$/.test(value) ? value : undefined;
}

/** An ISO timestamp, re-emitted from a parsed date rather than passed through. */
function asTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/** A random install id. 128 bits of `crypto`, related to nothing. */
export function newInstallId(cryptoImpl: Pick<Crypto, 'getRandomValues'>): string {
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface TelemetrySettings {
  readonly enabled: boolean;
  readonly installId?: string;
}

/** What the panel is told. Never includes the install id. */
export interface TelemetryInfo {
  readonly enabled: boolean;
  /** Whether an id currently exists. Not the id itself. */
  readonly hasInstallId: boolean;
  /** The transport's own description of where events would go. */
  readonly destination: string;
  /** What a single event would contain, for the UI to state plainly. */
  readonly collects: readonly string[];
}

export const TELEMETRY_COLLECTS: readonly string[] = [
  'a random id created when you switch this on, and deleted when you switch it off',
  'the extension version',
  'which of the three tabs you opened',
];

/**
 * Reads stored settings without trusting them.
 *
 * Anything unrecognised means off. A corrupted value must never be read as
 * consent.
 */
export function parseSettings(raw: unknown): TelemetrySettings {
  if (typeof raw !== 'object' || raw === null) return { enabled: false };
  const record = raw as Record<string, unknown>;
  if (record['enabled'] !== true) return { enabled: false };
  const installId = asShortId(record['installId']);
  // Enabled without a usable id is treated as off: an event needs both, and
  // inventing one here would be generating an identifier nobody asked for.
  return installId === undefined ? { enabled: false } : { enabled: true, installId };
}
