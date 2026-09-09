/**
 * The Chrome Web Store checks, as pure functions.
 *
 * Everything here takes strings and objects and returns findings. The file
 * reading, the reporting and the exit code live in
 * `scripts/verify-package.mjs`, so the interesting logic is testable in vitest
 * without a `dist/` on disk. Same split as `scripts/lib/evidence.mjs`.
 *
 * A finding is `{ check, message }`. There is no severity: everything here
 * either draws a rejection or means a document is describing a build that does
 * not exist, and neither is a warning.
 *
 * Checked against the store's own documentation on 9 September 2026. Policy
 * moves — the 1 August 2026 update tightened Limited Use and the disclosure
 * rules — so re-read it before a submission rather than trusting this comment.
 */

/** Store limits, from the listing requirements. */
export const NAME_LIMIT = 45;
export const DESCRIPTION_LIMIT = 132;

/**
 * How short a permission justification may be before it reads as a shrug.
 *
 * Arbitrary, and said to be arbitrary in the failure message. The store
 * documents a thin justification as a rejection cause but names no length, so
 * the number here is a prompt to write a sentence rather than a rule from
 * anywhere.
 */
export const MIN_JUSTIFICATION = 120;

/** Fields the store rejects in an uploaded manifest. */
const FORBIDDEN_MANIFEST_KEYS = ['key', 'update_url'];

/**
 * Pulls the permission → justification map out of the listing document.
 *
 * The document is the source: it is what gets pasted into the form, so a check
 * against anything else would be checking the wrong thing. Rows look like
 *
 *     | `storage` | `Stores the release snapshot…` |
 *     | `https://*.salesforce.com/*` (optional) | `Requested only when…` |
 *
 * so the key is the first backticked span in the first cell and the
 * justification is the first backticked span in the second. A row whose first
 * cell has no backticks is a header or a separator and is skipped.
 *
 * @param {string} markdown contents of `docs/STORE-LISTING.md`
 * @returns {Map<string, string>}
 */
export function parseJustifications(markdown) {
  const found = new Map();

  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1);
    if (cells.length < 2) continue;

    const key = backticked(cells[0] ?? '');
    const justification = backticked(cells[1] ?? '');
    if (key === undefined || justification === undefined) continue;
    found.set(key, justification);
  }

  return found;
}

/** The contents of the first backtick pair, or undefined if there is none. */
function backticked(cell) {
  const match = /`([^`]+)`/.exec(cell);
  return match?.[1];
}

/**
 * Compares what the manifest asks for against what the document explains.
 *
 * Both directions matter, and the second one is the reason this is a script.
 * A missing justification is caught by the reviewer. A justification for a
 * permission the extension no longer requests is caught by nobody, and it tells
 * a reviewer the paperwork is not trustworthy — which is a worse thing for them
 * to conclude than that a sentence is missing.
 *
 * @param {{ requested: readonly string[], justified: Map<string, string> }} input
 * @returns {{ check: string, message: string }[]}
 */
export function diffPermissions({ requested, justified }) {
  const findings = [];
  const asked = new Set(requested);

  for (const permission of requested) {
    const justification = justified.get(permission);
    if (justification === undefined) {
      findings.push({
        check: 'permissions',
        message: `\`${permission}\` is requested in the manifest and has no justification in docs/STORE-LISTING.md.`,
      });
      continue;
    }
    if (justification.length < MIN_JUSTIFICATION) {
      findings.push({
        check: 'permissions',
        message:
          `The justification for \`${permission}\` is ${justification.length} characters. ` +
          `Under ${MIN_JUSTIFICATION} reads as a shrug to a reviewer. The threshold is arbitrary; ` +
          `the sentence it is asking for is "which user-visible feature needs this, and why would a narrower permission not do".`,
      });
    }
  }

  for (const permission of justified.keys()) {
    if (asked.has(permission)) continue;
    findings.push({
      check: 'permissions',
      message:
        `docs/STORE-LISTING.md justifies \`${permission}\`, which the manifest does not request. ` +
        `Remove the row: a justification for a permission that is not asked for tells a reviewer the paperwork is stale.`,
    });
  }

  return findings;
}

/** Every permission a store reviewer sees, in one list. */
export function requestedPermissions(manifest) {
  return [
    ...(manifest.permissions ?? []),
    ...(manifest.optional_permissions ?? []),
    ...(manifest.host_permissions ?? []),
    ...(manifest.optional_host_permissions ?? []),
  ];
}

/**
 * Patterns that would mean remotely hosted code.
 *
 * **This is a scan, not a proof.** It cannot see obfuscation and would miss
 * `window['ev' + 'al']`. It is worth having because of what this build is: tsc
 * plus a copy step over a first-party tree with no runtime dependencies, no
 * bundler and no minifier — so shipped output *is* source, and scanning it is
 * close to reading it. The failure it is built for is accident (a CDN font
 * link, a `new Function` in a JSON helper), not an attacker who owns the repo.
 */
