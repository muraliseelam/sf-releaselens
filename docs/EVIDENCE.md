# Adoption evidence

```bash
npm run evidence
```

Ten seconds, once a month. It appends one dated reading to `evidence/` and
rebuilds `evidence/SUMMARY.md` from the whole series.

## Why a monthly cadence, specifically

GitHub keeps clone and view traffic for **fourteen days** and no longer. Stars
and downloads are cumulative and can be read at any time, but traffic is a
rolling window: any period longer than a fortnight with no reading is
permanently unmeasured. There is no backfill and no way to recover it.

That is the whole argument for this file existing rather than a note to look at
the Insights tab someday. A monthly run leaves gaps of a fortnight or so in the
traffic series; it is imperfect and it is the best a manual process can do.

## What it collects

Everything comes from the GitHub API through the `gh` CLI, using the credential
the maintainer already has. **Nothing comes from the extension or from any
user.** This is not telemetry. The extension's own telemetry switch is opt-in,
off by default and has no endpoint to send to — see
[`../SECURITY.md`](../SECURITY.md).

| Field | Meaning |
| --- | --- |
| `stars`, `forks`, `watchers` | Cumulative, from the repository object |
| `issues`, `pullRequests` | Open and closed counts, from the search API — the repository's own `open_issues_count` counts pull requests as issues, which is a long-standing trap |
| `contributors` | A **count**. Never a list of people |
| `releases.assets[]` | Per-asset download counts, cumulative and never reset by GitHub |
| `traffic.clones`, `traffic.views` | Total and unique over the preceding 14 days. Owner-only: a non-owner token records these as unavailable |

## Reading a record

Every metric that can fail is `{ value, error }`.

```json
"contributors": { "value": 2, "error": null }
"clones":       { "value": null, "error": "HTTP 403: Must have push access" }
```

That shape is the point of the whole design. A record is read months later by
somebody who was not there when it was collected, and `0` versus "we could not
read it" are different facts. Collapsing them would turn a failed API call into
a measurement of zero adoption, permanently, in a file that looks authoritative.
`SUMMARY.md` renders the second case as **unavailable**, never as `0`.

## What it will not do

**It will not write a record it cannot stand behind.** No `gh`, an
unauthenticated `gh`, or an unreadable repository aborts the run with a non-zero
exit and touches nothing under `evidence/`. A single metric failing is different
— that is recorded as unavailable and the run continues, because a partial
reading dated today still beats no reading.

**It will not revise the past.** Records are named `YYYY-MM-DD.json` in UTC and
a second run on the same date refuses unless `--force`. The series is worth
something precisely because an earlier reading cannot be quietly adjusted.
`SUMMARY.md` is the exception: it is derived, so it is rebuilt every run and is
reproducible from the JSON.

**It will not name anybody.** Contributors are counted, stargazers and issue
authors are not read at all. A dated list of who engaged with a project is a
social graph, and this project has no use for one — public repository or not.

## When a reading is missed

Record the gap rather than papering over it. Stars, forks and downloads are
cumulative, so the next reading still captures them correctly; only traffic is
lost, and the summary's date column makes the gap visible. Do not backfill a
date with a later reading: that would be exactly the revision the append-only
rule exists to prevent.
