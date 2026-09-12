# Live-org runbook

**Status, and what changed.** The data layer has now been run against **seven
real Salesforce orgs** — see [`ORG-COMPATIBILITY.md`](ORG-COMPATIBILITY.md) for
the measurements and `npm run test:org` for the contract tests that keep them
true. That found and fixed five real defects, including one that made the
metadata inspector permanently empty for org data. Everything below the
"Connect from the panel" step is therefore **measured**, not predicted.

What is still unverified is the half only you can do: completing
`chrome.identity.launchWebAuthFlow`. The org tests borrow the Salesforce CLI's
token, so the extension's own OAuth flow has still never run. Step 3 is marked
**⚠ never performed** below.

Step 2 has been done once: a Connected App named `sf-releaselens` was created in
two orgs on 9 September 2026 (`SELECT Name, CreatedDate FROM ConnectedApplication`
through the Tooling API). Nothing was signed in through it — as of 12 September
2026 neither org has an `OauthToken` row or a `LoginHistory` entry naming the app,
and a completed sign-in leaves both — so the settings in step 2 are recorded as
written, not as proven to work.

Use a **scratch org or a developer sandbox**. Not production, not on the first
run. Nothing here writes to an org — the interface used to reach Salesforce has
no `post`, `patch` or `delete` member at all, and the contract suite asserts a
`load()` makes no request whatsoever — but "nothing writes" is a claim worth
verifying on an org you do not mind being wrong about.

Budget about 20 minutes, most of it waiting for the Connected App to propagate.

## Before you spend that time: check the org first

Ten seconds, no Connected App needed, and it tells you whether the rest is worth
doing:

```bash
npm run build
npm run test:org -- --target-org <alias>
```

Fourteen contract tests against that org, using the CLI's own authentication.
They assert the fields this build reads are present, the nulls it tolerates are
the ones that occur, and a full refresh produces a snapshot the validator
accepts. Expected output:

```
 Test Files  1 passed (1)
      Tests  14 passed (14)
```

With no CLI or no authenticated org it **skips**, saying which. A skip is not a
failure.

---

## Before you start

```bash
git clone https://github.com/muraliseelam/sf-releaselens.git
cd sf-releaselens
npm install
npm run build
```

Load `dist/` at `chrome://extensions` → **Developer mode** → **Load unpacked**.

**Write down the extension id** Chrome assigns — the long string under the
extension's name. You need it in step 2, and it changes if you remove and
reload the extension, which invalidates the Connected App's redirect URI.

Then get the redirect URI the extension will actually use. Open the panel,
right-click it → **Inspect**, and in the console:

```js
chrome.identity.getRedirectURL()
```

Expected: `https://<extension-id>.chromiumapp.org/` — **with the trailing
slash and no path**. The code calls `getRedirectURL()` with no argument, so
anything you append here will not match what the token exchange sends, and
Salesforce answers `redirect_uri_mismatch`. Verified against a real Chromium in
the e2e harness; don't retype it from memory.

That host does not exist and is never contacted. Chrome intercepts the redirect
in the browser, which is the whole point of `launchWebAuthFlow`: the
authorization code never leaves the browser and no server of ours is in the
path.

---

## 1. Point it at an org that has deployed something

Any org the CLI can reach will do. If you already have one authenticated:

```bash
sf org list
```

**An org with no deploy history is a valid case, not a broken one** — four of
the seven measured have never had a deploy, and the panel renders an empty state
for them, which is now covered by a unit test, a contract test and a browser
test. But an empty dashboard tells you nothing about whether the mapping works,
so use an org with history if you have one.

To create a fresh one:

```bash
sf org create scratch --definition-file config/project-scratch-def.json   --alias releaselens-test --duration-days 7 --set-default
sf project deploy start --source-dir force-app --target-org releaselens-test
```

**Correct output:** `Deploy Succeeded.` and a deploy id starting `0Af`.

One Apex class is enough. Do it twice if you want more than one release.

## 2. Create the Connected App ✅ done once, 9 September 2026

> An app with this name was created on 9 September 2026, so the form can be
> filled in as described. Whether these exact settings are the ones that work is
> still unproven: nothing has signed in through that app, so no step here has
> been confirmed by its result. The field values remain Salesforce's
> documentation, not experience.

Setup → **App Manager** → **New Connected App** → **Create an API-only app** if
prompted, otherwise the classic form.

| Field | Value |
| --- | --- |
| Connected App Name | `sf-releaselens` |
| API Name | `sf_releaselens` |
| Contact Email | yours |
| **Enable OAuth Settings** | ✅ ticked |
| **Callback URL** | `https://<extension-id>.chromiumapp.org/` — trailing slash, no path |
| **Selected OAuth Scopes** | `Manage user data via APIs (api)` and `Perform requests at any time (refresh_token, offline_access)` — **those two only** |
| **Require Proof Key for Code Exchange (PKCE)** | ✅ ticked |
| **Require Secret for Web Server Flow** | ❌ **unticked** |
| **Require Secret for Refresh Token Flow** | ❌ **unticked** |
| Enable Client Credentials Flow | ❌ unticked |

