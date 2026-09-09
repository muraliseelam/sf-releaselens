# Self-review of the night's work

## Why

Five increments went in between `0.6.0` and here: an evidence trail, opt-in
telemetry, store-submission verification, a raised test floor, and a first-run
rewrite. 7,200 lines. This is the pass that re-reads all of it looking for the
four things that are easy to introduce and hard to notice:

1. anything that could leak org data;
2. a silent degradation — a check that stops checking without saying so;
3. a test that passes without asserting anything real;
4. a place where an existing guarantee was weakened to make something pass.

## What was found

**Two silent degradations, both in code written last night.**

`scanForRemoteCode` — the check that backs the MV3 "no remotely hosted code"
declaration — reads only `.js`, `.html`, `.css` and `.json`. Any other file type
in the build is skipped **and the verifier still prints `ok`**. Ship a `.mjs`
tomorrow and the store declaration becomes an unchecked claim, silently. That is
precisely the failure this project's posture exists to prevent, introduced by
the script written to prevent it.

`test/fixtures/org/no-secrets.test.ts` walks a list of source roots and crashes
with a raw `ENOENT` if one is missing, rather than saying which root and why.
The crash is the safe direction; the message is not.

**Two tests that assert less than they appear to.**

`screenZipEntries` failure cases assert only that the finding list is non-empty
— they would pass unchanged on a version that rejected every entry in the
archive. And a new salesforce test asserts only that a refresh resolved, when
what matters is that it resolved *with the release in it*.

**One accuracy gap in the security documentation.**

`SECURITY.md` says the panel makes no outbound request of any kind in local
mode. Increment 5 added an anchor to the Connected App instructions on GitHub.
A link the user clicks is not the extension making a request — but the document
claims something absolute, and the honest thing is to say the anchor is there
and what it does not do.

**No org-data leak was found**, and the search is described in `design.md` so
that "we looked" is a claim somebody can check rather than a reassurance.

## What changes

- The remote-code scan reports every shipped file it did **not** read, and
  refuses to pass while any executable-looking file is unscanned.
- The credential guard names the missing root.
- The two weak assertions become assertions.
- `SECURITY.md` states the one outbound link and what it is not.

## Non-goals

- No new features. This increment only removes ways to be wrong.
- No relaxing of anything to make the pass come out clean.
