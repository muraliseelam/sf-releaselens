/**
 * Generates `assets/icon.svg` and the PNGs Chrome needs, from one definition.
 *
 *   node scripts/generate-icons.mjs           write the files
 *   node scripts/generate-icons.mjs --check   regenerate and compare, write nothing
 *
 * `--check` compares **pixels**, not file bytes. zlib's compressed output can
 * differ between Node versions, and a byte comparison would then fail while
 * telling you nothing about whether the icon actually changed.
 *
 * No dependencies: the PNG codec and rasteriser are ~200 lines of Node stdlib
 * in `scripts/lib/`, which is a smaller and more auditable surface than a
 * native image library pulled in to draw four circles.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DESIGN_SIZE, ICON_SIZES, drawIcon, toSvg } from './icon-design.mjs';
import { createCanvas } from './lib/raster.mjs';
import { decodePng, encodePng } from './lib/png.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(projectRoot, 'assets');

const svgPath = join(assetsDir, 'icon.svg');
const pngPath = (size) => join(assetsDir, `icon-${size}.png`);

/** Every artefact this script owns, as name → bytes. */
function render() {
  const files = new Map();
  files.set(svgPath, Buffer.from(toSvg(), 'utf8'));
  for (const size of ICON_SIZES) {
    const canvas = drawIcon(createCanvas(size));
    files.set(pngPath(size), encodePng(canvas.rgba, size, size));
  }
  return files;
}

function write() {
  mkdirSync(assetsDir, { recursive: true });
  for (const [path, bytes] of render()) {
    writeFileSync(path, bytes);
    console.log(`  wrote ${path.slice(projectRoot.length + 1)} (${bytes.length} bytes)`);
  }
  console.log(`\nGenerated ${ICON_SIZES.length} PNGs + 1 SVG from a ${DESIGN_SIZE}-unit design.`);
}

function check() {
  let problems = 0;

  for (const [path, expected] of render()) {
    const name = path.slice(projectRoot.length + 1);
    let actual;
    try {
      actual = readFileSync(path);
    } catch {
      console.log(`  MISSING  ${name}`);
      problems += 1;
      continue;
    }

    if (path.endsWith('.svg')) {
      // Text: compare exactly, ignoring line-ending normalisation.
      const normalise = (buffer) => buffer.toString('utf8').replace(/\r\n/g, '\n');
      if (normalise(actual) !== normalise(expected)) {
        console.log(`  STALE    ${name} — regenerate with \`npm run icons\``);
        problems += 1;
      } else {
        console.log(`  ok       ${name}`);
      }
      continue;
    }

    try {
      const a = decodePng(actual);
      const b = decodePng(expected);
      const sameSize = a.width === b.width && a.height === b.height;
      const samePixels = sameSize && a.rgba.every((value, index) => value === b.rgba[index]);
      if (!samePixels) {
        console.log(`  STALE    ${name} — pixels differ; regenerate with \`npm run icons\``);
        problems += 1;
      } else {
        console.log(`  ok       ${name} (${a.width}x${a.height})`);
      }
    } catch (cause) {
      console.log(`  UNREADABLE ${name}: ${cause.message}`);
      problems += 1;
    }
  }

  if (problems > 0) {
    console.error(`\n${problems} icon artefact(s) out of date.`);
    process.exitCode = 1;
    return;
  }
  console.log('\nAll icon artefacts match the design definition.');
}

if (process.argv.includes('--check')) {
  check();
} else {
  write();
}
