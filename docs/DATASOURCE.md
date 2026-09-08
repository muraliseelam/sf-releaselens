# Connecting a real Salesforce org — proposal

**Status: proposal. Nothing here is implemented.** This document is for a
decision, not a record of work done.

## 1. Where we actually are

| | |
| --- | --- |
| Manifest permissions | `storage`, `sidePanel`. Nothing else. |
| Host permissions | **None.** The extension cannot make a cross-origin request today. |
| Data | 100% local. `src/data/seed.ts` is ~17 KB of **fictional** demo records — five releases, 57 components, seven approvals. |
| Implementations of `DataSource` | One: `LocalDataSource`, over `chrome.storage.local`. |
| Path to real data today | Manual: `sf project deploy report --json` → **Import**. |

So "release data" in the panel is either sample data or a file somebody pasted
in. Nothing observes an org.

## 2. The boundary that already exists

`src/data/datasource.ts` is the seam, and it is genuinely the only one — the
router, the panel and every view depend on `DataSource` and nothing below it.
A Salesforce-backed implementation has to satisfy exactly this:

```ts
interface DataSource {
  load(): Promise<Snapshot>;
  readRaw(): Promise<unknown>;
  decide(command: DecisionCommand): Promise<DecisionResult>;
  importSnapshot(raw: unknown): Promise<Snapshot>;
  exportSnapshot(): Promise<Snapshot>;
  reset(seed: SeedKind): Promise<Snapshot>;
  setActor(actor: Actor): Promise<Snapshot>;
}
```

Two properties of that contract shape everything below.

**It is snapshot-at-a-time, not query-at-a-time.** Every method returns the
*whole* resulting `Snapshot`. That is deliberate (the UI can never render a
half-applied mutation) and it is fine for local storage — but a naive remote
implementation would refetch the world on every call. §5 addresses this.

**`decide()` has no remote counterpart.** Salesforce has no deployment-approval
object. This is the crux of the proposal and §6 is about it.

## 3. What a real org can and cannot supply

| Snapshot field | Real source | Fidelity |
| --- | --- | --- |
| `releases` | Tooling API `DeployRequest` | **Good.** id, status, dates, test level, component counts. |
| `releases[].name` / `version` | — | **No source.** A deploy has an id, not a release name. Needs a naming convention or local metadata. |
| `releases[].ticketRefs` | — | **No source.** Would need Jira/ADO, out of scope. |
| `releases[].riskLevel` | — | **Derived at best** (failure count, destructive changes). Currently a human judgement. |
| `items` | `DeployRequest.details.componentSuccesses` / `componentFailures` | **Good.** Same mapping `transfer.ts` already does for the CLI JSON. |
| `items[].dependsOn` | — | **Not available.** A deploy report carries components, not edges. The dependency panes would be empty for org-sourced releases. |
| `items[].testCoverage` | Tooling `ApexCodeCoverageAggregate` | **Good**, one extra query. |
| `environments` | Org identity (`Organization`, `IsSandbox`, `TrialExpirationDate`) | **Good.** |
| `approvals` | — | **Nothing.** See §6. |
| `auditLog` | — | Stays local. |

**The honest headline: connecting an org improves `releases` and `items`, does
nothing for `approvals`, and loses `dependsOn`.** Two of the three surfaces get
better; the approvals helper does not.

## 4. Auth — three options

We should not implement OAuth ourselves in a browser extension if we can avoid
it. Ranked:

### Option A — session cookie on an already-open org tab *(recommended for v2)*

The user is signed into their org in Chrome. We reuse that session.

- **Host permissions:** `https://*.my.salesforce.com/*` plus
  `https://*.salesforce.com/*`, or — much better — **`optional_host_permissions`**
  so the extension ships requesting nothing and asks per-domain at connect time.
- **Auth:** none of our own. `fetch(..., { credentials: 'include' })` against
  `/services/data/vXX.0/...` on the org origin. Requires a session id for the
  REST API, which a cookie alone does **not** give you — so realistically this
  means reading the session from an open Setup page via a content script, which
  is fragile and looks a lot like credential scraping.
- **Verdict:** cheapest to describe, worst to defend. I do **not** recommend it.

