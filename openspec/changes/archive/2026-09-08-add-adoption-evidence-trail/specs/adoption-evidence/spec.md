# Adoption evidence

## ADDED Requirements

### Requirement: Collect published repository metrics
The system SHALL collect, from the GitHub API via the authenticated `gh` CLI,
the repository's stargazer count, fork count, watcher count, open and closed
issue counts, open and closed pull request counts, contributor count, per-asset
release download counts, and clone and view traffic where the API grants them
to the repository owner.

#### Scenario: A normal collection run
- **WHEN** `npm run evidence` runs with `gh` authenticated and network available
- **THEN** the record contains every metric above
- **AND** each release asset appears with its own download count
- **AND** the record states which repository and which UTC timestamp it describes

#### Scenario: Traffic data is not granted
- **WHEN** the traffic endpoints return 403, because the token lacks the scope
  or the caller does not own the repository
- **THEN** the run still succeeds
- **AND** the traffic fields record `null` with the reason, never `0`
- **AND** the summary says traffic was unavailable rather than reporting zero

### Requirement: Refuse rather than write a misleading record
The system SHALL NOT write a record it cannot stand behind. A missing `gh`, an
unauthenticated `gh`, or a failure to read the repository SHALL abort the run
with a non-zero exit and an actionable message, leaving `evidence/` unchanged.

#### Scenario: gh is not installed
- **WHEN** `gh` cannot be executed
- **THEN** the run exits non-zero naming `gh` and how to install it
- **AND** no file under `evidence/` is created or modified

#### Scenario: gh is installed but not authenticated
- **WHEN** `gh auth status` reports no active account
- **THEN** the run exits non-zero telling the user to run `gh auth login`
- **AND** no file under `evidence/` is created or modified

#### Scenario: A metric is unavailable
- **WHEN** one metric cannot be read but the repository itself can
- **THEN** that metric is recorded as `null` with a stated reason
- **AND** the run succeeds, because a partial record dated today is worth more
  than no record at all

### Requirement: Append only, never overwrite
The system SHALL treat collected records as immutable history. Each run SHALL
write a new file keyed by its UTC date and SHALL NOT modify any earlier record.

#### Scenario: Two runs on different days
- **WHEN** the script runs on two different UTC dates
- **THEN** two files exist and the earlier one is byte-identical to what it was

#### Scenario: A second run on the same day
- **WHEN** the script runs twice on one UTC date
- **THEN** it refuses to overwrite unless `--force` is passed
- **AND** the refusal names the existing file

### Requirement: A readable series
The system SHALL regenerate a human-readable Markdown summary from the whole
series on each run, so the record is legible without parsing JSON.

#### Scenario: Summary after several runs
- **WHEN** three dated records exist
- **THEN** `evidence/SUMMARY.md` shows one row per date, oldest first
- **AND** shows the change since the previous row for each counted metric
- **AND** distinguishes "unavailable" from zero

### Requirement: Never record anything about a person
The system SHALL record only repository-level aggregates. It SHALL NOT record
usernames, email addresses, individual stargazers, issue authors, or any
per-person identifier, even where the API offers them.

#### Scenario: Contributor data
- **WHEN** contributors are counted
- **THEN** the record contains the count and no login, name or address
