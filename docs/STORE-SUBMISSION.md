# Pre-submission checklist

The single thing to work through on submission day. The field values themselves
live in [`STORE-LISTING.md`](STORE-LISTING.md); this is the list of what has to
be true before any of them are pasted anywhere.

**Nothing has been submitted.** Publishing needs a Chrome Web Store developer
account with its one-time registration fee (USD 5 when last checked; the
official registration page does not state the amount), which the maintainer has
not bought. Nothing here has been through review, and the outcome of a review is
genuinely unknown until someone tries.

Requirements were re-read against the store's own documentation on
**12 September 2026**. Policy moves — see [Since you last read the
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

- [x] **Somebody has loaded the packaged zip in Chrome and worked through
      [`QA-CHECKLIST.md`](QA-CHECKLIST.md) §1–§7.** Done on 2026-10-18 for
      v0.8.4; see the last paragraph of this item. The e2e suite
      drives `dist/` directly; it has never driven the artefact that would
      actually be uploaded, and unpacking is where a packaging mistake shows up.
      What has been done (2026-09-12): the v0.8.3 release asset was screened by
      `verify:package` (45 entries, all present in `dist/`) and its extracted
      contents compared with a fresh local build — identical apart from one
      line-ending byte in `ui/panel.js`; see the reproducibility note below.
      What has been done (2026-10-17): a script unpacked the v0.8.3 release
      asset, loaded it into Playwright's Chromium 153 and worked §1–§7 and §7a
      against it. Most rows pass, marked *✅ zip* in the checklist. Two fail:
      7a.7, where focus lands on the refusal notice, fixed by
      [#3](https://github.com/muraliseelam/sf-releaselens/pull/3), and 7a.10,
      overflow at 200% zoom, fixed by
      [#1](https://github.com/muraliseelam/sf-releaselens/pull/1). Both fixes
      shipped in v0.8.4 on 2026-10-17. The same script then drove the
      v0.8.4 release asset, the one to upload now, and every row it covers
      passed, both of those included.
      2.1, the toolbar click, could not be automated. That was the first time
      the uploadable artefact had run, but a script is not a person and none of
      it went through Chrome's side-panel host.
      Done (2026-10-18): the maintainer loaded the v0.8.4 release zip into
      Google Chrome 155.0.8059.80 with *Load unpacked*. By hand they checked
      every row of §1–§7 that no automation reaches: the toolbar icon opening
      the real side panel (2.1), a clean console, the narrowest width, the OS
      theme and 200% zoom, a keyboard rejection, an approval surviving a full
      browser quit, and a real download. Those rows are marked *✅ person*.
      Every other row in §1–§7 is covered by a script against the same zip
      (*✅ zip*) or against `dist/`. The approval and the download were
      confirmed from the profile on disk as well. Still open elsewhere: the
      screen-reader rows in §7a and the org sign-in in §8.
- [ ] **The screenshots contain no real org name, username, instance URL or
      deploy id.** A script can assert 1280x800; it cannot read a screenshot.
      The five generated plates use demo data and are safe by construction — but
      if you replace plate 5 with a connected-org capture, this is on you.
      See [`ASSETS.md`](ASSETS.md). Plates and tiles were regenerated on
      2026-09-12 (`build-assets/manifest.json` `capturedAt`) from the build in
      `dist/`, whose manifest reads 0.8.3; the look at them by a person is
      still to do. Regenerated again on 2026-10-17 from a fresh clone at
      v0.8.3 plus docs-only commits, and each plate and both tiles were opened
      and read: demo or fixture data only, with no real org name, username,
      instance URL or deploy id. Plate 5 shows the connect form with its
      `3MVG9...` placeholder and `login.salesforce.com`. Have a person
      confirm before uploading.
- [x] **A privacy policy is published at a stable URL.** **Required**: the
      extension handles authentication information, which makes the privacy
      policy field mandatory rather than optional. Done on 2026-09-12:
      [`privacy.html`](privacy.html), derived from [`SECURITY.md`](../SECURITY.md)
      and [`STORE-LISTING.md`](STORE-LISTING.md) §2, is served by GitHub Pages
      from `main`, folder `/docs`, and
      <https://muraliseelam.github.io/sf-releaselens/privacy.html> returns 200.
      Re-check it after any change to that page, because the store form and a
      reviewer both open it.
- [ ] **A Chrome Web Store developer account exists and has paid the
      registration fee.** Not done. This is the actual blocker.
- [ ] **The org connection has been exercised against a real Salesforce org on
      the version being submitted.** The data layer was run on 0.5.3 against
      ten orgs through the CLI's token; redo it if the OAuth or fetch paths
      changed since. As of 2026-09-12, `src/auth/` and
      `src/data/fetchConnection.ts` are unchanged in git since v0.5.3
      (`git diff --stat v0.5.3..HEAD -- src/auth src/data/fetchConnection.ts`
      prints nothing), so that trigger has not fired. On 2026-10-17
      `npm run test:org` was tried against 0.8.3 and produced no result. The
      suite walks every CLI-connected org in one test and stops at the first
      failure, and the first org's token from `sf org display` was refused
      by the REST API even though `sf data query` against the same org
      succeeded. So one org with a stale CLI session masks all the others.
      Run it per org with `--target-org` until that is fixed. The
      extension's own sign-in window and permission prompt are a separate,
      person-only check: [`QA-CHECKLIST.md`](QA-CHECKLIST.md) §8. See
      [`LIVE-ORG-RUNBOOK.md`](LIVE-ORG-RUNBOOK.md).

## Assets to upload

```bash
npm run assets     # about 40 seconds; writes build-assets/
```

| Asset | Size | Where | Store's position |
| --- | --- | --- | --- |
| Store icon | 128x128 | `assets/icon-128.png` | **Required.** Rejected without one |
| Screenshots | 1280x800 | `build-assets/store/1-5*.png` | **Required**, at least one, at most five |
| Small promotional tile | 440x280 | `build-assets/promo/small-tile-440x280.png` | Marked *required* in the image guidelines; listings without one are ranked after those with one |
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
- **There are no runtime dependencies.** `package.json` has no
  `dependencies` field. Everything in the archive was written in this repository.
- **The shipped JavaScript is the TypeScript compiler's output of the source** at
  <https://github.com/muraliseelam/sf-releaselens>, which is public, so the
  permission justifications describe code a reviewer can read.
- **The archive is reproducible.** `scripts/package-extension.mjs` sorts entries
  and fixes timestamps, so packaging the same `dist/` twice gives byte-identical
  output — anybody can rebuild the zip and compare it to the uploaded one.
  One caveat, measured 2026-09-12: on the maintainer's Windows checkout, 10 of
  the 41 `.ts` files under `src/` still carry CRLF in the working tree
  (`git ls-files --eol src` shows `w/crlf`). They pre-date `.gitattributes` and
  Git does not rewrite files already checked out; a fresh clone shows `w/lf` for
  all 41. A multi-line template literal keeps that ending, so a local build
  differed from the CI-built v0.8.3 asset by one byte in `ui/panel.js`. Upload
  the asset CI attached to the release, or build from a checkout where
  `git ls-files --eol src` shows only `w/lf`. That held on 2026-10-17: a
  fresh Windows clone (all 41 `w/lf`) ran `npm run package` and produced a zip
  byte-identical to the v0.8.3 release asset, sha256
  `c7493095b3049603cd6c8da17432d362ca6e75102f43b54d899c8bfade834a2e`. The same
  held for v0.8.4, rebuilt from its tag: sha256
  `57893b25492108d2512a2ddc1ffd74e02685ba293617711d296299c6cab34250`, 105,200
  bytes.

`npm run verify:package` prints the wording to have ready if a reviewer asks how
the package was built; the remote-code question itself is answered by selecting
"No, I am not using remote code".

### What the remote-code check does not prove

It is a scan of built output, and a scan is not a proof. It cannot see
obfuscation and would miss `window['ev' + 'al']`. It is worth having anyway, for
a reason specific to this build: with no bundler and no dependencies, the
shipped output *is* the source, so scanning it is close to reading it — and the
realistic failure here is an accident (a CDN font link, a `new Function` in a
JSON helper), which is exactly what a scan catches. Do not quote it as more than
that.

## Since you last read the policy

The update announced on **1 July 2026** and enforced from **1 August 2026**
(<https://developer.chrome.com/blog/cws-policy-updates-2026>) changed two things
that matter to this extension. The wording quoted below is the blog post's; at
the time of writing the policy pages themselves still read "necessary" rather
than "strictly necessary".

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

0. Done on 2026-09-12: `docs/privacy.html`, `docs/index.html` and
   `docs/.nojekyll` are committed, GitHub Pages serves `main` folder `/docs`,
   and the privacy policy URL returns 200. Re-check the URL if that page
   changes.
1. `npm run check` — includes `verify:package` against a fresh build.
2. `npm run test:e2e` — the browser suite against `dist/`.
3. Fetch the release asset for the tag being submitted (`gh release download
   vX.Y.Z --pattern sf-releaselens.zip --clobber`), or `npm run package` on an
   LF checkout — produces `sf-releaselens.zip`.
4. `npm run verify:package` again — now the archive exists to be screened.
5. Load the unpacked zip in Chrome and work `QA-CHECKLIST.md` §1–§7.
6. `npm run assets` — screenshots, tiles and the walkthrough video.
7. Paste from [`STORE-LISTING.md`](STORE-LISTING.md), upload, and expect to be
   asked something nobody predicted.