### Option B — Connected App OAuth via `chrome.identity` *(recommended)*

- **Manifest:** `"permissions": ["storage", "sidePanel", "identity"]`,
  `"optional_host_permissions": ["https://*.salesforce.com/*", "https://*.my.salesforce.com/*"]`.
- **Flow:** `chrome.identity.launchWebAuthFlow` → org login → PKCE authorization
  code → access + refresh token. The redirect URI is
  `https://<extension-id>.chromiumapp.org/`, which must be registered in the
  Connected App.
- **Requires the customer to create a Connected App** in their org (or us to
  publish one, which means we become an identity party — a much bigger
  commitment). Customer-created is the right call.
- **Token storage:** access token in memory only, in the service worker. Refresh
  token in `chrome.storage.session` (cleared on browser close), **never**
  `chrome.storage.local`, which persists to disk unencrypted.
- **Verdict:** standard, defensible, explainable in a README. Recommended.

### Option C — a local companion process

The extension talks to `http://127.0.0.1:<port>` served by a small local binary
that shells out to the `sf` CLI and inherits its auth. Zero credential handling
by us — the same posture `sf-mcp` takes.

- **Manifest:** `host_permissions: ["http://127.0.0.1/*"]`.
- **Cost:** users must install and run a second thing. Kills the "just install
  the extension" story.
- **Verdict:** best security posture, worst adoption. Worth keeping as an option
  for regulated customers.

**Recommendation: B, with C documented as an alternative.**

## 5. API surface

One new implementation, `src/data/salesforce.ts`, plus a thin transport:

```ts
export function createSalesforceDataSource(deps: {
  storage: StorageArea;        // reused: local cache + the local-only fields
  connection: OrgConnection;   // new: the network seam, mocked in tests
  clock: Clock;
  newId: IdFactory;
}): DataSource;
```

`OrgConnection` is the new port — and the *only* file allowed to touch `fetch`:

```ts
interface OrgConnection {
  readonly instanceUrl: string;
  readonly apiVersion: string;
  /** REST GET. Read-only by construction: there is no post/patch/delete member. */
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
  /** Tooling API SOQL. */
  toolingQuery<T>(soql: string): Promise<{ records: T[]; done: boolean; nextRecordsUrl?: string }>;
}
```

Keeping it read-only in the *type* is the point: a future contributor cannot
give a read path a write side effect without changing this interface, which is a
visible diff.

Calls needed for `load()`:

| Purpose | Call |
| --- | --- |
| Org identity / environment | `GET /query?q=SELECT Id,IsSandbox,TrialExpirationDate,OrganizationType,InstanceName FROM Organization` |
| Recent deployments | Tooling: `SELECT Id,Status,StartDate,CompletedDate,NumberComponentsTotal,NumberComponentErrors,CheckOnly FROM DeployRequest ORDER BY CreatedDate DESC LIMIT 25` |
| Components per deploy | Tooling: `GET /tooling/sobjects/DeployRequest/<id>` (details come with the record) |
| Coverage (optional) | Tooling: `SELECT ApexClassOrTriggerId,NumLinesCovered,NumLinesUncovered FROM ApexCodeCoverageAggregate` |

That is **four API calls per refresh**, not per render.

### Making a snapshot-shaped contract work remotely

`DataSource.load()` returning the whole world on every call is wrong against a
network. Proposal:

- `load()` returns the **cached** snapshot immediately from `chrome.storage.local`
  and does not hit the network.
- Add **one** method to the port:

  ```ts
  /** Refetches from the org and merges into the cached snapshot. */
  refresh(): Promise<Snapshot>;
  ```

  `LocalDataSource.refresh()` is `load()` — a no-op — so nothing above the port
  changes behaviour for local mode. The panel gets a **Refresh** button, enabled
  only when an org is connected.
- Refresh is **explicit and user-initiated**. No polling, no background timer.
  An extension that quietly hits someone's org on a timer burns their API limit
  and will get it uninstalled.

This is the one change to the existing boundary I am proposing. Everything else
is additive.

## 6. Approvals — the part that does not work remotely

Salesforce has no deployment-approval object. Three ways to go:

1. **Keep approvals local** (what happens today). Org supplies releases and
   components; approvals remain a local, unauthenticated aid. Cheapest, and the
   README already says exactly this. **Recommended for v2.**
