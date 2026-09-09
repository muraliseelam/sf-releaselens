# The first run, for somebody who has not read the documentation

## Why

Four of the ten orgs this extension has been validated against have **never had
a deploy**. So the single most likely first experience of a successful org
connection is a dashboard with nothing on it.

Here is what that dashboard says today:

> **No releases yet.**
> Import an sf deploy report or a previous export to populate the dashboard.
> `[ Import JSON… ]`

That is wrong in the one case it most needs to be right. The user has just
connected an org, granted a host permission, completed an OAuth sign-in and
pressed Refresh — and is told to import a file. It reads as though the
connection failed. The correct answer is that the connection worked and the org
has no deployment history.

The empty state does not know *why* it is empty, so it gives the same advice to
three situations that need three different answers.

The second defect is in the connect form. The one thing a new user must do
before anything works is create a Connected App, and the form points at it like
this:

> Sign in with a Connected App you create in your own org. See
> docs/CONNECTED-APP.md.

An unclickable relative path, in a side panel, in an extension the reader may
have installed from the Chrome Web Store and never seen a repository for.

## What changes

- **The empty dashboard learns why it is empty.** Three states, three answers:
  no org connected; an org connected but never read; an org read and genuinely
  without deploy history. The third says so, and does not suggest importing a
  file as though something had gone wrong.
- **Connecting an org becomes reachable from the empty state**, not only from
  the org strip above it — which is where somebody looking at "No releases yet"
  is not looking.
- **The Connected App instructions become a link** to the public repository,
  with `target="_blank"` and `rel="noreferrer"`, rather than a path.
- **Browser tests against genuinely empty storage** for each of the three
  states. The existing org test for an org with no deploy history asserts only
  that `.empty` is visible — it would pass unchanged on today's misleading
  wording, which is exactly the kind of test this project should not have.

## Non-goals

- **No onboarding tour, no modal, no carousel.** The panel is 480px wide and
  the user is at work. One sentence and the right button.
- **No change to what is seeded on a genuine first run.** Demo data stays: it is
  clearly labelled, it makes the product evaluable in one click, and "Start
  empty" is beside it.
- **No new permission and no new network call** — in particular the link is a
  plain anchor, not a fetch.

## Impact

- Changed: `src/ui/views/dashboard.ts` (the empty state), `src/ui/views/orgbar.ts`
  (the connect-form intro), `src/ui/styles.css`.
- Changed: `test/ui/views.test.ts`, `e2e/panel.spec.ts`, `e2e/org.spec.ts`.
