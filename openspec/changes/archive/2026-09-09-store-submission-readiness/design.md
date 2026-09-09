# Design

## What the current policy actually says

Checked against the store's own documentation on 9 September 2026 rather than
recalled. Three things had moved since this repository's listing doc was
written.

**The 1 August 2026 policy update.** Two clauses matter here.

*Limited Use* now requires that user data collected be **strictly necessary to
the extension's disclosed single purpose**. This lands squarely on the telemetry
added yesterday: "which of the three tabs you opened" is not strictly necessary
to summarising deployments. The resolution is not to argue the point. The
shipped transport discards, no endpoint exists, and nothing leaves the browser —
so nothing is *collected* in the store's sense, and the disclosure answer is
unchanged. What changes is the checklist: **wiring a real endpoint would make
this extension non-compliant**, not merely unpopular, and that has to be written
down where the person who wires it will read it.

*Disclosure Requirements* now demands proactive notification of users when data
practices change after installation. Same conclusion, same place: it is a
condition on a future endpoint, not on this build.

**Image sizes.** The store requires a 128x128 icon, at least one 1280x800 (or
640x400) screenshot to a maximum of five, and a **440x280 small promotional
tile**. The listing doc called the tile "optional but strongly recommended".
That is wrong: a listing missing it is rejected. The 1400x560 marquee is
genuinely optional, but an extension without one cannot be featured.

**Remote code.** Unchanged in substance — MV3 cannot load a remotely hosted file
— but the form has a dedicated declaration and the documentation is explicit
that failing to declare it is itself a rejection reason.

## Why a script rather than a longer document

The listing document has been right and then quietly wrong twice already: the
tile was described as optional, and the telemetry bullet said "no analytics of
any kind" for a day after that stopped being true. Prose about a manifest decays
the moment the manifest changes, and nothing fails when it does.

So the permission table is parsed, not read. The interesting property is the
**second** direction: a justification for a permission the extension no longer
requests. Nobody would catch that by eye, and it is worse than a missing one — a
reviewer reading a justification for `scripting` in an extension that does not
request `scripting` learns that the paperwork is not trustworthy.

## Why the checks live in a lib

`scripts/lib/store-policy.mjs` holds the pure functions — parse the permission
tables, diff them against a manifest, scan text for remote-code patterns, check
the metadata limits. `scripts/verify-package.mjs` does the file reading and the
reporting. The same split as `scripts/lib/evidence.mjs`, and for the same
reason: the interesting logic is testable in `vitest` without a `dist/`.

## The remote-code scan, and its honest limits

A regex scan of built output is not a proof. It cannot see obfuscation, and it
would not catch `window['ev'+'al']`. It is worth having anyway, for two reasons
that are worth stating rather than overclaiming:

1. The build is `tsc` plus a copy step over a first-party tree with **no runtime
   dependencies**. There is no bundler, no minifier and no vendored code, so
   shipped output is source, and a scan of it is close to a read of it.
2. The realistic failure is accident, not attack — a contributor adding a CDN
   font link, or a `new Function` in a JSON path helper. A scan catches exactly
   that class.

The checklist says this in as many words. A check described as stronger than it
is, is worse than no check.

## What is deliberately not checked

- **Screenshot content.** A script can assert 1280x800; it cannot assert that no
  real org name is visible. That stays a human item on the checklist.
- **The listing prose.** Character limits are checked against the *manifest*,
  which is what the store reads. The `STORE-LISTING.md` short description is a
  suggestion for a form field and has no artefact to check against.
- **Whether review passes.** Unknowable until someone submits, and the checklist
  says so.
