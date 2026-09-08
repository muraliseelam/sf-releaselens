## What this changes

<!-- One or two sentences. The commit message carries the reasoning; this is the summary. -->

## Why

<!-- The problem, not the patch. Link an issue if there is one. -->

## How it was verified

<!-- Not "tests pass" — what did you actually observe? Which surface did you open, on which
     dataset, and what did it do? If you loaded dist/ in Chrome, say so; that is the check
     CI cannot perform. -->

## Checklist

- [ ] `npm run check` passes locally (lint, icon check, build, tests).
- [ ] New behaviour has tests. Domain logic goes in `core/` with no `chrome.*` and no I/O.
- [ ] Coverage thresholds still pass. They are a ratchet — if the number rises, raise them;
      never lower them to make a run go green.
- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/). The
      release and the changelog are generated from them, so `feat:` and `fix:` are load
      bearing. Use `!` or a `BREAKING CHANGE:` footer for a breaking change.
- [ ] No secret, Consumer Key, token, org username, instance URL or deploy id is committed,
      logged, or reachable in an error message.
- [ ] TypeScript stays strict. No `any` without a comment justifying it.

## Scope

- [ ] This adds **no** write path to a Salesforce org.
- [ ] This adds **no** background poll, timer or scheduled fetch.
- [ ] This adds **no** telemetry.
- [ ] This adds **no** runtime dependency. *(A dev dependency needs a line in the commit
      message saying why it earns its place.)*

<!-- If you ticked none of the boxes above because the change is a docs typo, say so and
     delete the sections that do not apply. Reviewer time is the scarce resource. -->
