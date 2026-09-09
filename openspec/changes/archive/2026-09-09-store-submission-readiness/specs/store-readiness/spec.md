# store-readiness

The rule this capability exists to enforce: **nothing in the submission
paperwork may describe a build that does not exist.** Every claim made to a
reviewer must be derived from the shipped artefact, not from memory.

## ADDED Requirements

### Requirement: the verifier reads the built artefact, not the source

`npm run verify:package` SHALL inspect `dist/`, and SHALL refuse to run when
`dist/` is absent or older than `src/manifest.json`, directing the reader to
`npm run build`.

It SHALL exit non-zero on any failed check and print every finding, not only the
first, so one run gives the whole list.

#### Scenario: dist is missing
- **WHEN** `dist/` does not exist
- **THEN** the command exits non-zero naming `npm run build`, and reports
  nothing else — a verdict derived from no artefact would be worse than none.

#### Scenario: dist is stale
- **WHEN** `src/manifest.json` is newer than `dist/manifest.json`
- **THEN** the command exits non-zero saying the build is stale.

### Requirement: permissions and justifications match exactly

The verifier SHALL parse the permission tables in `docs/STORE-LISTING.md` and
compare their keys against `permissions` and `optional_host_permissions` in
`dist/manifest.json`.

- A permission with no justification SHALL fail, naming the permission.
- A justification for a permission that is not requested SHALL fail, naming it —
  a stale justification tells a reviewer the extension asks for something it
  does not, which invites the question of what else is wrong.
- A justification that is present but shorter than 120 characters SHALL fail. A
  one-line justification is the documented cause of rejection; the threshold is
  arbitrary, and it is stated in the failure message as arbitrary.

#### Scenario: a permission is added without a justification
- **WHEN** the manifest requests `tabs` and `STORE-LISTING.md` has no row for it
- **THEN** verification fails naming `tabs`.

#### Scenario: a permission is removed but the justification remains
- **WHEN** `STORE-LISTING.md` justifies `scripting` and the manifest does not
  request it
- **THEN** verification fails naming `scripting` as unrequested.

### Requirement: no remotely hosted code, proved mechanically

MV3 forbids executing remotely hosted code, and the submission form asks the
developer to certify its absence. The verifier SHALL read every `.js`, `.html`
and `.css` file under `dist/` and fail on:

- a `<script src>` or `<link href>` whose target is not a relative path;
- `eval(`, `new Function(`, or a dynamic `import(` of an expression that is not
  a relative string literal;
- `chrome.scripting` usage of any kind, since this extension declares no
  `scripting` permission and its presence would mean the manifest is wrong;
- a `content_security_policy` containing `unsafe-eval`, `unsafe-inline`, or a
  remote host in `script-src`.

The check SHALL report the file and line of each hit rather than a bare verdict.

#### Scenario: a bundler inlines a CDN fallback
- **WHEN** any shipped file contains `<script src="https://…">`
- **THEN** verification fails, naming the file and line.

#### Scenario: the clean build
- **WHEN** the current `dist/` is verified
- **THEN** the remote-code check passes and the command prints the sentence the
  developer can paste into the "does your extension use remote code" field.

### Requirement: the listing metadata fits the store's limits

The verifier SHALL check, against `dist/manifest.json`:

- `manifest_version` is `3`;
- `name` is at most 45 characters and `description` at most 132;
- a 128x128 icon is declared and the file exists;
- `version` equals the `version` in `package.json`;
- no `key`, no `update_url` — both are rejected in a store upload.

#### Scenario: the description grows past the limit
- **WHEN** `description` is 140 characters
- **THEN** verification fails, reporting the length and the limit.

### Requirement: the packaged zip contains only what is shipped

When `sf-releaselens.zip` is present, the verifier SHALL list its entries and
fail on any `.map` file, any dotfile, any `node_modules` path, and on any entry
absent from `dist/`.

#### Scenario: a source map is packaged
- **WHEN** the zip contains `background/service-worker.js.map`
- **THEN** verification fails naming the entry.

### Requirement: every image size the store asks for is generated

`npm run assets` SHALL additionally produce, into `build-assets/promo/`:

- `small-tile-440x280.png` — required by the store; a listing without one is
  rejected;
- `marquee-1400x560.png` — optional, and without it the extension cannot be
  featured.

Both SHALL be generated from `scripts/icon-design.mjs` and the project's own PNG
codec, with no new dependency, so a tile cannot drift from the icon it depicts.

#### Scenario: the tiles are generated
- **WHEN** `npm run assets` completes
- **THEN** both files exist at exactly those pixel dimensions.

### Requirement: the checklist states what is not done

`docs/STORE-SUBMISSION.md` SHALL be the single pre-submission checklist, and
SHALL distinguish what a command verifies from what only a person can. Items
that are genuinely not done — a paid developer account, a published privacy
policy URL, a human working through `QA-CHECKLIST.md` against the packaged zip —
SHALL be listed as not done rather than omitted.

It SHALL state where the built output comes from, in terms a reviewer can check
against the public repository.

#### Scenario: a reader wants to know what is left
- **WHEN** a reader opens the checklist
- **THEN** every unticked item names who has to do it and why it cannot be
  automated.

### Requirement: the verifier runs in CI, not on submission day

A check that runs once, on the day it is needed, catches drift a year after it
started. `npm run check` SHALL run the verifier after the build, so a permission
added without a justification fails the same commit that added it.

The zip checks SHALL be skipped, not failed, when no zip is present, since
`npm run check` does not package.

#### Scenario: a permission is added in an ordinary commit
- **WHEN** a contributor adds a permission to `src/manifest.json` and runs
  `npm run check`
- **THEN** it fails on the missing justification, before the commit.

#### Scenario: check runs without a packaged zip
- **WHEN** `sf-releaselens.zip` is absent
- **THEN** the zip checks report as skipped and the command still exits zero.