const REMOTE_CODE_PATTERNS = [
  {
    label: 'eval',
    pattern: /\beval\s*\(/,
    why: 'MV3 forbids it and the default CSP blocks it.',
  },
  {
    label: 'new Function',
    pattern: /\bnew\s+Function\s*\(/,
    why: 'A string compiled at runtime is remotely hosted code as soon as the string is.',
  },
  {
    label: 'dynamic import of a non-relative target',
    // A static `import x from './y.js'` has no parenthesis and is not matched.
    pattern: /\bimport\s*\(\s*(?!['"]\.)/,
    why: 'Only a relative string literal can be proved to resolve inside the package.',
  },
  {
    label: 'chrome.scripting',
    pattern: /\bchrome\s*\.\s*scripting\b/,
    why: 'This extension declares no `scripting` permission, so its presence would mean the manifest is wrong.',
  },
];

/**
 * Scans one shipped file for remote-code patterns.
 *
 * @param {string} name path to report
 * @param {string} text file contents
 * @returns {{ check: string, message: string }[]}
 */
export function scanForRemoteCode(name, text) {
  const findings = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const { label, pattern, why } of REMOTE_CODE_PATTERNS) {
      if (!pattern.test(line)) continue;
      findings.push({
        check: 'remote-code',
        message: `${name}:${index + 1} uses ${label}. ${why}`,
      });
    }

    for (const reference of externalReferences(line)) {
      findings.push({
        check: 'remote-code',
        message: `${name}:${index + 1} loads \`${reference}\`, which is not a path inside the package.`,
      });
    }
  });

  return findings;
}

/** `src` and `href` targets on one line that are not relative paths. */
function externalReferences(line) {
  const found = [];
  const tag = /<(?:script|link|iframe)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']*)["']/gi;
  for (const match of line.matchAll(tag)) {
    const target = match[1] ?? '';
    if (isRelative(target)) continue;
    found.push(target);
  }
  return found;
}

function isRelative(target) {
  if (target === '') return false;
  if (target.startsWith('#')) return true;
  // `//host` is protocol-relative and just as remote as `https://host`.
  if (target.startsWith('//')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(target);
}

/**
 * The listing metadata the store reads out of the manifest itself.
 *
 * @param {object} manifest parsed `dist/manifest.json`
 * @param {{ packageVersion: string, iconExists: (path: string) => boolean }} context
 */
export function checkManifest(manifest, { packageVersion, iconExists }) {
  const findings = [];
  const fail = (message) => findings.push({ check: 'manifest', message });

  if (manifest.manifest_version !== 3) {
    fail(`manifest_version is ${JSON.stringify(manifest.manifest_version)}; the store accepts 3 only.`);
  }

  const name = typeof manifest.name === 'string' ? manifest.name : '';
  if (name.length === 0) fail('name is empty. A listing with no name is rejected.');
  if (name.length > NAME_LIMIT) {
    fail(`name is ${name.length} characters; the limit is ${NAME_LIMIT}.`);
  }

  const description = typeof manifest.description === 'string' ? manifest.description : '';
  if (description.length === 0) {
    fail('description is empty. A blank description field is an explicit rejection reason.');
  }
  if (description.length > DESCRIPTION_LIMIT) {
    fail(`description is ${description.length} characters; the limit is ${DESCRIPTION_LIMIT}.`);
  }

  if (manifest.version !== packageVersion) {
    fail(
      `manifest version ${manifest.version} does not match package.json ${packageVersion}. ` +
        `The store rejects a re-upload of a version it already has, so a stale manifest version wastes a submission.`,
    );
  }

  const icon128 = manifest.icons?.['128'];
  if (typeof icon128 !== 'string') {
    fail('No 128x128 icon is declared. The store requires one and rejects a listing without it.');
  } else if (!iconExists(icon128)) {
    fail(`The declared 128x128 icon ${icon128} is not in the build.`);
  }

  for (const key of FORBIDDEN_MANIFEST_KEYS) {
    if (key in manifest) {
      fail(`manifest contains \`${key}\`, which the store rejects in an uploaded package.`);
    }
  }

  findings.push(...checkContentSecurityPolicy(manifest));

  return findings;
}

/**
 * The CSP, if one is declared.
 *
 * No policy at all is the safe answer: MV3's default already forbids inline and
 * remote script, and every way of writing one down is a way of loosening it.
 */
function checkContentSecurityPolicy(manifest) {
  const policy = manifest.content_security_policy;
  if (policy === undefined) return [];

  const findings = [];
  const values = typeof policy === 'string' ? [policy] : Object.values(policy);

  for (const value of values) {
    if (typeof value !== 'string') continue;
    for (const forbidden of ["'unsafe-eval'", "'unsafe-inline'"]) {
      if (value.includes(forbidden)) {
        findings.push({
          check: 'remote-code',
          message: `content_security_policy contains ${forbidden}, which permits exactly what MV3 forbids.`,
        });
      }
    }
    if (/(?:script-src|script-src-elem)[^;]*https?:/i.test(value)) {
      findings.push({
        check: 'remote-code',
        message: 'content_security_policy allows a remote host in script-src.',
      });
    }
  }

  return findings;
}

/**
 * Screens the entries of the packaged zip.
 *
 * The zip is what a reviewer downloads and what they run their own scanners
 * over, so the question is not "does it work" but "is there anything in here
 * nobody decided to ship".
 *
 * @param {readonly string[]} entries forward-slash paths inside the archive
 * @param {readonly string[]} shipped forward-slash paths present in `dist/`
 */
export function screenZipEntries(entries, shipped) {
  const findings = [];
  const known = new Set(shipped);
  const fail = (message) => findings.push({ check: 'package', message });

  if (entries.length === 0) fail('The archive is empty.');

  for (const entry of entries) {
    if (entry.endsWith('.map')) fail(`${entry} is a source map and is not needed at runtime.`);
    if (entry.endsWith('.d.ts')) fail(`${entry} is a type declaration and is not shipped code.`);
    if (entry.split('/').some((part) => part.startsWith('.'))) {
      fail(`${entry} is a dotfile or lives under one.`);
    }
    if (entry.split('/').includes('node_modules')) fail(`${entry} is inside node_modules.`);
    if (!known.has(entry)) fail(`${entry} is in the archive but not in dist/.`);
  }

  return findings;
}
