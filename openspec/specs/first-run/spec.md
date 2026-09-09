# first-run Specification

## Purpose
TBD - created by archiving change 2026-09-09-first-run-experience. Update Purpose after archive.

## Requirements

### Requirement: the empty dashboard distinguishes three situations

When the dashboard has no releases to show and no status filter is applied, it
SHALL choose its message from the connection state rather than showing one
message for every case.

- **No org connected.** The user is in local mode with nothing stored. Offer
  both routes — connect an org, or import a file — and say in one line what each
  gives.
- **An org is connected but has never been read.** Say so and point at Refresh.
  Do not suggest importing: the data is one button away.
- **An org has been read and returned no deployments.** Say that the org has no
  deployment history in the window read. Do **not** suggest importing a file,
  which reads as "the connection failed".

The third case SHALL NOT contain the word "import" in its primary sentence, and
SHALL name the org's own emptiness as the reason.

#### Scenario: a connected org with no deploy history
- **WHEN** a refresh against a connected org returns no deploy records
- **THEN** the dashboard says the org has no deployment history, offers Refresh,
  and does not tell the user to import a file to populate the dashboard.

#### Scenario: connected but not yet refreshed
- **WHEN** an org is connected and no refresh has completed
- **THEN** the dashboard says nothing has been read yet and points at Refresh.

#### Scenario: no org, no data
- **WHEN** the snapshot is empty and no org is connected
- **THEN** both connecting an org and importing a file are offered, each with a
  line saying what it gives.

### Requirement: connecting an org is reachable from where the user is looking

The empty dashboard SHALL offer the connect action directly. A user reading "no
releases" is not looking at the strip above the tab bar.

The button SHALL open the same connect form the org strip opens — one form, not
a second copy of it.

#### Scenario: connecting from the empty dashboard
- **WHEN** the user presses the connect button in the empty dashboard
- **THEN** the org connect form opens, with the same fields and the same
  defaults as when opened from the org strip.

### Requirement: the Connected App instructions are a link

The connect form SHALL link to the Connected App instructions at their public
URL, opening in a new tab with `rel="noreferrer"`. A relative repository path
is not reachable from a side panel.

#### Scenario: a user who has never seen the repository
- **WHEN** the connect form is open
- **THEN** it contains an anchor whose `href` is an absolute `https://` URL to
  the Connected App instructions, and the anchor is not a bare file path.

### Requirement: the empty states are tested against genuinely empty storage

Each of the three states SHALL be asserted in a browser test on its **words**,
not merely on the presence of a container element. A test that asserts only
that `.empty` is visible passes unchanged on wording that says the wrong thing,
which is the defect this capability exists to fix.

#### Scenario: the org-with-no-history test
- **WHEN** the browser test for an org with no deploy history runs
- **THEN** it asserts the message names the org's empty history, and asserts the
  absence of the import advice.
