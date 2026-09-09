# Chrome Web Store listing

Everything needed to submit, written out so submission is copy-and-paste rather
than improvisation at the form.

**Not submitted.** Publishing needs a Chrome Web Store developer account (a
one-off USD 5 registration). Nothing here has been through review, and the
review outcome is genuinely unknown until someone tries.

---

## 1. Store listing fields

**Extension name** (45 char max)

```
sf-releaselens
```

**Short description** (132 char max — this is what shows in search results)

```
Release dashboard, metadata inspector and approvals helper for Salesforce release managers. Read-only, local-first.
```

*(114 characters.)*

**Category:** Developer Tools
**Language:** English (UK)

**Detailed description**

```
sf-releaselens puts three things a Salesforce release manager checks all day
into one side panel: what is in flight, what is actually in a release, and what
is waiting on you.

WHAT IT DOES

• Release dashboard — every tracked release summarised by status, with the
  blocked and failed ones sorted to the top. Click a status to filter, click a
  release to see inside it.

• Metadata inspector — search components by name, type, path or author. Filter
  by metadata type or operation. Open one to see its coverage, its warnings, and
  what depends on it.

• Approvals helper — the promotion gates waiting on you, separated from the ones
  waiting on someone else. Approve or reject with a comment, and see the effect
  on the release status immediately.

HOW IT GETS DATA

Three ways, and it is always clear which you are looking at:

• Demo data, shipped with the extension so you can evaluate it in one click.
  Clearly labelled. Entirely fictional.
• A file you import — either a previous export, or the JSON from
  `sf project deploy report --json`.
• A Salesforce org you connect, using a Connected App you create in your own
  org. Read-only.

WHAT IT DOES NOT DO

• It never writes to your Salesforce org. The interface it uses to reach
  Salesforce has no create, update or delete operation at all.
• It never reads the page you are on. There are no content scripts and no tabs
  permission.
• It never polls. Data is read from your org only when you press Refresh.
• It sends no analytics or error reports. Telemetry is opt-in, off by default,
  and no endpoint is configured — switched on, it would still send nothing.
• Approvals recorded here are a workflow aid, not an audit trail. There is no
  server, so the acting profile is not an authenticated identity. If you need an
  approval record that stands up to an audit, this is not it.

Open source, MIT licensed: https://github.com/muraliseelam/sf-releaselens
```

---

## 2. Privacy practices

This is the section submissions are rejected over. Answer precisely; a vague
justification reads as a request for more access than is needed.

**Single purpose**

```
A read-only dashboard for Salesforce release managers: it summarises deployments,
lets the user search the metadata components in them, and tracks local approval
sign-offs. Every feature serves that one purpose.
```

### Permission justifications

| Permission | Justification to paste |
| --- | --- |
| `storage` | `Stores the release snapshot the panel displays, the cached copy of data read from the connected org, and the user's own display preferences. All of it is local to the browser profile. Without it the panel would be empty on every open and every approval decision would be lost.` |
| `sidePanel` | `The entire user interface is a side panel, so that it can stay open beside a Salesforce tab while the user cross-checks a release. There is no other UI surface.` |
| `identity` | `Used only for chrome.identity.launchWebAuthFlow, to run an OAuth 2.0 authorization-code flow with PKCE against a Connected App the user creates in their own Salesforce org. This is what lets the extension read the org without ever handling a password, and without the extension author operating any identity service. It is not used to read the user's Google identity, and getProfileUserInfo is never called.` |
| `https://*.salesforce.com/*` (optional) | `Requested only when the user chooses to connect an org, and only then. Covers the Salesforce login host (login.salesforce.com or test.salesforce.com), which is where the OAuth token exchange and token revocation endpoints live. Not granted at install.` |
| `https://*.my.salesforce.com/*` (optional) | `Requested only when the user chooses to connect an org. This is the user's own org instance, where the read-only REST and Tooling API calls go. The exact instance host is not known until after sign-in completes, which is why the pattern is by domain rather than by exact origin; the extension calls no host other than the one org the user connected.` |

### Data usage disclosures

Tick exactly these, and no others:

