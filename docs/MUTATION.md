# Mutation testing

```bash
npm run mutate
```

Stryker changes the code and asks whether any test notices. It is the only
mechanical way to tell a test that pins behaviour from a test that merely
visits a line — coverage counts both the same.

**Not in `npm run check` and not in the default CI job.** A full run took
**442 minutes** when it was first measured end to end on 13 September 2026. A
pre-commit gate that takes seven hours does not get skipped occasionally, it
gets skipped always, and a skipped gate is worse than an absent one because it
is still in the documentation. It runs on manual trigger and on the first of each month:
[`.github/workflows/mutation.yml`](../.github/workflows/mutation.yml).

## Scope, and why it is narrow

`src/core/**` and `src/data/**`, less `src/data/seed.ts`.

That is where the logic is: validation, mapping, snapshot arithmetic, approval
rules, redaction, the transport.

- **`src/ui/**` is excluded.** A mutant that changes a class name or a text node
  is usually equivalent, occasionally uninteresting, and rarely a bug. A score
  dominated by that noise is a score nobody reads twice.
- **`src/data/seed.ts` is excluded.** It is the fictional demo dataset. A mutant
  that renames a fake release or moves a fake component is not a defect anybody
  could act on — and it is 632 of this tree's 2,797 mutants, so leaving it in
  would let noise set the headline number.
- **`src/auth` is out of the first run** for a different reason: its tests were
  written on 9 September 2026, and a baseline taken the same hour would measure
  the tests against themselves.

No `break` threshold is configured. This reports; it does not gate. A mutation
score is a finding to read, not a number to defend.

## The toolchain finding, which came first

The obvious configuration — `@stryker-mutator/vitest-runner`, the official
runner — **produces a wrong answer rather than an error.**

It declares `vitest >= 2.0.0`. This project is on vitest 5. Against vitest 5 the
runner either crashes in `VitestTestRunner.init` with `Converting circular
structure to JSON`, or survives init and then reports `Ran 0.00 tests per
mutant` — scoring `validate.ts`, `salesforce.ts`, `snapshot.ts`, `releases.ts`,
`storage.ts` and `transfer.ts` at **0.00%** each, for a headline of 16.09%.

Those files have hundreds of direct, assertive tests. A 0% score on
`src/core/errors.ts` — whose tests assert exact error strings — is not a
finding about the tests; it is a runner that ran nothing and reported survival.

**This is the failure mode worth writing down.** A tool that returns a plausible
bad number is more dangerous than one that crashes: 16% would have been written
into a document, believed, and used to justify work on tests that were fine. It
was caught only because 0.00% on a file with twenty-five assertions on exact
strings is not a believable number, and the right response to an unbelievable
measurement is to distrust the instrument.

So `npm run mutate` uses Stryker's **command runner** instead: it runs the suite
as a command per mutant and reads the exit code. That costs per-test coverage
analysis — which is the entire reason a full run takes hours rather than
minutes — and it is worth it, because the number it produces is real.

## The score

### Pilot: `src/core/errors.ts`, 9 September 2026

Run first, on its own, to confirm the command runner produces a believable
number before spending an hour on the whole tree.

| | |
| --- | --- |
| Mutants | 82 |
| Killed | 71 |
| Survived | 11 |
| **Mutation score** | **86.59%** |

For comparison, the same file scored **0.00%** under the vitest runner on the
same tests, minutes earlier.

### Full run, 13 September 2026

The first complete run of `src/core` + `src/data` under the command runner.
Node v24.19.0 on win32 x64, concurrency 4, against the suite as it stood at
commit `b790dfc` (864 tests in 38 files).

| | |
| --- | --- |
| Mutants | 2,160 |
| Killed | 1,769 |
| Timed out | 12 |
| Survived | 379 |
| No coverage | 0 |
| Errors | 0 |
| **Mutation score** | **82.45%** |
| Wall clock | **442 minutes** |

A timeout counts as killed: the mutant changed behaviour enough to hang the
suite, which is a test noticing. No mutant was left uncovered and none errored,
so every one of the 2,160 got a verdict — the run is complete, not partial.

For comparison the incompatible vitest runner reported 16.09% over this same
tree. That number was never real; see the section above.

| File | Score | Killed | Timed out | Survived |
| --- | ---: | ---: | ---: | ---: |
| `core/clock.ts` | 100.00% | 10 | 0 | 0 |
| `core/releases.ts` | 98.85% | 86 | 0 | 1 |
| `core/hosts.ts` | 95.95% | 71 | 0 | 3 |
| `core/snapshot.ts` | 92.75% | 64 | 0 | 5 |
| `core/telemetry.ts` | 92.59% | 117 | 8 | 10 |
| `data/local.ts` | 91.89% | 34 | 0 | 3 |
| `core/approvals.ts` | 91.58% | 87 | 0 | 8 |
| `data/storage.ts` | 87.76% | 43 | 0 | 6 |
| `core/metadata.ts` | 87.01% | 154 | 0 | 23 |
| `core/errors.ts` | 86.59% | 71 | 0 | 11 |
| `data/transfer.ts` | 83.94% | 183 | 0 | 35 |
| `data/fetchConnection.ts` | 79.02% | 110 | 3 | 30 |
| `data/salesforce.ts` | 77.98% | 301 | 0 | 85 |
| `core/validate.ts` | 77.38% | 301 | 0 | 88 |
| `core/redact.ts` | 73.33% | 33 | 0 | 12 |
| `core/diagnostics.ts` | 66.67% | 59 | 1 | 30 |
| `core/types.ts` | 62.07% | 18 | 0 | 11 |
| `data/connection.ts` | 60.00% | 27 | 0 | 18 |

