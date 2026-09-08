/**
 * Credentials and connections for the live-org tests, from the `sf` CLI.
 *
 * This is the only file that knows how to obtain a real access token, and it
 * obtains it from the CLI's own auth store rather than asking anyone for one.
 * Two consequences worth stating:
 *
 *  - **Nothing here is written down.** The token lives in a closure for the
 *    duration of a process and is never logged, never serialised, never put in
 *    a fixture. `redactForOutput` exists for anything that might be printed.
 *  - **Read-only, by construction.** The connection handed out is the
 *    extension's own `OrgConnection`, whose interface has `get`, `toolingQuery`
 *    and `queryMore` and no write member at all. There is no code path from
 *    here that could modify an org even by mistake.
 *
 * The CLI's token is a *session* token for the `PlatformCLI` connected app, not
 * the token the shipped extension would hold. That difference does not matter
 * for a contract test: the API responses are identical, and what is under test
 * is the shape of what Salesforce returns.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Where the Salesforce CLI installs on Windows, when it is not already on PATH. */
const WINDOWS_SF_PATH = 'C:\\Program Files\\sf\\bin';

function environment() {
  const path = process.env['PATH'] ?? '';
  return path.includes(WINDOWS_SF_PATH) || process.platform !== 'win32'
    ? process.env
    : { ...process.env, PATH: `${path};${WINDOWS_SF_PATH}` };
}

/**
 * Runs the CLI.
 *
 * On Windows `sf` is a `.cmd` shim, and Node refuses to `execFile` one
 * directly. The alternative usually reached for is `shell: true`, which
 * concatenates the arguments into a command line instead of escaping them —
 * so this goes through `cmd /c` with the arguments still as an array, which
 * keeps them separate.
 */
async function sf(args) {
  const [command, commandArgs] =
    process.platform === 'win32'
      ? [process.env['ComSpec'] ?? 'cmd.exe', ['/c', 'sf', ...args]]
      : ['sf', args];

  const { stdout } = await run(command, commandArgs, {
    env: environment(),
    // A large org list carries a token per org and outgrows the default buffer.
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

/**
 * @returns the aliases the CLI is currently authenticated to, or `[]` when the
 *          CLI is absent or has no orgs. Never throws: "no org available" is a
 *          skip, not a failure.
 */
export async function listOrgAliases() {
  return (await listOrgs()).map((org) => org.alias);
}

/**
 * Connected orgs with the facts `org list` carries and `org display` does not —
 * `namespacePrefix` in particular, which is the one that matters here and is
 * absent from `org display`'s output.
 */
export async function listOrgs() {
  try {
    const result = await sf(['org', 'list', '--json']);
    const all = [
      ...(result?.result?.nonScratchOrgs ?? []),
      ...(result?.result?.scratchOrgs ?? []),
      ...(result?.result?.sandboxes ?? []),
    ];
    const byAlias = new Map();
    for (const org of all) {
      if (org.connectedStatus !== 'Connected') continue;
      const alias = org.alias ?? org.username;
      if (typeof alias !== 'string' || alias.length === 0) continue;
      // `org list` repeats an org across buckets; first wins.
      if (!byAlias.has(alias)) {
        byAlias.set(alias, {
          alias,
          namespacePrefix: org.namespacePrefix ?? null,
          instanceApiVersion: org.instanceApiVersion ?? null,
          isSandbox: org.isSandbox ?? null,
          isScratch: org.isScratch ?? null,
        });
      }
    }
    return [...byAlias.values()];
  } catch (cause) {
    void cause;
    return [];
  }
}

/**
 * Everything needed to talk to one org, plus the facts about it that a
 * compatibility report should record.
 *
 * `accessToken` is returned so the caller can build a connection. It must not
 * be stored, printed or passed anywhere else.
 */
export async function describeOrg(alias) {
  const result = await sf(['org', 'display', '--target-org', alias, '--json']);
  const org = result?.result;
  if (org?.accessToken === undefined || org?.instanceUrl === undefined) {
    throw new Error(`sf org display returned no token or instance URL for "${alias}"`);
  }
  // `org display` omits namespacePrefix, so the listing supplies it.
  const listed = (await listOrgs()).find((entry) => entry.alias === alias);

  return {
    alias,
    accessToken: org.accessToken,
    instanceUrl: org.instanceUrl,
    /** Reported by the CLI, e.g. `67.0`. The org's own API version. */
    instanceApiVersion: org.apiVersion ?? listed?.instanceApiVersion ?? null,
    namespacePrefix: listed?.namespacePrefix ?? null,
    isSandbox: listed?.isSandbox ?? null,
    isScratch: listed?.isScratch ?? null,
    /** For the compatibility table. Never the org id or username. */
    instanceHostPattern: classifyHost(org.instanceUrl),
  };
}

function classifyHost(instanceUrl) {
  try {
    const host = new URL(instanceUrl).host.toLowerCase();
    if (host.endsWith('.develop.my.salesforce.com')) return '*.develop.my.salesforce.com';
    if (host.endsWith('.sandbox.my.salesforce.com')) return '*.sandbox.my.salesforce.com';
    if (host.endsWith('.my.salesforce.com')) return '*.my.salesforce.com';
    if (host.endsWith('.salesforce.com')) return '*.salesforce.com';
    return 'other (not covered by the manifest)';
  } catch (cause) {
    void cause;
    return 'unparseable';
  }
}

/**
 * Strips anything credential-shaped out of a value before it is printed or
 * written anywhere.
 *
 * A thin wrapper over the extension's own redactor so the harness cannot drift
 * from what the product considers a secret — but the harness never relies on it
 * alone: fixtures are built by picking fields, not by filtering.
 */
export async function redactForOutput(text) {
  const { redact } = await import('../dist/core/redact.js');
  return redact(text);
}
