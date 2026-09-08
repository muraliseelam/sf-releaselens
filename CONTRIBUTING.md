# Contributing

Thanks for looking. This is a small codebase with a few opinions held firmly; the rest is
open.

## Getting set up

```bash
npm install
npm run check    # lint + build + test — this is what CI runs
```

Load the extension from `dist/` via `chrome://extensions` → Developer mode → Load unpacked.
After a code change, run `npm run build` and press the reload arrow on the extension card.
Reopen the side panel to pick up a new service worker.

Node 22.13 or later. Chrome 116 or later, for the side panel API.

## Where code goes

| Layer | Rule |
| --- | --- |
| `src/core/` | Pure functions. No `chrome.*`, no I/O, no `Date.now()`, no `crypto.randomUUID()` — time and ids arrive through the `Clock` and `IdFactory` ports. |
| `src/data/` | Adapters behind the `DataSource` and `StorageArea` ports. The only place that knows about `chrome.storage`. |
| `src/background/` | Message routing. The single writer: every mutation funnels through `router.ts`. |
| `src/ui/` | DOM rendering and the view-state reducer. Views receive `Handlers` and nothing else, so a view cannot start its own I/O. `main.ts` is the only file here that touches `chrome.*`. |

If you find yourself wanting to import `chrome` into `core/`, the logic wants to move down a
layer or the port wants a new method.

## Non-negotiables

These are enforced by `eslint.config.js` and `tsconfig.json` rather than by review:

- TypeScript `strict`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- No `any` and no `@ts-expect-error` without an adjacent comment justifying it.
- No bare `catch {}`. Bind the error and either handle it or rethrow a typed error from
  `core/errors.ts`.
- Every error message names the offending record or field and says what to do next. They
  are shown to a human in a 400px panel, not just logged.
- No runtime dependencies. A new dev dependency needs a sentence in the PR explaining why
  the standard library will not do.

Two product rules that are easy to break by accident:

- **Unknown is not zero.** `testCoverage` is optional and must never be defaulted to `0`.
- **Org facts outrank opinions.** `deriveReleaseStatus` must never overwrite `in_progress`,
  `deployed`, `failed` or `rolled_back` — those describe what happened in an org.

## Tests

```bash
npm run test
npm run test:coverage   # thresholds fail the build below 85%
```

- Every exported function needs unit tests. Coverage thresholds are a floor, not a target:
  test the edge case, not the line.
- No network and no live org in tests. Substitute `MemoryStorageArea`, a fixed clock and
  a sequential id factory (`test/fixtures/snapshot.ts`), so assertions are on exact values
  rather than shapes. The panel is driven through a stub `Client`, never `chrome.runtime`.
- DOM tests opt into jsdom per file with a `@vitest-environment jsdom` docblock. jsdom is
  the only test-time dependency; the runtime dependency count stays zero.
- Keep `src/ui/main.ts` free of logic. It is the bootstrap, and everything it calls lives
  in `panel.ts` so that it can be tested without a browser.
- Build fixtures with the helpers in `test/fixtures/snapshot.ts` rather than by hand — they
  keep `exactOptionalPropertyTypes` honest about absent-versus-undefined.

If you change anything in `core/metadata.ts` or `core/validate.ts`, re-run
`node bench/bench.mjs` and update the table in the README with the numbers you actually
measured.

## The browser suite

`npm run test:e2e` launches a real Chromium with the built extension from
`dist/` loaded and drives the panel through the real service worker, real
`chrome.storage` and real message passing. It is deliberately **outside**
`npm run check`: the unit suite runs in about five seconds and is what you run
on every save, and a ninety-second suite in that loop gets skipped.

Run it before opening a pull request, and always after touching anything in
`background/`, `data/storage.ts` or the panel's message plumbing. CI runs it as
its own job, and a release cannot be cut unless it passes.

Two things to know before adding to it:

- **Console output fails a test.** Any console error, uncaught exception or
  unhandled promise rejection fails a test that otherwise passed. If you need to
  allow one, add it to `IGNORED_CONSOLE` in `e2e/fixtures.ts` *with a reason* —
  an allow-list that grows without argument is how a gate stops finding
  anything.
- **One browser per worker, storage cleared between tests.** Do not add a
  per-test browser: deleting a Chromium profile on Windows costs tens of
  seconds, and that choice is what keeps the suite at ninety seconds rather than
  seven minutes.

`npm run typecheck:e2e` type-checks the suite, which Playwright's runner does
not. It is part of `npm run check`, and it has already caught a listener that
silently did nothing.

## The org suites

Two more, both about real Salesforce data.

`npm run test:e2e:org` replays payloads captured from real orgs through the real
extension in Chrome. It needs no org access and no network — the captures are in
`test/fixtures/org/` — and CI runs it on every push.

`npm run test:org` drives the shipping code against a live org, using the `sf`
CLI's own authentication. It is **opt-in and read-only**: every call goes through
`OrgConnection`, which has no write member. With no CLI or no authenticated org
it skips with a message saying which, so a green build never depends on anybody
having an org.

```bash
npm run test:org                          # every connected org
npm run test:org -- --target-org nsorg    # one
```

**Never commit a captured payload by hand.** `scripts/capture-org-fixtures.mjs`
scrubs by allow-list — every string is replaced unless its field is Salesforce's
own vocabulary — and `test/fixtures/org/no-secrets.test.ts` re-checks the
committed result from the other direction, including that it is a fixed point of
the product's own redactor. If that test fails, re-capture; do not weaken it.

Ids are scrubbed **stably per original value**, because the captures
cross-reference each other: a deploy row's `Id` is the key used to fetch its
details. Minting a fresh id per occurrence breaks that join silently, and the
fixture then reproduces a bug that is not real.

## Commits and releases

[Conventional Commits](https://www.conventionalcommits.org/), semantic-release compatible:

```
feat: add release-level risk filter to the dashboard
fix: keep the comment draft when a rejection is refused
docs: state the approval-trail limitation in the README
```

Breaking changes take a `!` and a `BREAKING CHANGE:` footer. A change to the persisted
snapshot shape is breaking: bump `CURRENT_SCHEMA_VERSION` and say in the footer what a user
with stored data should do.

## Pull requests

Small and reviewable beats complete. In the description, say what a reviewer should look at
first and what you deliberately left out. If you hit an ambiguous product decision, open an
issue and ask rather than guessing — the answer is usually cheap and the rework is not.
