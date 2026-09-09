# Design

## The guarantee is structural, not careful

The weakest possible version of this feature is "we are careful not to put org
data in the events". That survives exactly as long as the person who wrote it.

So the event type is a closed union whose every field is a literal or an
enumerated string:

    type TelemetryEvent =
      | { readonly name: 'view.opened'; readonly view: TelemetryView }
      | { readonly name: 'telemetry.enabled' };

There is no field of type `string` into which an org name could be placed, and
adding one is a visible diff in a file whose entire purpose is that it has none.

## Defence in depth: a runtime allow-list

Types are erased at runtime, and the risk here is a future contributor rather
than a present one. `sanitiseEnvelope` rebuilds the envelope key by key from an
allow-list before the transport is called, so an extra field added anywhere
upstream is dropped rather than forwarded. It returns `undefined` for an
unrecognised event name, which is refused rather than sent.

Rebuilding rather than filtering matters: a filter has to know what to remove,
and an allow-list only has to know what to keep.

## Lazy identifier

The install id is generated on first enablement, not at install. A user who
never opts in has no identifier anywhere — nothing to leak, nothing to
correlate, nothing to delete. Disabling deletes it, so re-enabling yields a new
one and the two periods cannot be joined.

## Transport

    interface TelemetryTransport {
      readonly describe: string;
      send(envelope: TelemetryEnvelope): void;
    }

Ships as `createNoopTransport()`, which discards. `describe` is surfaced in the
UI so the panel states — from the transport actually in use, not from a constant
— that no endpoint is configured.

There is deliberately no HTTP transport in the tree. The project's lint rule
confines `fetch` to two files and telemetry is not one of them, so "telemetry
cannot make a network call" is enforced by CI rather than asserted in a comment.

## Where the control lives

A footer row in the shell: an unchecked checkbox, a one-line statement of
exactly what would be sent, and the transport's own description of where it
would go. Placed last so it is discoverable without competing with the product,
and phrased so that leaving it off is the obvious default.

## Storage

One key, `sf-releaselens.telemetry.v1`, in `chrome.storage.local`, holding
`{ enabled: boolean, installId?: string }`. Absent means off. It joins the
documented key list in SECURITY.md and the diagnostics report's storage table,
both of which are asserted by existing tests — so adding a key that is not
documented fails the build.
