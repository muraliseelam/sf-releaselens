# Tasks

- [x] 1. `src/core/telemetry.ts` — closed event union, envelope, allow-list
      sanitiser, transport interface, no-op transport
- [x] 2. Storage key, lazy install id, enable and disable in the worker
- [x] 3. Messages: `telemetry.info`, `telemetry.setEnabled`, `telemetry.record`
- [x] 4. Panel footer control; the panel records a view-opened event when a tab
      is selected and telemetry is on
- [x] 5. Tests: default off, no id until enabled, id deleted on disable,
      allow-list holds against a payload stuffed with org data, unknown view
      refused, disabled reports not-recorded
- [x] 6. Browser test: enabling and opening all three views makes no network
      request, and the storage key list still matches what is documented
- [x] 7. README and SECURITY.md say precisely what is true
- [x] 8. `npm run check` and `npm run test:e2e` green; commit and push