The two "Require Secret" boxes are the ones that matter. This extension is a
**public client**: it has no server, so it cannot hold a secret, and the token
exchange refuses to send one. Leaving either ticked produces
`invalid_client_id` at step 4 — see the failure table.

Save, then **wait 10 minutes**. Salesforce says 2–10; it is usually nearer 10,
and the failure while you wait looks exactly like a wrong Consumer Key.

Then **Manage** → **Edit Policies**:

| Field | Value |
| --- | --- |
| Permitted Users | `All users may self-authorize` |
| IP Relaxation | `Relax IP restrictions` |
| Refresh Token Policy | `Refresh token is valid until revoked` |

Finally, **Manage Consumer Details** → copy the **Consumer Key**. It starts
`3MVG9`. It is a public identifier, not a secret — it appears in the
authorization URL in your address bar — but do not paste it into a public issue
anyway; there is no reason to.

**Do not copy the Consumer Secret.** You will not need it, and this extension
will not accept it.

---

## 3. Connect from the panel ⚠ never performed

Open the side panel → **Connect org…**

| Field | Value |
| --- | --- |
| Login URL | `https://test.salesforce.com` for a sandbox, `https://login.salesforce.com` for a scratch/developer org |
| Consumer Key | the `3MVG9…` value from step 2 |

Press **Sign in**.

**Correct output, in order:**

1. Chrome shows a permission prompt naming `login.salesforce.com` (or
   `test.salesforce.com`) **and** `*.my.salesforce.com`. Two patterns, in one
   prompt, inside your click. Accept it.
2. A Salesforce login window opens. Log in.
3. An approval screen lists exactly two scopes: *Manage user data via APIs* and
   *Perform requests at any time*. If it lists more, the Connected App has more
   scopes than the table above; fix it there.
4. The window closes on its own.
5. The org strip changes from `Local data · no org connected` to the org's
   instance host with a **Refresh** button enabled and `never refreshed`
   beside it.

**If the permission prompt does not appear**, that is the highest-risk unknown
in this whole document — see the failure table.

---

## 4. Refresh

Press **Refresh**. Nothing happens on its own; there is no polling anywhere in
the codebase.

**Correct output**, all of it measured against real orgs:

- One release per recent deployment, up to ten.
- Each release named by its **deploy id** (`0Af…`). Salesforce has no release
  name and this extension will not invent one — see "Release names" below.
- **Components listed.** If a release shows zero components, that is either a
  deploy whose details have aged out or a real bug; check another release before
  concluding.
- `package.xml` is **not** among the components. It comes back with an empty
  `componentType`, and is dropped.
- Every component attributed to whoever ran the deploy, never "unknown".
- Apex classes show a coverage percentage; a class with no lines shows *Coverage
  unknown*, never `0%`. **An org that cannot answer for coverage at all** shows
  *Coverage unknown* everywhere and says so in the refresh's audit entry — that
  is correct, not a failure.
- Every component's detail pane shows the amber **Dependency data is not
  available** notice in both directions. A deploy report lists components, not
  edges.
- The org strip reads `refreshed just now`.

**Then verify the read-only claim from the org's side.** Setup → **View Setup
Audit Trail**. There should be no new entries from your API user beyond the
login. There is no write path in the code — the interface used to reach
Salesforce has no `post`, `patch` or `delete` member at all — but this is the
check that makes that a fact rather than a claim.

---

## 5. The things worth testing deliberately

| Check | How | Expected |
| --- | --- | --- |
| Approvals stay local | Approve something, then look in the org | No records created anywhere. There is no write path. |
| Approvals survive a refresh | Approve, then **Refresh** | The decision is still there. |
| Staleness | Wait 15 minutes without refreshing | An amber banner says the data may be out of date. |
| Disconnect | **Disconnect** | The strip returns to local data, the host permission is handed back (check `chrome://extensions` → Details → Site access), and the org cache is cleared. |
| Token survives a worker eviction | Leave the panel closed for a minute, reopen, **Refresh** | It works. The access token is gone with the worker; the refresh token in session storage gets a new one. |
| Token does not survive a browser restart | Quit Chrome entirely, reopen | You are asked to reconnect. `chrome.storage.session` is memory-backed by design. |
| Budget guard | Only if your org is genuinely near its limit | Refresh is refused with the usage numbers rather than "trying anyway". |

---

## What is most likely to break, and what you should see

Read this **before** the first run, so you can tell a real defect from expected
behaviour. Everything in the "Expected" column is a designed response; anything
else is a bug worth reporting.

