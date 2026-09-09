# Pre-submission checklist

The single thing to work through on submission day. The field values themselves
live in [`STORE-LISTING.md`](STORE-LISTING.md); this is the list of what has to
be true before any of them are pasted anywhere.

**Nothing has been submitted.** Publishing needs a Chrome Web Store developer
account with its one-off USD 5 registration fee, which the maintainer has not
bought. Nothing here has been through review, and the outcome of a review is
genuinely unknown until someone tries.

Requirements were re-read against the store's own documentation on
**9 September 2026**. Policy moves — see [Since you last read the
policy](#since-you-last-read-the-policy) — so re-read it rather than trusting
this file if a season has passed.

---

## What a command checks

```bash
npm run check      # includes verify:package
npm run package    # then run verify:package again, to screen the zip
```

`npm run verify:package` reads `dist/` and fails on anything that would draw a
rejection. It is in `npm run check`, so these stay true continuously rather than
being established once on submission day.

- [x] **Every permission is justified, and every justification is for a
      permission that is requested.** Both directions. The second is the one
      nobody catches by eye: a justification for a permission the extension no
      longer asks for tells a reviewer the paperwork describes a different
      extension.
- [x] **No remotely hosted code.** No `eval`, no `new Function`, no dynamic
      import of a non-relative target, no external `<script src>` or
      `<link href>`, no `chrome.scripting`, and no content security policy that
      would permit any of them. See [the limits of that
      check](#what-the-remote-code-check-does-not-prove).
- [x] **Manifest v3**, name within 45 characters, description within 132, a
      128x128 icon that exists in the build, `version` matching `package.json`,
      and no `key` or `update_url`.
- [x] **The archive contains only what was built.** No source maps, no `.d.ts`,
      no dotfiles, no `node_modules`, and no entry that is not in `dist/`.
- [x] **The build is not stale.** The verifier refuses to run if
      `src/manifest.json` is newer than `dist/manifest.json`; a verdict about a
      stale build says nothing about what would be uploaded.

## What only a person can check

- [ ] **Somebody has loaded the packaged zip in Chrome and worked through
      [`QA-CHECKLIST.md`](QA-CHECKLIST.md) §1–§7.** Not done. The e2e suite
      drives `dist/` directly; it has never driven the artefact that would
      actually be uploaded, and unpacking is where a packaging mistake shows up.
- [ ] **The screenshots contain no real org name, username, instance URL or
      deploy id.** A script can assert 1280x800; it cannot read a screenshot.
      The five generated plates use demo data and are safe by construction — but
      if you replace plate 5 with a connected-org capture, this is on you.
      See [`ASSETS.md`](ASSETS.md).
- [ ] **A privacy policy is published at a stable URL.** Not done, and
      **required**: the extension handles authentication information, which
      makes the privacy policy field mandatory rather than optional.
      [`SECURITY.md`](../SECURITY.md) is the content; it needs a URL that is not
      a file in a repository that could be renamed.
- [ ] **A Chrome Web Store developer account exists and has paid the
      registration fee.** Not done. This is the actual blocker.
- [ ] **The org connection has been exercised against a real Salesforce org on
      the version being submitted.** Done on 0.5.3 against ten orgs; redo it if
      the OAuth or fetch paths changed since. See
      [`LIVE-ORG-RUNBOOK.md`](LIVE-ORG-RUNBOOK.md).

## Assets to upload

```bash
npm run assets     # about 40 seconds; writes build-assets/
```

| Asset | Size | Where | Store's position |
| --- | --- | --- | --- |
| Store icon | 128x128 | `assets/icon-128.png` | **Required.** Rejected without one |
| Screenshots | 1280x800 | `build-assets/store/1-5*.png` | **Required**, at least one, at most five |
| Small promotional tile | 440x280 | `build-assets/promo/small-tile-440x280.png` | **Required.** A listing missing it is rejected |
| Marquee tile | 1400x560 | `build-assets/promo/marquee-1400x560.png` | Optional — but an extension without one cannot be featured |

Every one of these is generated: the screenshots by driving the real extension
in a real browser, the icon and the tiles from a single design definition using
the project's own PNG codec. Nothing is hand-composed, so no asset can depict a
state the product does not reach or an icon it does not ship.

## Where the built output comes from

The store asks, and a reviewer will look. The honest answer is short:

- **`dist/` is `tsc` plus a copy step.** `scripts/build.mjs` compiles the
  TypeScript in `src/` and copies the static files. There is no bundler, no
  minifier, no transpiler beyond `tsc`, and no code-generation step.
- **There are no runtime dependencies.** `package.json` has an empty
  `dependencies`. Everything in the archive was written in this repository.
- **The shipped JavaScript corresponds line for line to the source** at
  <https://github.com/muraliseelam/sf-releaselens>, which is public, so the
  permission justifications describe code a reviewer can read.
- **The archive is reproducible.** `scripts/package-extension.mjs` sorts entries
  and fixes timestamps, so packaging the same `dist/` twice gives byte-identical
  output — anybody can rebuild the zip and compare it to the uploaded one.

`npm run verify:package` prints the exact sentence to paste into the remote-code
declaration field, derived from the artefact rather than from memory.

### What the remote-code check does not prove

It is a scan of built output, and a scan is not a proof. It cannot see
obfuscation and would miss `window['ev' + 'al']`. It is worth having anyway, for
a reason specific to this build: with no bundler and no dependencies, the
shipped output *is* the source, so scanning it is close to reading it — and the
realistic failure here is an accident (a CDN font link, a `new Function` in a
JSON helper), which is exactly what a scan catches. Do not quote it as more than
that.

## Since you last read the policy

The **1 August 2026** update changed two things that matter to this extension.

**Limited Use** now requires that user data collected be *strictly necessary to
the extension's disclosed single purpose*. This lands on the opt-in telemetry
seam, and it is the one thing in this repository that could turn a compliant
extension into a non-compliant one:

> Wiring a real endpoint to `TelemetryTransport` would make this extension
> non-compliant with Limited Use as written, because "which of the three tabs
> you opened" is not strictly necessary to summarising deployments.

As shipped this is moot. The transport discards, no endpoint exists, and nothing
leaves the browser — so nothing is *collected* in the store's sense and the
disclosure answers in [`STORE-LISTING.md`](STORE-LISTING.md) §2 are unchanged.
The constraint is on whoever configures an endpoint, which is why it is written
here rather than in a commit message. See `src/core/telemetry.ts`.

**Disclosure Requirements** now demands proactive notification of users when
data practices change after installation. Same conclusion, same condition on the
same future endpoint.

Neither clause changes what is uploaded today.

## Order of operations

1. `npm run check` — includes `verify:package` against a fresh build.
2. `npm run test:e2e` — 50 browser tests against `dist/`.
3. `npm run package` — produces `sf-releaselens.zip`.
4. `npm run verify:package` again — now the archive exists to be screened.
5. Load the unpacked zip in Chrome and work `QA-CHECKLIST.md` §1–§7.
6. `npm run assets` — screenshots, tiles and the walkthrough video.
7. Paste from [`STORE-LISTING.md`](STORE-LISTING.md), upload, and expect to be
   asked something nobody predicted.