`core` scores 84.24% and `data` 79.84%.

The per-mutant detail, including every survivor with its line and its
replacement, is in the HTML report at `build-assets/mutation/index.html`. That
file is 30 MB and gitignored, so it is regenerated rather than read from here;
the survivors have **not** been triaged one by one yet.

**The number that was acted on is `core/redact.ts` at 73.33%, with 12
survivors — see [the follow-up](#what-the-redactor-survivors-turned-out-to-be)
below.**
Not because it is the lowest — `data/connection.ts` and `core/types.ts` are
lower, and both are largely type and interface declarations where a surviving
mutant is usually equivalent — but because
[`SECURITY.md`](../SECURITY.md) rests a promise on that file: that no token can
appear in a log or a serialized error. A surviving mutant there is a change to
the redactor that no test noticed, which is exactly the shape of the defect
that promise is about. Triage those twelve before any other survivor.

`core/diagnostics.ts` at 66.67% with 30 survivors is the same argument one step
weaker: it builds the bug report that is meant to be safe to attach to a public
issue. It has **not** been triaged.

### What the redactor survivors turned out to be

Re-running Stryker over `src/core/redact.ts` alone on 13 September 2026 listed
them: 45 mutants, 32 killed, **13 survived, 71.11%**. The scoped run disagrees
with the tree-wide run above by one mutant, which recorded 12 survivors and
73.33% over the same 45. The cause was not identified; both runs used the same
commit and the same command runner. Treat the difference as the measurement
noise of this setup rather than as a change in the code.

Every one of the 13 broke a **single rule while another rule covered for it**.
`redact` applies four rules in sequence — known values, the access-token shape,
the bearer shape, the OAuth-parameter shape, then the opaque run — and the tests
asserted the outcome, that the token is gone, which any one of them can deliver.
So a rule could stop working and no test would notice, and the header on the
test file claiming each layer was exercised on its own was not true.

Each mutant was checked against the real implementation to find an input that
distinguishes them, rather than reasoned about. All 13 were distinguishable, so
none was equivalent. The cases worth knowing:

- **A partial redaction leaks the rest of the value.** With the parameter rule's
  `+` reduced to a single character, `code=abcdef` redacts the first character
  and leaves `bcdef` in the text.
- **Two spaces after `Bearer` defeated the header rule**, because nothing
  exercised more than one space.
- **The access-token rule earns its place in exactly one case**: a token ending
  in `=` padding. The opaque-run rule needs a word boundary, so it stops before
  the `=` and leaves it visible; the access-token rule takes it. For every other
  input tried, the opaque-run rule covers the access-token rule completely.
- **The eight-character floor on a known secret was untested on both sides.**

Thirteen tests were added to `test/core/redact.test.ts`, each isolating one rule
with values the others cannot match: under twenty characters, or free of digits,
or ending on a character that stops the opaque run at a word boundary.

**`src/core/redact.ts` now scores 97.78%: 45 mutants, 44 killed, 1 survived.**

The one survivor is equivalent, and is left alone deliberately:

```
- export function redact(text: string, secrets: readonly (string|undefined)[] = []): string
+ export function redact(text: string, secrets: readonly (string|undefined)[] = ["Stryker was here"]): string
```

Killing it would need text containing the literal `Stryker was here`, which
tests the mutation framework rather than the product. An equivalent mutant is a
score you cannot reach, not a test you are missing.

### The monthly workflow cannot finish this run

[`.github/workflows/mutation.yml`](../.github/workflows/mutation.yml) sets
`timeout-minutes: 45`. This run took 442 minutes on a 12-thread machine at
concurrency 4. A GitHub-hosted runner is smaller, so the scheduled run on the
first of each month is cancelled at 45 minutes and has never produced a score —
which is consistent with that workflow having no completed run to date.

Three ways out, none of them free, and none chosen here:

- **Raise the timeout.** GitHub caps a job at 6 hours, which is *less* than this
  run took, so the timeout alone does not fix it.
- **Narrow the scope.** Mutating only the files whose score matters — the
  redactor, the validator, the approval rules — would fit, at the cost of no
  longer having a tree-wide number.
- **Run it locally and commit the result**, as this section does. Slowest to
  remember, cheapest to operate, and the only option that needs no CI budget.

## How to read a survivor

A surviving mutant is a change to the code that no test objected to. Three
things it can mean, in descending order of interest:

1. **A missing assertion.** A test calls the function and checks that it did not
   throw. This is the finding worth having, and the reason for running any of
   this.
2. **An equivalent mutant.** The change cannot alter observable behaviour —
   `>=` for `>` on a value that can never be equal, a default that is never
   reached. Nothing to fix; worth writing down so nobody re-investigates it.
3. **Untested by choice.** The exact wording of a diagnostic string. Real, and
   deliberately not pinned, because a test asserting every message verbatim
   makes every message change a test change.

Only the first is a defect. Reporting all three as though they were the same is
how a mutation score becomes theatre.

Most of `errors.ts`'s eleven survivors are the third kind: mutants inside
message strings, on the parts no test quotes. The ones worth a second look are
in the HTML report, which shows each survivor beside its line.

## What this does not measure

The same thing coverage does not: whether the behaviour being pinned is the
*right* behaviour. A test can assert confidently on a wrong answer, every mutant
will die, and the score will be excellent. Mutation testing raises the floor; it
does not raise the ceiling.
