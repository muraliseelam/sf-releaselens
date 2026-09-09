# Opt-in telemetry, default off, with no endpoint

## Why

The project has no idea which of its three surfaces anybody uses. That is a real
gap — but it sits directly against the security story the whole product rests
on: *no telemetry, no org data leaves the browser.*

So the goal is not "add analytics". It is to build the mechanism such that
turning it on remains defensible, and such that the claim "this sends nothing"
stays checkable by reading two files.

## What changes

- A telemetry capability that is **off unless a user turns it on**, with no
  pre-checked box, no prompt, no nag, and no "help us improve" banner.
- Events are a **closed union** carrying only: a random install id, the
  extension version, and which of the three views was opened. There is no field
  in which org data could be placed, so the guarantee is structural rather than
  a matter of care.
- A `TelemetryTransport` seam, shipped wired to a **no-op** transport. **No
  endpoint is configured and none is contacted.** A real endpoint needs a
  privacy-policy decision that is not mine to make.
- A runtime allow-list guard in front of the transport, because types vanish at
  runtime and a future contributor will not remember this file.
- A test that fails if anything org-derived can reach a transport.

## Non-goals

- **No backend, no endpoint, no network call.** Not now and not behind a flag.
- **No install id unless telemetry is on.** A user who never opts in has no
  identifier generated, stored, or written to disk.
- **No counts of anything a customer owns.** Not release counts, not component
  counts, not "org connected: yes". Those describe a customer's Salesforce
  estate, and their absence is the point of the whole design.

## Impact

- New: `src/core/telemetry.ts`, a no-op transport, one storage key, three
  messages, a footer control in the panel.
- Changed: README and SECURITY.md, which currently say the product has no
  telemetry and must now say something more precise and still true.
