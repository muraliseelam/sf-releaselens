# Tasks

- [x] 1. `renderEmpty` takes the connection state and chooses between three
      messages; the connected-and-empty one names the org's own empty history
- [x] 2. A connect button in the empty state, opening the same form the org
      strip opens
- [x] 3. The connect-form intro becomes a real link to the Connected App
      instructions, `target="_blank" rel="noreferrer"`
- [x] 4. `src/ui/styles.css` for the two-option empty state
- [x] 5. `test/ui/views.test.ts` — the three messages, asserted on their words
- [x] 6. `e2e/panel.spec.ts` — the no-org empty state from genuinely empty
      storage, and connecting from it opens the form
- [x] 7. `e2e/org.spec.ts` — the existing no-deploy-history test asserts the
      sentence and the absence of the import advice
- [x] 8. `npm run check` and `npm run test:e2e` green; commit and push
