# Creating the Connected App

sf-releaselens has no Salesforce identity of its own. To connect an org you
create a Connected App **in that org**, and the extension signs in against it.

That is deliberate. The alternative — us publishing a Connected App everyone
uses — would make this project an identity party in your org's trust chain,
with a client id we control and a revocation switch we hold. A Connected App you
own is one you can inspect, restrict by profile, and revoke without asking us.

**Nothing in this document is a secret.** The Consumer Key is a public
identifier. There is no Consumer Secret in this flow: the extension is a PKCE
public client, and it will not accept a secret if you try to give it one.

---

## 1. Get your redirect URI first

It contains your local extension id, so it differs per installation.

1. Load the extension (`chrome://extensions` → Developer mode → Load unpacked →
   `dist/`).
2. Copy the **ID** shown on the extension card, e.g. `abcdefghijklmnopabcdefghijklmnop`.
3. Your redirect URI is:

   ```
   https://<extension-id>.chromiumapp.org/
   ```

   The trailing slash matters. Salesforce compares this string exactly.

> If you reload the extension from the same directory the id stays the same. If
> you move the directory, the id changes and you must update the Connected App.

## 2. Create the Connected App

In the org you want to read, go to **Setup → App Manager → New Connected App**
(the "Create a Connected App" option if Setup offers you the newer flow).

**Basic Information**

| Field | Value |
| --- | --- |
| Connected App Name | `sf-releaselens` |
| API Name | `sf_releaselens` |
| Contact Email | yours |

**API (Enable OAuth Settings)**

| Setting | Value |
| --- | --- |
| Enable OAuth Settings | ✅ |
| Callback URL | `https://<extension-id>.chromiumapp.org/` |
| Enable Client Credentials Flow | ❌ leave off |
| Require Proof Key for Code Exchange (PKCE) | ✅ **on** |
| Require Secret for Web Server Flow | ❌ **off** |
| Require Secret for Refresh Token Flow | ❌ **off** |

The two "Require Secret" boxes must be **off**. A browser extension cannot keep
a secret, which is exactly the situation PKCE exists for; leaving them on makes
the token exchange fail with `invalid_client`.

**Selected OAuth Scopes** — add exactly these two:

| Scope | Why |
| --- | --- |
| `Manage user data via APIs (api)` | Read `Organization`, `DeployRequest` and `ApexCodeCoverageAggregate`. |
| `Perform requests at any time (refresh_token, offline_access)` | Keeps the panel working after the access token expires, without prompting again. |

Do **not** add `full`, `web`, or `chatter_api`. The extension requests only
`api refresh_token` and asking for more would grant access it never uses.

Save. Salesforce warns that changes can take up to 10 minutes to take effect;
in practice 2–3 is typical.

## 3. Copy the Consumer Key

**Setup → App Manager →** your app **→ View → Manage Consumer Details**. Copy the
**Consumer Key** (starts `3MVG9…`). Ignore the Consumer Secret; it is not used.

## 4. Connect

In the side panel: **Connect org…**, then

| Field | Value |
| --- | --- |
| Login URL | `https://login.salesforce.com` for production and developer orgs, `https://test.salesforce.com` for sandboxes, or your My Domain URL |
| Consumer Key | the value from step 3 |

Chrome asks for permission to access the org's origin. That prompt is the
extension asking for network access it does **not** have by default — the
manifest ships with `optional_host_permissions` and no granted hosts.

Then press **Refresh**. Nothing is read from the org until you do; there is no
polling and no background fetch.

## 5. Restricting who can use it (recommended)

**Setup → App Manager →** your app **→ Manage → Edit Policies**:

- **Permitted Users**: *Admin approved users are pre-authorized*, then assign
  the profiles or permission sets that should be able to connect.
- **IP Relaxation**: leave enforced unless you have a reason not to.
- **Refresh Token Policy**: *Expire refresh token after 90 days* is a reasonable
  default. Whatever you choose, the extension handles expiry by asking you to
  reconnect once — it never loops.

The extension only ever issues `GET` requests against `/services/data/`. It has
no write path: the connection interface it uses has no `post`, `patch` or
`delete` member, which is enforced by the type system and by a lint rule
restricting `fetch` to two files. If you want that guarantee at the org end too,
give the connecting profile read-only access.

## 6. Revoking

Any of these is sufficient, and none needs our cooperation:

| Where | Effect |
| --- | --- |
| Panel → **Disconnect** | Revokes the refresh token at the org, clears local token state, and hands the host permission back to Chrome. |
| Setup → **Connected Apps OAuth Usage** → Revoke | Kills every session for that user immediately. |
| `chrome://extensions` → **Site access** | Removes network access; the panel keeps working on cached data and says the permission is missing. |
| Quit Chrome | The refresh token lives in `chrome.storage.session`, which is cleared on browser close. You will sign in again next launch. |

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `redirect_uri_mismatch` | The Callback URL does not exactly match `https://<extension-id>.chromiumapp.org/`, usually a missing trailing slash or a changed extension id. |
| `invalid_client` on token exchange | "Require Secret for Web Server Flow" is still on. |
| `invalid_grant` right after signing in | PKCE is not enabled on the Connected App, or the app was saved less than a few minutes ago. |
| The panel says the org did not return a refresh token | The `refresh_token` scope is missing. |
| Sign-in works, then every read fails with a permission error | The Chrome host-permission prompt was dismissed. Use **Grant access** in the panel. |
| `INVALID_SESSION_ID` | The refresh token was revoked in Setup. Reconnect. |