2. **Store approvals in a custom object** (`Release_Approval__c`). Real, shared,
   auditable — and requires the customer to deploy metadata to their org, plus
   write access, which means the extension can no longer be honestly described as
   read-only. Large jump in both capability and risk.
3. **A real backend.** Correct for a genuine approval trail; out of scope for a
   browser extension with no server.

**Recommendation: (1) for v2, and say so plainly.** Do not let "connects to
Salesforce" imply the approvals became trustworthy — they did not.

## 7. What stays local, permanently

- `auditLog` — local record of local decisions.
- `actor` — the profile switcher.
- All UI state: filters, selection, tab.
- The whole snapshot as a **cache**, so the panel opens instantly and works
  offline, showing the last refresh time.
- `readRaw` / import / export / reset — rescue and portability paths that must
  keep working whether or not an org is reachable.

## 8. Failure modes to specify before coding

Same posture as the existing code: refuse clearly rather than degrade silently.

| Failure | Proposed behaviour |
| --- | --- |
| Not connected | Local mode, no error. Refresh disabled with a reason. |
| Token expired | Refresh once; on failure surface `ORG_AUTH_EXPIRED` with a Reconnect button. Never a silent re-prompt. |
| Host permission revoked | Detect via `chrome.permissions.contains`; prompt to re-grant. |
| API limit ≥95% | Refuse refresh with the current usage numbers, do not "try anyway". |
| Org unreachable | Keep the cached snapshot on screen, banner the staleness with the last-refresh time. **Never** blank the panel. |
| Org returns a shape we cannot parse | Same rule as stored data: refuse, name the field, keep the cache. **Reported as `ORG_RESPONSE_INVALID`, never as `SNAPSHOT_VALIDATION`** — see the note below. |

### The mapped snapshot is validated, and a failure there is the org's fault

`refresh()` runs the snapshot it built through `parseSnapshot`, the same
validator that guards stored data, so a mapping bug cannot reach the cache.

The error that comes out of that check is deliberately rewritten. A raw
`SnapshotValidationError` reads "Snapshot is not valid at …", which a release
manager reads as *my local data is corrupt* — and the panel offers **Reset to
demo data** right beside it. Resetting would destroy their local approvals to
fix a problem that arrived down the wire. So a mapping failure is re-thrown as
`ORG_RESPONSE_INVALID`, keeping the failing field but saying plainly that the
org's records could not be mapped and that nothing local was touched.

This was found by the property test in `test/data/salesforce.property.test.ts`,
not by review: about one fuzzed org response in six mapped to something the
validator rejected, and every one of them named the wrong culprit. The reachable
real-world trigger is two `DeployRequest` rows with the same Id, which a paged
query can produce.

## 9. Scope and cost

| Increment | Work |
| --- | --- |
| 1. `OrgConnection` port + fetch transport + tests | ~1 day |
| 2. `chrome.identity` PKCE flow, session-only token storage | ~2 days |
| 3. `SalesforceDataSource`: mapping, caching, `refresh()` | ~2 days |
| 4. Panel: connect/disconnect, Refresh, staleness banner, new error states | ~1.5 days |
| 5. Manifest + permission prompts + README/limitations rewrite | ~0.5 day |

Roughly **a week**, and it changes the security story from "no network, no host
permissions, cannot read your tabs" to "OAuth client holding an org token".
That trade is the actual decision — not the code.

## 10. Decisions I need before implementing

1. **Auth: Option B (`chrome.identity` + customer Connected App)?** Or C
   (local companion) for a stronger posture at the cost of adoption?
2. **Approvals: keep local (1)?** Or is a `Release_Approval__c` custom object in
   scope, accepting that the extension then writes to the org?
3. **Is adding `refresh()` to `DataSource` acceptable?** It is the only change to
   the existing boundary; everything else is additive.
4. **Ship `optional_host_permissions` rather than `host_permissions`?** I
   recommend yes — the extension then installs asking for nothing and prompts
   only when someone connects an org.
5. **Do releases keep human names?** The org supplies deploy ids. Either we keep
   a local name/ticket overlay keyed by deploy id, or the dashboard shows ids.
