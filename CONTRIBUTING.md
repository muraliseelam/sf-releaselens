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
