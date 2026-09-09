# Adoption evidence trail

## Why

The repository went public with v0.5.0 and is shipping releases. Nothing is
recording what happens next, and adoption that was never measured cannot be
evidenced later — GitHub's own traffic API keeps only **14 days** of clone and
view data, so any week nobody snapshots it is a week permanently lost.

This is not analytics for its own sake. It is the difference between "some
people seem to use it" and a dated series showing stars, downloads and clones
month by month.

## What changes

A script that reads what GitHub already knows about a public repository and
appends it to a dated, immutable record in the repository itself.

- `scripts/collect-evidence.mjs`, run as `npm run evidence`.
- Data comes from the `gh` CLI, which the maintainer is already authenticated
  to. No new credential, no new service.
- Each run writes one JSON file named for its date under `evidence/`, plus
  regenerates a human-readable `evidence/SUMMARY.md` from the whole series.
- `docs/EVIDENCE.md` describes the monthly process and what each field means.

## Non-goals

- **No telemetry.** Nothing is collected from users or from the extension.
  Everything here is data GitHub publishes about a public repository, read by
  its owner.
- **No backfill.** The series starts today. Traffic data older than 14 days is
  gone and this will not pretend otherwise.
- **No automation in CI.** A scheduled workflow would need a token with repo
  scope stored as a secret, for a task that takes ten seconds by hand once a
  month. Revisit if the manual step is actually forgotten.

## Impact

- New: `scripts/collect-evidence.mjs`, `evidence/`, `docs/EVIDENCE.md`.
- Changed: `package.json` gains one script; README links the evidence.
- No product code is touched. Nothing ships in the extension.
