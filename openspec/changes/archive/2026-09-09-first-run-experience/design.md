# Design

## How the empty state knows which case it is in

Two facts, both already in hand where the dashboard renders:

- `state.org.status?.connected` — whether an org is connected. Already passed to
  `renderDashboard` as part of `ViewState`.
- whether a refresh has completed — the snapshot's audit log carries a
  `snapshot.refreshed` entry, which is the same signal the org strip uses for
  its "last refreshed" time.

No new state, no new message, no new storage key. The information was there; the
empty state simply never asked for it.

## Why not just soften the wording

An obvious smaller fix is to change one sentence to something that is true in
every case — "Nothing to show." That is worse. It is accurate and useless: the
user still does not know whether the connection worked, whether to press
Refresh, or whether their org is simply quiet. A screen with nothing on it is
the one place where the product has to do the explaining.

## The third case is the one that matters

An org that has never deployed is not an error, not a misconfiguration, and not
something the user can fix. It is a fact about their org, and the honest thing
is to say it and stop. Four of ten validated orgs are in this state.

So that case says what is true and offers Refresh, and does not offer Import as
its primary action. Import stays available in the toolbar, where it always is —
it is simply not the advice a connected user needs.

## The link

`docs/CONNECTED-APP.md` is pointed at as a bare path today. In a side panel that
is unreachable: there is no repository checkout, and quite possibly no
repository the reader has ever seen. It becomes an anchor to the file on GitHub,
`target="_blank"` with `rel="noreferrer"` — the second half because a link out
of an extension page should not hand the destination a referrer naming the
extension id.

No new permission: an anchor is not a fetch, and the panel's CSP is untouched.

## What the tests must assert

On **words**, not on the presence of a `.empty` div.

`e2e/org.spec.ts` already has "renders an org with no deploy history as empty,
not as an error", and it passes today against wording that tells the user to
import a file. It asserts `.empty` is visible. That is the failure this change
exists to fix, and a test that cannot see it is a test that is not doing its
job — so it gains assertions on the sentence, and a negative assertion that the
import advice is not there.
