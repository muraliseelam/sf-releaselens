/**
 * Packages `dist/` into `sf-releaselens.zip` — the artefact attached to a
 * GitHub Release and the file uploaded to the Chrome Web Store.
 *
 *   node scripts/package-extension.mjs
 *
 * Source maps and type declarations are excluded: they are build output, not
 * things the extension needs at runtime, and shipping `.d.ts` to the Web Store
 * is noise a reviewer has to read past.
 *
 * The archive is **reproducible**: entries are sorted and timestamps are fixed,
 * so packaging the same `dist/` twice gives byte-identical output. A release
 * artefact that changes because the clock moved cannot be verified by anyone.
 */

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createZip } from './lib/zip.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = join(projectRoot, 'dist');
const outputPath = join(projectRoot, 'sf-releaselens.zip');

/** Extensions that are build output rather than shipped code. */
const EXCLUDED = ['.map', '.d.ts', '.tsbuildinfo'];

async function collect(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collect(full)));
    } else if (!EXCLUDED.some((suffix) => entry.name.endsWith(suffix))) {
      found.push(full);
    }
  }
  return found;
}

async function main() {
  try {
    await stat(distRoot);
  } catch {
    throw new Error('dist/ does not exist. Run `npm run build` first.');
  }

  const files = (await collect(distRoot)).sort();
  if (files.length === 0) throw new Error('dist/ contains no files to package.');

  const manifest = files.find((file) => relative(distRoot, file) === 'manifest.json');
  if (manifest === undefined) {
    throw new Error('dist/manifest.json is missing; the archive would not load as an extension.');
  }

  const entries = [];
  for (const file of files) {
    entries.push({
      // ZIP requires forward slashes; Windows would otherwise produce an
      // archive Chrome reads as one file with a backslash in its name.
      name: relative(distRoot, file).split(sep).join('/'),
      data: await readFile(file),
    });
  }

  const zip = createZip(entries);
  await writeFile(outputPath, zip);

  const version = JSON.parse(await readFile(manifest, 'utf8')).version;
  console.log(
    `sf-releaselens: packaged ${entries.length} files (v${version}) into ` +
      `${relative(projectRoot, outputPath)} — ${(zip.length / 1024).toFixed(1)} KB`,
  );
}

main().catch((cause) => {
  console.error(`sf-releaselens packaging failed: ${cause.message}`);
  process.exitCode = 1;
});
