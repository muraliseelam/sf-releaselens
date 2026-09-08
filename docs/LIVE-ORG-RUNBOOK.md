# Live-org runbook

The org integration is complete, unit-tested against a fake connection, and
**has never been pointed at a real Salesforce org**. This is the sequence for
doing that the first time: what to click, what correct output looks like at each
step, and — the longer half — what is most likely to break and how to tell a
real bug from expected behaviour.

Use a **scratch org or a developer sandbox**. Not production, not on the first
run. Nothing here writes to an org, but "nothing writes" is a claim you should
verify on an org you do not mind being wrong about.

Budget about 20 minutes, most of it waiting for the Connected App to propagate.

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

## 1. Create the scratch org

```bash
sf org create scratch --definition-file config/project-scratch-def.json \
  --alias releaselens-test --duration-days 7 --set-default
sf org open --target-org releaselens-test
```

Any scratch definition will do. If you have no project handy, a developer
sandbox or a Developer Edition org works identically.

**Give it something to look at.** A brand new org has no deploy history, and an
empty dashboard is indistinguishable from a broken refresh:

```bash
sf project deploy start --source-dir force-app --target-org releaselens-test
```

Any deploy will do — one Apex class is enough. Do it twice if you want to see
more than one release.

**Correct output:** `Deploy Succeeded.` and a deploy id starting `0Af`.

---

## 2. Create the Connected App

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

## 3. Connect from the panel

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

**Correct output:**

- The dashboard shows one release per recent deployment, up to ten.
- Each release is named by its **deploy id** (`0Af…`), not by a name. Salesforce
  has no release name, and this extension will not invent one. See "Release
  names" below.
- Component counts match what you deployed. `package.xml` is **not** listed as
  a component.
- Apex classes show a coverage percentage; a class with no lines shows
  *Coverage unknown*, never `0%`.
- Every component's detail pane shows the amber **Dependency data is not
  available** notice in both directions. This is correct and is not a bug: a
  deploy report lists components, not edges.
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

This is the part to read **before** the first run, so you can tell a real defect
from expected behaviour. Everything in the "Expected" column is a designed
response; anything else is a bug worth reporting.

### The permission prompt

**Risk: highest.** `chrome.permissions.request` requires a user gesture, and
the panel requests it inside the click that starts sign-in. If Chrome decides
the gesture has been consumed — by the OAuth window opening, or by a re-render
in between — the prompt never appears.

| Symptom | Expected behaviour | If you see something else |
| --- | --- | --- |
| No prompt, sign-in fails immediately | The panel says the host permission was refused, with a button to grant it. | A silent failure, or a spinner that never resolves, is a bug. |
| Prompt appears but lists only one host | Both `login`/`test` and `*.my.salesforce.com` should be listed. | The instance host is not known until after sign-in, so it must be requested up front. One host means the request was built wrong. |

### My Domain and instance host variants

The manifest declares `https://*.salesforce.com/*` and
`https://*.my.salesforce.com/*`. Real instance hosts vary more than that:

| Host | Covered? |
| --- | --- |
| `acme.my.salesforce.com` | ✅ |
| `acme--uat.sandbox.my.salesforce.com` | ✅ (matches `*.my.salesforce.com`) |
| `acme.develop.my.salesforce.com` | ✅ |
| `acme--uat.sandbox.my.**force**.com` | ❌ **not covered** |
| Anything on `*.force.com` | ❌ **not covered** |
| `acme.cloudforce.com` (legacy) | ❌ **not covered** |

**Expected on an uncovered host:** the refresh fails with a permission error
naming the host, not a silent CORS failure. **Report it with the diagnostics
file** — the report's `org.instanceHostPattern` field says exactly which case
you hit, without naming your org.

### API version drift

The API version is pinned at **62.0** in `service-worker.ts`. A pinned version
is the right default — a platform release cannot shift response shapes
underneath you — but it goes stale.

| Symptom | Expected behaviour |
| --- | --- |
| Org is older than API 62.0 | The request fails with an org error naming the version. Not a parse error. |
| A field this build reads has been removed | `ORG_RESPONSE_INVALID` naming the field. |

### `DeployRequest` field availability

`DeployRequest` is a Tooling API object and not uniformly populated:

| Field | When it can be missing |
| --- | --- |
| `DeployResult.details` | Not returned for older deploys, or where the detail has aged out |
| `CompletedDate` | Absent while a deploy is still running |
| `CreatedBy.Name` | Absent when the API user cannot see the creating user |
| `NumberComponentsTotal` | Zero on a validation-only deploy |

**Expected:** a release with no `details` maps to a release with **zero
components**, not to a failed refresh. A missing `CreatedBy.Name` shows as
`unknown`. Neither should produce an error.

### Mapping failures

If the org returns records this build cannot map onto a snapshot, you get
`ORG_RESPONSE_INVALID` — *"The org's response was not valid at
`DeployRequest -> …`"* — and the message says your local data and approvals are
untouched, because they are.

**You should never see `SNAPSHOT_VALIDATION` from a refresh.** That error means
*your stored data is corrupt* and the panel offers **Reset to demo data** beside
it. If a refresh produces it, that is a bug: report it, and **do not press
Reset**, because you would lose local approvals over a problem that came down
the wire.

### CORS

There is no CORS configuration to do, and you should not need to add the
extension origin to the org's CORS allow-list. Extension requests from a
service worker with a granted host permission are not subject to the page CORS
model.

**If you see a CORS error in the worker console**, something is wrong with the
host permission rather than with the org — check `chrome://extensions` →
Details → Site access, then use **Disconnect** and reconnect.

### Token refresh

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

### Release names

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

Whatever happens, the results belong in
[`QA-CHECKLIST.md`](QA-CHECKLIST.md) §8 and §9 — that is where "requires a live
org" is tracked, and it is currently entirely unticked. Change the ❓ marks to
✅ or ❌ with a note. A ❌ with a diagnostics file attached to an issue is worth
more to this project than anything else on this page.
