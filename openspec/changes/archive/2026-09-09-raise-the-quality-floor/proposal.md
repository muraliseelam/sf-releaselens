# Raise the quality floor

## Why

774 tests and 93% coverage say the suite is large. Neither says it is good.

Two specific things are wrong, and both were found by looking rather than
assumed.

**`src/auth/` is not measured at all.** The coverage `include` list in
`vitest.config.ts` names `src/core`, `src/data`, two background files and
`src/ui` — and not `src/auth`. So the OAuth token exchange and the refresh path,
which are the riskiest code in the repository and the only code that touches a
credential, have been reported on by nobody. There *are* tests; what there is no
knowledge of is which parts they reach.

Measuring it turns up exactly the paths a reader would worry about:

- an org that returns tokens but **no `instance_url`**, where the code must
  clear the session rather than keep a half-connected one;
- a **refresh response the adopter rejects**, where the same clearing must
  happen and an expired-auth error must be raised rather than a retry loop.

Neither is exercised. Both are the failure mode that leaves a credential behind.

**Coverage cannot tell an assertion from a visit.** A test that calls a function
and asserts nothing raises the percentage exactly as much as one that pins the
behaviour. Mutation testing is the only mechanical way to tell them apart, and
this repository has never run any.

## What changes

- **`src/auth/**` joins the coverage include list.** The number moves; the
  honest number replaces the flattering one, and the thresholds are set to what
  is actually achieved rather than to what reads well.
- **Tests for the risky paths the measurement exposed**, in `src/auth`,
  `src/data` and `src/core`: the token-refresh edge cases above, a storage quota
  failure on a value that cannot even be measured, malformed org responses at
  the narrowing helpers, and the error-description branch of an OAuth denial.
- **Mutation testing with Stryker**, against `src/core/` and `src/data/` only.
  Not in `npm run check` and not in the default CI run — it is minutes, not
  seconds. A separate manually-triggered workflow, and `npm run mutate`.
- **The score reported honestly**, in a document, with the survivors that matter
  named. If it reveals a test that asserts nothing, that test gets fixed and the
  fix gets said out loud.

## Non-goals

- **No chasing the percentage.** No test whose purpose is to visit a line. If a
  branch is unreachable, the fix is to remove the branch or say why it stays.
- **No raising a threshold above what is achieved**, and no lowering one to make
  a run pass. The comment in `vitest.config.ts` currently claims numbers the
  suite no longer produces; that is a documentation bug and is fixed here.
- **No mutation testing of `src/ui/`.** The DOM views are where a mutant is most
  likely to be equivalent and least likely to be interesting, and a score
  dominated by noise is a score nobody reads.

## Impact

- Changed: `vitest.config.ts` (include list, thresholds and their stale
  comment), tests under `test/auth/`, `test/data/`, `test/core/`.
- New: `stryker.config.json`, `docs/MUTATION.md`, a manual CI workflow,
  `npm run mutate`, two dev dependencies.
