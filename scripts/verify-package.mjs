/**
 * Verifies the built extension against Chrome Web Store policy.
 *
 *   node scripts/verify-package.mjs
 *
 * It exists because `docs/STORE-LISTING.md` is prose about a manifest, and
 * prose about a manifest goes quietly wrong the moment the manifest changes.
 * The check that could not be done by reading is the two-way one: every
 * permission requested must be justified, and every justification must be for a
 * permission that is actually requested.
 *
 * Runs inside `npm run check`, after the build, so drift fails the commit that
 * introduced it rather than the submission six months later. The zip checks
 * skip when no zip is present, because `npm run check` does not package.
 *
 * It reports every finding, not the first. A run that stops at one problem
 * turns a ten-second check into ten runs.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkManifest,
  classifyShippedFile,
  diffPermissions,
  parseJustifications,
  requestedPermissions,
  reportUnscannable,
  scanForRemoteCode,
  screenZipEntries,
} from './lib/store-policy.mjs';
import { readZipEntryNames } from './lib/zip.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(projectRoot, 'dist');
const ZIP = join(projectRoot, 'sf-releaselens.zip');
const LISTING = join(projectRoot, 'docs', 'STORE-LISTING.md');
const SOURCE_MANIFEST = join(projectRoot, 'src', 'manifest.json');

/** Not shipped, so not scanned and not measured. Matches the packager. */
const NOT_SHIPPED = ['.map', '.d.ts', '.tsbuildinfo'];

/*
 * Which files the scanner can read is decided in store-policy.mjs, along with
 * which it may skip. Nothing is skipped silently: see `reportUnscannable`.
 */

/**
 * A refusal to run at all, as distinct from a finding.
 *
 * Same posture as the rest of the project: a verdict derived from no artefact
 * would be worse than no verdict, so this aborts rather than reporting a pass.
 */
class Fatal extends Error {}

async function walk(directory, into = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path, into);
    } else if (!NOT_SHIPPED.some((suffix) => path.endsWith(suffix))) {
      into.push(path);
    }
  }
  return into;
}

const asPosix = (path) => relative(DIST, path).split(sep).join('/');

async function preflight() {
  const dist = await stat(DIST).catch(() => undefined);
  if (dist === undefined) {
    throw new Fatal('dist/ does not exist. Run `npm run build` first.');
  }

  const built = await stat(join(DIST, 'manifest.json')).catch(() => undefined);
  if (built === undefined) {
    throw new Fatal('dist/manifest.json does not exist. Run `npm run build` first.');
  }

  const source = await stat(SOURCE_MANIFEST);
  if (source.mtimeMs > built.mtimeMs) {
    throw new Fatal(
      'src/manifest.json is newer than dist/manifest.json. Run `npm run build` — verifying a stale build says nothing about what would be uploaded.',
    );
  }
}

async function main() {
  await preflight();

  const findings = [];
  const notes = [];

  const manifest = JSON.parse(await readFile(join(DIST, 'manifest.json'), 'utf8'));
  const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const shipped = (await walk(DIST)).map(asPosix).sort();
  const shippedSet = new Set(shipped);

  findings.push(
    ...checkManifest(manifest, {
      packageVersion: packageJson.version,
      iconExists: (path) => shippedSet.has(path),
    }),
  );

  const requested = requestedPermissions(manifest);
  const justified = parseJustifications(await readFile(LISTING, 'utf8'));
  findings.push(...diffPermissions({ requested, justified }));
  notes.push(`${requested.length} permissions requested, each justified in docs/STORE-LISTING.md`);

  let scanned = 0;
  for (const path of await walk(DIST)) {
    if (classifyShippedFile(asPosix(path)) !== 'scan') continue;
    scanned += 1;
    findings.push(...scanForRemoteCode(asPosix(path), await readFile(path, 'utf8')));
  }
  // Every shipped file is accounted for: read, or refused by name.
  findings.push(...reportUnscannable(shipped));
  const inert = shipped.length - scanned;
  notes.push(
    `${scanned} shipped text files scanned for remotely hosted code, ${inert} known-inert (images, fonts) skipped by name`,
  );

  const zip = await readFile(ZIP).catch(() => undefined);
  if (zip === undefined) {
    notes.push('package checks skipped: no sf-releaselens.zip (run `npm run package`)');
  } else {
    const entries = readZipEntryNames(zip);
    findings.push(...screenZipEntries(entries, shipped));
    notes.push(`${entries.length} archive entries screened, all present in dist/`);
  }

  report(findings, notes, manifest);
}

function report(findings, notes, manifest) {
  const out = process.stdout;

  if (findings.length > 0) {
    out.write(`\nsf-releaselens: ${findings.length} store-policy problem(s).\n\n`);
    for (const finding of findings) out.write(`  [${finding.check}] ${finding.message}\n`);
    out.write('\nSee docs/STORE-SUBMISSION.md.\n');
    process.exitCode = 1;
    return;
  }

  for (const note of notes) out.write(`  ok  ${note}\n`);
  out.write(`\n${manifest.name} ${manifest.version} is consistent with its submission paperwork.\n`);

  /*
   * Printed rather than filed away, because it is the answer to a form field
   * the developer has to fill in by hand, and the whole point of this script is
   * that the answer should come from the artefact. The remote-code question is
   * a radio button with no free-text box, so this is what to have ready if a
   * reviewer asks how the package was built, not something to paste in.
   */
  out.write(
    '\nRemote code: answer "No, I am not using remote code". There is no free-text\n' +
      'field for that answer; have this ready if a reviewer asks how the package was\n' +
      'built:\n\n',
  );
  out.write(
    '  No, I am not using remote code. Every file the extension executes is inside the\n' +
      '  uploaded package. The build is the TypeScript compiler plus a copy step over a\n' +
      '  first-party source tree with no runtime dependencies: no bundler, no minifier and\n' +
      '  no vendored library, so the shipped JavaScript is the TypeScript compiler output\n' +
      '  of the source at https://github.com/muraliseelam/sf-releaselens. There is no eval,\n' +
      '  no new Function, no dynamic import, no remote script or stylesheet, and no relaxed\n' +
      '  content security policy.\n',
  );
}

main().catch((cause) => {
  const prefix = cause instanceof Fatal ? '' : 'verification failed: ';
  process.stderr.write(`\nsf-releaselens: ${prefix}${cause.message}\n`);
  process.exitCode = 1;
});