Each heading is now marked with what is actually known:

- **measured** — observed against real orgs, and asserted by `npm run test:org`.
- **⚠ unverified** — still reasoning, not observation.

### The permission prompt — ⚠ unverified, and the highest risk left

**Risk: highest.** `chrome.permissions.request` requires a user gesture, and
the panel requests it inside the click that starts sign-in. If Chrome decides
the gesture has been consumed — by the OAuth window opening, or by a re-render
in between — the prompt never appears.

| Symptom | Expected behaviour | If you see something else |
| --- | --- | --- |
| No prompt, sign-in fails immediately | The panel says the host permission was refused, with a button to grant it. | A silent failure, or a spinner that never resolves, is a bug. |
| Prompt appears but lists only one host | Both `login`/`test` and `*.my.salesforce.com` should be listed. | The instance host is not known until after sign-in, so it must be requested up front. One host means the request was built wrong. |

### My Domain and instance host variants — measured

The manifest declares `https://*.salesforce.com/*` and
`https://*.my.salesforce.com/*`. Of the seven orgs measured, four are on
`*.my.salesforce.com` and three on `*.develop.my.salesforce.com` — both covered,
the second because it is a subdomain of the first.

| Host | Covered? | Seen |
| --- | --- | --- |
| `acme.my.salesforce.com` | ✅ | 4 orgs |
| `acme.develop.my.salesforce.com` | ✅ | 3 orgs |
| `acme--uat.sandbox.my.salesforce.com` | ✅ (matches `*.my.salesforce.com`) | not seen |
| `acme--uat.sandbox.my.**force**.com` | ❌ **not covered** | not seen |
| Anything on `*.force.com` | ❌ **not covered** | not seen |
| `acme.cloudforce.com` (legacy) | ❌ **not covered** | not seen |

**Expected on an uncovered host:** the refresh fails with a permission error
naming the host, not a silent CORS failure. **Report it with the diagnostics
file** — its `org.instanceHostPattern` field says exactly which case you hit,
without naming your org.

### API version drift — measured

The API version is pinned at **62.0** in `service-worker.ts`. All seven orgs
measured report **67.0** and all seven still serve 62.0, so the pin works today
and the gap is five versions — under the six-version threshold at which the
refresh starts saying so.

The pin is deliberate: the mapper is written against one version's response
shapes, and following the org's latest would let those shapes change under a
user with no code change at all. What a pin cannot do is notice it has gone
stale, so a refresh now reads `/services/data/` once.

| Symptom | Expected behaviour |
| --- | --- |
| The org has retired v62.0 | `ORG_RESPONSE_INVALID` saying the org no longer offers it and the extension needs updating — **before** anything else runs, so you never see a bare 404. Covered by a browser test. |
| The org is six or more versions ahead | The refresh succeeds and the audit entry says fields added since then are not read. |
| `/services/data/` cannot be read at all | The refresh proceeds anyway. A diagnostic must not cost a capability. |

### `DeployRequest` field availability — measured

`DeployRequest` is a Tooling API object and not uniformly populated. Measured
across 20 real deploy records:

| Field | What was actually observed |
| --- | --- |
| `TestLevel` | **`null` in all 20 rows, every org.** No longer selected. |
| `CreatedBy.Name` | Present in all 20. Nullable when the API user cannot see the creating user; still handled. |
| `CompletedDate` | Present in all 20; absent while a deploy runs. |
| `DeployResult` | **Absent from the Tooling record entirely.** Details come from the Metadata REST API — see below. |

**Component details do not come from the Tooling record.** They come from:

```
GET /services/data/vXX/metadata/deployRequest/{deployId}?includeDetails=true
```

and `includeDetails=true` is required: without it the `componentSuccesses` and
`componentFailures` arrays come back present and empty. This build used to read
the Tooling record, so **every org-sourced release had zero components** and the
metadata inspector was permanently empty for org data. Fixed, and asserted by a
contract test that reads the Tooling record's field list.

Two more measured facts about a component:

- **It has no author.** 0 of 17 components carry a `createdByName`, in either
  the Metadata API or the CLI's `deploy report --json`. The deploy's author is
  used instead; before that, every component read "unknown".
- **`problemType` is `null` even on a genuine failure**, with the text in
  `problem`. The warning code is derived, so a failed component shows
  `DEPLOY_FAILURE` and the real message.

**Coverage is not available in every org.** One of the seven rejects
`ApexCodeCoverageAggregate` outright:

```
INVALID_TYPE: sObject type 'ApexCodeCoverageAggregate' is not supported.
```

That used to fail the entire refresh. It now degrades: the releases arrive,
every component reports *Coverage unknown* rather than 0%, and the reason is
written into the refresh's audit entry. An auth failure on the same query still
fails the refresh, because "no coverage" and "no session" are different answers.

