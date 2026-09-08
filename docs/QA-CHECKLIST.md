# Manual QA checklist

## Why this document exists

Nobody has yet loaded this extension into a real Chrome, and nobody has pointed
it at a real Salesforce org. The automated suite (521 tests) and two harnesses
that drive the **built `dist/` output** under jsdom
cover the logic and the DOM, but they cannot cover Chrome itself: browser
automation tooling is blocked from interacting with `chrome://` URLs at all — it
cannot navigate there, and cannot even screenshot such a page — so *Load
unpacked* cannot be automated. A side panel is also not a tab, so it would not be
drivable even once loaded.

Everything marked ❓ below is therefore **unverified**, and §9 lists what cannot
be verified without a live org at all. Treat both as outstanding work, not as a
formality.

Each item says how it stands today:

| Mark | Meaning |
| --- | --- |
| ✅ auto | Covered by `npm test` against the source. |
| ✅ dist | Additionally exercised against the built `dist/` output under jsdom. |
| ❓ | **Never verified.** Needs a human with Chrome. |

---

## 1. Load the extension

Requires **Chrome 116+** (the `sidePanel` API).

```bash
npm run check     # must exit 0; emits 135 files into dist/
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select `C:\EB1A\chrome-extension\dist` (the `dist`
   directory itself, not the repo root).

| # | Check | Expected | Status |
| --- | --- | --- | --- |
| 1.1 | The extension loads | Card appears: *sf-releaselens 0.1.0*. **No errors** button on the card. | ❓ |
| 1.2 | Permissions | Card shows *storage*, *sidePanel* and *identity*. **Site access must be empty** — host permissions are optional and requested only at connect time. | ❓ |
| 1.3 | Service worker | Card shows *service worker* as **active** or *inactive* — never *errored*. Click it: DevTools console must be empty. | ❓ |
| 1.4 | Icon | Chrome shows the **default grey puzzle piece** — the extension ships no icons. Expected, and a known gap. | ❓ |

## 2. Open the side panel

| # | Check | Expected | Status |
| --- | --- | --- | --- |
| 2.1 | Toolbar click opens the panel | Clicking the toolbar icon opens the side panel directly (set by `sidePanel.setPanelBehavior({openPanelOnActionClick:true})` on install). | ❓ (behaviour call ✅ dist) |
| 2.2 | Panel renders | Header *sf-releaselens*, an org strip reading **Local data · no org connected**, three tabs, and a blue **Demo data** banner. | ❓ (markup ✅ dist) |
| 2.3 | No console errors | Right-click the panel → Inspect. Console clean. **This is the CSP check** — MV3 blocks inline script, and nothing else tests that. | ❓ |
| 2.4 | Theme | Panel follows the OS light/dark setting; text legible in both. | ❓ |
| 2.5 | Narrow width | Drag the panel to its narrowest. No horizontal scrollbar; long API names wrap rather than truncate. | ❓ |

## 3. Release dashboard

Seeded demo data. Values below are exact — anything else is a bug.

| # | Check | Expected | Status |
| --- | --- | --- | --- |
| 3.1 | Headline | `5 releases tracked · 2 need attention` (the second half in red). | ✅ dist |
| 3.2 | Status counts | Nine chips: `All 5`, `Draft 1`, `Awaiting approval 1`, `Scheduled 0`, `In progress 0`, `Deployed 1`, `Blocked 1`, `Failed 1`, `Rolled back 0`. Zero-count chips are present and dimmed. | ✅ dist |
| 3.3 | Status bar | Proportional coloured bar above the chips. | ✅ dist |
| 3.4 | Row order | *Payment Retry Hotfix* first, with a red left border (attention sorts first). | ✅ dist |
| 3.5 | Row detail | Each row: name, version, status pill, environment, risk, component count, updated-ago. *Q3 Billing Enhancements* shows a **2 pending approvals** badge. | ✅ dist |
| 3.6 | Filter | Click **Blocked** → one row, *Payment Retry Hotfix*. Click **All** → five rows again. | ✅ dist |
| 3.7 | Empty state | Click **Start empty** on the demo banner → *No releases yet* with an **Import JSON…** button. Then reload the panel: it stays empty (it must **not** re-seed demo data). | ✅ auto |

## 4. Metadata inspector

| # | Check | Expected | Status |
| --- | --- | --- | --- |
| 4.1 | Drill-in | From the dashboard click *Q3 Billing Enhancements* → Inspector tab opens, release dropdown pre-set, caption `21 of 57 components`. | ✅ dist |
| 4.2 | Search | Type `usageaggregator` → exactly `UsageAggregator` and `UsageAggregatorTest`. | ✅ dist |
| 4.3 | Multi-token search narrows | Type `usage flow` → exactly `Usage_Rollup_Nightly`. Tokens are ANDed. | ✅ dist |
| 4.4 | Type facet | Click the **Flow** chip → 2 rows. Click again → back to 21. | ✅ dist |
| 4.5 | Warnings filter | Tick *Only components with warnings* → only flagged rows. | ✅ auto |
| 4.6 | Detail — coverage | Select `InvoiceBuilder` → detail pane shows `91% covered`, `Depends on (2)`, `Depended on by (4)`. | ✅ dist |
| 4.7 | Detail — unknown coverage | Select `ProrationCalculator` → shows **`Coverage unknown`**, never `0% covered`, plus a `NO_TEST_COVERAGE` warning. | ✅ dist |
| 4.8 | External dependency | Select `Invoice_Approval_Routing` → `Billing_Approvers` listed as *not in this snapshot*. | ✅ auto |
| 4.9 | Walk the graph | In a detail pane, click a dependent → selection moves to it. | ✅ auto |
| 4.10 | Caret survives typing | Type mid-word in the search box, then click into the middle of the text and keep typing. **The caret must not jump to the end.** Full re-render on every keystroke makes this the highest-risk interaction in the panel. | ❓ (logic ✅ auto) |
| 4.11 | Scroll performance | Clear filters (57 components) and scroll. Should be smooth. | ❓ |

## 5. Approvals helper

| # | Check | Expected | Status |
| --- | --- | --- | --- |
| 5.1 | Badge | The **Approvals** tab shows a badge of `1`. | ✅ dist |
| 5.2 | Queues | Three sections: `Waiting on you 1`, `Waiting on others 1`, `Recently decided 5`. | ✅ dist |
| 5.3 | Buttons only where actionable | Only the *Waiting on you* card has Approve/Reject. | ✅ dist |
| 5.4 | Reject needs a reason | Click **Reject** with an empty comment → red notice, code `MISSING_REJECTION_COMMENT`. Nothing is recorded. | ✅ dist |
| 5.5 | Draft survives the refusal | Type a comment, click **Reject**, get refused, then check the comment is **still in the box**. | ✅ dist |
| 5.6 | Approve | Type `Verified in UAT.`, click **Approve** → green notice: *"UAT sign-off on Q3 Billing Enhancements is now approved. The release status is unchanged."* | ✅ dist |
| 5.7 | Role switch | Set **Acting as** to `qa-lead` → *QA regression sign-off* becomes actionable. | ✅ dist |
| 5.8 | Reject blocks the release | Reject that gate with a comment → *"...is now rejected. The release moved from awaiting_approval to blocked."* Dashboard now shows `Blocked 2`. | ✅ dist |
| 5.9 | **Persists across reopen** | Close the side panel entirely, reopen it. The approval is still in *Recently decided*, with decider and comment; the badge is gone. | ✅ dist (two-process reload) |
| 5.10 | Persists across browser restart | Quit Chrome, reopen, open the panel. Same state. **Only a real browser tests this** — the harness cannot. | ❓ |
| 5.11 | Two panels disagree | Open the panel in two windows. Decide the same approval in both. The second must fail with `INVALID_APPROVAL_TRANSITION` naming who decided first — not silently overwrite. | ❓ (logic ✅ auto) |

## 6. Import / export

| # | Check | Expected | Status |
| --- | --- | --- | --- |
| 6.1 | Export downloads | **Export** → a file `sf-releaselens-<timestamp>.json` lands in Downloads. **Browser-only**: the harness stubs `URL.createObjectURL`. | ❓ (payload ✅ dist) |
| 6.2 | Import round-trip | **Import** that file → dashboard unchanged, demo banner gone. | ✅ auto |
| 6.3 | Import a deploy report | Import `sf project deploy report --json` output → one release, components mapped, failures as error warnings. | ✅ auto |
| 6.4 | Malformed import | Import a non-JSON file → `IMPORT_FORMAT` error and **the existing snapshot is untouched**. | ✅ auto |

## 7. Known-broken — do not sign off without checking

| # | Check | Expected | Status |
| --- | --- | --- | --- |
| 7.1 | **Raw export of a corrupt snapshot is broken** | With a corrupt snapshot stored, the panel says *"Export the raw data before resetting so nothing is lost"* and offers **Export raw data** — but clicking it downloads **nothing**, because it routes through the *validating* export, which fails on exactly that data. Clicking **Reset to demo data** then destroys it. `snapshot.readRaw` exists, is routed and unit-tested, but no UI code calls it. | ❌ reproduced against `dist/` |

To reproduce: DevTools on the panel →
`chrome.storage.local.set({'sf-releaselens.snapshot.v1': {schemaVersion: 42}})` →
reload the panel.

## 8. Org connection (all ❓ — never run against a real org)

Prerequisite: a Connected App per [`CONNECTED-APP.md`](CONNECTED-APP.md). Use a
**sandbox or scratch org**, never production, for first verification.

| # | Check | Expected | Status |
| --- | --- | --- | --- |
| 8.1 | Installs with no host access | On the extension card, *Site access* is empty. The extension has requested nothing. | ❓ |
| 8.2 | Local mode is untouched | Before connecting, everything in §3–§6 behaves exactly as it did. | ✅ auto (regression guard) |
| 8.3 | Connect prompt | **Connect org…** → enter login URL + Consumer Key → **Sign in**. Chrome asks for access to the org origin *before* the Salesforce login window opens. | ❓ |
| 8.4 | Refusing the prompt | Decline Chrome's permission prompt → red notice, no Salesforce window opens, still in local mode. | ✅ auto |
| 8.5 | Sign-in | Salesforce login appears in a popup, not a tab. After approving, the popup closes and the bar shows the org host and *never refreshed*. | ❓ |
| 8.6 | No automatic read | After connecting, **no** deployments appear until you press Refresh. | ✅ auto |
| 8.7 | Refresh | **Refresh** → releases appear, one per recent deployment, named by deploy id. Bar shows *refreshed just now*. | ❓ (mapping ✅ auto) |
| 8.8 | Components | Open a release in the Inspector → its components are listed; `package.xml` is **not** among them. | ✅ auto |
| 8.9 | Dependencies say "unknown" | A component detail must **not** read "No recorded dependencies". It must say dependency data is unavailable from a deploy report. | ✅ auto (data), ❓ (wording on screen) |
| 8.10 | Coverage | Apex classes show a coverage percentage; a class with no lines shows *Coverage unknown*, never 0%. | ✅ auto |
| 8.11 | Approvals survive a refresh | Approve something, press Refresh, confirm the decision is still there. | ✅ auto |
| 8.12 | Approvals never reach the org | Setup → check no records were created anywhere. There is no write path. | ❓ |
| 8.13 | Staleness | Wait 15 minutes without refreshing → an amber banner says the data may be out of date. | ❓ |
| 8.14 | Disconnect | **Disconnect** → back to local data, *Site access* empty again on the extension card, and Setup → Connected Apps OAuth Usage no longer lists a session. | ❓ |
| 8.15 | Browser restart | Connect, quit Chrome, reopen. You are signed out (the refresh token lives in session storage) but the cached org data is still on screen. | ❓ |

### Failure modes (§8 of DATASOURCE.md)

| # | Check | Expected | Status |
| --- | --- | --- | --- |
| 8.16 | Revoke site access mid-session | `chrome://extensions` → set Site access to "On click" → Refresh in the panel → notice with a **Grant access** button; cached data stays on screen. | ✅ auto (state), ❓ (real revoke) |
| 8.17 | Revoke the token in Setup | Setup → Connected Apps OAuth Usage → Revoke → Refresh → *session expired* notice with **Reconnect**. It must not loop or re-prompt on its own. | ❓ |
| 8.18 | Org unreachable | Go offline → Refresh → the cached snapshot stays on screen under *Showing cached org data … not live*, with **Try again**. The panel must never blank. | ✅ auto |
| 8.19 | API budget | Hard to stage deliberately; verify the numbers appear and that the notice offers **no** retry button. | ✅ auto only |
| 8.20 | Unparseable response | Cannot be staged without a proxy. Verify the message names the offending field. | ✅ auto only |

