# Mutation testing

```bash
npm run mutate
```

Stryker changes the code and asks whether any test notices. It is the only
mechanical way to tell a test that pins behaviour from a test that merely
visits a line — coverage counts both the same.

**Not in `npm run check` and not in the default CI job.** A full run is tens of
minutes. A pre-commit gate that takes tens of minutes gets skipped, and a
skipped gate is worse than an absent one because it is still in the
documentation. It runs on manual trigger and on the first of each month:
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
analysis — which is the entire reason a full run takes tens of minutes rather
than minutes — and it is worth it, because the number it produces is real.

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

### Full run

The full `src/core` + `src/data` figure is recorded here when a complete run
lands; see the HTML report at `build-assets/mutation/index.html` after
`npm run mutate`. Until then the honest statement is: **one file has been
measured properly, and the tree-wide number is not yet known.** The 16.09%
reported by the incompatible runner is not it, and is recorded above only as the
thing that was wrong.

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
