# Tasks

- [x] 1. `src/auth/**` into the coverage include list; record the real numbers
- [x] 2. `test/auth/oauth.test.ts` — no `instance_url`, an unadoptable refresh
      response, a failed refresh request; each asserting **storage is empty**,
      not merely that it threw
- [x] 3. `test/core/errors.test.ts` — `describeCause` over every runtime type,
      including a circular object and a symbol
- [x] 4. `test/data/storage.test.ts` — a quota failure on a value
      `JSON.stringify` throws on
- [x] 5. `test/data/` — malformed org responses at the narrowing helpers, an
      unreadable response body, a non-`Error` cause reaching redaction
- [x] 6. `test/core/` — the remaining reachable branches worth pinning:
      `cancelled` approvals, a shown-greater-than-total window, a non-integer
      count, telemetry sanitisers against a non-object
- [x] 7. Thresholds raised to just under what is genuinely achieved; the stale
      comment replaced with today's figures
- [x] 8. Stryker against `src/core/**` and `src/data/**`; `npm run mutate`; a
      manually-triggered workflow, not the default job
- [x] 9. Run it. `docs/MUTATION.md` with the score, the date and the survivors
      that matter. Fix any test the survivors show to be asserting nothing
- [x] 10. `npm run check` and `npm run test:e2e` green; commit and push