## 9. Requires a live org

Everything below is **unverifiable without a real Salesforce org and a real
Chrome**. It is listed rather than faked into a passing test.

| Area | What only a live org can confirm |
| --- | --- |
| OAuth round trip | That the authorize URL, PKCE challenge, redirect URI and token exchange are accepted by Salesforce end to end. The flow is fully unit-tested against a fake, which proves our side of the contract and nothing about theirs. |
| Connected App setup | That the steps in `CONNECTED-APP.md` are correct and complete — particularly that PKCE on / "Require Secret" off is the combination that works. |
| `chrome.identity` behaviour | That `launchWebAuthFlow` returns the redirect we expect, and that `getRedirectURL()` matches the Callback URL exactly. |
| Permission gesture | **The highest-risk unknown.** `permissions.request` needs a user gesture; it is called from the panel for that reason, but that has never been executed in a browser. If Chrome refuses it, connecting fails at the first step. |
| Real API shapes | That `DeployRequest`, its `DeployResult.details`, and `ApexCodeCoverageAggregate` match the fixtures in `test/fixtures/salesforce.ts`. Those were written from the documented shapes, not captured from an org. |
| Tooling API field availability | That `CreatedBy.Name` and `DeployResult` are queryable on `DeployRequest` in the target API version. |
| API call cost | That a refresh really costs 1 + N + 3 calls, and what that does to a busy org's budget. |
| Token lifetime | That the 30-minute fallback expiry is sensible when Salesforce omits `expires_in`, and that proactive refresh behaves. |
| Session storage | That `chrome.storage.session` really is cleared on browser close in the target Chrome build. |
| Revocation | That `/services/oauth2/revoke` accepts the refresh token and that Setup then shows no session. |

## 10. What no amount of manual QA will cover

These are absent from the product, not untested in it:

- **Approvals never reach the org, by design.** Salesforce has no
  deployment-approval object; see decision 2 in `DATASOURCE.md`.
- **Demo data is sample data.** The five releases and 57 components in
  `src/data/seed.ts` are fictional. Org-connected mode never shows them — an
  org with no refresh yet shows an empty panel and says so.
- **Approvals are not authenticated.** *Acting as* is a local profile switcher.
  Anyone can export the JSON, edit a decision, and re-import it.
- **Nothing is shared between machines.** Two installs are two independent
  snapshots.
