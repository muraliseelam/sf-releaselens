/**
 * Sets the release version in every file that carries one.
 *
 *   node scripts/set-version.mjs 1.2.3
 *
 * There are two sources of version truth in a browser extension and they must
 * agree: `package.json` is what the repo and semantic-release track, and
 * `src/manifest.json` is what Chrome actually shows the user. A release that
 * bumps one and not the other ships an extension whose version silently never
 * changes — so this script owns both, and semantic-release calls it instead of
 * using `@semantic-release/npm`.
 *
 * Chrome's manifest version must be one to four dot-separated integers, so a
 * prerelease like `1.2.3-beta.1` cannot go in verbatim. Rather than silently
 * mangling it, that is refused.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const version = process.argv[2];
if (version === undefined) {
  console.error('Usage: node scripts/set-version.mjs <version>');
  process.exit(2);
}

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(
    `Refusing to set version "${version}". Chrome's manifest accepts only dot-separated ` +
      'integers, so a prerelease or build-metadata version cannot be represented. ' +
      'Release a plain x.y.z, or add an explicit mapping here first.',
  );
  process.exit(1);
}

/** Rewrites one JSON file's `version` field, preserving key order. */
async function setVersion(relativePath) {
  const path = join(projectRoot, relativePath);
  const text = await readFile(path, 'utf8');
  const parsed = JSON.parse(text);
  const previous = parsed.version;
  parsed.version = version;
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  console.log(`  ${relativePath}: ${previous} -> ${version}`);
}

await setVersion('package.json');
await setVersion('package-lock.json');
await setVersion('src/manifest.json');

// package-lock also carries the version in its root package entry.
const lockPath = join(projectRoot, 'package-lock.json');
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
if (lock.packages?.['']?.version !== undefined) {
  lock.packages[''].version = version;
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

console.log(`sf-releaselens: version set to ${version}`);
