# Chrome Web Store submission readiness

## Why

`docs/STORE-LISTING.md` already carries the field values. What it does not carry
is any way to know they are still *true*. It is prose, written once, describing
a manifest that has changed twice since — and the single most common rejection
is a permission justification that does not match the permissions actually
requested.

The store's own requirements moved too. The **1 August 2026** policy update
tightened Limited Use ("user data collected must be strictly necessary to the
extension's disclosed single purpose") and Disclosure Requirements, which is
directly relevant because this repository added opt-in telemetry yesterday.

Submission itself needs a paid developer account and is not in scope. Being
*ready* to submit — and being able to prove it in ten seconds rather than
re-reading three documents — is.

## What changes

- **A verifier, not a document.** `npm run verify:package` inspects the built
  artefact and fails on anything that would draw a rejection. Its central check
  is the one prose cannot do: every permission and optional host permission in
  `src/manifest.json` must have a justification in `docs/STORE-LISTING.md`, and
  every justification must correspond to a permission that is actually
  requested. Drift in either direction is an error.
- **A mechanical no-remote-code proof.** MV3 forbids remotely hosted code, and
  the submission form asks the developer to certify it. The verifier reads every
  shipped file and refuses an external `<script src>`, a remote `import()`,
  `eval`, `new Function`, or a CSP that would permit any of them — so the
  certification is a check result rather than a recollection.
- **The missing image sizes.** The capture pipeline produces the five 1280x800
  screenshots and the 128x128 icon. It does not produce the **440x280 small
  promotional tile**, which the store requires, or the optional 1400x560
  marquee, without which an extension cannot be featured. Both are generated
  from the existing icon definition with the project's own PNG codec.
- **One checklist.** `docs/STORE-SUBMISSION.md` — the single thing to work
  through on submission day, including what the 2026 policy update means for
  this extension and where the built output comes from.

## Non-goals

- **No upload, and no attempt at one.** That needs the owner's paid account.
- **No new listing copy.** `STORE-LISTING.md` §1 stays as written; this change
  makes it checkable, not different.
- **No relaxing of anything to make a check pass.** If the verifier finds a real
  problem, the finding is the deliverable.

## Impact

- New: `scripts/verify-package.mjs`, `scripts/lib/store-policy.mjs`,
  `scripts/build-promo-tiles.mjs`, `docs/STORE-SUBMISSION.md`,
  `test/scripts/store-policy.test.ts`.
- Changed: `docs/STORE-LISTING.md` (§3 gains the tile sizes, §4 becomes a
  pointer at the checklist), `docs/ASSETS.md`, `package.json` scripts.
