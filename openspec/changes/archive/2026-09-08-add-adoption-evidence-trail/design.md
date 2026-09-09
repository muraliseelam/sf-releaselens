# Design

## Where the data comes from

`gh api` rather than raw `curl`, for one reason: `gh` already holds the
maintainer's credential, so the script introduces no new secret and nothing has
to be stored in the repository or in CI.

| Metric | Source |
| --- | --- |
| stars, forks, watchers, open issues | `GET /repos/{owner}/{repo}` |
| open/closed issues and PRs | `GET /search/issues` counts, which separate the two |
| contributors | `GET /repos/{owner}/{repo}/contributors?per_page=100`, counted |
| release assets and downloads | `GET /repos/{owner}/{repo}/releases` |
| clones, views | `GET /repos/{owner}/{repo}/traffic/{clones,views}` — owner only |

`open_issues_count` on the repository object counts pull requests as issues,
which is a well-known trap; the search endpoint is used instead so the two are
actually separated.

## Failure posture

Two distinct failures, treated differently, matching the project's existing
"refuse clearly rather than degrade silently" rule:

- **Cannot establish the baseline at all** — no `gh`, no auth, repository
  unreadable. Abort, write nothing. A record that silently says "0 stars"
  because a command failed is worse than no record, because it will later be
  read as a measurement.
- **One metric unavailable** — traffic 403 for a non-owner, a rate limit on one
  endpoint. Record `null` plus the reason, continue. Every optional field is
  `{ value, error }` so "unavailable" is representable and distinguishable from
  zero at every layer, including the Markdown summary.

## Immutability

Filename is `evidence/YYYY-MM-DD.json` in UTC. A second run on the same date
refuses unless `--force`, because the value of the series is that a past reading
cannot be quietly revised. `SUMMARY.md` is derived and therefore regenerated
every run; it is the one file that is rewritten, and it is reproducible from the
JSON.

## Privacy

Only aggregates. Contributors are counted, never listed. This matters even for
a public repository: a dated list of who starred a project is a social graph,
and the project has no use for one.

## Testing

The collector shells out to `gh`, so the parts worth testing are the pure ones,
extracted into `scripts/lib/evidence.mjs`:

- building a record from API payloads, including the `{ value, error }` shape;
- rendering the Markdown summary from a series, including deltas and the
  "unavailable" rendering;
- refusing a same-date overwrite.

The `gh` calls themselves are exercised by running the script for real to
establish the baseline, which is part of this change.