| Question | Answer |
| --- | --- |
| Does it collect personally identifiable information? | **No** |
| Health information? | **No** |
| Financial and payment information? | **No** |
| Authentication information? | **Yes** — see the note below |
| Personal communications? | **No** |
| Location? | **No** |
| Web history? | **No** |
| User activity (clicks, mouse position, keystrokes)? | **No** |
| Website content? | **No** |

Authentication information note:

```
An OAuth access token and refresh token for the Salesforce org the user chose to
connect. Both are held only in the user's own browser: the access token in
service-worker memory, the refresh token in chrome.storage.session, which Chrome
clears when the browser closes. Neither is written to disk, transmitted anywhere
other than the user's own Salesforce org, or visible to the extension author.
There is no server operated by this extension.
```

Certifications:

- **I do not sell or transfer user data to third parties**, outside the approved use cases — ✅
- **I do not use or transfer user data for purposes unrelated to my item's single purpose** — ✅
- **I do not use or transfer user data to determine creditworthiness or for lending purposes** — ✅

**Privacy policy URL:** required because the extension handles authentication
information. Publish `SECURITY.md`'s threat model, or a page derived from it, at
a stable URL and use that.

---

## 3. Screenshot shot list

Chrome accepts 1280×800 or 640×400. Use **1280×800**, five screenshots. The side
panel is narrow, so compose each shot as the panel beside a Salesforce tab
rather than the panel alone on a white field.

| # | Shot | What must be visible | Why |
| --- | --- | --- | --- |
| 1 | Release dashboard | The `5 releases tracked · 2 need attention` headline, the status chips including the zero ones, and the blocked release sorted first with its red edge. | The first screenshot is the one that decides whether anyone reads the second. |
| 2 | Metadata inspector, filtered | The search box with a term typed, the type facet chips, and the `21 of 57 components` caption. | Shows the tool is about narrowing, not scrolling. |
| 3 | Component detail, imported | A component from an imported deploy report, showing the amber *Dependency data is not available* notice in both directions. | Demonstrates the honesty of the data model, which is the differentiator. Coverage and the unavailable notice cannot appear together — coverage comes from the demo dataset, the notice from an import — so this shot carries the notice and shot 2 carries the rest. |
| 4 | Approvals | The three queues, and a decision just recorded showing the release status change in place. | Shows the one interactive workflow. |
| 5 | Org connection | The connect form: login URL, Consumer Key, and the note that no client secret is accepted. | Shows that the org integration uses a Connected App the reviewer creates themselves. A *connected* strip would have to be staged, since there is no live org; if you have one, capture that state by hand and replace this plate. |

**Before recording**

- Reset to demo data (**Start empty**, then reload, then reinstall the demo set)
  so the numbers match the ones quoted in §1 and in the README.
- Use the light theme; the store's own chrome is light and a dark panel on a
  light page reads as an error.
- No real org name, username, instance URL or deploy id may appear in any shot.
  Demo data is safe by construction; a connected-org shot is not — blur or use a
  scratch org with a fictional name.

**Generating them:** `npm run assets` drives the real extension in Chromium and
writes these five plates at 1280×800 into `build-assets/store/`, plus a video of
the walkthrough. See [`ASSETS.md`](ASSETS.md). Nothing is hand-composed, so a
plate cannot show a state the product does not reach.

**Promotional tiles** are generated by the same command, into
`build-assets/promo/`, from the icon definition rather than composed by hand.

| Tile | Size | Store position |
| --- | --- | --- |
| Small | 440×280 | **Required.** A listing missing it is rejected — an earlier version of this document called it optional, which was wrong |
| Marquee | 1400×560 | Optional, in the sense that never being featured is optional |

Neither carries text. The store asks that promotional images avoid it, and
this project has no font renderer — plotted letterforms would look worse than
their absence.

---

## 4. Before submitting

See **[`STORE-SUBMISSION.md`](STORE-SUBMISSION.md)** — the single checklist,
kept there rather than here so there is one list rather than two that drift.

The short version: `npm run check` now runs `verify:package`, which fails if
any permission in the manifest is missing a justification above, or if any
justification above is for a permission the manifest does not request. So §2 of
this document cannot silently go stale. What it cannot check — a paid developer
account, a published privacy policy URL, and a human loading the packaged zip —
is listed there as not done.
