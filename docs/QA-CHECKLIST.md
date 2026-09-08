# Manual QA checklist

## Why this document exists

Nobody has yet loaded this extension into a real Chrome. The automated suite
(343 tests) and two harnesses that drive the **built `dist/` output** under jsdom
cover the logic and the DOM, but they cannot cover Chrome itself: browser
automation tooling is blocked from interacting with `chrome://` URLs at all — it
cannot navigate there, and cannot even screenshot such a page — so *Load
unpacked* cannot be automated. A side panel is also not a tab, so it would not be
drivable even once loaded.

Everything in **§3 Browser-only** below is therefore **unverified**. Treat it as
outstanding work, not as a formality.

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
npm run check     # must exit 0; emits 107 files into dist/
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select `C:\EB1A\chrome-extension\dist` (the `dist`
   directory itself, not the repo root).

| # | Check | Expected | Status |
| --- | --- | --- | --- |
| 1.1 | The extension loads | Card appears: *sf-releaselens 0.1.0*. **No errors** button on the card. | ❓ |
| 1.2 | Permissions | Card shows only *storage* and *sidePanel*. No host permissions, no site access. | ❓ |
| 1.3 | Service worker | Card shows *service worker* as **active** or *inactive* — never *errored*. Click it: DevTools console must be empty. | ❓ |
| 1.4 | Icon | Chrome shows the **default grey puzzle piece** — the extension ships no icons. Expected, and a known gap. | ❓ |

## 2. Open the side panel

| # | Check | Expected | Status |
| --- | --- | --- | --- |
| 2.1 | Toolbar click opens the panel | Clicking the toolbar icon opens the side panel directly (set by `sidePanel.setPanelBehavior({openPanelOnActionClick:true})` on install). | ❓ (behaviour call ✅ dist) |
| 2.2 | Panel renders | Header *sf-releaselens*, three tabs, and a blue **Demo data** banner. | ❓ (markup ✅ dist) |
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

## 8. What no amount of manual QA will cover

These are absent from the product, not untested in it:

- **No Salesforce connection.** All data is local; nothing reaches an org. See
  `docs/DATASOURCE.md`.
- **Demo data is sample data.** The five releases and 57 components in
  `src/data/seed.ts` are fictional.
- **Approvals are not authenticated.** *Acting as* is a local profile switcher.
  Anyone can export the JSON, edit a decision, and re-import it.
- **Nothing is shared between machines.** Two installs are two independent
  snapshots.
