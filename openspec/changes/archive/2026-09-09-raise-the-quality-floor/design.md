# Design

## How the gap was found

Not by intuition. `vitest --coverage --coverage.reporter=json` gives a per-file
map of unexecuted statements and branches; reading it against the source is what
turned up the two token paths and the unmeasured directory. The same read is
what rules out the alternative explanation for a low number — a branch that is
genuinely unreachable — because the line is right there.

`src/auth` being absent from the `include` list is the interesting failure. The
list was written when the extension was local-only and there was no `src/auth`,
and adding a directory to the tree does not add it to a list. Nothing failed. A
coverage configuration is a claim about what is measured, and this one had
quietly stopped being true.

## Why these tests and not others

The paths chosen all have the same shape: **a failure that could leave a
credential behind.**

- No `instance_url` in the token response. The tokens are already in hand at
  that point. If the code returned without clearing, a refresh token would sit
  in session storage belonging to a connection the user was told had failed.
- A refresh response the adopter rejects. Same, one layer along, and worse: this
  runs unattended when an access token expires mid-session.

The assertion in each case is on **storage after the throw**, not on the throw.
A test that only asserts the error type passes just as happily on a version that
leaks the token, which is precisely the class of test this increment exists to
stop writing.

The remaining additions — `describeCause` over every runtime type, a quota
failure on an unserialisable value, the narrowing helpers on malformed org
responses — are error-handling paths that run exactly when something has already
gone wrong, which is the worst moment for a second failure.

## Why mutation testing, and why only here

Coverage cannot distinguish an assertion from a visit. Mutation testing can: it
changes the code and asks whether anything notices.

Scoped to `src/core/**` and `src/data/**` because that is where the logic is —
validation, mapping, snapshot arithmetic, the transport. `src/ui/**` is
deliberately excluded: a mutant that changes a class name or a text node is
usually equivalent or uninteresting, and a score dominated by that noise is a
score nobody reads twice. `src/auth` is left out of the first run for a
different reason — its tests are new as of this change, and a baseline is worth
more than a number taken the same hour.

**Not in CI's default job.** It is minutes. A pre-commit gate that takes minutes
gets skipped, and a skipped gate is worse than an absent one because it is still
in the documentation. Manual trigger, and a document that records what the last
run found.

## The honest-number rule

The thresholds move to just under what the suite actually achieves *after* the
new tests and *after* `src/auth` is included. Not to a round number, and not to
what was there before.

The existing comment in `vitest.config.ts` claims "94.2 lines / 93.6 statements
/ 92.0 functions / 89.2 branches". The suite produces 93.5 / 92.6 / 90.9 / 89.7.
The comment is a year-old snapshot presented as current, which is the same class
of defect as a stale permission justification and is fixed the same way: by
writing what is true on the day.