### Mapping failures — measured

If the org returns records this build cannot map onto a snapshot, you get
`ORG_RESPONSE_INVALID` — *"The org's response was not valid at
`DeployRequest -> …`"* — and the message says your local data and approvals are
untouched, because they are.

**You should never see `SNAPSHOT_VALIDATION` from a refresh.** That error means
*your stored data is corrupt* and the panel offers **Reset to demo data** beside
it. If a refresh produces it, that is a bug: report it, and **do not press
Reset**, because you would lose local approvals over a problem that came down
the wire.

### CORS — ⚠ unverified for the extension's own requests

There is no CORS configuration to do, and you should not need to add the
extension origin to the org's CORS allow-list. Extension requests from a
service worker with a granted host permission are not subject to the page CORS
model.

**If you see a CORS error in the worker console**, something is wrong with the
host permission rather than with the org — check `chrome://extensions` →
Details → Site access, then use **Disconnect** and reconnect.

### Token refresh — ⚠ unverified

The access token lives in service-worker memory and is gone whenever Chrome
evicts the worker, which is roughly every 30 idle seconds. The refresh token
lives in `chrome.storage.session`, which is memory-backed and cleared when the
browser closes.

| Symptom | Expected behaviour |
| --- | --- |
| First refresh after the panel has been closed a while | Works. A new access token is fetched silently. |
| Refresh token expired or revoked | `ORG_AUTH_EXPIRED` with a **Reconnect** button. Never a silent re-prompt. |
| Refresh token policy set to expire | Same, at the policy's interval. Set *valid until revoked* to avoid it during testing. |
| After quitting Chrome | You must reconnect. This is by design, not a bug. |

### Release names — measured

Salesforce has no release name, so a release shows its deploy id until a local
overlay supplies one. The overlay is real, keyed by deploy id, and read from
`chrome.storage.local` under `sf-releaselens.release-overlay.v1` — but **there
is no UI to edit it yet**. To try it, in the panel's console:

```js
chrome.storage.local.set({
  'sf-releaselens.release-overlay.v1': {
    '0AfWs00000abcDEFG': { name: 'Q3 Billing', riskLevel: 'high' },
  },
});
```

Then **Refresh**. Deploy ids with no entry keep showing the id; a name is never
invented.

---

## When something fails: the diagnostics file

Press **Diagnostics** in the org strip. It downloads
`sf-releaselens-diagnostics-<timestamp>.json`.

**That file is safe to attach to a public issue.** It is built field by field
from counts, versions, enums and durations — not filtered from org data
afterwards — so there is no value in it to leave in by mistake. It carries:

- extension version, Chrome major version, platform, pinned API version;
- whether an org is connected, whether the host permission is still granted,
  which login endpoint (classified, never the URL), which host *pattern* the
  instance matches, and how long ago it connected and last refreshed;
- snapshot shape: counts by kind, releases by status, approvals by status, how
  many components have coverage / warnings / unavailable dependencies;
- storage keys present and their approximate sizes;
- the last ten audit **actions** and their ages.

It deliberately excludes tokens, the Consumer Key, the org name, instance URL,
org id, user id, username, deploy ids, release names, component names, file
paths, ticket references, approval comments and approver names. `excludes` is
printed inside the report so a reader can see the promise without taking it on
trust, and `test/core/diagnostics.test.ts` asserts it against a payload stuffed
with every one of those.

Attach that, plus:

- **what you expected and what happened**, one sentence each;
- the **service worker console**: `chrome://extensions` → Details → *Inspect
  views: service worker*. Errors are redacted before they are thrown, but read
  them before pasting;
- **not** a screenshot with your org name in it.

---

## After the run

The data layer is already recorded — [`ORG-COMPATIBILITY.md`](ORG-COMPATIBILITY.md)
holds the measurements and `npm run test:org` keeps them true. What your run adds
is the half nobody has done:

1. **Whether the permission prompt appears inside the sign-in click.** This is
   the single largest unknown left in the project. If it does not, the panel
   should say the host permission was refused and offer a button to grant it; a
   spinner that never resolves is a bug.
2. **Whether the Connected App settings in §2 are right.** They are transcribed
   from Salesforce's documentation, not from having created one.
3. **Whether `launchWebAuthFlow` completes and the redirect URI matches.** The
   value is `https://<extension-id>.chromiumapp.org/` — trailing slash, no path,
   verified against a real Chromium, but never exchanged with Salesforce.
4. **Whether the refresh-token grant works** the first time the access token
   expires.

Record the outcome in [`QA-CHECKLIST.md`](QA-CHECKLIST.md) §8 and §9, changing
the ❓ marks to ✅ or ❌ with a note. A ❌ with a diagnostics file attached to an
issue is worth more to this project than anything else on this page.
