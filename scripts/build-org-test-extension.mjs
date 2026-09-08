/**
 * Builds a copy of `dist/` whose only difference is a pre-granted host
 * permission, for the browser tests that exercise the org-connected path.
 *
 *   node scripts/build-org-test-extension.mjs
 *
 * ## Why this exists
 *
 * The extension asks for its org host through `optional_host_permissions`, so
 * Chrome prompts the user at connect time. That prompt is browser chrome, not
 * page content: Playwright cannot click it, headless or headed. And an
 * extension loaded with `--load-extension` is not written to the profile's
 * preferences, so the grant cannot be seeded there either.
 *
 * Without a grant, `currentDataSource` throws `HostPermissionRevokedError` and
 * the org path is unreachable in a browser test — which would leave the
 * org-connected UI, the surface most likely to be wrong, tested only in jsdom.
 *
 * So this copies the built extension and moves those patterns from
 * `optional_host_permissions` to `host_permissions`, which Chrome grants at
 * install. **Nothing else changes**: same code, same manifest otherwise, same
 * service worker.
 *
 * The shipped extension must never do this, and does not: `panel.spec.ts`
 * asserts that `chrome.runtime.getManifest().host_permissions` is undefined in
 * the real artefact, and that assertion runs against `dist/`.
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(projectRoot, 'dist');
const OUT = join(projectRoot, '.org-test-extension');

async function main() {
  const manifestPath = join(DIST, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  if (!Array.isArray(manifest.optional_host_permissions)) {
    throw new Error('dist/manifest.json has no optional_host_permissions. Run `npm run build` first.');
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await cp(DIST, OUT, { recursive: true });

  const patched = {
    ...manifest,
    host_permissions: manifest.optional_host_permissions,
  };
  delete patched.optional_host_permissions;

  await writeFile(join(OUT, 'manifest.json'), `${JSON.stringify(patched, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `Built the org-test extension into ${OUT}\n` +
      `  host_permissions: ${patched.host_permissions.join(', ')}\n`,
  );
}

await main();
