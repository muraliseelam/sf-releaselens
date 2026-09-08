/**
 * Copies the non-TypeScript half of the extension into `dist/`, then verifies
 * that every path the manifest points at actually exists.
 *
 * That last step is the reason this is a script and not a `cp`: a manifest
 * pointing at a missing file produces a Chrome load error that names the
 * manifest, not the missing file, and the loop of guessing which path broke is
 * exactly the kind of time this project is meant to save.
 */

import { cp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(projectRoot, 'src');
const assetsRoot = join(projectRoot, 'assets');
const distRoot = join(projectRoot, 'dist');

/** Everything `tsc` does not emit. */
const ASSETS = [
  { from: 'manifest.json', to: 'manifest.json' },
  { from: 'ui/sidepanel.html', to: 'ui/sidepanel.html' },
  { from: 'ui/styles.css', to: 'ui/styles.css' },
];

/**
 * Icons live outside `src/` because they are generated artefacts, not source.
 * Regenerate with `npm run icons`; the source of truth is
 * `scripts/icon-design.mjs`.
 */
const ICONS = [16, 32, 48, 128].map((size) => ({
  from: `icon-${size}.png`,
  to: `icons/icon-${size}.png`,
}));

async function main() {
  if (!(await exists(distRoot))) {
    throw new Error(
      // The likely cause is a deleted dist/ with a surviving tsbuildinfo: tsc
      // then believes it has nothing to emit, and "npm run build" appears to
      // succeed while producing nothing. Say the command that actually works.
      `dist/ does not exist. If you just ran "npm run build", tsc considered ` +
        `itself up to date because .tsbuildinfo outlived dist/. Run "npm run clean" first.`,
    );
  }

  for (const asset of ASSETS) {
    const source = join(sourceRoot, asset.from);
    const target = join(distRoot, asset.to);
    if (!(await exists(source))) {
      throw new Error(`Build asset is missing: src/${asset.from}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
  }

  for (const icon of ICONS) {
    const source = join(assetsRoot, icon.from);
    const target = join(distRoot, icon.to);
    if (!(await exists(source))) {
      throw new Error(
        `Icon is missing: assets/${icon.from}. Run \`npm run icons\` to regenerate it.`,
      );
    }
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
  }

  await verifyManifest();

  const emitted = await countFiles(distRoot);
  console.log(`sf-releaselens: built ${emitted} files into dist/`);
  console.log('Load it with chrome://extensions → Developer mode → Load unpacked → dist/');
}

/** Checks every file path the manifest references, so a typo fails here. */
async function verifyManifest() {
  const manifestPath = join(distRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  // Every path the manifest can name. A missing icon must fail the build here
  // rather than at "Load unpacked", where Chrome blames the manifest and not
  // the file.
  const referenced = [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ].filter((value) => typeof value === 'string');

  const missing = [];
  for (const relative of referenced) {
    if (!(await exists(join(distRoot, relative)))) missing.push(relative);
  }

  if (missing.length > 0) {
    throw new Error(
      `manifest.json references ${missing.length} file(s) that were not built: ${missing.join(', ')}. ` +
        'Check the tsconfig rootDir/outDir and the ASSETS list in scripts/build.mjs.',
    );
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (cause && cause.code === 'ENOENT') return false;
    throw cause;
  }
}

async function countFiles(root) {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).length;
}

main().catch((cause) => {
  console.error(`sf-releaselens build failed: ${cause.message}`);
  process.exitCode = 1;
});
