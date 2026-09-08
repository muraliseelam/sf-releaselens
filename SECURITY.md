# Security policy

## Reporting a vulnerability

Report privately, not in a public issue.

Use GitHub's private vulnerability reporting: the **Security** tab of this
repository → **Report a vulnerability**. That opens a channel visible only to the
maintainers.

If that button is not available, email the maintainer at the address on the
commits in this repository's history, with `sf-releaselens security` in the
subject.

Please include what you can of: the version or commit, the browser and Chrome
version, what an attacker gains, and the smallest reproduction you have. A
proof-of-concept helps but is not required to report.

**Do not include a real access token, refresh token, Consumer Key, org username,
instance URL or deploy id in the report.** If a redaction failure is the bug,
describe the shape of what leaked rather than pasting the value.

### What to expect

This is a single-maintainer side project, so be honest with yourself about the
timelines before relying on them:

| | Target |
| --- | --- |
| Acknowledgement | 5 working days |
| First assessment (confirmed / not a vulnerability / need more) | 15 working days |
| Fix for a confirmed issue affecting tokens or the org boundary | as fast as I can, and I will tell you the date I expect |
| Public disclosure | after a fix ships, or 90 days from the report, whichever is first |

Credit in the release notes and the advisory unless you would rather not be
named. There is no bug bounty.

### Supported versions

Only the latest release. This project is pre-1.0 and there are no maintenance
branches; a fix ships as a new release, not a backport.

---

## Threat model

This is the section worth reading before you install anything into a browser that
is signed in to a production Salesforce org. It describes what the extension can
reach, not what it intends to do — an intention is not a control.

### What the extension can see

| | |
| --- | --- |
| **The page you are on** | Nothing. There are no content scripts, no `tabs` permission, no `activeTab`, and no `scripting` permission. The extension cannot read, or even enumerate, your open tabs. |
| **Your browsing history** | Nothing. No `history` or `webNavigation` permission. |
| **Your cookies** | Nothing. No `cookies` permission, and the extension does not read a Salesforce session out of an open tab — a design decision, recorded in `docs/DATASOURCE.md`, not an oversight. |
| **The network** | Nothing at install: the manifest declares **no** `host_permissions`, only `optional_host_permissions`. Until you connect an org and Chrome prompts you to grant that origin, the extension cannot make a cross-origin request at all. |
| **Your Salesforce org, once connected** | Whatever the OAuth `api` scope allows for **your own user**. It cannot exceed your own permissions. In practice it reads `Organization`, the ten most recent `DeployRequest` records with their components, and `ApexCodeCoverageAggregate`. |

### What it stores, and where

| Data | Area | On disk? | Cleared by |
| --- | --- | --- | --- |
| Access token | Service-worker memory only. Never passed to any storage area. | No | Worker suspension, browser close, **Disconnect** |
| Refresh token (`sf-releaselens.org-session.v1`) | `chrome.storage.session` | **No** — session storage is memory-backed | Browser close, **Disconnect** |
| Consumer Key (`sf-releaselens.org-settings.v1`) | `chrome.storage.local` | Yes | **Disconnect** |
| Local snapshot (`sf-releaselens.snapshot.v1`) | `chrome.storage.local` | Yes | **Start empty** |
| Org data cache (`sf-releaselens.org-snapshot.v1`) | `chrome.storage.local` | Yes | **Disconnect**, **Start empty** |
| Release name overlay (`sf-releaselens.release-overlay.v1`) | `chrome.storage.local` | Yes | **Start empty** |

The Consumer Key of a PKCE public client is a public identifier, not a secret —
it is embedded in the authorization URL that appears in the browser address bar.
There is no client secret, and the token exchange refuses to send one.

`chrome.storage.local` is **not encrypted**. The org cache on disk contains
release names, deploy ids, component names and paths, authors and coverage
figures. That is org metadata, never record data and never a credential — but if
your policy says org metadata may not rest unencrypted on a laptop, this
extension is not compliant with it, and **Disconnect** is the answer.

### What it deliberately does not do

Each of these is enforced by something a reviewer can check, not by good
intentions:

- **No write path to your org.** The `OrgConnection` port has `get` and two query
  methods and no `post`, `patch` or `delete` member at all. Adding a write means
  changing that interface, which is a visible diff.
- **No arbitrary network access.** An ESLint rule (`no-restricted-globals`)
  restricts `fetch` to exactly two files: the org transport and the token
  exchange. Every outbound request in the product is reviewable in two files, and
  CI fails if a third appears.
- **No polling, no timers, no background fetch.** The org is read only when you
  press **Refresh**. There is no `chrome.alarms` permission, so the service
  worker cannot be woken on a schedule even if someone tried.
- **No telemetry, no analytics, no error reporting.** Nothing is sent anywhere
  except to the one org you connected. There is no opt-out because there is
  nothing to opt out of.
- **No shared Connected App.** The OAuth client is one **you** create in your own
  org, so the maintainer is not in your auth path and cannot be compromised into
  it.
- **No token in a log or an error.** Every auth and transport error passes
  through a three-layer redactor — known secret values, shape matching, and
  opaque high-entropy runs — and a test asserts that no token value can appear in
  a serialized error.

### What the extension does *not* protect you from

Stated plainly, because a threat model that only lists strengths is marketing:

- **Anything with access to your browser profile.** `chrome.storage.local` is a
  file on disk readable by any process running as you, and by any tool with your
  profile directory. The refresh token avoids this by living in session storage;
  the cached org metadata does not.
- **Another extension with `management` or debugger access**, or a malicious
  native messaging host. Chrome's extension isolation is the boundary here, and
  it is not one this project controls.
- **A compromised dependency in the build.** The shipped extension has **zero**
  runtime dependencies, which removes the supply-chain path into the published
  artefact — but the toolchain that builds it has development dependencies like
  any project. CI pins actions to commit SHAs, runs `npm audit --omit=dev` as a
  gate, and Dependabot proposes updates; the packaging step is deterministic, so
  a released zip can be rebuilt and compared byte-for-byte from its tag.
- **Someone editing an exported snapshot.** Import validates shape, not
  provenance. See the next point.
- **A dishonest approval.** Approvals are local, unauthenticated state. The
  "acting as" profile is a switcher, not an identity, and anyone who can open the
  panel can record a decision as anyone else — or export the JSON, edit it, and
  import it back. **Approvals here are a workflow aid and are not an audit
  trail.** If a control needs to survive an auditor, this is not that control.

### If you find a token where one should not be

That is the highest-severity class of bug in this project. Report it privately
using the process above, and describe the shape rather than pasting the value.
