# Tasks

- [x] 1. `scripts/lib/store-policy.mjs` — pure checks: parse the permission
      tables out of `STORE-LISTING.md`, diff against a manifest, scan text for
      remote-code patterns, check the metadata limits, screen zip entries
- [x] 2. `scripts/verify-package.mjs` — reads `dist/` and the zip, runs the
      checks, reports every finding, exits non-zero on any
- [x] 3. `test/scripts/store-policy.test.ts` — the failure cases, including a
      justification for a permission that is not requested
- [x] 4. `scripts/build-promo-tiles.mjs` — 440x280 and 1400x560 from the icon
      definition and the project's own PNG codec; wire into `npm run assets`
- [x] 5. Run the verifier against the real build; **fix whatever it finds**
- [x] 6. `docs/STORE-SUBMISSION.md` — the single checklist, including what the
      1 August 2026 policy update means for the telemetry seam
- [x] 7. `docs/STORE-LISTING.md` and `docs/ASSETS.md` updated: the tile is
      required, not recommended; §4 points at the checklist
- [x] 8. `npm run check` and `npm run test:e2e` green; commit and push
